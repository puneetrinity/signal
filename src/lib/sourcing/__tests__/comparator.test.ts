/**
 * Unit tests for compareFitWithConfidence epsilon tie-breaker.
 *
 * Run with: npx tsx src/lib/sourcing/__tests__/comparator.test.ts
 */

import { compareFitWithConfidence, type ScoredCandidate } from '../ranking';

let passed = 0;
let failed = 0;

function makeCandidate(
  candidateId: string,
  fitScore: number,
  method: 'snapshot' | 'text_fallback',
): ScoredCandidate {
  return {
    candidateId,
    fitScore,
    fitBreakdown: {
      skillScore: fitScore,
      skillScoreMethod: method,
      roleScore: 0.5,
      seniorityScore: 0.5,
      activityFreshnessScore: 0.5,
      locationBoost: 0.5,
    },
    matchTier: 'strict_location',
    locationMatchType: 'city_exact',
  };
}

function assert(label: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

console.log('compareFitWithConfidence tests\n');

// Test 1: fitScore delta exceeds epsilon — fitScore wins regardless of confidence
{
  const a = makeCandidate('a', 0.62, 'snapshot');
  const b = makeCandidate('b', 0.70, 'text_fallback');
  const result = compareFitWithConfidence(a, b, 0.03);
  assert('delta > epsilon: higher fitScore wins (0.70 text_fallback > 0.62 snapshot)', result > 0);
}

// Test 2: within epsilon, confidence breaks tie — snapshot wins over text_fallback
{
  const a = makeCandidate('a', 0.64, 'text_fallback');
  const b = makeCandidate('b', 0.62, 'snapshot');
  const result = compareFitWithConfidence(a, b, 0.03);
  assert('within epsilon: snapshot (0.62) ranks before text_fallback (0.64)', result > 0);
}

// Test 3: epsilon 0 uses pure fitScore (no confidence tie-breaking)
{
  const a = makeCandidate('a', 0.64, 'text_fallback');
  const b = makeCandidate('b', 0.62, 'snapshot');
  // With epsilon 0, compareFitWithConfidence should NOT be called by rankCandidates,
  // but if called directly, delta 0.02 >= epsilon 0, so fitScore wins.
  const result = compareFitWithConfidence(a, b, 0);
  assert('epsilon 0: higher fitScore wins (0.64 text_fallback > 0.62 snapshot)', result < 0);
}

// Test 4: exact tie determinism — same fitScore, same method, stable candidateId ordering
{
  const a = makeCandidate('candidate-aaa', 0.55, 'snapshot');
  const b = makeCandidate('candidate-zzz', 0.55, 'snapshot');
  const result1 = compareFitWithConfidence(a, b, 0.03);
  const result2 = compareFitWithConfidence(b, a, 0.03);
  assert('exact tie: candidateId ordering is deterministic (aaa < zzz)', result1 < 0);
  assert('exact tie: reversed inputs produce opposite sign', result2 > 0);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
