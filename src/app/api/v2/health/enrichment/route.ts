/**
 * Enrichment Health Check API
 *
 * GET /api/v2/health/enrichment
 * - Returns health status of enrichment infrastructure
 * - Checks LangGraph feature flag, Redis connectivity
 * - Public endpoint returns minimal info (healthy: true/false)
 * - Authenticated users get detailed breakdown
 *
 * Used to detect misconfiguration before users hit it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRedisHealth } from '@/lib/redis/health';
import { withAuth } from '@/lib/auth';

/**
 * Check if LangGraph enrichment is enabled
 */
function isLangGraphEnabled(): boolean {
  return process.env.USE_LANGGRAPH_ENRICHMENT === 'true';
}

/**
 * Check if Redis URL is configured
 */
function isRedisConfigured(): boolean {
  return !!(process.env.REDIS_URL || (process.env.REDIS_HOST && process.env.REDIS_PORT));
}

/**
 * GET /api/v2/health/enrichment
 *
 * Returns enrichment infrastructure health status.
 * - Unauthenticated: returns minimal { healthy, timestamp }
 * - Authenticated: returns detailed breakdown
 */
export async function GET(_request: NextRequest) {
  const enabled = isLangGraphEnabled();
  const redisConfigured = isRedisConfigured();

  // Only ping Redis if configured (reuses existing client)
  let redisOk = false;
  if (redisConfigured) {
    redisOk = await checkRedisHealth();
  }

  // Overall health: LangGraph enabled AND Redis working
  const healthy = enabled && redisOk;

  // Check if user is authenticated for detailed response
  const authCheck = await withAuth('authenticated');
  const isAuthenticated = authCheck.authorized;

  // Minimal response for public/unauthenticated requests
  if (!isAuthenticated) {
    return NextResponse.json(
      {
        healthy,
        timestamp: Date.now(),
      },
      {
        status: healthy ? 200 : 503,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      }
    );
  }

  // Detailed response for authenticated users
  const status = {
    healthy,
    timestamp: Date.now(),
    checks: {
      langgraph: {
        enabled,
        message: enabled
          ? 'LangGraph enrichment is enabled'
          : 'USE_LANGGRAPH_ENRICHMENT is not set to "true"',
      },
      redis: {
        configured: redisConfigured,
        connected: redisOk,
        message: !redisConfigured
          ? 'Redis not configured (REDIS_URL or REDIS_HOST/REDIS_PORT)'
          : redisOk
            ? 'Redis connected'
            : 'Redis connection failed',
      },
    },
    notes: healthy
      ? ['Enrichment infrastructure is healthy']
      : [
          'Enrichment is misconfigured or unavailable',
          'Contact admin to resolve infrastructure issues',
        ],
  };

  return NextResponse.json(status, {
    status: healthy ? 200 : 503,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
