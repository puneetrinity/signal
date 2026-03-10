/**
 * Shared guarded-swap helper for top-K quality enforcement.
 *
 * Used by both orchestrator (AssembledCandidate) and rerank (ScoredCandidate)
 * to enforce unknown-location cap, role guard, and skill floor in top-20.
 */

export interface GuardedSwapResult {
  demoted: number;
  noReplacementCount: number;
  epsilonBlockedCount: number;
}

/**
 * Swap violations in top-K positions with eligible replacements from below top-K.
 *
 * Violations are demoted weakest-first; replacements are promoted strongest-first.
 * A swap only happens if the replacement's fitScore is within `epsilon` of the
 * demoted candidate's fitScore (guarded swap).
 *
 * Mutates `items` in place. Returns swap diagnostics.
 */
export function guardedTopKSwap<T>(opts: {
  items: T[];
  topK: number;
  isViolation: (item: T) => boolean;
  isEligibleReplacement: (item: T) => boolean;
  cap: number;
  epsilon: number;
  getFitScore: (item: T) => number;
  /** Optional: bias replacement sort (negative = prefer a over b) after eligibility filter. */
  preferReplacement?: (a: T, b: T) => number;
}): GuardedSwapResult {
  const { items, topK, isViolation, isEligibleReplacement, cap, epsilon, getFitScore, preferReplacement } = opts;

  if (items.length <= topK) {
    return { demoted: 0, noReplacementCount: 0, epsilonBlockedCount: 0 };
  }

  // Find violations in top-K, sorted by fitScore ascending (weakest first for demotion)
  const violations = items.slice(0, topK)
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => isViolation(c))
    .sort((a, b) => getFitScore(a.c) - getFitScore(b.c));

  if (violations.length <= cap) {
    return { demoted: 0, noReplacementCount: 0, epsilonBlockedCount: 0 };
  }

  // Find eligible replacements below top-K, sorted strongest-first
  const replacements = items.slice(topK)
    .map((c, i) => ({ c, i: i + topK }))
    .filter(({ c }) => isEligibleReplacement(c))
    .sort((a, b) => {
      if (preferReplacement) {
        const pref = preferReplacement(a.c, b.c);
        if (pref !== 0) return pref;
      }
      return getFitScore(b.c) - getFitScore(a.c);
    });

  const excess = violations.slice(0, violations.length - cap);
  let ri = 0;
  let demoted = 0;
  let noReplacementCount = 0;
  let epsilonBlockedCount = 0;

  for (const demoteItem of excess) {
    if (ri >= replacements.length) {
      noReplacementCount++;
      continue;
    }
    const replacement = replacements[ri];
    if (getFitScore(replacement.c) < getFitScore(demoteItem.c) - epsilon) {
      // Remaining replacements are weaker → all subsequent violations also blocked
      epsilonBlockedCount += (excess.length - demoted - noReplacementCount - epsilonBlockedCount);
      break;
    }
    [items[demoteItem.i], items[replacement.i]] = [items[replacement.i], items[demoteItem.i]];
    demoted++;
    ri++;
  }

  return { demoted, noReplacementCount, epsilonBlockedCount };
}
