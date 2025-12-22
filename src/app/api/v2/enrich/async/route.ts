/**
 * Async Enrichment API
 *
 * POST /api/v2/enrich/async
 * - Creates an enrichment session and queues a job
 * - Returns immediately with sessionId for progress tracking
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { createEnrichmentSession } from '@/lib/enrichment/queue';
import { withRateLimit, ENRICH_RATE_LIMIT, rateLimitHeaders } from '@/lib/rate-limit';
import { withAuth, requireTenantId } from '@/lib/auth';
import type { RoleType } from '@/types/linkedin';
import type { EnrichmentBudget } from '@/lib/enrichment/graph/types';

/**
 * Check if LangGraph enrichment is enabled
 */
function isLangGraphEnabled(): boolean {
  return process.env.USE_LANGGRAPH_ENRICHMENT === 'true';
}

/**
 * POST /api/v2/enrich/async
 *
 * Start async enrichment for a candidate.
 *
 * Request body:
 * - candidateId: string (required)
 * - roleType?: RoleType
 * - budget?: Partial<EnrichmentBudget>
 * - priority?: number (0 = normal, higher = more urgent)
 *
 * Response:
 * - sessionId: string (for progress tracking)
 * - statusUrl: string (URL to check progress)
 */
export async function POST(request: NextRequest) {
  // Check feature flag
  if (!isLangGraphEnabled()) {
    return NextResponse.json(
      {
        success: false,
        error: 'Async enrichment is not enabled. Set USE_LANGGRAPH_ENRICHMENT=true to enable.',
      },
      { status: 400 }
    );
  }

  // Auth check
  const authCheck = await withAuth('recruiter');
  if (!authCheck.authorized) {
    return authCheck.response;
  }
  const tenantId = requireTenantId(authCheck.context);

  // Rate limit by userId (all requests are now Clerk-authenticated)
  const rateLimitKey = authCheck.context.userId || undefined;
  const rateLimitCheck = await withRateLimit(ENRICH_RATE_LIMIT, rateLimitKey);
  if (!rateLimitCheck.allowed) {
    return rateLimitCheck.response;
  }

  try {
    const body = await request.json();
    const { candidateId, roleType, budget, priority } = body as {
      candidateId: string;
      roleType?: RoleType;
      budget?: Partial<EnrichmentBudget>;
      priority?: number;
    };

    if (!candidateId) {
      return NextResponse.json(
        { success: false, error: 'candidateId is required' },
        { status: 400 }
      );
    }

    // Create session and enqueue job (tenant-scoped)
    const { sessionId, jobId } = await createEnrichmentSession(tenantId, candidateId, {
      roleType,
      budget,
      priority,
    });

    const forwardedProto =
      request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
    const forwardedHost =
      request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    const baseUrl = forwardedHost ? `${forwardedProto}://${forwardedHost}` : request.nextUrl.origin;

    return NextResponse.json(
      {
        success: true,
        version: 'v2',
        mode: 'async',
        sessionId,
        jobId,
        statusUrl: `${baseUrl}/api/v2/enrich/session?sessionId=${sessionId}`,
        streamUrl: `${baseUrl}/api/v2/enrich/session/stream?sessionId=${sessionId}`,
        timestamp: Date.now(),
      },
      { headers: rateLimitHeaders(rateLimitCheck.result) }
    );
  } catch (error) {
    console.error('[v2/enrich/async] Error:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start async enrichment',
      },
      { status: 500 }
    );
  }
}
