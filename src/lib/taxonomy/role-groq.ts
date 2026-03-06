/**
 * Groq LLM Fallback for Role Family Classification
 *
 * Called when deterministic regex can't resolve a title.
 * Mirrors src/lib/sourcing/track-groq.ts pattern:
 *   Redis cache, circuit breaker, hard timeout, retry.
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import { generateObject } from 'ai';
import { createGroqModel } from '@/lib/ai/groq';
import { getCache, setCache } from '@/lib/redis/cache';
import redis from '@/lib/redis/client';
import { createLogger } from '@/lib/logger';
import type { SourcingConfig } from '@/lib/sourcing/config';

const log = createLogger('RoleGroq');

// ---------------------------------------------------------------------------
// Schema version / prompt hash — included in cache key to auto-bust on changes
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

const ROLE_FAMILIES_LIST = [
  'backend', 'frontend', 'fullstack', 'devops', 'data', 'qa', 'security', 'mobile',
  'technical_account_manager', 'sales_engineer', 'customer_success',
  'account_executive', 'business_development', 'account_manager',
] as const;

const FALLBACK_KINDS = ['other_tech', 'other_non_tech', 'unknown'] as const;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const RoleClassificationSchema = z.object({
  family: z.enum([...ROLE_FAMILIES_LIST, ...FALLBACK_KINDS]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).catch([]).transform(arr => arr.slice(0, 3)),
});

export interface GroqRoleResult {
  family: string;
  fallbackKind: string | null;
  confidence: number;
  reasons: string[];
  modelName: string;
  latencyMs: number;
  cached: boolean;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const CLASSIFICATION_PROMPT = `Classify this person's role into exactly one of these families:

TECH: backend, frontend, fullstack, devops, data, qa, security, mobile
NON-TECH: technical_account_manager, sales_engineer, customer_success, account_executive, business_development, account_manager
FALLBACK: other_tech, other_non_tech, unknown

RULES:
- Match the person's PRIMARY role based on their title and context.
- TAM = technical_account_manager
- CSM = customer_success
- SE/Solutions Engineer = sales_engineer
- SDR/BDR = business_development
- AE = account_executive
- AM/KAM = account_manager
- If the role is clearly tech but doesn't fit the 8 tech families, use other_tech.
- If the role is clearly non-tech but doesn't fit the 6 non-tech families, use other_non_tech.
- Only use unknown if you truly cannot determine the role.
- Set confidence 0.0-1.0 reflecting how certain you are.

PERSON:`;

const PROMPT_HASH = createHash('sha256').update(CLASSIFICATION_PROMPT).digest('hex').slice(0, 8);

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function buildCacheKey(
  title: string,
  context: string | null,
  modelHash: string,
): string {
  const titleHash = createHash('sha256').update(title.toLowerCase().trim()).digest('hex').slice(0, 12);
  const contextHash = context
    ? createHash('sha256').update(context.toLowerCase().trim().slice(0, 500)).digest('hex').slice(0, 12)
    : '0';
  return `role:groq:v${SCHEMA_VERSION}:m${modelHash}:p${PROMPT_HASH}:${titleHash}:${contextHash}`;
}

// ---------------------------------------------------------------------------
// Circuit breaker (Redis-backed)
// ---------------------------------------------------------------------------

const CB_FAILURES_KEY = 'role:groq:cb:failures';
const CB_OPEN_UNTIL_KEY = 'role:groq:cb:open_until';

async function isCircuitOpen(): Promise<boolean> {
  try {
    const openUntil = await redis.get(CB_OPEN_UNTIL_KEY);
    if (!openUntil) return false;
    return Date.now() < Number(openUntil);
  } catch {
    return false;
  }
}

async function recordFailure(config: SourcingConfig): Promise<void> {
  try {
    const count = await redis.incr(CB_FAILURES_KEY);
    if (count === 1) {
      await redis.expire(CB_FAILURES_KEY, config.roleCbWindowSec);
    }
    if (count >= config.roleCbThreshold) {
      const cooldownUntil = Date.now() + config.roleCbCooldownSec * 1000;
      await redis.setex(CB_OPEN_UNTIL_KEY, config.roleCbCooldownSec, String(cooldownUntil));
      log.warn({ count, cooldownSec: config.roleCbCooldownSec }, 'Role Groq circuit breaker opened');
    }
  } catch (err) {
    log.warn({ error: err }, 'Failed to record role circuit breaker failure');
  }
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Role Groq timeout after ${ms}ms`)), ms),
    ),
  ]);
}

function classifyGroqError(err: unknown): {
  retryable: boolean;
  countTowardsBreaker: boolean;
  timeout: boolean;
} {
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  const name = err instanceof Error ? err.name.toLowerCase() : '';
  const timeout = message.includes('timeout');
  const validation =
    name.includes('ai_noobjectgeneratederror') ||
    name.includes('ai_typevalidationerror') ||
    message.includes('typevalidationerror') ||
    message.includes('invalid_enum_value') ||
    message.includes('zod');

  const transientNetwork =
    message.includes('econn') ||
    message.includes('socket') ||
    message.includes('network') ||
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('503');

  if (validation) {
    return { retryable: false, countTowardsBreaker: false, timeout: false };
  }
  if (timeout || transientNetwork) {
    return { retryable: true, countTowardsBreaker: true, timeout };
  }
  return { retryable: false, countTowardsBreaker: false, timeout: false };
}

// ---------------------------------------------------------------------------
// Core Groq call (single attempt)
// ---------------------------------------------------------------------------

async function callGroq(
  title: string,
  context: string | null,
  config: SourcingConfig,
): Promise<GroqRoleResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const start = Date.now();
  const { model, modelName } = await createGroqModel(apiKey);
  const modelHash = createHash('sha256').update(modelName).digest('hex').slice(0, 8);

  const personText = [
    `Title: ${title}`,
    context ? `Context: ${context.slice(0, 500)}` : null,
  ].filter(Boolean).join('\n');

  const { object } = await withTimeout(
    generateObject({
      model,
      schema: RoleClassificationSchema,
      prompt: `${CLASSIFICATION_PROMPT}\n${personText}`,
    }),
    config.roleGroqTimeoutMs,
  );

  const familyStr = object.family;
  const isFallback = FALLBACK_KINDS.includes(familyStr as typeof FALLBACK_KINDS[number]);

  const result: GroqRoleResult = {
    family: isFallback ? '' : familyStr,
    fallbackKind: isFallback ? familyStr : null,
    confidence: object.confidence,
    reasons: object.reasons,
    modelName,
    latencyMs: Date.now() - start,
    cached: false,
  };

  // Cache
  const cacheKey = buildCacheKey(title, context, modelHash);
  const ttlSec = config.roleGroqCacheTtlDays * 24 * 60 * 60;
  await setCache(cacheKey, result, ttlSec);

  return result;
}

// ---------------------------------------------------------------------------
// Export: groqClassifyRole
// ---------------------------------------------------------------------------

export async function groqClassifyRole(
  title: string,
  context: string | null,
  config: SourcingConfig,
): Promise<GroqRoleResult | null> {
  // Compute model hash for cache key (we need model name before calling)
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    log.warn('GROQ_API_KEY not set, skipping role classification');
    return null;
  }

  // Check cache with a generic model hash first — we'll match on actual key
  // We need the model name for the cache key, so we create it early
  const { modelName } = await createGroqModel(apiKey);
  const modelHash = createHash('sha256').update(modelName).digest('hex').slice(0, 8);
  const cacheKey = buildCacheKey(title, context, modelHash);

  const cached = await getCache<GroqRoleResult>(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  // Check circuit breaker
  if (await isCircuitOpen()) {
    log.warn('Role Groq circuit breaker open, skipping');
    return null;
  }

  // Attempt with retry
  const maxAttempts = 1 + config.roleGroqMaxRetries;
  let lastError: unknown;
  let breakerFailure = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await callGroq(title, context, config);
      log.info(
        { family: result.family, fallbackKind: result.fallbackKind, confidence: result.confidence, latencyMs: result.latencyMs, attempt },
        'Role Groq classification succeeded',
      );
      return result;
    } catch (err) {
      lastError = err;
      const classification = classifyGroqError(err);
      breakerFailure = breakerFailure || classification.countTowardsBreaker;
      log.warn({ error: err, attempt, maxAttempts }, 'Role Groq attempt failed');
      if (!classification.retryable || attempt >= maxAttempts) break;
    }
  }

  if (breakerFailure) {
    await recordFailure(config);
  }
  log.warn({ error: lastError, title }, 'Role Groq classification failed after retries');
  return null;
}
