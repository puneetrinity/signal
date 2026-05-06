import { NextRequest, NextResponse } from 'next/server';
import { verifyServiceJWT } from '@/lib/auth/service-jwt';
import { requireScope } from '@/lib/auth/service-scopes';
import { fetchEnrichLayerPersonalEmail, fetchEnrichLayerProfile } from '@/lib/enrichment/enrichlayer';
import { fetchReverseContactSignals, getReverseContactStatus } from '@/lib/enrichment/reversecontact';
import { prisma } from '@/lib/prisma';
import { summarizeIdentitySignals } from '@/lib/sourcing/identity-summary';
import { hasActiveSeeker, hasEmailAvailability, hasOutreachReady, shortenSummary, toRecruiterCard, topSkills } from '@/lib/sourcing/recruiter-cards';
import { resolveLocationDeterministic } from '@/lib/taxonomy/location-service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; candidateId: string }> },
) {
  const auth = await verifyServiceJWT(request);
  if (!auth.authorized) return auth.response;

  const scopeCheck = requireScope(auth.context, 'jobs:results');
  if (!scopeCheck.authorized) return scopeCheck.response;

  const { id: externalJobId, candidateId } = await params;
  const tenantId = auth.context.tenantId;
  const requestId = request.nextUrl.searchParams.get('requestId');
  const refresh = request.nextUrl.searchParams.get('refresh') === 'true';

  const sourcingRequest = await prisma.jobSourcingRequest.findFirst({
    where: {
      tenantId,
      externalJobId,
      ...(requestId ? { id: requestId } : {}),
    },
    orderBy: { requestedAt: 'desc' },
    include: {
      candidates: {
        where: { candidateId },
        take: 1,
        include: {
          candidate: {
            include: {
              intelligenceSnapshots: {
                where: { track: { in: ['tech', 'non-tech'] } },
                orderBy: { computedAt: 'desc' },
              },
              identityCandidates: {
                where: { tenantId },
                orderBy: { confidence: 'desc' },
              },
              confirmedIdentities: {
                where: { tenantId },
                orderBy: { confirmedAt: 'desc' },
              },
              enrichmentSessions: {
                where: { tenantId },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
          },
        },
      },
    },
  });

  const sourcingCandidate = sourcingRequest?.candidates[0] ?? null;

  if (!sourcingRequest || !sourcingCandidate) {
    return NextResponse.json(
      { success: false, error: 'Candidate result not found' },
      { status: 404 },
    );
  }

  const candidate = sourcingCandidate.candidate;
  const techSnap = candidate.intelligenceSnapshots.find((snapshot) => snapshot.track === 'tech') ?? null;
  const nonTechSnap = candidate.intelligenceSnapshots.find((snapshot) => snapshot.track === 'non-tech') ?? null;
  const latestSession = candidate.enrichmentSessions[0] ?? null;
  const requestJobContext = sourcingRequest.jobContext as Record<string, unknown> | null;
  const requestedLocation = typeof requestJobContext?.location === 'string' ? requestJobContext.location : null;
  const targetHasCity = Boolean(
    requestedLocation
      ? resolveLocationDeterministic(requestedLocation).city
      : null,
  );
  const identitySummary = summarizeIdentitySignals(
    candidate.identityCandidates,
    candidate.confirmedIdentities,
  );

  const card = toRecruiterCard({
    id: candidate.id,
    name: candidate.nameHint,
    linkedinUrl: candidate.linkedinUrl,
    headline: candidate.headlineHint,
    location: techSnap?.location ?? nonTechSnap?.location ?? candidate.locationHint,
    company: candidate.companyHint,
    rank: sourcingCandidate.rank,
    fitScore: sourcingCandidate.fitScore,
    locationLabel: (() => {
      const fitBreakdown = sourcingCandidate.fitBreakdown as Record<string, unknown> | null;
      const locationMatchType = typeof fitBreakdown?.locationMatchType === 'string'
        ? fitBreakdown.locationMatchType
        : null;
      if (locationMatchType === 'city_exact' || locationMatchType === 'city_alias') return 'location_verified';
      if (locationMatchType === 'country_only') return targetHasCity ? 'location_partial' : 'location_verified';
      if (locationMatchType === 'unknown_location') return 'location_unverified';
      if (locationMatchType === 'none') return 'location_mismatch';
      return 'location_unknown';
    })(),
    enrichmentStatus: sourcingCandidate.enrichmentStatus,
    skillsTopN: topSkills(
      techSnap?.skillsNormalized ?? nonTechSnap?.skillsNormalized ?? [],
      latestSession?.summaryStructured ?? null,
    ),
    summaryShort: shortenSummary(latestSession?.summary),
    emailAvailable: hasEmailAvailability(latestSession?.summaryStructured ?? null),
    activeSeeker: hasActiveSeeker(latestSession?.summaryStructured ?? null),
    outreachReady: hasOutreachReady(latestSession?.summaryStructured ?? null, sourcingCandidate.enrichmentStatus),
    sourceType: sourcingCandidate.sourceType,
  });

  let liveEnrichment: {
    profile: unknown | null;
    email: unknown | null;
    reverseContact: unknown | null;
    emailAvailable: boolean | null;
    activeSeeker: boolean | null;
    outreachReady: boolean | null;
    refreshedAt: string;
  } | null = null;

  if (refresh) {
    const reverseContactEnabled = getReverseContactStatus().enabled;
    const [profileResult, emailResult, reverseContactResult] = await Promise.allSettled([
      fetchEnrichLayerProfile(candidate.linkedinUrl),
      fetchEnrichLayerPersonalEmail(candidate.linkedinUrl),
      reverseContactEnabled
        ? fetchReverseContactSignals(candidate.linkedinUrl)
        : Promise.resolve(null),
    ]);

    const profile = profileResult.status === 'fulfilled' ? profileResult.value : null;
    const email = emailResult.status === 'fulfilled' ? emailResult.value : null;
    const reverseContact = reverseContactResult.status === 'fulfilled' ? reverseContactResult.value : null;
    const emailAvailable = Boolean(
      email && (
        (Array.isArray(email.personal_emails) && email.personal_emails.length > 0) ||
        (Array.isArray(email.emails) && email.emails.length > 0) ||
        email.work_email
      ),
    );
    const activeSeeker = reverseContact?.activeSeeker ?? null;

    liveEnrichment = {
      profile,
      email,
      reverseContact,
      emailAvailable,
      activeSeeker,
      outreachReady: emailAvailable,
      refreshedAt: new Date().toISOString(),
    };
  }

  return NextResponse.json({
    success: true,
    requestId: sourcingRequest.id,
    externalJobId: sourcingRequest.externalJobId,
    candidate: card,
    detail: {
      linkedinId: candidate.linkedinId,
      searchTitle: candidate.searchTitle,
      searchSnippet: candidate.searchSnippet,
      locationHint: candidate.locationHint,
      companyHint: candidate.companyHint,
      seniorityHint: candidate.seniorityHint,
      confidenceScore: candidate.confidenceScore,
      sourceType: sourcingCandidate.sourceType,
      fitScore: sourcingCandidate.fitScore,
      fitBreakdown: sourcingCandidate.fitBreakdown,
      latestSession: latestSession
        ? {
            id: latestSession.id,
            status: latestSession.status,
            queriesExecuted: latestSession.queriesExecuted,
            identitiesFound: latestSession.identitiesFound,
            identitiesConfirmed: latestSession.identitiesConfirmed,
            finalConfidence: latestSession.finalConfidence,
            summary: latestSession.summary,
            summaryStructured: latestSession.summaryStructured,
            summaryEvidence: latestSession.summaryEvidence,
            summaryModel: latestSession.summaryModel,
            summaryGeneratedAt: latestSession.summaryGeneratedAt?.toISOString() ?? null,
            createdAt: latestSession.createdAt.toISOString(),
            completedAt: latestSession.completedAt?.toISOString() ?? null,
          }
        : null,
      identitySummary,
      identities: candidate.identityCandidates.map((identity) => ({
        id: identity.id,
        platform: identity.platform,
        platformId: identity.platformId,
        profileUrl: identity.profileUrl,
        status: identity.status,
        confidence: identity.confidence,
        confidenceBucket: identity.confidenceBucket,
        bridgeTier: identity.bridgeTier,
        scoreBreakdown: identity.scoreBreakdown,
        evidence: identity.evidence,
      })),
      snapshots: {
        tech: techSnap
          ? {
              skillsNormalized: techSnap.skillsNormalized,
              roleType: techSnap.roleType,
              seniorityBand: techSnap.seniorityBand,
              location: techSnap.location,
              industries: techSnap.industries,
              computedAt: techSnap.computedAt.toISOString(),
              staleAfter: techSnap.staleAfter.toISOString(),
            }
          : null,
        nonTech: nonTechSnap
          ? {
              skillsNormalized: nonTechSnap.skillsNormalized,
              roleType: nonTechSnap.roleType,
              seniorityBand: nonTechSnap.seniorityBand,
              location: nonTechSnap.location,
              industries: nonTechSnap.industries,
              computedAt: nonTechSnap.computedAt.toISOString(),
              staleAfter: nonTechSnap.staleAfter.toISOString(),
            }
          : null,
      },
      ...(liveEnrichment ? { liveEnrichment } : {}),
    },
  });
}
