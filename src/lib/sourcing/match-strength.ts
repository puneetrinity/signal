export type MatchStrength = "strong" | "good" | "possible";

export interface MatchStrengthBands {
  sampleSize: number;
  p50: number | null;
  p80: number | null;
  goodFloor: number;
  effectiveGoodThreshold: number | null;
  effectiveStrongThreshold: number | null;
}

const GOOD_PERCENTILE = 0.5;
const STRONG_PERCENTILE = 0.8;
export const MATCH_STRENGTH_GOOD_FLOOR = 60;

function percentile(sortedScores: number[], fraction: number): number {
  const position = (sortedScores.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedScores[lowerIndex]!;
  const upper = sortedScores[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

/**
 * Calibrate display-only match-strength bands from every finite fit score in
 * one persisted sourcing run. Linear interpolation keeps the cutoff stable
 * between adjacent scores, while score comparisons keep ties in one band. The
 * 60-point floor prevents a uniformly weak run from manufacturing "good".
 */
export function computeMatchStrengthBands(
  fitScores: readonly unknown[],
): MatchStrengthBands {
  const sortedScores = fitScores
    .filter(
      (score): score is number =>
        typeof score === "number" && Number.isFinite(score),
    )
    .sort((a, b) => a - b);

  if (sortedScores.length === 0) {
    return {
      sampleSize: 0,
      p50: null,
      p80: null,
      goodFloor: MATCH_STRENGTH_GOOD_FLOOR,
      effectiveGoodThreshold: null,
      effectiveStrongThreshold: null,
    };
  }

  const p50 = percentile(sortedScores, GOOD_PERCENTILE);
  const p80 = percentile(sortedScores, STRONG_PERCENTILE);
  return {
    sampleSize: sortedScores.length,
    p50,
    p80,
    goodFloor: MATCH_STRENGTH_GOOD_FLOOR,
    effectiveGoodThreshold: Math.max(p50, MATCH_STRENGTH_GOOD_FLOOR),
    effectiveStrongThreshold: Math.max(p80, MATCH_STRENGTH_GOOD_FLOOR),
  };
}

export function classifyMatchStrength(
  fitScore: unknown,
  skillScoreMethod: unknown,
  bands: MatchStrengthBands,
): MatchStrength {
  if (
    typeof fitScore !== "number" ||
    !Number.isFinite(fitScore) ||
    bands.p50 === null ||
    bands.p80 === null ||
    bands.effectiveGoodThreshold === null ||
    bands.effectiveStrongThreshold === null
  ) {
    return "possible";
  }

  // A collapsed distribution has no meaningful top band. Keep finite scores
  // "good" instead of calling an all-equal run (or singleton) "strong".
  if (
    bands.p80 > bands.p50 &&
    fitScore >= bands.effectiveStrongThreshold &&
    skillScoreMethod === "snapshot"
  ) {
    return "strong";
  }
  if (fitScore >= bands.effectiveGoodThreshold) return "good";
  return "possible";
}
