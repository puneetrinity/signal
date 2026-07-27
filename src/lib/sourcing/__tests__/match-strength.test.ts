import { describe, expect, it } from "vitest";
import {
  classifyMatchStrength,
  computeMatchStrengthBands,
  type MatchStrength,
} from "../match-strength";

describe("match-strength percentile bands", () => {
  it("uses the run p80 and p50 rather than absolute score thresholds", () => {
    const bands = computeMatchStrengthBands([60, 61, 62, 63, 64, 65]);

    expect(bands).toEqual({
      sampleSize: 6,
      p50: 62.5,
      p80: 64,
      goodFloor: 60,
      effectiveGoodThreshold: 62.5,
      effectiveStrongThreshold: 64,
    });
    expect(classifyMatchStrength(65, "snapshot", bands)).toBe("strong");
    expect(classifyMatchStrength(63, "snapshot", bands)).toBe("good");
    expect(classifyMatchStrength(62, "snapshot", bands)).toBe("possible");
  });

  it("handles skew without splitting equal scores across percentile bands", () => {
    const scores = [10, 10, 10, 10, 10, 20, 30, 40, 50, 100];
    const bands = computeMatchStrengthBands(scores);
    const labelsByScore = new Map<number, Set<MatchStrength>>();

    for (const score of scores) {
      const labels = labelsByScore.get(score) ?? new Set<MatchStrength>();
      labels.add(classifyMatchStrength(score, "snapshot", bands));
      labelsByScore.set(score, labels);
    }

    expect(bands.p50).toBe(15);
    expect(bands.p80).toBeCloseTo(42);
    expect(bands.effectiveGoodThreshold).toBe(60);
    expect(bands.effectiveStrongThreshold).toBe(60);
    expect(
      [...labelsByScore.values()].every((labels) => labels.size === 1),
    ).toBe(true);
  });

  it("keeps a tie that crosses a nominal percentile boundary in one band", () => {
    const bands = computeMatchStrengthBands([
      50, 55, 60, 65, 65, 65, 65, 70, 75, 80,
    ]);

    expect(classifyMatchStrength(65, "snapshot", bands)).toBe("good");
    expect(
      [65, 65, 65, 65].map((score) =>
        classifyMatchStrength(score, "snapshot", bands),
      ),
    ).toEqual(["good", "good", "good", "good"]);
  });

  it("keeps collapsed cohorts good only when they clear the honesty floor", () => {
    const allEqual = computeMatchStrengthBands([70, 70, 70]);
    const singleton = computeMatchStrengthBands([70]);
    const weakSingleton = computeMatchStrengthBands([42]);

    expect(allEqual).toEqual({
      sampleSize: 3,
      p50: 70,
      p80: 70,
      goodFloor: 60,
      effectiveGoodThreshold: 70,
      effectiveStrongThreshold: 70,
    });
    expect(classifyMatchStrength(70, "snapshot", allEqual)).toBe("good");
    expect(classifyMatchStrength(70, "text_fallback", allEqual)).toBe("good");
    expect(classifyMatchStrength(70, "snapshot", singleton)).toBe("good");
    expect(classifyMatchStrength(70, null, singleton)).toBe("good");
    expect(classifyMatchStrength(42, "snapshot", weakSingleton)).toBe(
      "possible",
    );
  });

  it("excludes missing and non-finite scores from calibration", () => {
    const bands = computeMatchStrengthBands([
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      20,
      80,
    ]);

    expect(bands).toEqual({
      sampleSize: 2,
      p50: 50,
      p80: 68,
      goodFloor: 60,
      effectiveGoodThreshold: 60,
      effectiveStrongThreshold: 68,
    });
    expect(classifyMatchStrength(null, "snapshot", bands)).toBe("possible");
    expect(classifyMatchStrength(Number.NaN, "snapshot", bands)).toBe(
      "possible",
    );
  });

  it("fails closed to possible for an empty finite-score distribution", () => {
    const bands = computeMatchStrengthBands([null, Number.NaN]);

    expect(bands).toEqual({
      sampleSize: 0,
      p50: null,
      p80: null,
      goodFloor: 60,
      effectiveGoodThreshold: null,
      effectiveStrongThreshold: null,
    });
    expect(classifyMatchStrength(100, "snapshot", bands)).toBe("possible");
  });

  it("never assigns strong without verified snapshot skills", () => {
    const bands = computeMatchStrengthBands([60, 70, 80, 90, 100]);

    expect(classifyMatchStrength(100, "snapshot", bands)).toBe("strong");
    expect(classifyMatchStrength(100, "text_fallback", bands)).toBe("good");
    expect(classifyMatchStrength(100, null, bands)).toBe("good");
  });

  it("keeps an entirely weak run possible despite relative percentiles", () => {
    const scores = [50.45, 50.8, 51.2, 52.1, 52.7];
    const bands = computeMatchStrengthBands(scores);

    expect(bands.effectiveGoodThreshold).toBe(60);
    expect(
      scores.map((score) => classifyMatchStrength(score, "snapshot", bands)),
    ).toEqual(["possible", "possible", "possible", "possible", "possible"]);
  });

  it("keeps labels independent of the response limit when bands use the full run", () => {
    const run = Array.from({ length: 100 }, (_, index) => ({
      id: `candidate-${index + 1}`,
      fitScore: index + 1,
      skillScoreMethod: "snapshot",
    }));
    const bands = computeMatchStrengthBands(
      run.map((candidate) => candidate.fitScore),
    );
    const labelsAtLimit = (limit: number) =>
      new Map(
        run
          .slice(0, limit)
          .map((candidate) => [
            candidate.id,
            classifyMatchStrength(
              candidate.fitScore,
              candidate.skillScoreMethod,
              bands,
            ),
          ]),
      );

    const limit20 = labelsAtLimit(20);
    const limit100 = labelsAtLimit(100);
    for (const [id, label] of limit20) {
      expect(limit100.get(id)).toBe(label);
    }
    expect(run.map((candidate) => candidate.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `candidate-${index + 1}`),
    );
  });
});
