import {
  classifyMatchStrength,
  computeMatchStrengthBands,
  type MatchStrength,
} from "./match-strength";

export interface MatchStrengthReplayCandidate {
  candidateId: string;
  rank: number;
  fitScore: number | null;
  skillScoreMethod: unknown;
  sourceType?: string;
}

function fixedThresholdLabel(
  fitScore: number | null,
  skillScoreMethod: unknown,
): MatchStrength {
  if (fitScore === null || !Number.isFinite(fitScore)) return "possible";
  if (fitScore >= 80 && skillScoreMethod === "snapshot") return "strong";
  if (fitScore >= 60) return "good";
  return "possible";
}

function labelCounts(labels: MatchStrength[]): Record<MatchStrength, number> {
  return labels.reduce<Record<MatchStrength, number>>(
    (counts, label) => {
      counts[label] += 1;
      return counts;
    },
    { strong: 0, good: 0, possible: 0 },
  );
}

function membershipChanges(
  before: string[],
  after: string[],
  limit: number,
): number {
  const afterIds = new Set(after.slice(0, limit));
  return before.slice(0, limit).filter((id) => !afterIds.has(id)).length;
}

/**
 * Read-only evaluation of label recalibration. The candidate objects are
 * copied and annotated without sorting or filtering so the report can assert
 * that labeling leaves ranking and membership untouched.
 */
export function evaluateMatchStrengthReplay(
  jobId: string | number,
  candidates: readonly MatchStrengthReplayCandidate[],
) {
  const bands = computeMatchStrengthBands(
    candidates.map((candidate) => candidate.fitScore),
  );
  const beforeIds = candidates.map((candidate) => candidate.candidateId);
  const beforeScores = candidates.map((candidate) => candidate.fitScore);
  const labeled = candidates.map((candidate) => ({
    ...candidate,
    matchStrength: classifyMatchStrength(
      candidate.fitScore,
      candidate.skillScoreMethod,
      bands,
    ),
  }));
  const afterIds = labeled.map((candidate) => candidate.candidateId);
  const afterScores = labeled.map((candidate) => candidate.fitScore);
  const percentileLabels = labeled.map((candidate) => candidate.matchStrength);
  const fixedLabels = candidates.map((candidate) =>
    fixedThresholdLabel(candidate.fitScore, candidate.skillScoreMethod),
  );

  const labelsByTiedScoreAndVerification = new Map<
    string,
    Set<MatchStrength>
  >();
  for (const candidate of labeled) {
    if (candidate.fitScore === null || !Number.isFinite(candidate.fitScore))
      continue;
    const verification =
      candidate.skillScoreMethod === "snapshot" ? "snapshot" : "unverified";
    const tieKey = `${candidate.fitScore}|${verification}`;
    const labels =
      labelsByTiedScoreAndVerification.get(tieKey) ?? new Set<MatchStrength>();
    labels.add(candidate.matchStrength);
    labelsByTiedScoreAndVerification.set(tieKey, labels);
  }

  return {
    jobId,
    candidates: candidates.length,
    bands,
    fixedThresholdLabels: labelCounts(fixedLabels),
    percentileLabels: labelCounts(percentileLabels),
    verifiedSnapshotCandidates: candidates.filter(
      (candidate) => candidate.skillScoreMethod === "snapshot",
    ).length,
    strongWithoutVerifiedSkills: labeled.filter(
      (candidate) =>
        candidate.matchStrength === "strong" &&
        candidate.skillScoreMethod !== "snapshot",
    ).length,
    tiedScoreBandConflicts: [
      ...labelsByTiedScoreAndVerification.values(),
    ].filter((labels) => labels.size > 1).length,
    orderUnchanged: beforeIds.every((id, index) => afterIds[index] === id),
    fitScoresUnchanged: beforeScores.every(
      (score, index) => afterScores[index] === score,
    ),
    top20MembershipChanges: membershipChanges(beforeIds, afterIds, 20),
    top100MembershipChanges: membershipChanges(beforeIds, afterIds, 100),
  };
}
