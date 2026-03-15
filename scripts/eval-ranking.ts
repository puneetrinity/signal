#!/usr/bin/env npx tsx
/**
 * Ranking Evaluator — Phase A (Scoring Optimization)
 *
 * Measures shortlist quality: does rankCandidates() put the right
 * candidates on top for a given job + candidate pool?
 *
 * Gold labels use bucket semantics, not exact ranks:
 *   must_be_top (4), good (3), acceptable (2),
 *   should_be_below (1), should_not_surface (0)
 *
 * Metrics: precision@5, precision@10, nDCG@10, top1_correct,
 *          bad_top10_rate, must_be_top_recall@5, must_be_top_recall@10
 *
 * Usage:
 *   npx tsx scripts/eval-ranking.ts
 *   npx tsx scripts/eval-ranking.ts --verbose
 *   npx tsx scripts/eval-ranking.ts --file research/datasets/ranking-tech-core.jsonl
 *
 * Also exports run(config) for use with research-runner.ts
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  rankCandidates,
  compareFitWithConfidence,
  type CandidateForRanking,
  type ScoredCandidate,
} from '../src/lib/sourcing/ranking';
import type { JobRequirements } from '../src/lib/sourcing/jd-digest';
import type { JobTrack } from '../src/lib/sourcing/types';
import { getLocationBoostWeight, getSourcingConfig } from '../src/lib/sourcing/config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GoldBucket = 'must_be_top' | 'good' | 'acceptable' | 'should_be_below' | 'should_not_surface';

const BUCKET_GRADE: Record<GoldBucket, number> = {
  must_be_top: 4,
  good: 3,
  acceptable: 2,
  should_be_below: 1,
  should_not_surface: 0,
};

interface RankingFixture {
  id: string;
  track: 'tech' | 'non_tech';
  note?: string;
  job: {
    title: string;
    topSkills: string[];
    domain: string | null;
    roleFamily: string | null;
    seniorityLevel: string | null;
    location: string | null;
  };
  candidates: FixtureCandidate[];
  gold: Record<string, GoldBucket>;
}

interface FixtureCandidate {
  id: string;
  headlineHint: string | null;
  seniorityHint?: string | null;
  locationHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
  enrichmentStatus: string;
  lastEnrichedAt: string;
  snapshot: {
    skillsNormalized: string[];
    roleType: string | null;
    seniorityBand: string | null;
    location: string | null;
    activityRecencyDays: number | null;
    computedAt: string;
    staleAfter: string;
  } | null;
}

interface RankingEvalConfig {
  fixturePath?: string;
  // Weight overrides per track (base weights, must sum to 1.0)
  techSkillWeight?: number;
  techRoleWeight?: number;
  techSeniorityWeight?: number;
  techFreshnessWeight?: number;
  nontechSkillWeight?: number;
  nontechRoleWeight?: number;
  nontechSeniorityWeight?: number;
  nontechFreshnessWeight?: number;
  // Location boost overrides
  locationBoostTech?: number;
  locationBoostNontech?: number;
  // Scoring parameters
  fitScoreEpsilon?: number;
}

interface EvalResult {
  objective: number;
  metrics: Record<string, number>;
  artifacts?: Record<string, unknown>;
}

interface FixtureResult {
  fixtureId: string;
  precision_at_5: number;
  precision_at_10: number;
  ndcg_at_10: number;
  top1_correct: number;
  bad_top10_rate: number;
  must_be_top_recall_at_5: number;
  must_be_top_recall_at_10: number;
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

function loadFixtures(path: string): RankingFixture[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function fixtureCandidateToRanking(fc: FixtureCandidate): CandidateForRanking {
  return {
    id: fc.id,
    headlineHint: fc.headlineHint,
    seniorityHint: fc.seniorityHint,
    locationHint: fc.locationHint,
    searchTitle: fc.searchTitle,
    searchSnippet: fc.searchSnippet,
    enrichmentStatus: fc.enrichmentStatus,
    lastEnrichedAt: fc.lastEnrichedAt ? new Date(fc.lastEnrichedAt) : null,
    snapshot: fc.snapshot ? {
      skillsNormalized: fc.snapshot.skillsNormalized,
      roleType: fc.snapshot.roleType,
      seniorityBand: fc.snapshot.seniorityBand,
      location: fc.snapshot.location,
      activityRecencyDays: fc.snapshot.activityRecencyDays,
      computedAt: new Date(fc.snapshot.computedAt),
      staleAfter: new Date(fc.snapshot.staleAfter),
    } : null,
  };
}

// ---------------------------------------------------------------------------
// Weight override & re-ranking
// ---------------------------------------------------------------------------

interface WeightVector {
  skill: number;
  role: number;
  seniority: number;
  freshness: number;
  location: number;
}

function getDefaultWeights(track: 'tech' | 'non_tech'): { base: { skill: number; role: number; seniority: number; freshness: number }; locationBoost: number } {
  // Keep base weights aligned with TRACK_WEIGHTS in src/lib/sourcing/ranking.ts.
  // Location defaults come from runtime config so evaluator stays in sync there.
  const config = getSourcingConfig();
  const runtimeTrack: JobTrack = track === 'tech' ? 'tech' : 'non_tech';
  if (track === 'tech') {
    return {
      base: { skill: 0.45, role: 0.15, seniority: 0.25, freshness: 0.15 },
      locationBoost: getLocationBoostWeight(config, runtimeTrack),
    };
  }
  return {
    base: { skill: 0.25, role: 0.30, seniority: 0.30, freshness: 0.15 },
    locationBoost: getLocationBoostWeight(config, runtimeTrack),
  };
}

function resolveWeights(track: 'tech' | 'non_tech', config: RankingEvalConfig): WeightVector {
  const defaults = getDefaultWeights(track);

  const isTech = track === 'tech';
  const skill = (isTech ? config.techSkillWeight : config.nontechSkillWeight) ?? defaults.base.skill;
  const role = (isTech ? config.techRoleWeight : config.nontechRoleWeight) ?? defaults.base.role;
  const seniority = (isTech ? config.techSeniorityWeight : config.nontechSeniorityWeight) ?? defaults.base.seniority;
  const freshness = (isTech ? config.techFreshnessWeight : config.nontechFreshnessWeight) ?? defaults.base.freshness;
  const locationBoost = (isTech ? config.locationBoostTech : config.locationBoostNontech) ?? defaults.locationBoost;

  const baseSum = skill + role + seniority + freshness;
  // Base weights must sum to 1.0 (tolerance 0.01)
  if (Math.abs(baseSum - 1.0) > 0.01) {
    return { skill: -1, role: -1, seniority: -1, freshness: -1, location: -1 }; // sentinel: invalid
  }

  const remaining = 1.0 - locationBoost;
  return {
    skill: skill * remaining,
    role: role * remaining,
    seniority: seniority * remaining,
    freshness: freshness * remaining,
    location: locationBoost,
  };
}

function hasWeightOverrides(config: RankingEvalConfig): boolean {
  return config.techSkillWeight !== undefined ||
    config.techRoleWeight !== undefined ||
    config.techSeniorityWeight !== undefined ||
    config.techFreshnessWeight !== undefined ||
    config.nontechSkillWeight !== undefined ||
    config.nontechRoleWeight !== undefined ||
    config.nontechSeniorityWeight !== undefined ||
    config.nontechFreshnessWeight !== undefined ||
    config.locationBoostTech !== undefined ||
    config.locationBoostNontech !== undefined;
}

/**
 * Recompute fitScore from FitBreakdown using custom weights.
 * Uses effectiveSeniorityScore (damped) when available, matching runtime.
 */
function recomputeFitScore(scored: ScoredCandidate, weights: WeightVector): number {
  const b = scored.fitBreakdown;
  const seniority = b.effectiveSeniorityScore ?? b.seniorityScore;
  return (
    weights.skill * b.skillScore +
    weights.role * b.roleScore +
    weights.seniority * seniority +
    weights.freshness * b.activityFreshnessScore +
    weights.location * b.locationBoost
  );
}

/**
 * Re-sort using same comparator semantics as runtime compareFitWithConfidence.
 */
function resortCandidates(scored: ScoredCandidate[], epsilon: number): ScoredCandidate[] {
  return [...scored].sort((a, b) => compareFitWithConfidence(a, b, epsilon));
}

// ---------------------------------------------------------------------------
// Metric computation
// ---------------------------------------------------------------------------

function computeNdcg(rankedIds: string[], gold: Record<string, GoldBucket>, k: number): number {
  const topK = rankedIds.slice(0, k);

  // DCG
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const bucket = gold[topK[i]];
    if (!bucket) continue;
    const grade = BUCKET_GRADE[bucket];
    dcg += (Math.pow(2, grade) - 1) / Math.log2(i + 2); // i+2 because log2(1+1)
  }

  // Ideal DCG: sort all candidates by grade descending
  const allGrades = Object.values(gold)
    .map(b => BUCKET_GRADE[b])
    .sort((a, b) => b - a)
    .slice(0, k);

  let idcg = 0;
  for (let i = 0; i < allGrades.length; i++) {
    idcg += (Math.pow(2, allGrades[i]) - 1) / Math.log2(i + 2);
  }

  return idcg === 0 ? 1.0 : dcg / idcg;
}

function computeFixtureMetrics(rankedIds: string[], gold: Record<string, GoldBucket>): FixtureResult {
  const top5 = rankedIds.slice(0, 5);
  const top10 = rankedIds.slice(0, 10);

  // precision@5: must_be_top or good
  const p5Good = top5.filter(id => {
    const b = gold[id];
    return b === 'must_be_top' || b === 'good';
  }).length;

  // precision@10: must_be_top, good, or acceptable
  const p10Good = top10.filter(id => {
    const b = gold[id];
    return b === 'must_be_top' || b === 'good' || b === 'acceptable';
  }).length;

  // bad_top10_rate: should_be_below or should_not_surface in top 10
  const badTop10 = top10.filter(id => {
    const b = gold[id];
    return b === 'should_be_below' || b === 'should_not_surface';
  }).length;

  // top-1 correct
  const top1Bucket = gold[rankedIds[0]];
  const top1Correct = top1Bucket === 'must_be_top' ? 1 : 0;

  // must_be_top recall
  const mustBeTopIds = Object.entries(gold)
    .filter(([, b]) => b === 'must_be_top')
    .map(([id]) => id);
  const mustBeTopInTop5 = mustBeTopIds.filter(id => top5.includes(id)).length;
  const mustBeTopInTop10 = mustBeTopIds.filter(id => top10.includes(id)).length;

  return {
    fixtureId: '',
    precision_at_5: top5.length > 0 ? p5Good / top5.length : 0,
    precision_at_10: top10.length > 0 ? p10Good / top10.length : 0,
    ndcg_at_10: computeNdcg(rankedIds, gold, 10),
    top1_correct: top1Correct,
    bad_top10_rate: top10.length > 0 ? badTop10 / top10.length : 0,
    must_be_top_recall_at_5: mustBeTopIds.length > 0 ? mustBeTopInTop5 / mustBeTopIds.length : 1,
    must_be_top_recall_at_10: mustBeTopIds.length > 0 ? mustBeTopInTop10 / mustBeTopIds.length : 1,
  };
}

// ---------------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------------

function evaluateFixture(
  fixture: RankingFixture,
  config: RankingEvalConfig,
  verbose: boolean,
): FixtureResult | null {
  const candidates = fixture.candidates.map(fixtureCandidateToRanking);
  const requirements: JobRequirements = {
    title: fixture.job.title,
    topSkills: fixture.job.topSkills,
    domain: fixture.job.domain,
    roleFamily: fixture.job.roleFamily,
    seniorityLevel: fixture.job.seniorityLevel,
    location: fixture.job.location,
    experienceYears: null,
    education: null,
  };

  const track: JobTrack = fixture.track === 'non_tech' ? 'non_tech' : 'tech';
  const defaults = getDefaultWeights(fixture.track);
  const locationBoostForRanking = (track === 'tech' ? config.locationBoostTech : config.locationBoostNontech) ?? defaults.locationBoost;
  const epsilon = config.fitScoreEpsilon ?? 0.03;

  // Get component scores from rankCandidates
  let scored = rankCandidates(candidates, requirements, {
    track,
    locationBoostWeight: locationBoostForRanking,
    fitScoreEpsilon: epsilon,
  });

  // If weight overrides exist, recompute fitScore and re-sort
  if (hasWeightOverrides(config)) {
    const weights = resolveWeights(fixture.track, config);
    if (weights.skill < 0) {
      // Invalid weight combo (doesn't sum to 1.0)
      if (verbose) console.log(`  SKIP ${fixture.id}: base weights don't sum to 1.0`);
      return null;
    }
    scored = scored.map(s => ({
      ...s,
      fitScore: recomputeFitScore(s, weights),
    }));
    scored = resortCandidates(scored, epsilon);
  }

  const rankedIds = scored.map(s => s.candidateId);
  const result = computeFixtureMetrics(rankedIds, fixture.gold);
  result.fixtureId = fixture.id;

  if (verbose) {
    console.log(`\n  ${fixture.id}: ${fixture.note ?? ''}`);
    console.log(`    nDCG@10=${result.ndcg_at_10.toFixed(3)} p@5=${result.precision_at_5.toFixed(3)} p@10=${result.precision_at_10.toFixed(3)} bad_top10=${result.bad_top10_rate.toFixed(3)} top1=${result.top1_correct}`);
    console.log(`    Ranking:`);
    for (let i = 0; i < scored.length; i++) {
      const s = scored[i];
      const bucket = fixture.gold[s.candidateId] ?? '???';
      const grade = BUCKET_GRADE[bucket as GoldBucket] ?? '?';
      console.log(`      ${String(i + 1).padStart(2)}. ${s.candidateId.padEnd(25)} fit=${s.fitScore.toFixed(3)} bucket=${bucket}(${grade}) skill=${s.fitBreakdown.skillScore.toFixed(2)} role=${s.fitBreakdown.roleScore.toFixed(2)} sen=${(s.fitBreakdown.effectiveSeniorityScore ?? s.fitBreakdown.seniorityScore).toFixed(2)} fresh=${s.fitBreakdown.activityFreshnessScore.toFixed(2)} loc=${s.fitBreakdown.locationBoost.toFixed(2)}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregate(results: FixtureResult[]): Record<string, number> {
  const n = results.length;
  if (n === 0) return {};

  const sum = (key: keyof FixtureResult) =>
    results.reduce((acc, r) => acc + (r[key] as number), 0) / n;

  return {
    precision_at_5: sum('precision_at_5'),
    precision_at_10: sum('precision_at_10'),
    ndcg_at_10: sum('ndcg_at_10'),
    top1_correct: sum('top1_correct'),
    bad_top10_rate: sum('bad_top10_rate'),
    must_be_top_recall_at_5: sum('must_be_top_recall_at_5'),
    must_be_top_recall_at_10: sum('must_be_top_recall_at_10'),
    fixture_count: n,
  };
}

// ---------------------------------------------------------------------------
// Exported run() for research-runner.ts
// ---------------------------------------------------------------------------

export async function run(config: Record<string, unknown>): Promise<EvalResult> {
  const evalConfig = config as unknown as RankingEvalConfig;
  const files = evalConfig.fixturePath
    ? [evalConfig.fixturePath]
    : [
        'research/datasets/ranking-tech-core.jsonl',
        'research/datasets/ranking-nontech-core.jsonl',
      ];

  const allResults: FixtureResult[] = [];
  for (const filepath of files) {
    const fixtures = loadFixtures(filepath);
    for (const fx of fixtures) {
      const result = evaluateFixture(fx, evalConfig, false);
      if (result) allResults.push(result);
    }
  }

  const metrics = aggregate(allResults);
  return {
    objective: metrics.ndcg_at_10 ?? 0,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): { verbose: boolean; file: string | null } {
  const args = process.argv.slice(2);
  let verbose = false;
  let file: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verbose') verbose = true;
    else if (args[i] === '--file' && args[i + 1]) file = args[++i];
  }
  return { verbose, file };
}

function main() {
  const { verbose, file } = parseArgs();
  const files = file
    ? [file]
    : [
        'research/datasets/ranking-tech-core.jsonl',
        'research/datasets/ranking-nontech-core.jsonl',
      ];

  const allResults: FixtureResult[] = [];

  for (const filepath of files) {
    const fixtures = loadFixtures(filepath);
    console.log(`\n=== ${filepath} (${fixtures.length} fixtures) ===`);

    for (const fx of fixtures) {
      const result = evaluateFixture(fx, {}, verbose);
      if (result) {
        allResults.push(result);
        if (!verbose) {
          const icon = result.bad_top10_rate === 0 ? 'OK' : 'WARN';
          console.log(`  ${icon.padEnd(4)} ${fx.id} nDCG@10=${result.ndcg_at_10.toFixed(3)} p@5=${result.precision_at_5.toFixed(3)} bad_top10=${result.bad_top10_rate.toFixed(3)}`);
        }
      }
    }
  }

  const metrics = aggregate(allResults);

  console.log('\n--- Aggregate Results ---');
  console.log(`  Fixtures evaluated:        ${metrics.fixture_count}`);
  console.log(`  nDCG@10 (avg):             ${metrics.ndcg_at_10?.toFixed(4)}`);
  console.log(`  Precision@5 (avg):         ${metrics.precision_at_5?.toFixed(4)}`);
  console.log(`  Precision@10 (avg):        ${metrics.precision_at_10?.toFixed(4)}`);
  console.log(`  Top-1 correct (avg):       ${metrics.top1_correct?.toFixed(4)}`);
  console.log(`  Bad top-10 rate (avg):     ${metrics.bad_top10_rate?.toFixed(4)}`);
  console.log(`  must_be_top recall@5:      ${metrics.must_be_top_recall_at_5?.toFixed(4)}`);
  console.log(`  must_be_top recall@10:     ${metrics.must_be_top_recall_at_10?.toFixed(4)}`);

  // Per-fixture breakdown
  console.log('\n--- Per-Fixture Breakdown ---');
  for (const r of allResults) {
    console.log(`  ${r.fixtureId.padEnd(20)} nDCG=${r.ndcg_at_10.toFixed(3)} p@5=${r.precision_at_5.toFixed(3)} p@10=${r.precision_at_10.toFixed(3)} bad=${r.bad_top10_rate.toFixed(3)} top1=${r.top1_correct}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
