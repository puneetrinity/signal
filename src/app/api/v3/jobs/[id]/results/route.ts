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
import { resolveLocationDeterministic } from '@/lib/taxonomy/location-service';

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

  const sourcingRequest = (await prisma.jobSourcingRequest.findFirst({
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
              seniorityHint: true,
              searchSnippet: true,
              searchMeta: true,
              searchProvider: true,
              enrichmentStatus: true,
              confidenceScore: true,
              lastEnrichedAt: true,
              profilePictureUrl: true,
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
  })) as any;

  if (!sourcingRequest) {
    return NextResponse.json(
      { success: false, error: 'Sourcing request not found' },
      { status: 404 },
    );
  }

  const candidates = (sourcingRequest as any).candidates || [];
  const candidateIds = candidates.map((c: any) => c.candidateId);
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
          platformId: true,
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
  const nonTechShadow = false;
  const diagnosticsObj = sourcingRequest.diagnostics as Record<string, unknown> | null;
  const diag = diagnosticsObj ?? {};
  const discoveredPromotedInTopCount = (diag.discoveredPromotedInTopCount as number) ?? 0;
  const requestJobContext = safeObject(sourcingRequest.jobContext);
  const requestedLocation = safeOptionalString(requestJobContext?.location);
  const targetHasCity = Boolean(
    requestedLocation
      ? resolveLocationDeterministic(requestedLocation).city
      : null,
  );

  const candidateResults = candidates.map((sc: any) => {
    const techSnap = sc.candidate.intelligenceSnapshots.find((s: any) => s.track === 'tech') ?? null;
    const nonTechSnap = sc.candidate.intelligenceSnapshots.find((s: any) => s.track === 'non-tech') ?? null;
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
        signalsJson: techSnap.signalsJson,
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
        matchedSkills: Array.isArray(fbRaw.matchedSkills) ? fbRaw.matchedSkills : [],
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
      locationMatchType === 'city_exact' || locationMatchType === 'city_alias'
        ? 'location_verified'
        : locationMatchType === 'country_only'
          ? (targetHasCity ? 'location_partial' : 'location_verified')
        : locationMatchType === 'unknown_location'
          ? (unknownLocationPromotion ? 'location_unverified_promoted' : 'location_unverified')
          : locationMatchType === 'none'
            ? 'location_mismatch'
            : 'location_unknown';

    const session = sc.candidate.enrichmentSessions?.[0];
    let aiSummary: { text: string; skills: string[] } | null = null;
    if (includeSummary && session?.summary) {
      const structured = (session.summaryStructured as { skills?: string[] }) || {};
      aiSummary = {
        text: session.summary,
        skills: structured?.skills ?? [],
      };
    }

    // fitScore is on a 0–100 scale (ranking-new emits 0–100). The thresholds
    // must match that scale — comparing against 0.8/0.6 made EVERY nonzero
    // score "strong". 80 = strong, 60 = good, below = possible.
    const fitScore = sc.fitScore ?? 0;
    const matchStrength = fitScore >= 80 ? 'strong' : fitScore >= 60 ? 'good' : 'possible';

    let locationStatus: 'verified' | 'partial' | 'unverified' | 'mismatch' | 'unknown' = 'unknown';
    if (locationLabel === 'location_verified') locationStatus = 'verified';
    else if (locationLabel === 'location_unverified' || locationLabel === 'location_unverified_promoted') locationStatus = 'unverified';
    else if (locationLabel === 'location_mismatch') locationStatus = 'mismatch';

    // Crustdata provides rich data directly — use as fallback before enrichment
    const searchMetaObj = sc.candidate.searchMeta as Record<string, unknown> | null;
    const crustdata = searchMetaObj?.crustdata as any | undefined;

    const crustdataEmail: string | null = null; // Person Search doesn't return emails
    const crustdataSummary = crustdata?.basic_profile?.summary as string | undefined;

    // Free contact availability flags from Person Search
    const crustdataContact = crustdata?.contact as { has_business_email?: boolean; has_personal_email?: boolean; has_phone_number?: boolean } | undefined;

    // Social handles from Person Search
    const crustdataTwitter = crustdata?.social_handles?.twitter_identifier?.slug as string | undefined;
    const crustdataGithub = crustdata?.social_handles?.dev_platform_identifier?.profile_url as string | undefined;

    // Skills waterfall: AI snapshot > AI summary > (Person Search doesn't return skills)
    let skillsTopN: string[] = [];
    if (techSnap?.skillsNormalized && Array.isArray(techSnap.skillsNormalized)) {
      skillsTopN = (techSnap.skillsNormalized as string[]).slice(0, 5);
    } else if (nonTechSnap?.skillsNormalized && Array.isArray(nonTechSnap.skillsNormalized)) {
      skillsTopN = (nonTechSnap.skillsNormalized as string[]).slice(0, 5);
    } else if (aiSummary?.skills && Array.isArray(aiSummary.skills)) {
      skillsTopN = aiSummary.skills.slice(0, 5);
    }

    const summaryText = aiSummary?.text ?? (crustdataSummary || null);
    const summaryShort = summaryText && summaryText.length > 200 ? summaryText.substring(0, 200) + '...' : summaryText;

    const location = techSnap?.location || nonTechSnap?.location || sc.candidate.locationHint;

    const identities = (identityByCandidateId.get(sc.candidateId) ?? []).map(ident => ({
      platform: ident.platform,
      platformId: ident.platformId,   // actual value: email address, phone number, github username etc.
      profileUrl: ident.profileUrl,
      confidence: ident.confidence,
      ...(includeScoreBreakdown && ident.scoreBreakdown ? { scoreBreakdown: ident.scoreBreakdown } : {})
    }));

    const emailIdentity = identities.find(i => i.platform === 'email');
    const phoneIdentity = identities.find(i => i.platform === 'phone');
    let githubIdentity = identities.find(i => i.platform === 'github');
    let twitterIdentity = identities.find(i => i.platform === 'twitter');

    if (!githubIdentity && crustdataGithub) {
      githubIdentity = {
        platform: 'github',
        platformId: crustdataGithub.split('/').pop() || '',
        profileUrl: crustdataGithub,
        confidence: 0.9,
      };
      identities.push(githubIdentity);
    }

    if (!twitterIdentity && crustdataTwitter) {
      const cleanTwitter = crustdataTwitter.replace(/^@/, '');
      twitterIdentity = {
        platform: 'twitter',
        platformId: cleanTwitter,
        profileUrl: `https://twitter.com/${cleanTwitter}`,
        confidence: 0.9,
      };
      identities.push(twitterIdentity);
    }

    const emailAvailable = !!emailIdentity || !!crustdataEmail || !!(crustdataContact?.has_business_email || crustdataContact?.has_personal_email);
    const phoneAvailable = !!phoneIdentity || !!crustdataContact?.has_phone_number;

    return {
      // --- NEW UNIFIED CARD SCHEMA ---
      candidate: {
        id: sc.candidate.id,
        name: sc.candidate.nameHint,
        linkedinUrl: sc.candidate.linkedinUrl,
        headline: sc.candidate.headlineHint,
        location,
        company: sc.candidate.companyHint,
        // Include legacy hints just in case
        nameHint: sc.candidate.nameHint,
        locationHint: sc.candidate.locationHint,
        headlineHint: sc.candidate.headlineHint,
        companyHint: sc.candidate.companyHint,
        enrichmentStatus: sc.candidate.enrichmentStatus,
        confidenceScore: sc.candidate.confidenceScore,
        lastEnrichedAt: sc.candidate.lastEnrichedAt,
        profilePictureUrl: sc.candidate.profilePictureUrl,
        searchMeta: sc.candidate.searchMeta,
      },
      sourcingContext: {
        rank: sc.rank,
        matchStrength,
        locationStatus,
      },
      cardSignals: {
        skillsTopN,
        summaryShort,
        emailAvailable,
        phoneAvailable,
        // Actual contact values — enrichment layer OR direct from Crustdata screener
        email: emailIdentity?.platformId ?? crustdataEmail,
        phone: phoneIdentity?.platformId ?? null,
        github: githubIdentity?.profileUrl ?? (githubIdentity?.platformId ? `https://github.com/${githubIdentity.platformId}` : null),
        twitter: twitterIdentity?.profileUrl ?? (twitterIdentity?.platformId ? `https://twitter.com/${twitterIdentity.platformId}` : null),
        activeSeeker: false,
      },
      crustdata, // EXPOSE THE RAW CRUSTDATA TO THE UI
      // --- DETAILED FIELDS FOR DETAIL VIEW ---
      snapshot,
      professionalValidation,
      fitScore: sc.fitScore,
      fitBreakdown,
      matchTier,
      locationMatchType,
      dataConfidence,
      locationLabel,
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

