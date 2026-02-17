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
              enrichmentStatus: true,
              confidenceScore: true,
              lastEnrichedAt: true,
              intelligenceSnapshots: {
                where: { track: 'tech' },
                take: 1,
                orderBy: { computedAt: 'desc' },
                select: {
                  skillsNormalized: true,
                  roleType: true,
                  seniorityBand: true,
                  location: true,
                  computedAt: true,
                  staleAfter: true,
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

  return NextResponse.json({
    success: true,
    requestId: sourcingRequest.id,
    externalJobId: sourcingRequest.externalJobId,
    status: sourcingRequest.status,
    requestedAt: sourcingRequest.requestedAt.toISOString(),
    completedAt: sourcingRequest.completedAt?.toISOString() ?? null,
    resultCount: sourcingRequest.resultCount,
    candidates: sourcingRequest.candidates.map((sc) => {
      const snap = sc.candidate.intelligenceSnapshots[0] ?? null;
      return {
        candidateId: sc.candidateId,
        fitScore: sc.fitScore,
        fitBreakdown: sc.fitBreakdown,
        sourceType: sc.sourceType,
        enrichmentStatus: sc.enrichmentStatus,
        rank: sc.rank,
        candidate: sc.candidate,
        snapshot: snap,
        freshness: {
          stale: snap?.staleAfter ? snap.staleAfter < new Date() : null,
          lastEnrichedAt: sc.candidate.lastEnrichedAt?.toISOString() ?? null,
        },
      };
    }),
  });
}
