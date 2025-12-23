/**
 * Sessions API
 *
 * GET /api/v2/sessions
 * - Returns enrichment sessions for monitoring and debugging
 * - Filters: status, candidateId
 * - Pagination: limit, offset
 *
 * @see docs/ARCHITECTURE_V2.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth, requireTenantId } from '@/lib/auth';

export async function GET(request: NextRequest) {
  // Auth check - recruiter role required
  const authCheck = await withAuth('recruiter');
  if (!authCheck.authorized) {
    return authCheck.response;
  }
  const tenantId = requireTenantId(authCheck.context);

  try {
    const { searchParams } = new URL(request.url);

    // Pagination
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
    const offset = parseInt(searchParams.get('offset') || '0');

    // Filters
    const status = searchParams.get('status');
    const candidateId = searchParams.get('candidateId');

    // Build where clause
    const where: Record<string, unknown> = { tenantId };

    if (status) {
      where.status = status;
    }

    if (candidateId) {
      where.candidateId = candidateId;
    }

    // Get sessions with candidate info
    const [sessions, total] = await Promise.all([
      prisma.enrichmentSession.findMany({
        where,
        include: {
          candidate: {
            select: {
              id: true,
              linkedinId: true,
              linkedinUrl: true,
              nameHint: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.enrichmentSession.count({ where }),
    ]);

    // Get aggregate stats
    const stats = await prisma.enrichmentSession.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: true,
    });

    const statusCounts = {
      pending: stats.find((s) => s.status === 'pending')?._count || 0,
      running: stats.find((s) => s.status === 'running')?._count || 0,
      completed: stats.find((s) => s.status === 'completed')?._count || 0,
      failed: stats.find((s) => s.status === 'failed')?._count || 0,
    };

    // Transform for frontend
    const items = sessions.map((session) => ({
      id: session.id,
      candidateId: session.candidateId,
      status: session.status,
      roleType: session.roleType,
      sourcesPlanned: session.sourcesPlanned as string[] | null,
      sourcesExecuted: session.sourcesExecuted as string[] | null,
      queriesPlanned: session.queriesPlanned,
      queriesExecuted: session.queriesExecuted,
      identitiesFound: session.identitiesFound,
      identitiesConfirmed: session.identitiesConfirmed,
      finalConfidence: session.finalConfidence,
      earlyStopReason: session.earlyStopReason,
      errorMessage: session.errorMessage,
      durationMs: session.durationMs,
      startedAt: session.startedAt?.toISOString() || null,
      completedAt: session.completedAt?.toISOString() || null,
      createdAt: session.createdAt.toISOString(),
      // Summary info
      hasSummary: !!session.summary,
      summaryModel: session.summaryModel,
      // Run trace (only include if requested)
      runTrace: searchParams.get('includeTrace') === 'true' ? session.runTrace : undefined,
      // Candidate info
      candidate: session.candidate
        ? {
            id: session.candidate.id,
            linkedinId: session.candidate.linkedinId,
            linkedinUrl: session.candidate.linkedinUrl,
            nameHint: session.candidate.nameHint,
          }
        : undefined,
    }));

    return NextResponse.json({
      success: true,
      version: 'v2',
      items,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
      stats: {
        statusCounts,
        totalSessions: statusCounts.pending + statusCounts.running + statusCounts.completed + statusCounts.failed,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[v2/sessions] Error fetching sessions:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch sessions' },
      { status: 500 }
    );
  }
}
