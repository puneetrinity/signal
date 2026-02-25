/**
 * GET /api/v3/jobs/[id]/results
 *
 * Returns sourcing results for a job. Optionally filter by requestId.
 * Scope: jobs:results
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyServiceJWT } from '@/lib/auth/service-jwt';
import { requireScope } from '@/lib/auth/service-scopes';
import { prisma } from '@/lib/prisma';
import { summarizeIdentitySignals } from '@/lib/sourcing/identity-summary';
import { isNonTechShadow } from '@/lib/enrichment/config';

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function safeOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readSearchSignals(searchMeta: unknown): {
  serpDate: string | null;
  linkedinHost: string | null;
  linkedinLocale: string | null;
} {
  const metaObj = safeObject(searchMeta);
  const serperObj = safeObject(metaObj?.serper);
  return {
    serpDate: safeOptionalString(serperObj?.resultDate),
    linkedinHost: safeOptionalString(serperObj?.linkedinHost),
    linkedinLocale: safeOptionalString(serperObj?.linkedinLocale),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyServiceJWT(request);
  if (!auth.authorized) return auth.response;

  const scopeCheck = requireScope(auth.context, 'jobs:results');
  if (!scopeCheck.authorized) return scopeCheck.response;

  const { id: externalJobId } = await params;
  const tenantId = auth.context.tenantId;
  const requestId = request.nextUrl.searchParams.get('requestId');

  const where = requestId
    ? { id: requestId, tenantId, externalJobId }
    : { tenantId, externalJobId };

  const sourcingRequest = await prisma.jobSourcingRequest.findFirst({
    where,
    orderBy: { requestedAt: 'desc' },
    include: {
      candidates: {
        orderBy: { rank: 'asc' },
        include: {
          candidate: {
            select: {
              id: true,
              linkedinUrl: true,
              linkedinId: true,
              nameHint: true,
              headlineHint: true,
              locationHint: true,
              companyHint: true,
              searchSnippet: true,
              searchMeta: true,
              searchProvider: true,
              enrichmentStatus: true,
              confidenceScore: true,
              lastEnrichedAt: true,
              intelligenceSnapshots: {
                where: { track: { in: ['tech', 'non-tech'] } },
                orderBy: { computedAt: 'desc' },
                select: {
                  track: true,
                  skillsNormalized: true,
                  roleType: true,
                  seniorityBand: true,
                  location: true,
                  computedAt: true,
                  staleAfter: true,
                  signalsJson: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!sourcingRequest) {
    return NextResponse.json(
      { success: false, error: 'Sourcing request not found' },
      { status: 404 },
    );
  }

  const candidateIds = sourcingRequest.candidates.map((c) => c.candidateId);
  const [identitySignals, confirmedSignals] = candidateIds.length > 0
    ? await Promise.all([
        prisma.identityCandidate.findMany({
          where: {
            tenantId,
            candidateId: { in: candidateIds },
          },
          select: {
            candidateId: true,
            platform: true,
            status: true,
            confidence: true,
            bridgeTier: true,
            updatedAt: true,
            discoveredAt: true,
          },
        }),
        prisma.confirmedIdentity.findMany({
          where: {
            tenantId,
            candidateId: { in: candidateIds },
          },
          select: {
            candidateId: true,
            platform: true,
            confirmedAt: true,
          },
        }),
      ])
    : [[], []];

  const identityByCandidateId = new Map<string, typeof identitySignals>();
  for (const signal of identitySignals) {
    const existing = identityByCandidateId.get(signal.candidateId);
    if (existing) existing.push(signal);
    else identityByCandidateId.set(signal.candidateId, [signal]);
  }

  const confirmedByCandidateId = new Map<string, typeof confirmedSignals>();
  for (const signal of confirmedSignals) {
    const existing = confirmedByCandidateId.get(signal.candidateId);
    if (existing) existing.push(signal);
    else confirmedByCandidateId.set(signal.candidateId, [signal]);
  }

  const now = new Date();

  // Compute per-candidate results and collect snapshot stats
  let totalWithSnapshot = 0;
  let staleCount = 0;
  let totalAgeDays = 0;

  const nonTechShadow = isNonTechShadow();

  const candidateResults = sourcingRequest.candidates.map((sc) => {
    const techSnap = sc.candidate.intelligenceSnapshots.find((s) => s.track === 'tech') ?? null;
    const nonTechSnap = sc.candidate.intelligenceSnapshots.find((s) => s.track === 'non-tech') ?? null;
    const identitySummary = summarizeIdentitySignals(
      identityByCandidateId.get(sc.candidateId) ?? [],
      confirmedByCandidateId.get(sc.candidateId) ?? [],
    );
    const searchSignals = readSearchSignals(sc.candidate.searchMeta);

    let snapshotAgeDays: number | null = null;
    let staleServed = false;
    if (techSnap) {
      totalWithSnapshot++;
      snapshotAgeDays = Math.floor(
        (now.getTime() - techSnap.computedAt.getTime()) / (24 * 60 * 60 * 1000),
      );
      totalAgeDays += snapshotAgeDays;
      staleServed = techSnap.staleAfter < now;
      if (staleServed) staleCount++;
    }

    // Build professionalValidation from non-tech snapshot (null-safe)
    let professionalValidation: {
      tier: number;
      overallScore: number;
      topReasons: string[];
      freshness: { lastValidatedAt: string | null; stale: boolean | null };
      contradictions: number;
    } | null = null;

    if (nonTechSnap && !nonTechShadow) {
      const signalsJson = nonTechSnap.signalsJson as Record<string, unknown> | null;
      const score = signalsJson?.score as Record<string, unknown> | undefined;
      const signals = signalsJson?.signals as Record<string, unknown> | undefined;
      const freshness = signals?.freshness as Record<string, unknown> | undefined;
      const contradictions = signals?.contradictions as Record<string, unknown> | undefined;
      professionalValidation = {
        tier: (score?.tier as number) ?? 3,
        overallScore: (score?.overallScore as number) ?? 0,
        topReasons: (score?.topReasons as string[]) ?? [],
        freshness: {
          lastValidatedAt: (freshness?.lastValidatedAt as string) ?? null,
          stale: (freshness?.stale as boolean) ?? null,
        },
        contradictions: (contradictions?.count as number) ?? 0,
      };
    }

    // Build snapshot output (tech only, preserving existing shape)
    const snapshot = techSnap
      ? {
          skillsNormalized: techSnap.skillsNormalized,
          roleType: techSnap.roleType,
          seniorityBand: techSnap.seniorityBand,
          location: techSnap.location,
          computedAt: techSnap.computedAt,
          staleAfter: techSnap.staleAfter,
        }
      : null;

    // Extract tier metadata from persisted fitBreakdown JSON
    const fbRaw = sc.fitBreakdown as Record<string, unknown> | null;
    const rawMatchTier = (fbRaw?.matchTier as string) ?? null;
    const matchTier =
      rawMatchTier === 'strict_location'
        ? 'best_matches'
        : rawMatchTier === 'expanded_location'
          ? 'broader_pool'
          : null;
    const rawLocationMatchType = (fbRaw?.locationMatchType as string) ?? null;
    const locationMatchType =
      rawLocationMatchType === 'city_exact' ||
      rawLocationMatchType === 'city_alias' ||
      rawLocationMatchType === 'country_only' ||
      rawLocationMatchType === 'none'
        ? rawLocationMatchType
        : null;

    // Clean fitBreakdown: only numeric score fields (strip tier metadata)
    const fitBreakdown = fbRaw
      ? {
          skillScore: fbRaw.skillScore ?? null,
          roleScore: fbRaw.roleScore ?? null,
          seniorityScore: fbRaw.seniorityScore ?? null,
          activityFreshnessScore: fbRaw.activityFreshnessScore ?? null,
        }
      : null;

    return {
      candidateId: sc.candidateId,
      fitScore: sc.fitScore,
      fitBreakdown,
      matchTier,
      locationMatchType,
      sourceType: sc.sourceType,
      enrichmentStatus: sc.enrichmentStatus,
      rank: sc.rank,
      candidate: {
        id: sc.candidate.id,
        linkedinUrl: sc.candidate.linkedinUrl,
        linkedinId: sc.candidate.linkedinId,
        nameHint: sc.candidate.nameHint,
        headlineHint: sc.candidate.headlineHint,
        locationHint: sc.candidate.locationHint,
        companyHint: sc.candidate.companyHint,
        searchSnippet: sc.candidate.searchSnippet ?? null,
        searchMeta: sc.candidate.searchMeta ?? null,
        searchProvider: sc.candidate.searchProvider ?? null,
        searchSignals,
        enrichmentStatus: sc.candidate.enrichmentStatus,
        confidenceScore: sc.candidate.confidenceScore,
        lastEnrichedAt: sc.candidate.lastEnrichedAt,
      },
      identitySummary,
      snapshot,
      freshness: {
        snapshotAgeDays,
        staleServed,
        lastEnrichedAt: sc.candidate.lastEnrichedAt?.toISOString() ?? null,
      },
      professionalValidation,
    };
  });

  const snapshotStats = {
    totalWithSnapshot,
    staleCount,
    avgAgeDays: totalWithSnapshot > 0
      ? Math.round((totalAgeDays / totalWithSnapshot) * 10) / 10
      : null,
  };

  // Extract trackDecision from diagnostics (null-safe for pre-classifier requests)
  const diagnosticsObj = sourcingRequest.diagnostics as Record<string, unknown> | null;
  const trackDecision = diagnosticsObj?.trackDecision ?? null;

  // Compute group counts from candidate tier data
  const strictCount = candidateResults.filter((c) => c.matchTier === 'best_matches').length;
  const expandedCount = candidateResults.filter((c) => c.matchTier === 'broader_pool').length;
  const diag = diagnosticsObj ?? {};
  const groupCounts = {
    bestMatches: strictCount,
    broaderPool: expandedCount,
    strictMatchedCount: strictCount,
    expandedCount,
    expansionReason: (diag.expansionReason as string) ?? null,
    requestedLocation: (diag.requestedLocation as string) ?? null,
    strictDemotedCount: (diag.strictDemotedCount as number) ?? 0,
    strictRescuedCount: (diag.strictRescuedCount as number) ?? 0,
    strictRescueApplied: (diag.strictRescueApplied as boolean) ?? false,
    strictRescueMinFitScoreUsed: (diag.strictRescueMinFitScoreUsed as number) ?? null,
    countryGuardFilteredCount: (diag.countryGuardFilteredCount as number) ?? 0,
    minDiscoveryPerRunApplied: (diag.minDiscoveryPerRunApplied as number) ?? 0,
    minDiscoveredInOutputApplied: (diag.minDiscoveredInOutputApplied as number) ?? 0,
    discoveredPromotedCount: (diag.discoveredPromotedCount as number) ?? 0,
    discoveredPromotedInTopCount: (diag.discoveredPromotedInTopCount as number) ?? 0,
    discoveredOrphanCount: (diag.discoveredOrphanCount as number) ?? 0,
    discoveredOrphanQueued: (diag.discoveredOrphanQueued as number) ?? 0,
    locationMatchCounts: (diag.locationMatchCounts as Record<string, number>) ?? null,
    demotedStrictWithCityMatch: (diag.demotedStrictWithCityMatch as number) ?? 0,
    strictBeforeDemotion: (diag.strictBeforeDemotion as number) ?? 0,
    selectedSnapshotTrack: (diag.selectedSnapshotTrack as string) ?? 'tech',
  };

  return NextResponse.json({
    success: true,
    requestId: sourcingRequest.id,
    externalJobId: sourcingRequest.externalJobId,
    status: sourcingRequest.status,
    requestedAt: sourcingRequest.requestedAt.toISOString(),
    completedAt: sourcingRequest.completedAt?.toISOString() ?? null,
    resultCount: sourcingRequest.resultCount,
    qualityGateTriggered: sourcingRequest.qualityGateTriggered,
    queriesExecuted: sourcingRequest.queriesExecuted,
    diagnostics: sourcingRequest.diagnostics,
    trackDecision,
    groupCounts,
    snapshotStats,
    candidates: candidateResults,
  });
}
