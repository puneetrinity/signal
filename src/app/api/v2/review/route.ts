/**
 * Review Queue API
 *
 * GET /api/v2/review
 * - Returns identity candidates that need human review (Tier-2 + top Tier-3)
 * - Filters: platform, confidenceBucket, hasContradiction, roleType
 * - Pagination: limit, offset
 *
 * @see docs/ARCHITECTURE_V2.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth, requireTenantId } from '@/lib/auth';

function parseNonNegativeInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return fallback;
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
    const limit = Math.min(parseNonNegativeInt(searchParams.get('limit'), 50), 100);
    const offset = parseNonNegativeInt(searchParams.get('offset'), 0);

    // Filters
    const platform = searchParams.get('platform');
    const confidenceBucket = searchParams.get('confidenceBucket');
    const hasContradiction = searchParams.get('hasContradiction');
    const roleType = searchParams.get('roleType');
    const bridgeTier = searchParams.get('bridgeTier');

    // Build where clause
    const where: Record<string, unknown> = {
      tenantId,
      status: 'unconfirmed',
      // Focus on Tier-2 (needs review) and high-confidence Tier-3
      OR: [
        { bridgeTier: 2 },
        { bridgeTier: 3, confidence: { gte: 0.5 } },
      ],
    };

    if (platform) {
      where.platform = platform;
    }

    if (confidenceBucket) {
      where.confidenceBucket = confidenceBucket;
    }

    if (hasContradiction === 'true') {
      where.hasContradiction = true;
    } else if (hasContradiction === 'false') {
      where.hasContradiction = false;
    }

    if (bridgeTier) {
      const parsedBridgeTier = Number.parseInt(bridgeTier, 10);
      if (![1, 2, 3].includes(parsedBridgeTier)) {
        return NextResponse.json(
          { success: false, error: 'bridgeTier must be one of: 1, 2, 3' },
          { status: 400 }
        );
      }
      // Override the OR clause if specific tier requested
      delete where.OR;
      where.bridgeTier = parsedBridgeTier;
    }

    // If roleType filter, join with candidate
    const candidateFilter = roleType ? { roleType } : undefined;

    // Get identities with candidate info
    const [identities, total] = await Promise.all([
      prisma.identityCandidate.findMany({
        where: {
          ...where,
          ...(candidateFilter && { candidate: candidateFilter }),
        },
        include: {
          candidate: {
            select: {
              id: true,
              linkedinId: true,
              linkedinUrl: true,
              nameHint: true,
              headlineHint: true,
              roleType: true,
            },
          },
        },
        orderBy: [
          { bridgeTier: 'asc' }, // Tier-2 first
          { confidence: 'desc' }, // Then by confidence
          { createdAt: 'desc' },
        ],
        take: limit,
        skip: offset,
      }),
      prisma.identityCandidate.count({
        where: {
          ...where,
          ...(candidateFilter && { candidate: candidateFilter }),
        },
      }),
    ]);

    // Get aggregate stats
    const stats = await prisma.identityCandidate.groupBy({
      by: ['bridgeTier'],
      where: {
        tenantId,
        status: 'unconfirmed',
      },
      _count: true,
    });

    const tierCounts = {
      tier1: stats.find((s) => s.bridgeTier === 1)?._count || 0,
      tier2: stats.find((s) => s.bridgeTier === 2)?._count || 0,
      tier3: stats.find((s) => s.bridgeTier === 3)?._count || 0,
      unknown: stats.find((s) => s.bridgeTier === null)?._count || 0,
    };

    // Transform for frontend
    const items = identities.map((identity) => ({
      id: identity.id,
      candidateId: identity.candidateId,
      platform: identity.platform,
      platformId: identity.platformId,
      profileUrl: identity.profileUrl,
      confidence: identity.confidence,
      confidenceBucket: identity.confidenceBucket,
      scoreBreakdown: identity.scoreBreakdown as Record<string, number> | null,
      hasContradiction: identity.hasContradiction,
      contradictionNote: identity.contradictionNote,
      status: identity.status,
      evidence: identity.evidence as unknown[],
      bridgeTier: identity.bridgeTier,
      bridgeSignals: identity.bridgeSignals as string[] | null,
      persistReason: identity.persistReason,
      createdAt: identity.createdAt.toISOString(),
      updatedAt: identity.updatedAt.toISOString(),
      candidate: identity.candidate
        ? {
            linkedinId: identity.candidate.linkedinId,
            linkedinUrl: identity.candidate.linkedinUrl,
            nameHint: identity.candidate.nameHint,
            headlineHint: identity.candidate.headlineHint,
            roleType: identity.candidate.roleType,
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
        tierCounts,
        totalUnconfirmed: tierCounts.tier1 + tierCounts.tier2 + tierCounts.tier3 + tierCounts.unknown,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[v2/review] Error fetching review queue:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch review queue' },
      { status: 500 }
    );
  }
}
