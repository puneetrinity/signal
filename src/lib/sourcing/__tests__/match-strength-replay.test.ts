import { describe, expect, it } from "vitest";
import { evaluateMatchStrengthReplay } from "../match-strength-replay";

describe("match-strength replay", () => {
  it("changes labels only, preserving scores, order, and membership", () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      candidateId: `candidate-${index + 1}`,
      rank: index + 1,
      fitScore: 100 - index,
      skillScoreMethod: index < 25 ? "snapshot" : "text_fallback",
      sourceType: index % 2 === 0 ? "pool" : "discovered",
    }));

    const report = evaluateMatchStrengthReplay(147, candidates);

    expect(report.orderUnchanged).toBe(true);
    expect(report.fitScoresUnchanged).toBe(true);
    expect(report.top20MembershipChanges).toBe(0);
    expect(report.top100MembershipChanges).toBe(0);
    expect(report.strongWithoutVerifiedSkills).toBe(0);
    expect(report.tiedScoreBandConflicts).toBe(0);
    expect(candidates.map((candidate) => candidate.candidateId)).toEqual(
      Array.from({ length: 100 }, (_, index) => `candidate-${index + 1}`),
    );
  });
});
