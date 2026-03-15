# Research Playbook

How we improve recruiter decision quality through field-by-field experiments.

## Goal

Each experiment targets one field that recruiters use to evaluate candidates. We measure extraction/matching accuracy in isolation, fix gaps, then verify on production data before shipping.

Fields, in rollout order:

1. Location
2. Headline/Title
3. Seniority
4. Skills (tech, then non-tech)
5. Currentness (next)
6. Identity/Reachability

One field at a time. Each gets its own fixtures, evaluator, and audit.

## Core workflow

Every field experiment follows the same pattern:

1. **Define the recruiter question** — what does the recruiter need from this field?
2. **Build fixtures** — gold-labeled (input, expected output) pairs in JSONL
3. **Build evaluator** — script that runs the matcher against fixtures, reports precision/recall/FP rate
4. **Measure baseline** — run evaluator on current code, find gaps
5. **Improve code** — fix aliases, add rules, tighten guards
6. **Add adversarial guards** — false positive protection for ambiguous cases
7. **Run prod audit** — sample real candidates, verify behavior on production data
8. **Dry-run backfill** — if persisted field, audit what would change
9. **Apply targeted backfill** — only vetted IDs, only safe changes

## Repo map

```
research/
  datasets/              # JSONL fixture files (gold-labeled)
  programs/              # Runner experiment definitions (JSON)
  experiments/           # Output (gitignored)

scripts/
  eval-*.ts              # Evaluators (offline, deterministic)
  audit-*.ts             # Prod audits (read-only, require DATABASE_URL)
  backfill-*.ts          # Prod backfills (write, require --ids + --apply)
  research-runner.ts     # Shared runner for parameter sweeps
  collect-live-*.ts      # Live API fixture generators (not for eval loops)

docs/superpowers/specs/  # Per-field design specs
```

## Dataset types

| Type | Purpose | Use as regression gate? |
|------|---------|------------------------|
| **core** | Stable regression set. Straightforward cases. | Yes |
| **adversarial** | Precision/false-positive protection. Edge cases. | Yes |
| **gap** | Discovery set. Find new failure modes. | No |
| **precision** | Targeted precision testing (ambiguous tokens, company names). | Yes |
| **prod** | Production-shaped fixtures (real headlines/snippets). | Yes |
| **resolution** | Resolver-only fixtures (known-good input). | Yes, for resolver |

Gap/discovery fixtures expose weaknesses but are not pass/fail gates. They inform what to fix, not whether to ship.

## Evaluator contract

Every evaluator:

- Reads JSONL fixtures from `research/datasets/`
- Runs the matcher/extractor against each fixture
- Reports: accuracy, precision, recall, FP rate, per-label breakdown, misses
- Supports `--verbose` for per-fixture output
- Supports `--file <path>` to run a single dataset
- Uses no live API calls (deterministic, free, fast)

Fixture shape (skill evidence example):

```json
{
  "id": "sk_core_001",
  "headline": "Senior Backend Engineer",
  "snippet": "Building microservices with Node.js and TypeScript",
  "target_skills": ["node.js", "typescript", "microservices"],
  "gold": {"node.js": "explicit", "typescript": "explicit", "microservices": "explicit"},
  "note": "straightforward tech stack"
}
```

Gold labels: `explicit` (expect detected), `inferred` (expect not detected), `absent` (expect not detected), `false_positive` (expect not detected).

For runner-compatible evaluators, export `async function run(config): Promise<EvalResult>` where:

```typescript
interface EvalResult {
  objective: number;
  metrics: Record<string, number>;
  artifacts?: Record<string, unknown>;
}
```

## When to use the runner

Only when there are real knobs to tune:

- Confidence thresholds
- Feature toggles
- Weight parameters
- Search space sweeps

If there are no tunable parameters, run the evaluator directly. Most experiments don't need the runner.

## Prod rollout pattern

For persisted fields (locationHint, headlineHint, seniorityHint):

1. **Audit first** — run `audit-*.ts` to see current state vs what new code would produce
2. **Classify changes** — NEW (safe), CHANGED (review), REGRESSED (investigate)
3. **Generate approved ID list** — only NEW or manually-vetted CHANGED
4. **Dry-run backfill** — run `backfill-*.ts --ids <list>` without `--apply`
5. **Apply** — run with `--apply`, batch UPDATE in groups of 500
6. **Re-audit** — confirm 0 remaining gaps, no regressions

For runtime-only improvements (skill matching rules, ranking weights):

1. Deploy code
2. Run prod sanity audit to verify behavior on real data
3. No backfill needed — changes are immediately active

## What to persist where

**Candidate table** — stable operational hints extracted from SERP/profile data:

- `locationHint` — city/country from search results
- `headlineHint` — cleaned headline
- `seniorityHint` — normalized seniority band

**CandidateIntelligenceSnapshot** — derived/interpretive data from enrichment:

- `skillsNormalized` — LLM-extracted skills
- `seniorityBand` — LLM-assessed seniority
- `roleType` — classification for routing

**Runtime only** (not persisted) — computed at ranking time:

- Skill evidence text fallback matches
- Non-tech concept rule matches
- Seniority text-parse fallback

## What not to do

- **Don't put live Serper in eval loops.** Fixtures are static. Live API is for fixture generation only.
- **Don't mix extraction accuracy with currentness.** "Is the extraction correct?" and "Is the data still current?" are different experiments.
- **Don't backfill from random samples.** Audit, generate ID list, dry-run, then apply vetted IDs only.
- **Don't treat gap/discovery fixtures as regression truth.** They inform fixes, not ship decisions.
- **Don't overclaim from fixture results.** 100% on fixtures means "evaluator and labels are aligned", not "solved in prod." Always follow with a prod sanity audit.

## Current status

| Field | Evaluator | Fixtures | Audit | Backfill | Status |
|-------|-----------|----------|-------|----------|--------|
| Location | eval-location-hints, eval-location-resolution | core, adversarial, prod, resolution | audit-location-* | backfill-location-hints | Complete |
| Headline/Title | eval-title-hints | core, adversarial | audit-title-backfill | backfill-headline-hints | Complete |
| Seniority | eval-seniority | core, adversarial | audit-seniority-backfill | backfill-seniority-hints | Complete (3,816 backfilled) |
| Tech Skills | eval-skill-evidence-tech | core, adversarial, gap, precision | audit-skill-ambiguous-prod | N/A (runtime) | v1 deployed |
| Non-Tech Skills | eval-skill-evidence-nontech | core, adversarial | audit-skill-nontech-prod | N/A (runtime) | v1 deployed |
| Currentness | eval-serp-currentness | title-core, location-core, adversarial | — | N/A (runtime) | v1 eval done, prod audit next |

## Per-field specs

Detailed design docs in `docs/superpowers/specs/`:

- `2026-03-15-title-extraction-experiment-design.md`
- `2026-03-15-seniority-experiment-design.md`
- `2026-03-15-skill-evidence-experiment-design.md`
- `2026-03-15-skill-evidence-nontech-design.md`
- `2026-03-15-serp-currentness-experiment-design.md`
