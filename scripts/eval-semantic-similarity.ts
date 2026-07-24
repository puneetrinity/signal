/**
 * Read-only semantic-similarity calibration replay.
 *
 * Replays a completed Flow job's stored JD against the current Memory vector
 * pool, then compares ranking at weight 0 and a proposed bounded weight. It
 * never writes to Signal or Memory.
 *
 * Usage:
 *   DATABASE_URL=... ACTIVEGRAPH_URL=... SIGNAL_JWT_PRIVATE_KEY=... \
 *     npx tsx scripts/eval-semantic-similarity.ts --job 148 --weight 4
 */

import { prisma } from '@/lib/prisma';
import { searchGlobalPool } from '@/lib/sourcing/activegraph-client';
import { extractLinkedInIdFromUrl } from '@/lib/sourcing/discovery';
import { buildJobRequirements } from '@/lib/sourcing/jd-digest';
import {
  rankCandidates,
  type CandidateForRanking,
} from '@/lib/sourcing/ranking-new';

function readOption(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function percentile(values: number[], percent: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percent;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  return Number(value.toFixed(4));
}

function summarize(values: number[]) {
  return {
    count: values.length,
    min: percentile(values, 0),
    p10: percentile(values, 0.1),
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: percentile(values, 1),
  };
}

async function main() {
  const jobId = readOption('--job', '148');
  const weight = Number(readOption('--weight', '4'));
  if (!Number.isFinite(weight) || weight < 0 || weight > 10) {
    throw new Error('--weight must be a number between 0 and 10');
  }

  const request = await prisma.jobSourcingRequest.findFirst({
    where: {
      externalJobId: `vanta:jobs:${jobId}`,
      status: 'complete',
    },
    orderBy: { requestedAt: 'desc' },
  });
  if (!request) throw new Error(`No completed sourcing request found for Flow job ${jobId}`);

  const requirements = buildJobRequirements(request.jobContext as never);
  const vectorResults = await searchGlobalPool(requirements, request.tenantId, 500, `sim-eval-${jobId}`);
  if (!vectorResults) throw new Error('Memory vector search was unavailable');

  // This calibration lookup intentionally resolves local rows by linkedinId
  // only. Production also has the Layer-1 URL-slug index, so this replay is a
  // conservative sample of scored vector results, not a pool-coverage audit.
  const vectorSlugs = vectorResults
    .map((result) => result.linkedin_id ?? extractLinkedInIdFromUrl(result.linkedin_url ?? ''))
    .filter((slug): slug is string => !!slug)
    .map((slug) => slug.toLowerCase());
  const candidates = await prisma.candidate.findMany({
    where: {
      tenantId: request.tenantId,
      linkedinId: { in: vectorSlugs },
    },
    select: {
      id: true,
      linkedinId: true,
      headlineHint: true,
      seniorityHint: true,
      locationHint: true,
      searchTitle: true,
      searchSnippet: true,
      enrichmentStatus: true,
      lastEnrichedAt: true,
      intelligenceSnapshots: {
        orderBy: { computedAt: 'desc' },
        take: 1,
        select: {
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
  });
  const candidateBySlug = new Map(candidates.map((candidate) => [candidate.linkedinId.toLowerCase(), candidate]));

  let skippedNoLocalCandidate = 0;
  let skippedNoProfile = 0;
  const rankingCandidates: CandidateForRanking[] = [];
  for (const result of vectorResults) {
    const slug = result.linkedin_id ?? extractLinkedInIdFromUrl(result.linkedin_url ?? '');
    if (!slug) {
      skippedNoLocalCandidate += 1;
      continue;
    }
    const candidate = candidateBySlug.get(slug.toLowerCase());
    if (!candidate) {
      skippedNoLocalCandidate += 1;
      continue;
    }
    if (!result.crustdata_profile) {
      skippedNoProfile += 1;
      continue;
    }
    const snapshot = candidate.intelligenceSnapshots[0];
    rankingCandidates.push({
      id: candidate.id,
      headlineHint: candidate.headlineHint,
      seniorityHint: candidate.seniorityHint,
      locationHint: candidate.locationHint,
      searchTitle: candidate.searchTitle,
      searchSnippet: candidate.searchSnippet,
      enrichmentStatus: candidate.enrichmentStatus,
      lastEnrichedAt: candidate.lastEnrichedAt,
      crustdata: result.crustdata_profile,
      semanticSimilarity: result.similarity,
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
    });
  }

  const baseline = rankCandidates(rankingCandidates, requirements, { semanticSimilarityWeight: 0 });
  const proposed = rankCandidates(rankingCandidates, requirements, { semanticSimilarityWeight: weight });
  const baselineById = new Map(baseline.map((candidate, index) => [candidate.candidateId, { ...candidate, index }]));
  const proposedById = new Map(proposed.map((candidate, index) => [candidate.candidateId, { ...candidate, index }]));

  const deltas = rankingCandidates.map((candidate) => {
    const before = baselineById.get(candidate.id);
    const after = proposedById.get(candidate.id);
    return (after?.fitScore ?? 0) - (before?.fitScore ?? 0);
  });
  const topKChanged = (k: number) => {
    const before = new Set(baseline.slice(0, k).map((candidate) => candidate.candidateId));
    const after = new Set(proposed.slice(0, k).map((candidate) => candidate.candidateId));
    return [...before].filter((id) => !after.has(id)).length;
  };

  console.log(JSON.stringify({
    jobId: Number(jobId),
    requestId: request.id,
    proposedWeight: weight,
    vectorResults: vectorResults.length,
    rankedCandidates: rankingCandidates.length,
    skippedNoLocalCandidate,
    skippedNoProfile,
    cosineSimilarity: summarize(rankingCandidates.map((candidate) => candidate.semanticSimilarity ?? 0)),
    scoreDelta: summarize(deltas),
    top20MembershipChanges: topKChanged(20),
    top100MembershipChanges: topKChanged(100),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
