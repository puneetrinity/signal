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

function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

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
    const rawLimit = parseInt(searchParams.get('limit') || '50', 10);
    const rawOffset = parseInt(searchParams.get('offset') || '0', 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 500);
    const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

    // Filters
    const status = searchParams.get('status');
    const candidateId = searchParams.get('candidateId');
    const from = parseDateParam(searchParams.get('from'));
    const to = parseDateParam(searchParams.get('to'));

    if (searchParams.get('from') && !from) {
      return NextResponse.json(
        { success: false, error: 'Invalid from date (expected ISO date)' },
        { status: 400 }
      );
    }
    if (searchParams.get('to') && !to) {
      return NextResponse.json(
        { success: false, error: 'Invalid to date (expected ISO date)' },
        { status: 400 }
      );
    }

    // Build where clause
    const where: Record<string, unknown> = { tenantId };

    if (status) {
      where.status = status;
    }

    if (candidateId) {
      where.candidateId = candidateId;
    }
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
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
      where,
      _count: true,
    });

    const statusCounts = {
      pending: stats.find((s) => s.status === 'pending')?._count || 0,
      running: stats.find((s) => s.status === 'running')?._count || 0,
      completed: stats.find((s) => s.status === 'completed')?._count || 0,
      failed: stats.find((s) => s.status === 'failed')?._count || 0,
    };

    // Shadow + scorer diagnostics aggregated from runTrace for test analysis.
    const shadowSummary = {
      sessionsWithShadow: 0,
      profilesScored: 0,
      bucketChanges: 0,
      avgDelta: 0,
    };
    let totalShadowDelta = 0;
    const scoringVersions: Record<string, number> = {};
    const dynamicScoringVersions: Record<string, number> = {};

    for (const session of sessions) {
      const trace = (session.runTrace || {}) as Record<string, unknown>;
      const final = (trace.final || {}) as Record<string, unknown>;
      const platformResults = (trace.platformResults || {}) as Record<string, Record<string, unknown>>;

      const staticVersions = (final.scoringVersions || {}) as Record<string, number>;
      for (const [version, count] of Object.entries(staticVersions)) {
        scoringVersions[version] = (scoringVersions[version] || 0) + (count || 0);
      }
      const dynamicVersions = (final.dynamicScoringVersions || {}) as Record<string, number>;
      for (const [version, count] of Object.entries(dynamicVersions)) {
        dynamicScoringVersions[version] = (dynamicScoringVersions[version] || 0) + (count || 0);
      }

      for (const result of Object.values(platformResults)) {
        const shadow = (result.shadowScoring || null) as
          | { profilesScored?: number; bucketChanges?: number; avgDelta?: number }
          | null;
        if (!shadow || typeof shadow.profilesScored !== 'number') continue;
        shadowSummary.sessionsWithShadow += 1;
        shadowSummary.profilesScored += shadow.profilesScored || 0;
        shadowSummary.bucketChanges += shadow.bucketChanges || 0;
        totalShadowDelta += (shadow.avgDelta || 0) * (shadow.profilesScored || 0);
      }
    }
    shadowSummary.avgDelta =
      shadowSummary.profilesScored > 0
        ? totalShadowDelta / shadowSummary.profilesScored
        : 0;

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
        shadowScoring: shadowSummary,
        scoringVersions: Object.keys(scoringVersions).length > 0 ? scoringVersions : undefined,
        dynamicScoringVersions:
          Object.keys(dynamicScoringVersions).length > 0 ? dynamicScoringVersions : undefined,
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
