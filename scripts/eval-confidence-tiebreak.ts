/**
 * Read-only replay of the fit-score confidence tie-break over a captured Flow
 * result payload. Captures contain the served cohort only, so this reports
 * ordering churn within that cohort; it cannot infer candidates that were not
 * persisted in the top 100.
 *
 * Usage:
 *   npx tsx scripts/eval-confidence-tiebreak.ts --input /path/to/cands150.json
 */

import { readFile } from 'node:fs/promises';
import {
  orderByFitScoreWithConfidence,
  type ScoredCandidate,
} from '@/lib/sourcing/ranking-new';

type CaptureCandidate = {
  signalCandidateId: string;
  signalRank: number;
  fitScoreRaw?: number;
  fitScore?: number;
  sourceType?: string;
  crustdata?: {
    basic_profile?: unknown;
    experience?: {
      employment_details?: {
        current?: unknown[];
        past?: unknown[];
      };
    };
  };
};

type Capture = { candidates?: CaptureCandidate[] };

function readOption(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function dataConfidence(candidate: CaptureCandidate): number {
  let confidence = 0.75;
  if (candidate.crustdata?.basic_profile) confidence = 0.85;
  if (candidate.crustdata?.experience?.employment_details?.past?.length) confidence = 0.9;
  if (candidate.crustdata?.experience?.employment_details?.current?.length) confidence = 1;
  return confidence;
}

function asScoredCandidate(candidate: CaptureCandidate): ScoredCandidate {
  const fitScore = candidate.fitScoreRaw ?? candidate.fitScore;
  if (!Number.isFinite(fitScore)) {
    throw new Error(`Missing finite fit score for ${candidate.signalCandidateId}`);
  }

  return {
    candidateId: candidate.signalCandidateId,
    fitScore: fitScore as number,
    fitBreakdown: {
      experienceScore: 0,
      skillScore: 0,
      roleScore: 0,
      seniorityScore: 0,
      domainIndustryScore: 0,
      locationBoost: 0,
      educationScore: 0,
      dataConfidence: dataConfidence(candidate),
    },
    matchTier: 'strict_location',
    locationMatchType: 'city_exact',
  };
}

function topMembershipChanges(before: string[], after: string[], count: number): number {
  const afterTop = new Set(after.slice(0, count));
  return before.slice(0, count).filter((id) => !afterTop.has(id)).length;
}

function sourceCounts(ids: string[], sourceById: Map<string, string>): Record<string, number> {
  return ids.reduce<Record<string, number>>((counts, id) => {
    const source = sourceById.get(id) ?? 'unknown';
    counts[source] = (counts[source] ?? 0) + 1;
    return counts;
  }, {});
}

async function main() {
  const input = readOption('--input');
  const epsilon = Number(readOption('--epsilon') ?? '3');
  if (!input) throw new Error('--input is required');
  if (!Number.isFinite(epsilon) || epsilon < 0) throw new Error('--epsilon must be a non-negative number');

  const capture = JSON.parse(await readFile(input, 'utf8')) as Capture;
  if (!capture.candidates?.length) throw new Error('Capture contains no candidates');

  const capturedOrder = [...capture.candidates]
    .sort((a, b) => a.signalRank - b.signalRank)
    .map((candidate) => candidate.signalCandidateId);
  const sourceById = new Map(capture.candidates.map((candidate) => [
    candidate.signalCandidateId,
    candidate.sourceType ?? 'unknown',
  ]));
  const reOrdered = orderByFitScoreWithConfidence(
    capture.candidates.map(asScoredCandidate),
    epsilon,
  ).map((candidate) => candidate.candidateId);
  const capturedRankById = new Map(capturedOrder.map((id, index) => [id, index]));
  const reOrderedRankById = new Map(reOrdered.map((id, index) => [id, index]));
  const rankChanges = capturedOrder.map((id) => Math.abs(
    (capturedRankById.get(id) ?? 0) - (reOrderedRankById.get(id) ?? 0),
  ));

  console.log(JSON.stringify({
    scope: 'served_cohort_only',
    caveat: 'Captures retain the served top-100, not every eligible candidate. Top-100 membership is therefore fixed by construction; measure new eligible-to-served movement on a post-deploy live run.',
    candidates: capturedOrder.length,
    epsilon,
    top20MembershipChanges: topMembershipChanges(capturedOrder, reOrdered, 20),
    top100MembershipChanges: topMembershipChanges(capturedOrder, reOrdered, 100),
    candidatesWithRankChange: rankChanges.filter((change) => change > 0).length,
    maxRankDisplacement: Math.max(...rankChanges),
    capturedServedSources: sourceCounts(capturedOrder, sourceById),
    capturedTop20Sources: sourceCounts(capturedOrder.slice(0, 20), sourceById),
    reOrderedTop20Sources: sourceCounts(reOrdered.slice(0, 20), sourceById),
    reOrderedTop100Sources: sourceCounts(reOrdered.slice(0, 100), sourceById),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
