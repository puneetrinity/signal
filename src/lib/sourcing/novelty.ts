/**
 * Cross-job novelty control: suppress broader-pool candidates that were
 * recently surfaced for the same roleFamily + city combination.
 */

import { prisma } from '@/lib/prisma';
import { buildJobRequirements, type SourcingJobContextInput } from './jd-digest';
import { canonicalizeLocation, extractPrimaryCity } from './ranking';

/**
 * Returns candidate IDs that appeared in recent completed sourcing requests
 * for the same tenant + roleFamily + normalized city.
 */
export async function getRecentlyExposedCandidateIds(
  tenantId: string,
  roleFamily: string | null,
  location: string | null,
  windowDays: number,
): Promise<Set<string>> {
  if (!roleFamily) return new Set();

  const targetCity = location
    ? extractPrimaryCity(canonicalizeLocation(location))
    : null;

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const recentRequests = await prisma.jobSourcingRequest.findMany({
    where: {
      tenantId,
      status: 'complete',
      completedAt: { gte: cutoff },
    },
    select: {
      id: true,
      jobContext: true,
    },
  });

  const matchingRequestIds: string[] = [];
  for (const req of recentRequests) {
    try {
      const ctx = req.jobContext as unknown as SourcingJobContextInput;
      const reqs = buildJobRequirements(ctx);
      if (reqs.roleFamily !== roleFamily) continue;

      const reqCity = reqs.location
        ? extractPrimaryCity(canonicalizeLocation(reqs.location))
        : null;
      if (targetCity !== reqCity) continue;

      matchingRequestIds.push(req.id);
    } catch {
      // Skip unparseable jobContext
    }
  }

  if (matchingRequestIds.length === 0) return new Set();

  const candidates = await prisma.jobSourcingCandidate.findMany({
    where: {
      sourcingRequestId: { in: matchingRequestIds },
    },
    select: { candidateId: true },
  });

  return new Set(candidates.map((c) => c.candidateId));
}
