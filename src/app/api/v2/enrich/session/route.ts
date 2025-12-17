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
import { withAuth } from '@/lib/auth';
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

    // Specific session
    if (sessionId) {
      const session = await getEnrichmentSession(sessionId);

      if (!session) {
        return NextResponse.json(
          { success: false, error: 'Session not found' },
          { status: 404 }
        );
      }

      // Get identity candidates if completed
      let identityCandidates = null;
      if (session.status === 'completed') {
        identityCandidates = await prisma.identityCandidate.findMany({
          where: { candidateId: session.candidateId },
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

    // Recent sessions for a candidate
    if (candidateId) {
      const sessions = await getRecentSessions(candidateId, 10);

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
