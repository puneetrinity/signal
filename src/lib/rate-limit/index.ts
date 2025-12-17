/**
 * Rate Limiting Infrastructure
 *
 * Provides rate limiting for:
 * - API endpoints (per IP or user)
 * - External API calls (GitHub, etc.)
 * - Sensitive actions (email reveal)
 *
 * Uses in-memory store with optional Redis backing.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { headers } from 'next/headers';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  limit: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Optional: Key prefix for namespacing */
  prefix?: string;
}

/**
 * Rate limit result
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: Date;
  retryAfterSeconds?: number;
}

/**
 * Rate limit entry in store
 */
interface RateLimitEntry {
  count: number;
  resetAt: number; // Unix timestamp ms
}

/**
 * In-memory rate limit store
 * In production, this should be backed by Redis for distributed rate limiting
 */
const store = new Map<string, RateLimitEntry>();

/**
 * Clean up expired entries periodically
 */
function cleanupExpired() {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) {
      store.delete(key);
    }
  }
}

// Run cleanup every minute
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupExpired, 60000);
}

/**
 * Check and consume rate limit
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  const fullKey = config.prefix ? `${config.prefix}:${key}` : key;
  const windowMs = config.windowSeconds * 1000;

  let entry = store.get(fullKey);

  // Reset if window expired
  if (!entry || entry.resetAt < now) {
    entry = {
      count: 0,
      resetAt: now + windowMs,
    };
  }

  // Check if limit exceeded
  if (entry.count >= config.limit) {
    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      limit: config.limit,
      resetAt: new Date(entry.resetAt),
      retryAfterSeconds,
    };
  }

  // Consume one request
  entry.count++;
  store.set(fullKey, entry);

  return {
    allowed: true,
    remaining: config.limit - entry.count,
    limit: config.limit,
    resetAt: new Date(entry.resetAt),
  };
}

/**
 * Get current rate limit status without consuming
 */
export function getRateLimitStatus(
  key: string,
  config: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  const fullKey = config.prefix ? `${config.prefix}:${key}` : key;

  const entry = store.get(fullKey);

  if (!entry || entry.resetAt < now) {
    return {
      allowed: true,
      remaining: config.limit,
      limit: config.limit,
      resetAt: new Date(now + config.windowSeconds * 1000),
    };
  }

  return {
    allowed: entry.count < config.limit,
    remaining: Math.max(0, config.limit - entry.count),
    limit: config.limit,
    resetAt: new Date(entry.resetAt),
    retryAfterSeconds:
      entry.count >= config.limit
        ? Math.ceil((entry.resetAt - now) / 1000)
        : undefined,
  };
}

/**
 * Reset rate limit for a key
 */
export function resetRateLimit(key: string, prefix?: string): void {
  const fullKey = prefix ? `${prefix}:${key}` : key;
  store.delete(fullKey);
}

/**
 * Get client IP from request headers
 */
export async function getClientIP(): Promise<string> {
  const headersList = await headers();

  // Check common proxy headers
  const forwardedFor = headersList.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  const realIP = headersList.get('x-real-ip');
  if (realIP) {
    return realIP;
  }

  // Fallback
  return 'unknown';
}

// ============================================================================
// Predefined Rate Limit Configs
// ============================================================================

/**
 * Standard API endpoint rate limit
 * 100 requests per minute per IP
 */
export const API_RATE_LIMIT: RateLimitConfig = {
  limit: 100,
  windowSeconds: 60,
  prefix: 'api',
};

/**
 * Search endpoint rate limit
 * 30 searches per minute per IP
 */
export const SEARCH_RATE_LIMIT: RateLimitConfig = {
  limit: 30,
  windowSeconds: 60,
  prefix: 'search',
};

/**
 * Enrichment endpoint rate limit
 * 20 enrichments per minute per IP
 */
export const ENRICH_RATE_LIMIT: RateLimitConfig = {
  limit: 20,
  windowSeconds: 60,
  prefix: 'enrich',
};

/**
 * Email reveal rate limit (stricter)
 * 10 reveals per hour per IP
 */
export const REVEAL_RATE_LIMIT: RateLimitConfig = {
  limit: 10,
  windowSeconds: 3600,
  prefix: 'reveal',
};

/**
 * Confirmation rate limit
 * 30 confirmations per hour per IP
 */
export const CONFIRM_RATE_LIMIT: RateLimitConfig = {
  limit: 30,
  windowSeconds: 3600,
  prefix: 'confirm',
};

// ============================================================================
// Rate Limit Middleware Helper
// ============================================================================

/**
 * Rate limit response headers
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': result.limit.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': Math.floor(result.resetAt.getTime() / 1000).toString(),
    ...(result.retryAfterSeconds
      ? { 'Retry-After': result.retryAfterSeconds.toString() }
      : {}),
  };
}

/**
 * Check rate limit and return error response if exceeded
 * Returns null if allowed, or a Response object if rate limited
 */
export async function withRateLimit(
  config: RateLimitConfig,
  customKey?: string
): Promise<{ allowed: true; result: RateLimitResult } | { allowed: false; response: Response }> {
  const ip = customKey || (await getClientIP());
  const result = checkRateLimit(ip, config);

  if (!result.allowed) {
    return {
      allowed: false,
      response: new Response(
        JSON.stringify({
          success: false,
          error: 'Rate limit exceeded',
          retryAfter: result.retryAfterSeconds,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            ...rateLimitHeaders(result),
          },
        }
      ),
    };
  }

  return { allowed: true, result };
}

export default {
  checkRateLimit,
  getRateLimitStatus,
  resetRateLimit,
  getClientIP,
  withRateLimit,
  rateLimitHeaders,
  API_RATE_LIMIT,
  SEARCH_RATE_LIMIT,
  ENRICH_RATE_LIMIT,
  REVEAL_RATE_LIMIT,
  CONFIRM_RATE_LIMIT,
};
