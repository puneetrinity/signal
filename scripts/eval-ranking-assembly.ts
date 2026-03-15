#!/usr/bin/env npx tsx
/**
 * Assembly Evaluator — Phase B (Guard/Policy Optimization)
 *
 * Measures shortlist cleanliness after assembly policy is applied on top
 * of rankCandidates() output. Simulates the post-score pipeline:
 *
 *   1. rankCandidates()
 *   2. Unknown-location penalty (tech/blended only)
 *   3. Split strict / expanded
 *   4. Strict demotion (fit floor + tech skill floor)
 *   5. Strict rescue (if all strict demoted)
 *   6. Assemble: strict-first, then expanded
 *   7. Top-20 guards (unknown cap → role → skill → unknown re-assert)
 *   8. Evaluate
 *
 * Reference logic:
 *   orchestrator.ts:471  (unknown penalty)
 *   orchestrator.ts:1031 (strict/expanded split)
 *   orchestrator.ts:1045 (strict demotion)
 *   orchestrator.ts:1067 (strict rescue)
 *   orchestrator.ts:1341 (top-20 guards)
 *   rerank.ts:248        (unknown penalty in rerank)
 *   rerank.ts:265        (strict demotion in rerank)
 *   rerank.ts:286        (top-20 guards in rerank)
 *   top20-guards.ts:23   (guardedTopKSwap)
 *
 * Usage:
 *   npx tsx scripts/eval-ranking-assembly.ts
 *   npx tsx scripts/eval-ranking-assembly.ts --verbose
 *   npx tsx scripts/eval-ranking-assembly.ts --file research/datasets/ranking-assembly-tech.jsonl
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
import { guardedTopKSwap } from '../src/lib/sourcing/top20-guards';
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

interface AssemblyEvalConfig {
  fixturePath?: string;
  // Assembly thresholds (from config.ts)
  bestMatchesMinFitScore?: number;            // default 0.45
  strictRescueMinFitScore?: number;           // default 0.30
  strictRescueCount?: number;                 // default 5
  unknownLocationPenaltyMultiplier?: number;  // default 0.85
  // Top-20 guards
  techTop20GuardsEnabled?: boolean;           // default true
  techTop20RoleMin?: number;                  // default 0.35
  techTop20RoleCap?: number;                  // default 1
  techTop20SkillMin?: number;                 // default 0.10
  // Scoring
  fitScoreEpsilon?: number;                   // default 0.03
}

interface EvalResult {
  objective: number;
  metrics: Record<string, number>;
  artifacts?: Record<string, unknown>;
}

interface FixtureResult {
  fixtureId: string;
  // Quality metrics
  precision_at_5: number;
  precision_at_10: number;
  ndcg_at_10: number;
  top1_correct: number;
  bad_top10_rate: number;
  bad_top20_rate: number;
  must_be_top_recall_at_5: number;
  must_be_top_recall_at_10: number;
  // Assembly-specific metrics
  strict_pool_purity: number;
  top20_low_role_count: number;
  top20_low_skill_count: number;
  unknown_location_top20_rate: number;
  // Assembly diagnostics
  strict_demoted: number;
  strict_rescued: number;
  unknown_penalized: number;
  role_guard_swapped: number;
  skill_guard_swapped: number;
  unknown_cap_swapped: number;
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
// Assembly candidate (mutable working type)
// ---------------------------------------------------------------------------

interface AssemblyCandidate {
  candidateId: string;
  fitScore: number;
  fitBreakdown: ScoredCandidate['fitBreakdown'];
  matchTier: 'strict_location' | 'expanded_location';
  locationMatchType: string;
  hasSnapshot: boolean;
}

// ---------------------------------------------------------------------------
// Assembly simulation — follows runtime order exactly
// ---------------------------------------------------------------------------

interface AssemblyResult {
  assembled: AssemblyCandidate[];
  diagnostics: {
    strict_demoted: number;
    strict_rescued: number;
    unknown_penalized: number;
    role_guard_swapped: number;
    skill_guard_swapped: number;
    unknown_cap_swapped: number;
  };
}

function simulateAssembly(
  scored: ScoredCandidate[],
  track: 'tech' | 'non_tech',
  config: AssemblyEvalConfig,
): AssemblyResult {
  const runtimeConfig = getSourcingConfig();
  const bestMatchesMinFitScore = config.bestMatchesMinFitScore ?? runtimeConfig.bestMatchesMinFitScore;
  const strictRescueMinFitScore = config.strictRescueMinFitScore ?? runtimeConfig.strictRescueMinFitScore;
  const strictRescueCount = config.strictRescueCount ?? runtimeConfig.strictRescueCount;
  const unknownPenaltyMultiplier = config.unknownLocationPenaltyMultiplier ?? runtimeConfig.unknownLocationPenaltyMultiplier;
  const guardsEnabled = (config.techTop20GuardsEnabled ?? runtimeConfig.techTop20GuardsEnabled) && track === 'tech';
  const roleMin = config.techTop20RoleMin ?? runtimeConfig.techTop20RoleMin;
  const roleCap = config.techTop20RoleCap ?? runtimeConfig.techTop20RoleCap;
  const skillMin = config.techTop20SkillMin ?? runtimeConfig.techTop20SkillMin;
  const epsilon = config.fitScoreEpsilon ?? 0.03;

  // Build mutable candidates
  const candidates: AssemblyCandidate[] = scored.map(s => ({
    candidateId: s.candidateId,
    fitScore: s.fitScore,
    fitBreakdown: { ...s.fitBreakdown },
    matchTier: s.matchTier as 'strict_location' | 'expanded_location',
    locationMatchType: s.locationMatchType,
    hasSnapshot: s.fitBreakdown.skillScoreMethod === 'snapshot',
  }));

  // ---- Step 2: Unknown-location penalty (orchestrator.ts:471) ----
  // Tech/blended only. Applied BEFORE strict/expanded split.
  let unknownPenalizedCount = 0;
  if (track !== 'non_tech') {
    for (const c of candidates) {
      if (
        c.locationMatchType === 'unknown_location' &&
        !(c.fitScore >= 0.60 && c.fitBreakdown.roleScore >= 0.70)
      ) {
        c.fitScore *= unknownPenaltyMultiplier;
        unknownPenalizedCount++;
      }
    }
    if (unknownPenalizedCount > 0) {
      candidates.sort((a, b) => sortByFit(a, b, epsilon));
    }
  }

  // ---- Step 3: Split strict / expanded (orchestrator.ts:1031) ----
  let expandedPool = candidates.filter(c => c.matchTier === 'expanded_location');

  // ---- Step 4: Strict demotion (orchestrator.ts:1045) ----
  let strictDemotedCount = 0;
  const qualifiedStrict: AssemblyCandidate[] = [];
  const demotedStrict: AssemblyCandidate[] = [];

  for (const c of candidates) {
    if (c.matchTier !== 'strict_location') continue;
    const failsSkillFloor = track === 'tech' && c.fitBreakdown.skillScore < skillMin;
    if (c.fitScore < bestMatchesMinFitScore || failsSkillFloor) {
      c.matchTier = 'expanded_location';
      demotedStrict.push(c);
      expandedPool.push(c);
      strictDemotedCount++;
    } else {
      qualifiedStrict.push(c);
    }
  }

  if (strictDemotedCount > 0) {
    expandedPool.sort((a, b) => sortByFit(a, b, epsilon));
  }

  // ---- Step 5: Strict rescue (orchestrator.ts:1067) ----
  let strictRescuedCount = 0;
  if (qualifiedStrict.length === 0 && demotedStrict.length > 0 && strictRescueCount > 0) {
    const rescued = demotedStrict
      .filter(c => {
        if (c.fitScore < strictRescueMinFitScore) return false;
        if (track === 'tech' && c.fitBreakdown.skillScore < skillMin) return false;
        if (track === 'tech' && c.fitBreakdown.roleScore < 0.7) return false;
        if (track !== 'tech' && c.fitBreakdown.roleScore < 0.6) return false;
        return true;
      })
      .slice(0, strictRescueCount);

    const rescuedIds = new Set(rescued.map(c => c.candidateId));
    for (const c of rescued) {
      c.matchTier = 'strict_location';
      qualifiedStrict.push(c);
      strictRescuedCount++;
    }
    expandedPool = expandedPool.filter(c => !rescuedIds.has(c.candidateId));
  }

  // ---- Step 6: Assemble strict-first, then expanded (orchestrator.ts:1093) ----
  qualifiedStrict.sort((a, b) => sortByFit(a, b, epsilon));
  expandedPool.sort((a, b) => sortByFit(a, b, epsilon));
  const assembled = [...qualifiedStrict, ...expandedPool];

  // ---- Step 7: Top-20 guards (orchestrator.ts:1341) ----
  const top20Size = Math.min(20, assembled.length);
  const unknownCapRatio = track === 'tech' ? 0.1 : 0.15;
  const top20UnknownCap = Math.max(1, Math.ceil(top20Size * unknownCapRatio));
  const getFitScore = (c: AssemblyCandidate) => c.fitScore;

  // 7a. Unknown-location cap (initial)
  const unknownCapResult = guardedTopKSwap({
    items: assembled,
    topK: top20Size,
    isViolation: c => c.locationMatchType === 'unknown_location',
    isEligibleReplacement: c => c.locationMatchType !== 'unknown_location',
    cap: top20UnknownCap,
    epsilon,
    getFitScore,
  });

  // 7b. Role guard (tech only)
  let roleGuardSwapped = 0;
  let skillGuardSwapped = 0;
  if (guardsEnabled) {
    const roleResult = guardedTopKSwap({
      items: assembled,
      topK: top20Size,
      isViolation: c => c.fitBreakdown.roleScore < roleMin,
      isEligibleReplacement: c => c.fitBreakdown.roleScore >= roleMin,
      cap: roleCap,
      epsilon,
      getFitScore,
      preferReplacement: (a, b) => {
        const aLocOk = a.locationMatchType !== 'unknown_location' ? 1 : 0;
        const bLocOk = b.locationMatchType !== 'unknown_location' ? 1 : 0;
        if (bLocOk !== aLocOk) return bLocOk - aLocOk;
        const aSkillOk = a.fitBreakdown.skillScore >= skillMin ? 1 : 0;
        const bSkillOk = b.fitBreakdown.skillScore >= skillMin ? 1 : 0;
        return bSkillOk - aSkillOk;
      },
    });
    roleGuardSwapped = roleResult.demoted;

    // 7c. Skill floor (tech only)
    const skillResult = guardedTopKSwap({
      items: assembled,
      topK: top20Size,
      isViolation: c => c.fitBreakdown.skillScore < skillMin,
      isEligibleReplacement: c =>
        c.fitBreakdown.skillScore >= skillMin &&
        c.fitBreakdown.roleScore >= roleMin,
      cap: 0,
      epsilon,
      getFitScore,
      preferReplacement: (a, b) => {
        const aLocOk = a.locationMatchType !== 'unknown_location' ? 1 : 0;
        const bLocOk = b.locationMatchType !== 'unknown_location' ? 1 : 0;
        return bLocOk - aLocOk;
      },
    });
    skillGuardSwapped = skillResult.demoted;

    // 7d. Unknown cap re-assertion
    if (roleGuardSwapped > 0 || skillGuardSwapped > 0) {
      guardedTopKSwap({
        items: assembled,
        topK: top20Size,
        isViolation: c => c.locationMatchType === 'unknown_location',
        isEligibleReplacement: c => c.locationMatchType !== 'unknown_location',
        cap: top20UnknownCap,
        epsilon,
        getFitScore,
      });
    }
  }

  return {
    assembled,
    diagnostics: {
      strict_demoted: strictDemotedCount,
      strict_rescued: strictRescuedCount,
      unknown_penalized: unknownPenalizedCount,
      role_guard_swapped: roleGuardSwapped,
      skill_guard_swapped: skillGuardSwapped,
      unknown_cap_swapped: unknownCapResult.demoted,
    },
  };
}

/** Sort by fitScore descending with epsilon tie-break (snapshot > text, then candidateId). */
function sortByFit(a: AssemblyCandidate, b: AssemblyCandidate, epsilon: number): number {
  return compareFitWithConfidence(
    {
      candidateId: a.candidateId,
      fitScore: a.fitScore,
      fitBreakdown: a.fitBreakdown,
      matchTier: a.matchTier,
      locationMatchType: a.locationMatchType as ScoredCandidate['locationMatchType'],
    },
    {
      candidateId: b.candidateId,
      fitScore: b.fitScore,
      fitBreakdown: b.fitBreakdown,
      matchTier: b.matchTier,
      locationMatchType: b.locationMatchType as ScoredCandidate['locationMatchType'],
    },
    epsilon,
  );
}

// ---------------------------------------------------------------------------
// Metric computation
// ---------------------------------------------------------------------------

function computeNdcg(rankedIds: string[], gold: Record<string, GoldBucket>, k: number): number {
  const topK = rankedIds.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const bucket = gold[topK[i]];
    if (!bucket) continue;
    dcg += (Math.pow(2, BUCKET_GRADE[bucket]) - 1) / Math.log2(i + 2);
  }
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

function computeFixtureMetrics(
  assembled: AssemblyCandidate[],
  gold: Record<string, GoldBucket>,
  track: 'tech' | 'non_tech',
  config: AssemblyEvalConfig,
): Omit<FixtureResult, 'fixtureId' | 'strict_demoted' | 'strict_rescued' | 'unknown_penalized' | 'role_guard_swapped' | 'skill_guard_swapped' | 'unknown_cap_swapped'> {
  const rankedIds = assembled.map(c => c.candidateId);
  const top5 = rankedIds.slice(0, 5);
  const top10 = rankedIds.slice(0, 10);
  const top20 = rankedIds.slice(0, 20);

  const isBad = (id: string) => {
    const b = gold[id];
    return b === 'should_be_below' || b === 'should_not_surface';
  };
  const isGoodAt5 = (id: string) => {
    const b = gold[id];
    return b === 'must_be_top' || b === 'good';
  };
  const isGoodAt10 = (id: string) => {
    const b = gold[id];
    return b === 'must_be_top' || b === 'good' || b === 'acceptable';
  };

  const mustBeTopIds = Object.entries(gold)
    .filter(([, b]) => b === 'must_be_top')
    .map(([id]) => id);

  // Strict pool purity: fraction of strict-tier candidates that are good+ (must_be_top or good)
  const strictCandidates = assembled.filter(c => c.matchTier === 'strict_location');
  const strictGood = strictCandidates.filter(c => {
    const b = gold[c.candidateId];
    return b === 'must_be_top' || b === 'good' || b === 'acceptable';
  });
  const strictPoolPurity = strictCandidates.length > 0
    ? strictGood.length / strictCandidates.length
    : 1.0;

  // Top-20 quality counts
  const roleMin = config.techTop20RoleMin ?? 0.35;
  const skillMin = config.techTop20SkillMin ?? 0.10;
  const top20Candidates = assembled.slice(0, 20);
  const top20LowRole = track === 'tech'
    ? top20Candidates.filter(c => c.fitBreakdown.roleScore < roleMin).length
    : 0;
  const top20LowSkill = track === 'tech'
    ? top20Candidates.filter(c => c.fitBreakdown.skillScore < skillMin).length
    : 0;
  const top20Unknown = top20Candidates.filter(c => c.locationMatchType === 'unknown_location').length;

  return {
    precision_at_5: top5.length > 0 ? top5.filter(isGoodAt5).length / top5.length : 0,
    precision_at_10: top10.length > 0 ? top10.filter(isGoodAt10).length / top10.length : 0,
    ndcg_at_10: computeNdcg(rankedIds, gold, 10),
    top1_correct: gold[rankedIds[0]] === 'must_be_top' ? 1 : 0,
    bad_top10_rate: top10.length > 0 ? top10.filter(isBad).length / top10.length : 0,
    bad_top20_rate: top20.length > 0 ? top20.filter(isBad).length / top20.length : 0,
    must_be_top_recall_at_5: mustBeTopIds.length > 0
      ? mustBeTopIds.filter(id => top5.includes(id)).length / mustBeTopIds.length : 1,
    must_be_top_recall_at_10: mustBeTopIds.length > 0
      ? mustBeTopIds.filter(id => top10.includes(id)).length / mustBeTopIds.length : 1,
    strict_pool_purity: strictPoolPurity,
    top20_low_role_count: top20LowRole,
    top20_low_skill_count: top20LowSkill,
    unknown_location_top20_rate: top20Candidates.length > 0
      ? top20Unknown / top20Candidates.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------------

function evaluateFixture(
  fixture: RankingFixture,
  config: AssemblyEvalConfig,
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
  const runtimeConfig = getSourcingConfig();
  const locationBoost = getLocationBoostWeight(runtimeConfig, track);
  const epsilon = config.fitScoreEpsilon ?? 0.03;

  // Step 1: rankCandidates()
  const scored = rankCandidates(candidates, requirements, {
    track,
    locationBoostWeight: locationBoost,
    fitScoreEpsilon: epsilon,
  });

  // Steps 2-7: Assembly simulation
  const { assembled, diagnostics } = simulateAssembly(scored, fixture.track, config);

  // Step 8: Evaluate
  const metrics = computeFixtureMetrics(assembled, fixture.gold, fixture.track, config);

  const result: FixtureResult = {
    fixtureId: fixture.id,
    ...metrics,
    ...diagnostics,
  };

  if (verbose) {
    console.log(`\n  ${fixture.id}: ${fixture.note ?? ''}`);
    console.log(`    nDCG@10=${result.ndcg_at_10.toFixed(3)} p@5=${result.precision_at_5.toFixed(3)} p@10=${result.precision_at_10.toFixed(3)} bad_top10=${result.bad_top10_rate.toFixed(3)} bad_top20=${result.bad_top20_rate.toFixed(3)} top1=${result.top1_correct}`);
    console.log(`    strict_purity=${result.strict_pool_purity.toFixed(3)} low_role=${result.top20_low_role_count} low_skill=${result.top20_low_skill_count} unk_top20=${result.unknown_location_top20_rate.toFixed(3)}`);
    console.log(`    Guards: demoted=${diagnostics.strict_demoted} rescued=${diagnostics.strict_rescued} unk_pen=${diagnostics.unknown_penalized} role_swap=${diagnostics.role_guard_swapped} skill_swap=${diagnostics.skill_guard_swapped} unk_cap=${diagnostics.unknown_cap_swapped}`);
    console.log(`    Assembled order:`);
    for (let i = 0; i < assembled.length; i++) {
      const c = assembled[i];
      const bucket = fixture.gold[c.candidateId] ?? '???';
      const grade = BUCKET_GRADE[bucket as GoldBucket] ?? '?';
      console.log(`      ${String(i + 1).padStart(2)}. ${c.candidateId.padEnd(25)} fit=${c.fitScore.toFixed(3)} tier=${c.matchTier.padEnd(18)} loc=${c.locationMatchType.padEnd(18)} bucket=${bucket}(${grade}) skill=${c.fitBreakdown.skillScore.toFixed(2)} role=${c.fitBreakdown.roleScore.toFixed(2)}`);
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
    bad_top20_rate: sum('bad_top20_rate'),
    must_be_top_recall_at_5: sum('must_be_top_recall_at_5'),
    must_be_top_recall_at_10: sum('must_be_top_recall_at_10'),
    strict_pool_purity: sum('strict_pool_purity'),
    top20_low_role_count: sum('top20_low_role_count'),
    top20_low_skill_count: sum('top20_low_skill_count'),
    unknown_location_top20_rate: sum('unknown_location_top20_rate'),
    strict_demoted: sum('strict_demoted'),
    strict_rescued: sum('strict_rescued'),
    unknown_penalized: sum('unknown_penalized'),
    role_guard_swapped: sum('role_guard_swapped'),
    skill_guard_swapped: sum('skill_guard_swapped'),
    unknown_cap_swapped: sum('unknown_cap_swapped'),
    fixture_count: n,
  };
}

// ---------------------------------------------------------------------------
// Exported run() for research-runner.ts
// ---------------------------------------------------------------------------

export async function run(config: Record<string, unknown>): Promise<EvalResult> {
  const evalConfig = config as unknown as AssemblyEvalConfig;
  const files = evalConfig.fixturePath
      ? [evalConfig.fixturePath]
      : [
        'research/datasets/ranking-assembly-tech.jsonl',
        'research/datasets/ranking-assembly-nontech.jsonl',
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
  // Objective: minimize bad_top10_rate (lower is better)
  return {
    objective: metrics.bad_top10_rate ?? 1,
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
        'research/datasets/ranking-assembly-tech.jsonl',
        'research/datasets/ranking-assembly-nontech.jsonl',
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
          const guards = [
            result.strict_demoted > 0 ? `dem=${result.strict_demoted}` : '',
            result.role_guard_swapped > 0 ? `role=${result.role_guard_swapped}` : '',
            result.skill_guard_swapped > 0 ? `skill=${result.skill_guard_swapped}` : '',
          ].filter(Boolean).join(' ');
          console.log(`  ${icon.padEnd(4)} ${fx.id} nDCG@10=${result.ndcg_at_10.toFixed(3)} bad_top10=${result.bad_top10_rate.toFixed(3)} bad_top20=${result.bad_top20_rate.toFixed(3)} purity=${result.strict_pool_purity.toFixed(3)}${guards ? ' [' + guards + ']' : ''}`);
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
  console.log(`  Bad top-20 rate (avg):     ${metrics.bad_top20_rate?.toFixed(4)}`);
  console.log(`  must_be_top recall@5:      ${metrics.must_be_top_recall_at_5?.toFixed(4)}`);
  console.log(`  must_be_top recall@10:     ${metrics.must_be_top_recall_at_10?.toFixed(4)}`);
  console.log(`  Strict pool purity:        ${metrics.strict_pool_purity?.toFixed(4)}`);
  console.log(`  Top-20 low role (avg):     ${metrics.top20_low_role_count?.toFixed(2)}`);
  console.log(`  Top-20 low skill (avg):    ${metrics.top20_low_skill_count?.toFixed(2)}`);
  console.log(`  Unknown location top-20:   ${metrics.unknown_location_top20_rate?.toFixed(4)}`);
  console.log('\n--- Assembly Diagnostics (avg) ---');
  console.log(`  Strict demoted:            ${metrics.strict_demoted?.toFixed(2)}`);
  console.log(`  Strict rescued:            ${metrics.strict_rescued?.toFixed(2)}`);
  console.log(`  Unknown penalized:         ${metrics.unknown_penalized?.toFixed(2)}`);
  console.log(`  Role guard swapped:        ${metrics.role_guard_swapped?.toFixed(2)}`);
  console.log(`  Skill guard swapped:       ${metrics.skill_guard_swapped?.toFixed(2)}`);
  console.log(`  Unknown cap swapped:       ${metrics.unknown_cap_swapped?.toFixed(2)}`);

  // Per-fixture breakdown
  console.log('\n--- Per-Fixture Breakdown ---');
  for (const r of allResults) {
    const guards = [
      r.strict_demoted > 0 ? `dem=${r.strict_demoted}` : '',
      r.role_guard_swapped > 0 ? `role=${r.role_guard_swapped}` : '',
      r.skill_guard_swapped > 0 ? `skill=${r.skill_guard_swapped}` : '',
    ].filter(Boolean).join(' ');
    console.log(`  ${r.fixtureId.padEnd(20)} nDCG=${r.ndcg_at_10.toFixed(3)} bad10=${r.bad_top10_rate.toFixed(3)} bad20=${r.bad_top20_rate.toFixed(3)} purity=${r.strict_pool_purity.toFixed(3)} top1=${r.top1_correct}${guards ? ' [' + guards + ']' : ''}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
