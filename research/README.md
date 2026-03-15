# Research

Datasets, evaluators, and audit scripts for field-by-field recruiter decision experiments.

## Datasets

All in `research/datasets/`. JSONL format, one fixture per line.

| File | Field | Type |
|------|-------|------|
| `location-fixtures-core.jsonl` | Location | Core regression |
| `location-fixtures-adversarial.jsonl` | Location | Adversarial |
| `location-fixtures-prod.jsonl` | Location | Prod-shaped |
| `resolution-fixtures.jsonl` | Location | Resolver-only |
| `title-fixtures-core.jsonl` | Title/Headline | Core regression |
| `title-fixtures-adversarial.jsonl` | Title/Headline | Adversarial |
| `seniority-fixtures-core.jsonl` | Seniority | Core regression |
| `seniority-fixtures-adversarial.jsonl` | Seniority | Adversarial |
| `skill-evidence-tech-core.jsonl` | Skills (tech) | Core regression |
| `skill-evidence-tech-adversarial.jsonl` | Skills (tech) | Adversarial |
| `skill-evidence-tech-gap.jsonl` | Skills (tech) | Gap/discovery |
| `skill-evidence-tech-precision.jsonl` | Skills (tech) | Precision |
| `skill-evidence-nontech-core.jsonl` | Skills (non-tech) | Core regression |
| `skill-evidence-nontech-adversarial.jsonl` | Skills (non-tech) | Adversarial |
| `serp-currentness-title-core.jsonl` | Currentness (title) | Core regression |
| `serp-currentness-location-core.jsonl` | Currentness (location) | Core regression |
| `serp-currentness-adversarial.jsonl` | Currentness (both) | Adversarial |

## Evaluators

```bash
# Location
npx tsx scripts/eval-location-hints.ts
npx tsx scripts/eval-location-resolution.ts

# Title/Headline
npx tsx scripts/eval-title-hints.ts

# Seniority
npx tsx scripts/eval-seniority.ts

# Skills
npx tsx scripts/eval-skill-evidence-tech.ts
npx tsx scripts/eval-skill-evidence-tech.ts --verbose
npx tsx scripts/eval-skill-evidence-tech.ts --file research/datasets/skill-evidence-tech-adversarial.jsonl
npx tsx scripts/eval-skill-evidence-nontech.ts
npx tsx scripts/eval-skill-evidence-nontech.ts --verbose

# SERP Currentness
npx tsx scripts/eval-serp-currentness.ts
npx tsx scripts/eval-serp-currentness.ts --verbose
npx tsx scripts/eval-serp-currentness.ts --file research/datasets/serp-currentness-adversarial.jsonl
```

All evaluators support `--verbose` for per-fixture output and `--file` to run a single dataset.

## Audit scripts (prod)

Require `DATABASE_URL` env var pointed at prod.

```bash
DB="postgresql://postgres:...@crossover.proxy.rlwy.net:18271/railway"

# Location
DATABASE_URL="$DB" npx tsx scripts/audit-location-extraction.ts
DATABASE_URL="$DB" npx tsx scripts/audit-location-backfill.ts
DATABASE_URL="$DB" npx tsx scripts/audit-location-ids.ts

# Title
DATABASE_URL="$DB" npx tsx scripts/audit-title-backfill.ts

# Seniority
DATABASE_URL="$DB" npx tsx scripts/audit-seniority-backfill.ts
DATABASE_URL="$DB" npx tsx scripts/audit-seniority-backfill.ts --missing-only

# Skills (prod sanity — not rate estimates, probe-biased samples)
DATABASE_URL="$DB" npx tsx scripts/audit-skill-ambiguous-prod.ts
DATABASE_URL="$DB" npx tsx scripts/audit-skill-nontech-prod.ts --probe --limit 500
```

## Backfill scripts (prod)

Always audit first. Always use `--ids` for targeted apply.

```bash
# Location
DATABASE_URL="$DB" npx tsx scripts/backfill-location-hints.ts --ids /tmp/backfill-ids.txt
DATABASE_URL="$DB" npx tsx scripts/backfill-location-hints.ts --ids /tmp/backfill-ids.txt --apply

# Headline
DATABASE_URL="$DB" npx tsx scripts/backfill-headline-hints.ts --ids /tmp/headline-backfill-ids.txt
DATABASE_URL="$DB" npx tsx scripts/backfill-headline-hints.ts --ids /tmp/headline-backfill-ids.txt --apply

# Seniority
DATABASE_URL="$DB" npx tsx scripts/backfill-seniority-hints.ts --ids /tmp/seniority-backfill-ids.txt
DATABASE_URL="$DB" npx tsx scripts/backfill-seniority-hints.ts --ids /tmp/seniority-backfill-ids.txt --apply
```

## Research runner

For experiments with tunable parameters (thresholds, toggles, confidence floors):

```bash
npx tsx scripts/research-runner.ts --program research/programs/<name>.json
npx tsx scripts/research-runner.ts --program <path> --seed 42
```

Only use the runner when there are real knobs to sweep. Otherwise run the evaluator directly.

## Live fixture collection

`scripts/collect-live-location-samples.ts` queries Serper to generate new fixture candidates.

```bash
npx tsx scripts/collect-live-location-samples.ts --db-only --limit 50
npx tsx scripts/collect-live-location-samples.ts --limit 20
```

Output needs manual labeling before use as fixtures.

## Rules

- **Never put live Serper calls in evaluator loops.** Fixtures are static. Live API is for fixture generation only.
- **Never treat gap/discovery datasets as regression gates.** They find new failure modes, not pass/fail.
- **Never backfill from random samples.** Audit first, generate approved ID list, dry-run, then apply.
- **Never mix extraction accuracy with currentness.** These are separate experiments.
