/**
 * Groq LLM Fallback for Job Track Classification
 *
 * Called when deterministic scorer has low confidence.
 * Features: Redis cache, circuit breaker, hard timeout, retry.
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import { generateObject } from 'ai';
import { createGroqModel } from '@/lib/ai/groq';
import { getCache, setCache } from '@/lib/redis/cache';
import redis from '@/lib/redis/client';
import { createLogger } from '@/lib/logger';
import type { SourcingConfig } from './config';
import type { SourcingJobContextInput } from './jd-digest';

const log = createLogger('TrackGroq');

// ---------------------------------------------------------------------------
// Output schema (no 'blended' — force LLM to pick a side)
// ---------------------------------------------------------------------------

const TrackClassificationSchema = z.object({
  track: z.enum(['tech', 'non_tech']),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).max(5),
  ambiguityFlag: z.boolean(),
});

export interface GroqTrackResult {
  track: 'tech' | 'non_tech';
  confidence: number;
  reasons: string[];
  ambiguityFlag: boolean;
  modelName: string;
  latencyMs: number;
  cached: boolean;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const CLASSIFICATION_PROMPT = `Classify this job as tech or non_tech.

RULES:
- tech: Primary work is building, maintaining, or operating software/infrastructure. Includes engineering, data science, ML, DevOps, QA automation.
- non_tech: Primary work is managing people, processes, budgets, or business functions. Includes sales, marketing, HR, finance, operations, legal, customer success.
- For hybrid roles (e.g., "Technical Account Manager"), classify by primary daily work.
- Set ambiguityFlag=true if the role straddles both categories.

JOB:`;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function buildCacheKey(
  classifierVersion: string,
  title: string | undefined,
  skills: string[] | undefined,
  jdDigest: string,
): string {
  const sortedSkills = [...(skills ?? [])].sort().join(',');
  const payload = `${title ?? ''}|${sortedSkills}|${jdDigest.slice(0, 500)}`;
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  return `track:groq:${classifierVersion}:${hash}`;
}

// ---------------------------------------------------------------------------
// Circuit breaker (Redis-backed)
// ---------------------------------------------------------------------------

const CB_FAILURES_KEY = 'track:groq:cb:failures';
const CB_OPEN_UNTIL_KEY = 'track:groq:cb:open_until';

async function isCircuitOpen(): Promise<boolean> {
  try {
    const openUntil = await redis.get(CB_OPEN_UNTIL_KEY);
    if (!openUntil) return false;
    return Date.now() < Number(openUntil);
  } catch {
    return false; // Redis error → assume closed (try Groq)
  }
}

async function recordFailure(config: SourcingConfig): Promise<void> {
  try {
    const count = await redis.incr(CB_FAILURES_KEY);
    if (count === 1) {
      await redis.expire(CB_FAILURES_KEY, config.trackCbWindowSec);
    }
    if (count >= config.trackCbThreshold) {
      const cooldownUntil = Date.now() + config.trackCbCooldownSec * 1000;
      await redis.setex(CB_OPEN_UNTIL_KEY, config.trackCbCooldownSec, String(cooldownUntil));
      log.warn({ count, cooldownSec: config.trackCbCooldownSec }, 'Circuit breaker opened');
    }
  } catch (err) {
    log.warn({ error: err }, 'Failed to record circuit breaker failure');
  }
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Groq timeout after ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Core Groq call (single attempt)
// ---------------------------------------------------------------------------

async function callGroq(
  jobContext: SourcingJobContextInput,
  config: SourcingConfig,
): Promise<GroqTrackResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const start = Date.now();
  const { model, modelName } = await createGroqModel(apiKey);

  const jobText = [
    jobContext.title ? `Title: ${jobContext.title}` : null,
    jobContext.skills?.length ? `Skills: ${jobContext.skills.join(', ')}` : null,
    jobContext.jdDigest ? `JD: ${jobContext.jdDigest.slice(0, 500)}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const { object } = await withTimeout(
    generateObject({
      model,
      schema: TrackClassificationSchema,
      prompt: `${CLASSIFICATION_PROMPT}\n${jobText}`,
    }),
    config.trackGroqTimeoutMs,
  );

  return {
    track: object.track,
    confidence: object.confidence,
    reasons: object.reasons,
    ambiguityFlag: object.ambiguityFlag,
    modelName,
    latencyMs: Date.now() - start,
    cached: false,
  };
}

// ---------------------------------------------------------------------------
// Export: groqClassifyTrack
// ---------------------------------------------------------------------------

export async function groqClassifyTrack(
  jobContext: SourcingJobContextInput,
  config: SourcingConfig,
): Promise<GroqTrackResult> {
  // Check cache first
  const cacheKey = buildCacheKey(
    config.trackClassifierVersion,
    jobContext.title,
    jobContext.skills,
    jobContext.jdDigest,
  );

  const cached = await getCache<GroqTrackResult>(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  // Check circuit breaker
  if (await isCircuitOpen()) {
    throw new Error('Groq circuit breaker open');
  }

  // Attempt with retry
  const maxAttempts = 1 + config.trackGroqMaxRetries;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await callGroq(jobContext, config);

      // Cache success
      const ttlSec = config.trackGroqCacheTtlDays * 24 * 60 * 60;
      await setCache(cacheKey, result, ttlSec);

      log.info(
        { track: result.track, confidence: result.confidence, latencyMs: result.latencyMs, attempt },
        'Groq classification succeeded',
      );
      return result;
    } catch (err) {
      lastError = err;
      const isTimeout = err instanceof Error && err.message.includes('timeout');
      log.warn({ error: err, attempt, maxAttempts }, 'Groq attempt failed');

      // Only retry on non-timeout failures
      if (isTimeout || attempt >= maxAttempts) break;
    }
  }

  // Record failure for circuit breaker
  await recordFailure(config);
  throw lastError;
}
