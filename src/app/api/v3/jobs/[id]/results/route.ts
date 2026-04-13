/**
 * GET /api/v3/jobs/[id]/results
 *
 * Returns sourcing results for a job. Optionally filter by requestId.
 * Scope: jobs:results
 * Note: Prisma types were recently regenerated.
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
  const includeSummary = request.nextUrl.searchParams.get('includeSummary') === 'true';
  const includeEvidence = request.nextUrl.searchParams.get('includeEvidence') === 'true';
  const includeScoreBreakdown = request.nextUrl.searchParams.get('includeScoreBreakdown') === 'true';
  const limit = parseInt(request.nextUrl.searchParams.get('limit') || '100', 10);

  const where = requestId
    ? { id: requestId, tenantId, externalJobId }
    : { tenantId, externalJobId };

  const sourcingRequest = await prisma.jobSourcingRequest.findFirst({
    where,
    orderBy: { requestedAt: 'desc' },
    include: {
      candidates: {
        orderBy: { rank: 'asc' },
        take: limit,
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
              enrichmentSessions: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  id: true,
                  status: true,
                  summary: true,
                  summaryStructured: true,
                  summaryGeneratedAt: true,
                }
              },
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
          id: true,
          candidateId: true,
          platform: true,
          profileUrl: true,
          status: true,
          confidence: true,
          bridgeTier: true,
          ...(includeEvidence ? { evidence: true } : {}),
          ...(includeScoreBreakdown ? { scoreBreakdown: true } : {}),
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

  // Compute per-candidate results
  const nonTechShadow = isNonTechShadow();
  const diagnosticsObj = sourcingRequest.diagnostics as Record<string, unknown> | null;
  const diag = diagnosticsObj ?? {};
  const discoveredPromotedInTopCount = (diag.discoveredPromotedInTopCount as number) ?? 0;

  const candidateResults = sourcingRequest.candidates.map((sc) => {
    const techSnap = sc.candidate.intelligenceSnapshots.find((s) => s.track === 'tech') ?? null;
    const nonTechSnap = sc.candidate.intelligenceSnapshots.find((s) => s.track === 'non-tech') ?? null;
    const identitySummary = summarizeIdentitySignals(
      identityByCandidateId.get(sc.candidateId) ?? [],
      confirmedByCandidateId.get(sc.candidateId) ?? [],
    );
    const searchSignals = readSearchSignals(sc.candidate.searchMeta);

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
        rawLocationMatchType === 'unknown_location' ||
        rawLocationMatchType === 'none'
        ? rawLocationMatchType
        : null;

    // Clean fitBreakdown: score fields + method flag (strip tier metadata)
    const fitBreakdown = fbRaw
      ? {
        skillScore: fbRaw.skillScore ?? null,
        skillScoreMethod: fbRaw.skillScoreMethod ?? null,
        roleScore: fbRaw.roleScore ?? null,
        seniorityScore: fbRaw.seniorityScore ?? null,
        activityFreshnessScore: fbRaw.activityFreshnessScore ?? null,
        locationBoost: fbRaw.locationBoost ?? null,
        unknownLocationPromotion: Boolean(fbRaw.unknownLocationPromotion),
      }
      : null;

    const rawDataConfidence = fbRaw?.dataConfidence;
    const dataConfidence =
      rawDataConfidence === 'high' || rawDataConfidence === 'medium' || rawDataConfidence === 'low'
        ? rawDataConfidence
        : 'low';

    const unknownLocationPromotion =
      Boolean(fbRaw?.unknownLocationPromotion) ||
      (
        sc.sourceType === 'discovered' &&
        locationMatchType === 'unknown_location' &&
        sc.rank <= discoveredPromotedInTopCount
      );

    const locationLabel =
      locationMatchType === 'city_exact' || locationMatchType === 'city_alias' || locationMatchType === 'country_only'
        ? 'location_verified'
        : locationMatchType === 'unknown_location'
          ? (unknownLocationPromotion ? 'location_unverified_promoted' : 'location_unverified')
          : locationMatchType === 'none'
            ? 'location_mismatch'
            : 'location_unknown';

    const session = sc.candidate.enrichmentSessions?.[0];

    const identities = (identityByCandidateId.get(sc.candidateId) ?? []).map(ident => ({
      platform: ident.platform,
      profileUrl: ident.profileUrl,
      confidence: ident.confidence,
      ...(includeScoreBreakdown && ident.scoreBreakdown ? { scoreBreakdown: ident.scoreBreakdown } : {})
    }));

    let aiSummary: { text: string; skills: string[] } | null = null;
    if (includeSummary && session?.summary) {
      const structured = (session.summaryStructured as { skills?: string[] }) || {};
      aiSummary = {
        text: session.summary,
        skills: structured?.skills ?? [],
      };
    }

    return {
      candidate: {
        id: sc.candidate.id,
        linkedinUrl: sc.candidate.linkedinUrl,
        nameHint: sc.candidate.nameHint,
      },
      sourcingContext: {
        rank: sc.rank,
      },
      ...(identities.length > 0 ? {
        identitySummary: {
          topConfidence: Math.max(...identities.map(i => i.confidence)),
          platforms: Array.from(new Set(identities.map(i => i.platform)))
        },
        identities
      } : {}),
      ...(aiSummary ? { aiSummary } : {}),
    };
  });

  return NextResponse.json({
    requestId: sourcingRequest.id,
    externalJobId: sourcingRequest.externalJobId,
    resultCount: sourcingRequest.resultCount,
    data: candidateResults,
  });
}
