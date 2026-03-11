# Signal Sourcing Competitiveness Roadmap

Date: March 7, 2026  
Scope: 90-day execution plan to improve sourcing quality and market competitiveness.

## Goals

1. Improve shortlist precision while increasing candidate coverage.
2. Reduce location uncertainty and gating noise.
3. Build compounding candidate intelligence across runs.
4. Increase pre-ranking recall so ranking has a stronger pool to choose from.
5. Reduce time-to-engagement-ready candidate (north-star product KPI).

## Current Baseline

Strengths:
- Strong ranking control and diagnostics.
- Good role precision in recent canaries.
- Discovery and promotion logic now more stable.

Weaknesses:
- Low pool depth in some role families.
- High `unknown_location` share.
- Recall bottleneck before ranking.
- Non-tech quality still depends heavily on discovery.
- Query quality iteration loop is not yet formalized.

## Phase 0 (Weeks 1-2): Stabilize and Measure

### Work

1. Keep current guardrails:
- `unknown_location` cap: tech `10%`, non-tech/blended `20%`.
- strategy defaults as currently configured.

2. Complete location ingest hardening:
- ship extractor improvements already in progress.
- run one-time backfill for missing location hints (quality-gated).

3. Add daily monitoring:
- `unknown_location %`
- `none %`
- known city/country coverage
- discovered promoted count
- unknown-location promoted count
- enrichment lift (`rank_before_enrichment` vs `rank_after_enrichment`)
- enrichment usefulness rate (`% candidates with material post-enrichment rank change`)
- novelty/fatigue indicators for repeated exposure

### Exit Criteria

- No regression in top-20 role quality.
- Known location coverage trending up week-over-week.

## Phase 1 (Weeks 3-4): Location Validation + Pool Seeding

### Work

1. Validate what is already shipped:
- location resolver in active mode (deterministic + LLM + confidence).
- unknown-location lane behavior by track.
- post-enrichment location resolution lift.
- add source-weighted `location_confidence` (`snippet`, `title`, `profile`, `llm`).
- ensure ranking and promotion gates consume confidence, not only presence.

2. Build required dashboards:
- city/country coverage trend.
- LLM eligible/used/resolved counts.
- unknown-location promoted count by track.

3. Start non-tech pool seeding (operational):
- weekly seed jobs for AE/CSM/TAM/BDR/AM in target geos.
- track pool coverage by role-family x city.

4. Start query quality iteration loop:
- weekly A/B on strict/fallback templates.
- track query-level hit rate, location extraction rate, promotion rate.

5. Add dashboard slices:
- by role family
- by city/country
- by source and confidence band (if persisted)
- role-family x city coverage heatmap for weekly seeding decisions

### Exit Criteria

- Known country coverage improves by at least 10 points.
- Non-tech pool share improves week-over-week in seeded families.
- Query experiments produce measurable lift in discovery yield.

## Phase 2a (Weeks 5-7): Candidate Memory Foundation (Dedup + Exposure)

### Work

1. Cross-run deduplication and memory primitives:
- enforce stable identity linkage per source key(s).
- normalize repeated discoveries into one reusable candidate memory record.
- add `identity_confidence` per link (deterministic + probabilistic signals).
- merge only above threshold; keep split records + telemetry below threshold.

2. Exposure and engagement memory:
- persist exposure history and outreach outcomes.
- add ranking features for exposure freshness / fatigue.
- add `candidate_novelty_score` and use it in tie-breaking/rerank.

3. Add safety and observability:
- merge/audit logs for identity collisions.
- duplicate-rate and repeat-hit dashboards.

### Exit Criteria

- Duplicate rediscovery rate drops.
- Repeat role-family jobs show better top-20 stability.

## Phase 2b (Weeks 8-10): Longitudinal Intelligence + Merge Rules

### Work

1. Field-level longitudinal model:
- role history with timestamps.
- skill history with source/confidence.
- location history with freshness and confidence.

2. Explicit conflict-resolution policy:
- deterministic precedence rules.
- confidence-weighted merges.
- stale-field decay and replacement rules.

3. Ranking integration:
- use validated historical fields only when current-run evidence is weak.

### Exit Criteria

- Merge conflict rate stays within threshold.
- Historical fields improve ranking consistency without precision regressions.

## Phase 3 (Weeks 11-13): Retrieval Upgrade v1

### Work

1. Build hybrid retrieval before ranking:
- lexical retrieval
- structured filters
- adjacency expansion

2. Add embedding retrieval behind a flag with explicit design decisions:
- define embedding model and text schema.
- define index ownership and refresh pipeline.
- define latency budget and fallback behavior.

3. Active Graph KG decision gate (mandatory):
- Option A: retrieval service lives in Active Graph KG.
- Option B: retrieval service is internal and Active Graph remains enrichment-only.
- produce one RFC and select one path before implementation.

4. Evaluate cohort quality:
- recall@100
- top-20 relevance
- discovery dependency rate
- good candidates lost before ranking (`good_candidates_lost_before_ranking`)
- query template performance table (hit rate, promotion rate) with auto-prioritization

### Exit Criteria

- Higher recall with no precision regression in top-20.
- Fewer good candidates found only in late fallback phases.

## Rollout Strategy

1. Shadow mode first for new model-assisted components.
2. Canary jobs per release:
- TAM (Bangalore)
- CSM (Mumbai)
- AE (Mumbai/Boston)
- Backend (Bangalore/SF)
3. Promote only when canary quality and diagnostics pass.
4. Keep env-based rollback switches for every new behavior.

## Ranking Governance (Moat Protection)

1. Keep retrieval, ranking, memory, and feedback as separate controlled layers.
2. Feedback never directly rewrites core ranking weights.
3. Apply feedback effects only as bounded features/boosts with hard caps.
4. Maintain a permanent exploration budget:
- tech: 10%
- non-tech/blended: 20%
5. Active Graph provides data/features only; ranking decisions stay in Signal ranking pipeline.
6. Require feedback threshold + shadow + canary before any active ranking impact.
7. Keep merge safety strict:
- auto-merge only when `identity_confidence >= 0.85`
- below threshold stays split with audit trail

## Role Taxonomy Intake Workflow

Goal: reduce day-to-day manual work while keeping ranking stable under fixed canonical families.

1. Runtime normalization path (automatic):
- accept LLM role output as raw string.
- map in order: exact canonical match -> alias table -> `unknown`.
- never pass non-canonical labels into ranking/gates.

2. Review queue (automatic capture):
- persist unmapped labels to a review queue with:
  - `raw_label`
  - count/frequency
  - sample titles
  - suggested canonical mapping
  - confidence stats

3. Weekly approval loop (manual, low-touch):
- decisions per label:
  - approve alias mapping to canonical family
  - keep as `unknown`
  - schedule new canonical family (rare, versioned release only)
- apply approved mappings to alias table used by runtime normalization.

4. Safe rollout controls:
- new mappings run in shadow first (delta: wouldPromote/wouldBlock).
- activate only after canary checks pass.
- keep kill switch: `ROLE_LABEL_AUTO_MAP_ENABLED`.

5. Governance thresholds:
- auto-suggest alias when volume >= 30, agreement >= 95%, avg confidence >= 0.75.
- ownership: engineering + sourcing owner weekly review (30 min SLA).

## KPI Set (Weekly Review)

1. Top-20 role precision by track (`tech`, `non_tech`, `blended`).
2. Known city/country coverage.
3. `unknown_location` share and unknown-lane promotion share.
4. Discovery-to-top20 conversion.
5. Time-to-engagement-ready candidate.
6. Duplicate rate across runs.
7. Pool coverage by role-family x city.
8. Query hit rate and promoted yield by query variant.
9. Enrichment lift score by track and role family.
10. Good candidates lost before ranking.
11. Enrichment usefulness rate by track and role family.
12. Role-family x city coverage heatmap completeness.
13. First qualified candidate rank (`first_qualified_candidate_rank`).

### KPI Contract (Lock in Sprint 1)

`time_to_engagement_ready_candidate`:
- Definition: `timestamp(first engagement-ready candidate) - timestamp(job source submitted)`.
- Report: p50 and p90.
- Slices: by `track` and `role_family`.
- Engagement-ready threshold (initial):
  - `fitScore >= 0.55`
  - `location_confidence >= threshold` (or strong location type when confidence unavailable)
  - `identity_confidence >= threshold` (when available)
  - `enrichment_status` not `pending` (or minimum profile completeness met)

Companion metric:
- `first_qualified_candidate_rank` to ensure speed gains do not hide ranking quality regressions.

## Risks and Controls

1. Risk: LLM overclassification or drift.  
Control: shadow validation, confidence gating, circuit breaker.

2. Risk: coverage gains with precision loss.  
Control: canary gate on top-20 precision before rollout.

3. Risk: merge errors in memory layer.  
Control: confidence-scored merges + reversible write strategy.

## Definition of Success (End of 90 Days)

1. Higher and more stable top-20 quality across tracked roles.
2. Meaningful reduction in unknown-location dependence.
3. Compounding candidate memory that improves reruns.
4. Better retrieval recall with ranking quality preserved.
