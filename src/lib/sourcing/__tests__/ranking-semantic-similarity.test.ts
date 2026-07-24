import { describe, expect, it } from 'vitest';
import type { CrustdataProfileResponse } from '../crustdata-client';
import type { JobRequirements } from '../jd-digest';
import { rankCandidates, type CandidateForRanking } from '../ranking-new';

const requirements = {
  title: 'Backend Engineer',
  topSkills: ['typescript'],
  roleFamily: 'backend',
  seniorityLevel: 'senior',
  location: 'Bengaluru, India',
} as JobRequirements;

const profile = {
  basic_profile: {
    headline: 'Senior Backend Engineer',
    location: { full_location: 'Bengaluru, India' },
  },
  experience: {
    employment_details: {
      current: [{
        title: 'Senior Backend Engineer',
        function_category: 'Engineering',
        seniority_level: 'Senior',
        company_industries: ['Software Development'],
      }],
      past: [],
    },
  },
} as CrustdataProfileResponse;

function candidate(id: string, similarity?: number): CandidateForRanking {
  return {
    id,
    headlineHint: 'Senior Backend Engineer',
    locationHint: 'Bengaluru, India',
    searchTitle: 'Senior Backend Engineer',
    searchSnippet: null,
    enrichmentStatus: 'completed',
    lastEnrichedAt: new Date(),
    crustdata: profile,
    semanticSimilarity: similarity,
  };
}

function adjustmentOf(scored: ReturnType<typeof rankCandidates>, id: string): number {
  const entry = scored.find((s) => s.candidateId === id);
  return entry?.fitBreakdown.semanticSimilarityAdjustment ?? 0;
}

describe('semantic similarity scoring (median-centered)', () => {
  it('keeps candidates without similarity exactly neutral', () => {
    const scored = rankCandidates(
      [candidate('with-sim', 0.7), candidate('no-sim')],
      requirements,
      { semanticSimilarityWeight: 4 },
    );

    expect(adjustmentOf(scored, 'no-sim')).toBe(0);
  });

  it('is zero-sum around the per-run median, not a fixed 0.5', () => {
    // A distribution entirely ABOVE 0.5 — the case that previously paid
    // every Memory candidate a positive adjustment while fresh candidates
    // sat at zero (systematic source advantage).
    const scored = rankCandidates(
      [candidate('low', 0.55), candidate('mid', 0.6), candidate('high', 0.65)],
      requirements,
      { semanticSimilarityWeight: 4 },
    );

    expect(adjustmentOf(scored, 'low')).toBeCloseTo(-0.4);
    expect(adjustmentOf(scored, 'mid')).toBeCloseTo(0);
    expect(adjustmentOf(scored, 'high')).toBeCloseTo(0.4);
    const sum =
      adjustmentOf(scored, 'low') + adjustmentOf(scored, 'mid') + adjustmentOf(scored, 'high');
    expect(sum).toBeCloseTo(0);
  });

  it('source-neutrality: similarity-bearing candidates gain no aggregate advantage', () => {
    // Pool candidates carry sims skewed above 0.5; fresh candidates carry none.
    // Identical profiles otherwise — mean fitScore of both groups must match.
    const pool = [candidate('p1', 0.52), candidate('p2', 0.55), candidate('p3', 0.58)];
    const fresh = [candidate('f1'), candidate('f2'), candidate('f3')];
    const scored = rankCandidates([...pool, ...fresh], requirements, {
      semanticSimilarityWeight: 4,
    });

    const mean = (ids: string[]) =>
      ids.reduce((sum, id) => sum + (scored.find((s) => s.candidateId === id)?.fitScore ?? 0), 0) /
      ids.length;

    expect(mean(['p1', 'p2', 'p3'])).toBeCloseTo(mean(['f1', 'f2', 'f3']), 5);
  });

  it('bounds the adjustment to ±weight even when the center shifts', () => {
    const scored = rankCandidates(
      [candidate('floor', 0), candidate('c1', 0.9), candidate('c2', 0.95), candidate('ceiling', 1)],
      requirements,
      { semanticSimilarityWeight: 4 },
    );

    expect(adjustmentOf(scored, 'floor')).toBe(-4);
    expect(Math.abs(adjustmentOf(scored, 'ceiling'))).toBeLessThanOrEqual(4);
  });

  it('weight 0 disables the component entirely', () => {
    const withWeight = rankCandidates(
      [candidate('a', 0.9), candidate('b', 0.4)],
      requirements,
      { semanticSimilarityWeight: 0 },
    );

    expect(adjustmentOf(withWeight, 'a')).toBe(0);
    expect(adjustmentOf(withWeight, 'b')).toBe(0);
  });
});
