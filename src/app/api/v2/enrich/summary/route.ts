/**
 * Summary-Only Enrichment API
 *
 * POST /api/v2/enrich/summary
 * - Creates a summary regeneration session using confirmed identities only
 * - Skips discovery phase, directly generates verified summary
 * - Returns immediately with sessionId for progress tracking
 *
 * Use this after identities have been confirmed to generate a "verified" summary.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { createSummaryOnlySession } from '@/lib/enrichment/queue';
import { withRateLimit, ENRICH_RATE_LIMIT, rateLimitHeaders } from '@/lib/rate-limit';
import { withAuth, requireTenantId } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * Check if LangGraph enrichment is enabled
 */
function isLangGraphEnabled(): boolean {
  return process.env.USE_LANGGRAPH_ENRICHMENT === 'true';
}

/**
 * POST /api/v2/enrich/summary
 *
 * Trigger summary regeneration for a candidate using confirmed identities.
 *
 * Request body:
 * - candidateId: string (required)
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

  // Rate limit (reuse enrich rate limit)
  const rateLimitKey = authCheck.context.apiKeyId || undefined;
  const rateLimitCheck = await withRateLimit(ENRICH_RATE_LIMIT, rateLimitKey);
  if (!rateLimitCheck.allowed) {
    return rateLimitCheck.response;
  }

  try {
    const body = await request.json();
    const { candidateId, priority } = body as {
      candidateId: string;
      priority?: number;
    };

    if (!candidateId) {
      return NextResponse.json(
        { success: false, error: 'candidateId is required' },
        { status: 400 }
      );
    }

    // Verify candidate exists and belongs to tenant
    const candidate = await prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: { id: true },
    });

    if (!candidate) {
      return NextResponse.json(
        { success: false, error: 'Candidate not found' },
        { status: 404 }
      );
    }

    // Verify there are confirmed identities (tenant-scoped via candidate)
    const confirmedCount = await prisma.confirmedIdentity.count({
      where: { candidateId, tenantId },
    });

    if (confirmedCount === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'No confirmed identities found. Confirm at least one identity before regenerating summary.',
        },
        { status: 400 }
      );
    }

    // Create session and enqueue summary-only job (tenant-scoped)
    const { sessionId, jobId } = await createSummaryOnlySession(tenantId, candidateId, {
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
        mode: 'summary_only',
        sessionId,
        jobId,
        confirmedIdentities: confirmedCount,
        statusUrl: `${baseUrl}/api/v2/enrich/session?sessionId=${sessionId}`,
        streamUrl: `${baseUrl}/api/v2/enrich/session/stream?sessionId=${sessionId}`,
        timestamp: Date.now(),
      },
      { headers: rateLimitHeaders(rateLimitCheck.result) }
    );
  } catch (error) {
    console.error('[v2/enrich/summary] Error:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start summary regeneration',
      },
      { status: 500 }
    );
  }
}
