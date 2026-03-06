/**
 * Groq LLM Fallback for Location Canonicalization
 *
 * Called when deterministic location parsing cannot confidently resolve city/country.
 * Mirrors role-groq.ts pattern:
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

const log = createLogger('LocationGroq');

const SCHEMA_VERSION = 1;

const COUNTRY_CODE_LIST = [
  'AE', 'AU', 'BR', 'CA', 'DE', 'ES', 'FR', 'GB', 'ID', 'IE', 'IN', 'IT', 'JP', 'MX', 'NL', 'SG', 'US',
] as const;

const FALLBACK_KINDS = ['unknown', 'ambiguous'] as const;

const LocationClassificationSchema = z.object({
  city: z.string().max(120).nullable().catch(null),
  countryCode: z.string().max(5).nullable()
    .transform(v => v && COUNTRY_CODE_LIST.includes(v as typeof COUNTRY_CODE_LIST[number]) ? v : null)
    .catch(null),
  fallbackKind: z.enum(FALLBACK_KINDS).nullable().catch(null),
  confidence: z.number().min(0).max(1),
});

export interface GroqLocationResult {
  city: string | null;
  countryCode: string | null;
  fallbackKind: 'unknown' | 'ambiguous' | null;
  confidence: number;
  modelName: string;
  latencyMs: number;
  cached: boolean;
}

const CLASSIFICATION_PROMPT = `Normalize this location text.

Return:
- city: canonical city name (or null)
- countryCode: ISO-3166 alpha-2 uppercase country code (or null)
- fallbackKind: "unknown" or "ambiguous" when city/country cannot be resolved
- confidence: 0.0-1.0

Rules:
- Be conservative. Prefer null when unsure.
- If city is known but country unknown, return city and countryCode=null.
- If country is known but city unknown, return city=null and countryCode.
- Use only one city and one country.
- Never invent.

INPUT:`;

const PROMPT_HASH = createHash('sha256').update(CLASSIFICATION_PROMPT).digest('hex').slice(0, 8);

function buildCacheKey(
  location: string,
  context: string | null,
  modelHash: string,
): string {
  const locationHash = createHash('sha256').update(location.toLowerCase().trim()).digest('hex').slice(0, 12);
  const contextHash = context
    ? createHash('sha256').update(context.toLowerCase().trim().slice(0, 500)).digest('hex').slice(0, 12)
    : '0';
  return `location:groq:v${SCHEMA_VERSION}:m${modelHash}:p${PROMPT_HASH}:${locationHash}:${contextHash}`;
}

const CB_FAILURES_KEY = 'location:groq:cb:failures';
const CB_OPEN_UNTIL_KEY = 'location:groq:cb:open_until';

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
      await redis.expire(CB_FAILURES_KEY, config.locationCbWindowSec);
    }
    if (count >= config.locationCbThreshold) {
      const cooldownUntil = Date.now() + config.locationCbCooldownSec * 1000;
      await redis.setex(CB_OPEN_UNTIL_KEY, config.locationCbCooldownSec, String(cooldownUntil));
      log.warn({ count, cooldownSec: config.locationCbCooldownSec }, 'Location Groq circuit breaker opened');
    }
  } catch (err) {
    log.warn({ error: err }, 'Failed to record location circuit breaker failure');
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Location Groq timeout after ${ms}ms`)), ms),
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

async function callGroq(
  location: string,
  context: string | null,
  config: SourcingConfig,
): Promise<GroqLocationResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const start = Date.now();
  const { model, modelName } = await createGroqModel(apiKey);
  const modelHash = createHash('sha256').update(modelName).digest('hex').slice(0, 8);
  const inputText = [
    `Location: ${location}`,
    context ? `Context: ${context.slice(0, 500)}` : null,
  ].filter(Boolean).join('\n');

  const { object } = await withTimeout(
    generateObject({
      model,
      schema: LocationClassificationSchema,
      prompt: `${CLASSIFICATION_PROMPT}\n${inputText}`,
    }),
    config.locationGroqTimeoutMs,
  );

  const result: GroqLocationResult = {
    city: object.city,
    countryCode: object.countryCode,
    fallbackKind: object.fallbackKind,
    confidence: object.confidence,
    modelName,
    latencyMs: Date.now() - start,
    cached: false,
  };

  const cacheKey = buildCacheKey(location, context, modelHash);
  const primaryCacheKey = buildCacheKey(location, null, modelHash);
  const ttlSec = config.locationGroqCacheTtlDays * 24 * 60 * 60;
  await setCache(cacheKey, result, ttlSec);
  if (primaryCacheKey !== cacheKey) {
    await setCache(primaryCacheKey, result, ttlSec);
  }

  return result;
}

export async function groqClassifyLocation(
  location: string,
  context: string | null,
  config: SourcingConfig,
): Promise<GroqLocationResult | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    log.warn('GROQ_API_KEY not set, skipping location classification');
    return null;
  }

  const { modelName } = await createGroqModel(apiKey);
  const modelHash = createHash('sha256').update(modelName).digest('hex').slice(0, 8);
  const primaryCacheKey = buildCacheKey(location, null, modelHash);
  const contextualCacheKey = buildCacheKey(location, context, modelHash);

  const cachedPrimary = await getCache<GroqLocationResult>(primaryCacheKey);
  if (cachedPrimary) {
    return { ...cachedPrimary, cached: true };
  }
  const cached = primaryCacheKey === contextualCacheKey
    ? null
    : await getCache<GroqLocationResult>(contextualCacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  if (await isCircuitOpen()) {
    log.warn('Location Groq circuit breaker open, skipping');
    return null;
  }

  const maxAttempts = 1 + config.locationGroqMaxRetries;
  let lastError: unknown;
  let breakerFailure = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await callGroq(location, context, config);
      log.info(
        { city: result.city, countryCode: result.countryCode, confidence: result.confidence, latencyMs: result.latencyMs, attempt },
        'Location Groq classification succeeded',
      );
      return result;
    } catch (err) {
      lastError = err;
      const classification = classifyGroqError(err);
      breakerFailure = breakerFailure || classification.countTowardsBreaker;
      log.warn({ error: err, attempt, maxAttempts }, 'Location Groq attempt failed');
      if (!classification.retryable || attempt >= maxAttempts) break;
    }
  }

  if (breakerFailure) {
    await recordFailure(config);
  }
  log.warn({ error: lastError, location }, 'Location Groq classification failed after retries');
  return null;
}
