# Ranking Optimization Experiment Design

**Date:** 2026-03-15
**Status:** Draft
**Goal:** Measure and improve shortlist quality — are the top 10/20 candidates the ones a recruiter would actually want first?

---

## Recruiter Question

> "Are the top 10/20 candidates the ones I would actually want to talk to first?"

This is not about individual component scores (skill, role, seniority). Those are already measured by field-specific experiments. This experiment measures whether the **weighted combination** produces the right **ordering** for a realistic candidate pool.

---

## Scope

This experiment has two phases with separate evaluators.

### Phase A: Scoring optimization (this experiment)

Tests `rankCandidates()` in isolation — the weighted scoring function.

**In scope:**
- Track-specific weight tuning (skill / role / seniority / freshness / location)
- Location boost values per track (tech, non-tech)
- Seniority dampening for role mismatch
- Fit score epsilon (tie-breaking sensitivity)
- Currentness penalty for historical titles — deferred until post-baseline (not part of `rankCandidates()` today, requires fixture metadata not yet defined)

**Not in scope for Phase A:**
- Guard thresholds (bestMatchesMinFitScore, techTop20RoleMin, techTop20SkillMin) — enforced in orchestrator/rerank, not in rankCandidates()
- Unknown-location penalty multiplier — applied post-rank in orchestrator
- Assembly policy (strict vs expanded tiers, unknown-location caps)

### Phase B: Assembly/guard optimization (future, separate evaluator)

Tests orchestrator-level policy: demotion rules, guard thresholds, tier assignment.

**Deferred to Phase B:**
- bestMatchesMinFitScore, techTop20RoleMin, techTop20SkillMin
- Unknown-location penalty multiplier
- Strict rescue policy
- Rerank/rescore alignment

### Excluded from both phases
- Identity / reachability signals
- Contactability
- Discovery query generation
- Search provider changes
- Enrichment pipeline changes
- Blended track — v1 ranking optimization covers tech and non-tech only. Blended fixtures deferred until tech/non-tech baselines are established.

---

## Fixture Format

Each fixture represents one **sourcing request**: a job spec + a curated candidate pool + gold bucket labels.

```typescript
interface RankingFixture {
  id: string;                        // e.g. "rk_tech_001"
  track: 'tech' | 'non_tech';
  note?: string;                     // what this fixture tests
  job: {
    title: string;                   // e.g. "Senior Backend Engineer"
    topSkills: string[];             // max 10, from JD digest
    domain: string | null;           // primary domain skill
    roleFamily: string | null;       // target role family
    seniorityLevel: string | null;   // target seniority band
    location: string | null;         // target location
  };
  candidates: RankingFixtureCandidate[];
  // Gold labels: which bucket each candidate belongs in
  gold: Record<string, GoldBucket>;  // candidateId → bucket
}

interface RankingFixtureCandidate {
  id: string;
  headlineHint: string | null;
  seniorityHint?: string | null;
  locationHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
  enrichmentStatus: 'completed' | 'pending';
  lastEnrichedAt: string;            // ISO date, for freshness calc
  snapshot: {
    skillsNormalized: string[];
    roleType: string | null;
    seniorityBand: string | null;
    location: string | null;
    activityRecencyDays: number | null;
    computedAt: string;              // ISO date
    staleAfter: string;              // ISO date
  } | null;
}

type GoldBucket =
  | 'must_be_top'          // recruiter wants this first, should be top 5
  | 'good'                 // recruiter would pick this, should be top 10
  | 'acceptable'           // fine but not first choice, top 20 ok
  | 'should_be_below'      // shouldn't be in top 10
  | 'should_not_surface'   // noise, wrong role, or stale — should be ranked last
```

### Bucket semantics

| Bucket | Numeric grade | Top-5 | Top-10 | Top-20 |
|--------|:---:|:---:|:---:|:---:|
| `must_be_top` | 4 | expected | expected | expected |
| `good` | 3 | acceptable | expected | expected |
| `acceptable` | 2 | acceptable | acceptable | expected |
| `should_be_below` | 1 | violation | violation | acceptable |
| `should_not_surface` | 0 | violation | violation | violation |

### Why buckets, not exact ranks

Exact rank ordering is hard to label consistently. "This candidate is rank 7 not rank 8" is subjective. But "this candidate should be in the top 10" is a judgment recruiters can make reliably.

---

## Fixture Files

```
research/datasets/ranking-tech-core.jsonl       # 5-8 tech fixtures
research/datasets/ranking-nontech-core.jsonl     # 5-8 non-tech fixtures
research/datasets/ranking-adversarial.jsonl      # edge cases (optional, later)
```

### Tech fixture themes

Each fixture: 1 job + 10-30 candidates with realistic near-misses.

| ID | Theme | Tests |
|---|---|---|
| `rk_tech_001` | Correct stack, wrong role | Frontend dev applied to backend role — skills overlap but role mismatch should penalize |
| `rk_tech_002` | Correct role, zero skills | Backend engineer with no matching skills — should not outrank skilled candidates |
| `rk_tech_003` | Exact match vs stale data | Fresh exact match vs stale exact match — freshness should differentiate |
| `rk_tech_004` | Exact location vs unknown | Same skills/role, one has exact city, one unknown — location boost should differentiate |
| `rk_tech_005` | Fullstack vs frontend/backend adjacency | Fullstack applied to backend role — adjacency should partially reward |
| `rk_tech_006` | Seniority over/under | Senior role: staff overqualified, mid underqualified, senior exact — seniority distance matters |

### Non-tech fixture themes

| ID | Theme | Tests |
|---|---|---|
| `rk_nt_001` | AE vs CS confusion | Account Executive role, CS candidates apply — adjacent but not exact |
| `rk_nt_002` | Enterprise sales vs generic BDR | Enterprise AE role, BDR candidates — role gap should matter more than skill overlap |
| `rk_nt_003` | TAM with strong stakeholder management | TAM role, account managers with stakeholder skills — near-miss |
| `rk_nt_004` | Correct role, weak skill evidence | Right role family but no snapshot skills — text fallback quality matters |
| `rk_nt_005` | Location tiebreaker | Same role/seniority, different location match — 0.03 boost should create separation |

---

## Evaluator

`scripts/eval-ranking.ts`

Must export `run(config): Promise<EvalResult>` for compatibility with `research-runner.ts`.

### Config parameters (from search space)

Scoring-only parameters. No guard/assembly thresholds — those belong to the Phase B evaluator.

```typescript
interface RankingEvalConfig {
  fixturePath?: string;              // override fixture file
  // Weight overrides (if absent, use defaults from ranking.ts)
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
```

### How weight overrides reach rankCandidates()

The evaluator computes its own weighted score locally rather than monkey-patching the `TRACK_WEIGHTS` constant inside `ranking.ts`. It:

1. Builds `JobRequirements` from the fixture
2. Calls `rankCandidates()` with the fixture's track and `options.locationBoostWeight`
3. If the config overrides base weights (skill/role/seniority/freshness), the evaluator recomputes fitScore from the per-component breakdown scores that `rankCandidates()` already returns in `FitBreakdown`:
   - `skillScore`
   - `roleScore`
   - `effectiveSeniorityScore ?? seniorityScore` (must use damped seniority, not raw — runtime uses damped at `ranking.ts:451`)
   - `activityFreshnessScore`
   - `locationBoost`
4. After recomputing fitScore, re-sorts candidates using the same comparator semantics as runtime (`compareFitWithConfidence` at `ranking.ts:66`):
   - higher fitScore wins
   - within epsilon: prefer snapshot-scored over text fallback
   - final tiebreak: candidateId lexicographic
   - uses overridden `fitScoreEpsilon` if provided in config

This avoids touching module internals. The evaluator uses `rankCandidates()` to get component scores and location classification, then applies its own weight vector and re-sorts.

### Metrics

| Metric | Definition |
|--------|-----------|
| `precision_at_5` | fraction of top-5 that are `must_be_top` or `good` |
| `precision_at_10` | fraction of top-10 that are `must_be_top`, `good`, or `acceptable` |
| `ndcg_at_10` | nDCG@10 using bucket numeric grades (4/3/2/1/0) |
| `top1_correct` | 1 if rank-1 candidate is `must_be_top`, else 0 |
| `bad_top10_rate` | fraction of top-10 that are `should_be_below` or `should_not_surface` |
| `must_be_top_recall_at_5` | fraction of `must_be_top` candidates found in top-5 |
| `must_be_top_recall_at_10` | fraction of `must_be_top` candidates found in top-10 |

### Primary objective

`ndcg_at_10` — averaged across all fixtures. This captures both "right candidates at top" and "wrong candidates demoted."

### Constraints

Phase A hard constraints (sweep will reject configs violating these):

```json
{
  "must_be_top_recall_at_10": { "min": 0.90 }
}
```

Phase A diagnostics (reported but not gated on):
- `bad_top10_rate` — partly Phase B responsibility (assembly guards handle demotion of bad candidates). Tracked for visibility but not a hard gate for scoring-only optimization.

### Evaluator flow

```
1. Load fixtures from JSONL
2. For each fixture:
   a. Build JobRequirements from fixture.job
   b. Build CandidateForRanking[] from fixture.candidates
   c. Call rankCandidates() with config overrides
   d. Compare ranked output against fixture.gold
   e. Compute per-fixture metrics
3. Aggregate metrics across fixtures (macro-average)
4. Return { objective: avg_ndcg_at_10, metrics: {...} }
```

---

## Research Program

### Baseline

Run the evaluator directly to measure current defaults:

```bash
npx tsx scripts/eval-ranking.ts
npx tsx scripts/eval-ranking.ts --verbose
npx tsx scripts/eval-ranking.ts --file research/datasets/ranking-tech-core.jsonl
```

No research-runner.ts needed for baseline — it adds nothing over a direct evaluator run.

### Weight sweep

`research/programs/ranking-optimization-sweep.json`

```json
{
  "name": "ranking-optimization-sweep",
  "evaluator": "ranking",
  "objective": "ndcg_at_10",
  "maximize": true,
  "constraints": {
    "bad_top10_rate": { "max": 0.05 },
    "must_be_top_recall_at_10": { "min": 0.90 }
  },
  "searchSpace": {
    "techSkillWeight": [0.40, 0.45, 0.50],
    "techRoleWeight": [0.10, 0.15, 0.20],
    "techSeniorityWeight": [0.20, 0.25, 0.30],
    "locationBoostTech": [0.05, 0.10, 0.15]
  },
  "budget": { "iterations": 100 },
  "seed": 42
}
```

Weights must sum to 1.0 (before location redistribution). The evaluator validates this and skips invalid combos.

---

## Implementation Plan

### Phase A (scoring optimization — this experiment)

1. **Write spec** — this document
2. **Build fixtures** — `ranking-tech-core.jsonl` and `ranking-nontech-core.jsonl`
3. **Build evaluator** — `scripts/eval-ranking.ts` with `run()` export
4. **Run baseline** — `npx tsx scripts/eval-ranking.ts` with current defaults
5. **Parameter sweep** — optimize via `research-runner.ts`
6. **Document results** — update `docs/ranking-defaults.md` if defaults change

### Phase A results

Freshness curve patched (`ranking.ts:408`): added 181-365d band (0.25) to separate medium-stale from very-stale. Previous curve had a cliff at 180d where both 200d and 560d scored 0.10.

Post-patch baseline (12 fixtures):
- nDCG@10: 0.983, top-1: 100%, must_be_top recall@10: 100%
- bad_top10_rate: 0.200 — driven by assembly/guard behavior, not scoring

Remaining misses:
- rk_tech_003: freshness separation now working (0.75/0.50/0.25/0.10 bands visible)
- rk_tech_005: Phase B guard issue (QA candidates with skill overlap leak into top-10)
- rk_nt_001/002/003: role-adjacency calibration (BDR→AE=0.7, CS→TAM=0.6 may be generous)

Phase A is complete. No further weight sweep warranted — remaining leakage maps to assembly policy.

### Phase B (assembly/guard optimization)

7. **Build assembly evaluator** — `scripts/eval-assembly.ts` simulating orchestrator demotion, rescue, penalty, and guard logic
8. **Reuse Phase A fixtures** — same fixtures, but now measuring post-assembly ordering
9. **Tune guard thresholds** — bestMatchesMinFitScore, techTop20RoleMin, techTop20SkillMin, unknown-location penalty, strict rescue

### Key design decisions

- Fixtures use **frozen candidate data** (snapshot skills, pre-set dates) — no DB access, no API calls
- `rankCandidates()` is called directly — no orchestrator, no assembly logic
- Weight overrides applied by recomputing fitScore from FitBreakdown components — no monkey-patching of module internals
- `enrichmentStatus` uses runtime values (`completed` / `pending`), not test-only values

### What this evaluator tests

The **scoring function** in isolation: given these candidates and this job, does `rankCandidates()` put the right ones on top?

### What this evaluator does NOT test

- Assembly policy (strict vs expanded tiers, unknown-location caps) — Phase B
- Guard thresholds (bestMatchesMinFitScore, techTop20RoleMin, techTop20SkillMin) — Phase B
- Rerank / rescore alignment — Phase B
- Blended track — deferred until tech/non-tech baselines are established

---

## After Offline Eval

1. If weight changes improve nDCG without violating constraints, update defaults
2. Replay audit: sample real sourcing requests, compare old vs new ranking config
3. Only then consider wiring currentness into ranking as an additional signal
