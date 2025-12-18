/**
 * Enrichment Session API
 *
 * GET /api/v2/enrich/session?sessionId=xxx
 * - Returns session status and progress
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { getEnrichmentSession, getRecentSessions, getQueueStats } from '@/lib/enrichment/queue';
import { withAuth, requireTenantId } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/v2/enrich/session
 *
 * Query params:
 * - sessionId: Get specific session status
 * - candidateId: Get recent sessions for a candidate
 * - stats: Return queue statistics (admin)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const candidateId = searchParams.get('candidateId');
  const showStats = searchParams.get('stats') === 'true';

  // Auth check (authenticated for read-only)
  const authCheck = await withAuth('authenticated');
  if (!authCheck.authorized) {
    return authCheck.response;
  }
  const tenantId = requireTenantId(authCheck.context);

  try {
    // Queue stats (admin only)
    if (showStats) {
      // For admin check, re-auth with admin level
      const adminCheck = await withAuth('admin');
      if (!adminCheck.authorized) {
        return NextResponse.json(
          { success: false, error: 'Admin access required for queue stats' },
          { status: 403 }
        );
      }

      const stats = await getQueueStats();
      return NextResponse.json({
        success: true,
        version: 'v2',
        queueStats: stats,
        timestamp: Date.now(),
      });
    }

    // Specific session - must belong to tenant
    if (sessionId) {
      // Verify session belongs to tenant via direct query
      const sessionRecord = await prisma.enrichmentSession.findFirst({
        where: { id: sessionId, tenantId },
      });

      if (!sessionRecord) {
        return NextResponse.json(
          { success: false, error: 'Session not found' },
          { status: 404 }
        );
      }

      // Get full session details
      const session = await getEnrichmentSession(sessionId);

      // Get identity candidates if completed (tenant-scoped)
      let identityCandidates = null;
      if (sessionRecord.status === 'completed') {
        identityCandidates = await prisma.identityCandidate.findMany({
          where: { candidateId: sessionRecord.candidateId, tenantId },
          orderBy: { confidence: 'desc' },
          take: 20,
        });
      }

      return NextResponse.json({
        success: true,
        version: 'v2',
        session,
        identityCandidates,
        timestamp: Date.now(),
      });
    }

    // Recent sessions for a candidate - must belong to tenant
    if (candidateId) {
      // Verify candidate belongs to tenant
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

      // Get sessions for this candidate (tenant-scoped via candidateId ownership)
      const sessions = await prisma.enrichmentSession.findMany({
        where: { candidateId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      return NextResponse.json({
        success: true,
        version: 'v2',
        candidateId,
        sessions,
        timestamp: Date.now(),
      });
    }

    return NextResponse.json(
      { success: false, error: 'sessionId or candidateId is required' },
      { status: 400 }
    );
  } catch (error) {
    console.error('[v2/enrich/session] Error:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch session',
      },
      { status: 500 }
    );
  }
}
