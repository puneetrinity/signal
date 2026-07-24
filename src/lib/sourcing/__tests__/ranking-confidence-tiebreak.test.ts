import { describe, expect, it } from 'vitest';
import {
  orderByFitScoreWithConfidence,
  type ScoredCandidate,
} from '../ranking-new';

function scored(candidateId: string, fitScore: number, dataConfidence: number): ScoredCandidate {
  return {
    candidateId,
    fitScore,
    fitBreakdown: {
      experienceScore: 0,
      skillScore: 0,
      roleScore: 0,
      seniorityScore: 0,
      domainIndustryScore: 0,
      locationBoost: 0,
      educationScore: 0,
      dataConfidence,
    },
    matchTier: 'strict_location',
    locationMatchType: 'city_exact',
  };
}

describe('fit-score confidence tie-break', () => {
  it('lets confidence swap only a directly adjacent candidate inside epsilon', () => {
    const ordered = orderByFitScoreWithConfidence([
      scored('higher-fit', 72, 0.75),
      scored('higher-confidence', 70, 1),
      scored('outside-window', 68, 1),
    ], 3);

    expect(ordered.map((candidate) => candidate.candidateId)).toEqual([
      'higher-confidence',
      'higher-fit',
      'outside-window',
    ]);
  });

  it('never lets confidence reverse candidates separated by epsilon or more', () => {
    const epsilon = 3;
    const ordered = orderByFitScoreWithConfidence([
      scored('fresh-71.11', 71.11, 0.75),
      scored('pool-70.9', 70.9, 1),
      scored('pool-68.2', 68.2, 1),
      scored('pool-66.43', 66.43, 1),
    ], epsilon);

    const rankById = new Map(ordered.map((candidate, index) => [candidate.candidateId, index]));
    for (const candidate of ordered) {
      for (const other of ordered) {
        if (candidate.fitScore - other.fitScore >= epsilon) {
          expect(rankById.get(candidate.candidateId)).toBeLessThan(rankById.get(other.candidateId)!);
        }
      }
    }
    expect(rankById.get('fresh-71.11')).toBeLessThan(rankById.get('pool-66.43')!);
  });

  it('uses deterministic candidate-id ordering when confidence cannot break a tie', () => {
    const ordered = orderByFitScoreWithConfidence([
      scored('zeta', 70, 0.9),
      scored('alpha', 70, 0.9),
    ], 3);

    expect(ordered.map((candidate) => candidate.candidateId)).toEqual(['alpha', 'zeta']);
  });

  it('keeps stable score-only order when epsilon is disabled', () => {
    const ordered = orderByFitScoreWithConfidence([
      scored('zeta', 70, 0.9),
      scored('alpha', 70, 1),
    ], 0);

    expect(ordered.map((candidate) => candidate.candidateId)).toEqual(['zeta', 'alpha']);
  });
});
