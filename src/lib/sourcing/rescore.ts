import { prisma } from '@/lib/prisma';
import { toJsonValue } from '@/lib/prisma/json';
import { createLogger } from '@/lib/logger';
import { buildJobRequirements, type SourcingJobContextInput } from './jd-digest';
import { rankCandidates, type CandidateForRanking } from './ranking';
import { jobTrackToDbFilter, type JobTrack } from './types';

const log = createLogger('SourcingRescore');

export type SnapshotRow = {
  track: string;
  skillsNormalized: string[];
  roleType: string | null;
  seniorityBand: string | null;
  location: string | null;
  activityRecencyDays: number | null;
  computedAt: Date;
  staleAfter: Date;
};

export type CandidateRow = {
  id: string;
  headlineHint: string | null;
  locationHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
  enrichmentStatus: string;
  lastEnrichedAt: Date | null;
  intelligenceSnapshots: SnapshotRow[];
};

export function readTrackFromDiagnostics(diagnostics: unknown): JobTrack | undefined {
  if (!diagnostics || typeof diagnostics !== 'object') return undefined;
  const diagnosticsObj = diagnostics as Record<string, unknown>;
  const trackDecision = diagnosticsObj.trackDecision;
  if (!trackDecision || typeof trackDecision !== 'object') return undefined;
  const track = (trackDecision as Record<string, unknown>).track;
  if (track === 'tech' || track === 'non_tech' || track === 'blended') return track;
  return undefined;
}

export function selectSnapshotForTrack(
  snapshots: SnapshotRow[],
  trackFilter: string[],
): SnapshotRow | null {
  const trackSnapshots = snapshots.filter((snapshot) => trackFilter.includes(snapshot.track));
  if (trackFilter.length === 1) return trackSnapshots[0] ?? null;

  // Blended requests remain deterministic: prefer tech, then non-tech.
  const latestTech = trackSnapshots.find((snapshot) => snapshot.track === 'tech') ?? null;
  const latestNonTech = trackSnapshots.find((snapshot) => snapshot.track === 'non-tech') ?? null;
  return latestTech ?? latestNonTech;
}

export function toRankingCandidate(
  candidate: CandidateRow,
  trackFilter: string[],
): CandidateForRanking {
  const snapshot = selectSnapshotForTrack(candidate.intelligenceSnapshots, trackFilter);
  return {
    id: candidate.id,
    headlineHint: candidate.headlineHint,
    locationHint: candidate.locationHint,
    searchTitle: candidate.searchTitle,
    searchSnippet: candidate.searchSnippet,
    enrichmentStatus: candidate.enrichmentStatus,
    lastEnrichedAt: candidate.lastEnrichedAt,
    snapshot: snapshot
      ? {
          skillsNormalized: snapshot.skillsNormalized,
          roleType: snapshot.roleType,
          seniorityBand: snapshot.seniorityBand,
          location: snapshot.location,
          activityRecencyDays: snapshot.activityRecencyDays,
          computedAt: snapshot.computedAt,
          staleAfter: snapshot.staleAfter,
        }
      : null,
  };
}

export function isValidJobContext(value: unknown): value is SourcingJobContextInput {
  if (!value || typeof value !== 'object') return false;
  const jobContext = value as Record<string, unknown>;
  return typeof jobContext.jdDigest === 'string';
}

/**
 * Recompute fitScore for completed sourcing rows where fitScore is still null.
 * This fills discovered candidates that were enriched after initial assembly.
 */
export async function rescoreCompletedSourcingRowsForCandidate(
  tenantId: string,
  candidateId: string,
): Promise<number> {
  const [candidate, rowsToRescore] = await Promise.all([
    prisma.candidate.findUnique({
      where: { id: candidateId },
      select: {
        id: true,
        headlineHint: true,
        locationHint: true,
        searchTitle: true,
        searchSnippet: true,
        enrichmentStatus: true,
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
            activityRecencyDays: true,
            computedAt: true,
            staleAfter: true,
          },
        },
      },
    }),
    prisma.jobSourcingCandidate.findMany({
      where: {
        tenantId,
        candidateId,
        fitScore: null,
        sourcingRequest: { status: 'complete' },
      },
      select: {
        id: true,
        sourcingRequest: {
          select: {
            id: true,
            jobContext: true,
            diagnostics: true,
          },
        },
      },
    }),
  ]);

  if (!candidate || rowsToRescore.length === 0) return 0;

  let updated = 0;

  for (const row of rowsToRescore) {
    const requestId = row.sourcingRequest.id;
    if (!isValidJobContext(row.sourcingRequest.jobContext)) {
      log.warn({ tenantId, candidateId, requestId }, 'Skipping sourcing rescore due to invalid job context');
      continue;
    }

    const track = readTrackFromDiagnostics(row.sourcingRequest.diagnostics);
    const trackFilter = jobTrackToDbFilter(track);
    const rankingCandidate = toRankingCandidate(candidate, trackFilter);
    const requirements = buildJobRequirements(row.sourcingRequest.jobContext);
    const scored = rankCandidates([rankingCandidate], requirements)[0];
    if (!scored) continue;

    await prisma.jobSourcingCandidate.update({
      where: { id: row.id },
      data: {
        fitScore: scored.fitScore,
        fitBreakdown: toJsonValue({
          ...scored.fitBreakdown,
          matchTier: scored.matchTier,
          locationMatchType: scored.locationMatchType,
        }),
        enrichmentStatus: candidate.enrichmentStatus,
      },
    });
    updated++;
  }

  if (updated > 0) {
    log.info({ tenantId, candidateId, updated }, 'Rescored sourcing rows after enrichment completion');
  }

  return updated;
}

