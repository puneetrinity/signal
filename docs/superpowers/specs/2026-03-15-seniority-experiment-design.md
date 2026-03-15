# Phase 3: Seniority Extraction Experiment Design

## Recruiter Question

"Is this person at the right level for the role?"

## Scope

Evaluate the existing `normalizeSeniorityFromText()` from `src/lib/taxonomy/seniority.ts` against gold-labeled headlines. Measure accuracy, identify gaps, then decide whether minor rule fixes or broader redesign is needed.

**Not in scope**: new extraction function, schema changes, backfill, wiring into main hint path, multi-source validation.

## Label Vocabulary

Use the existing function's output vocabulary:

```
intern | junior | mid | senior | staff | principal | lead | manager | director | vp | cxo | null
```

`null` = no seniority detected. No `unknown` label.

Rename/presentation cleanup (e.g., `cxo` -> `exec`) is deferred to post-eval.

## Fixture Format

```jsonl
{
  "id": "sen_001",
  "caseType": "explicit_senior",
  "headline": "Senior Software Engineer at Google",
  "gold": { "seniority": "senior" }
}
```

- **Input**: `headline` (string) — fed directly to `normalizeSeniorityFromText()`
- **Gold**: `seniority` — one of the 11 ladder values or `null`
- Gold reflects *desired* output, not necessarily current function behavior

## Fixture Split

### Core: `research/datasets/seniority-fixtures-core.jsonl` (~25 fixtures)

Coverage per rung, distinguishing what should pass today vs. expected baseline misses.

**Should pass today** (current function matches these keywords):

| Rung | Example | Why it works |
|------|---------|-------------|
| intern | "Software Engineering Intern at Meta" | keyword `intern` |
| junior | "Junior Developer at Shopify" | keyword `junior` |
| mid | "Mid-Level Engineer at Acme" | keyword `mid` (hyphen is word boundary) |
| senior | "Senior Product Manager at AWS" | keyword `senior` |
| staff | "Staff Engineer at Google" | keyword `staff` |
| principal | "Principal Architect at Netflix" | keyword `principal` |
| lead | "Lead Backend Engineer at Uber" | keyword `lead` |
| manager | "Engineering Manager at Spotify" | keyword `manager` |
| director | "Director of Engineering at Datadog" | keyword `director` |
| vp | "VP of Sales at HubSpot" | keyword `vp` |
| cxo | "CxO Advisory at McKinsey" | keyword `cxo` (literal match) |
| null | "Google" | no seniority keyword |
| null | "Building the future of AI" | description, no keyword |

**Expected baseline misses** (gold != current output):

| Gold | Example | Current output | Why it misses |
|------|---------|---------------|---------------|
| mid | "Software Engineer at Stripe" | null | no keyword; mid requires inference |
| vp | "SVP Engineering at Oracle" | null | `SVP` not matched by `\bvp\b` |
| vp | "EVP, Global Sales" | null | `EVP` not matched by `\bvp\b` |
| cxo | "CTO at Startup" | null | `CTO` not matched; only literal `cxo` |
| cxo | "CEO & Co-Founder" | null | same; `CEO` not in vocabulary |
| cxo | "CFO at BigBank" | null | same |
| cxo | "COO at ScaleUp" | null | same |
| cxo | "Former CTO at Acme" | null | `CTO` not in vocabulary |
| senior | "Sr. Software Engineer" | null | `Sr.` not matched by `\bsenior\b` |
| director | "Head of Engineering" | null | `head` not in keyword list |
| junior | "Associate Software Engineer" | null | `associate` not in keyword list |

These are intentional gold labels to expose known gaps in the baseline.

### Adversarial: `research/datasets/seniority-fixtures-adversarial.jsonl` (~15-20 fixtures)

**Scan order / compound titles** (should pass today):

| Case type | Example | Gold | Current output | Notes |
|-----------|---------|------|---------------|-------|
| compound_title | "Senior Staff Engineer" | staff | staff | scan finds staff (idx 4) before senior (idx 3) |
| compound_title_2 | "Senior Lead Designer" | lead | lead | scan finds lead (idx 6) before senior (idx 3) |
| all_caps | "SENIOR MANAGER AT IBM" | manager | manager | case-insensitive; scan finds manager before senior |
| associate_has_director | "Associate Director at JP Morgan" | director | director | `\bdirector\b` matches regardless of "Associate" |
| acting_has_vp | "Acting VP of Engineering" | vp | vp | `\bvp\b` matches regardless of "Acting" |
| managing_has_director | "Managing Director at Goldman" | director | director | `\bdirector\b` matches |
| tech_lead | "Tech Lead at Airbnb" | lead | lead | `\blead\b` matches "Lead" |

**Noise / formatting** (should pass today):

| Case type | Example | Gold | Current output | Notes |
|-----------|---------|------|---------------|-------|
| emoji_noise | "🚀 Staff Engineer at Startup" | staff | staff | emoji doesn't affect word boundaries |
| credential_noise | "Dr. Sarah Lee, PhD - Consultant" | null | null | no seniority keyword present |
| founding_not_level | "Founding Engineer at Startup" | null | null | "founding" is not a seniority keyword |
| no_seniority_role | "Account Executive at Salesforce" | null | null | role title, no level keyword |
| number_prefix | "L6 Software Engineer" | null | null | level numbers not supported |

**Potential false positives** (keyword appears in non-seniority context):

| Case type | Example | Gold | Current output | Notes |
|-----------|---------|------|---------------|-------|
| lead_in_verb | "Leading AI Research at DeepMind" | null | null | "Leading" ≠ `\blead\b` (no boundary after d) |
| intern_in_word | "International Sales at Acme" | null | null | "International" ≠ `\bintern\b` |
| senior_in_company | "Senior Living Solutions" | null | senior | `\bsenior\b` matches — potential FP |

## Evaluator: `scripts/eval-seniority.ts`

Same shape as `eval-title-hints.ts`:

### Interface

```typescript
export async function run(config: Record<string, unknown> = {}): Promise<EvalResult>
```

### Verdicts (per fixture)

- **MATCH**: extracted === gold
- **MISMATCH**: both non-null but different
- **FALSE_POSITIVE**: gold === null, extracted !== null
- **MISS**: gold !== null, extracted === null

### Metrics

| Metric | Denominator |
|--------|-------------|
| `accuracy` | fixtures where gold !== null |
| `false_positive_rate` | all fixtures |
| `miss_rate` | fixtures where gold !== null |
| `mismatch_rate` | fixtures where gold !== null |

### Objective

```
accuracy - false_positive_rate - 0.5 * miss_rate
```

Note: misses reduce both `accuracy` and `miss_rate`, so they are penalized ~1.5x vs mismatches at 1.0x. This is intentional — a miss (returning null when seniority exists) is worse than a mismatch (returning wrong level) for recruiter decisions.

### CLI

```
npx tsx scripts/eval-seniority.ts
npx tsx scripts/eval-seniority.ts --fixtures research/datasets/seniority-fixtures-adversarial.jsonl
npx tsx scripts/eval-seniority.ts --verbose
```

### Failure output

Grouped by verdict, shows:
- fixture id, caseType
- raw extracted value
- gold value

## Decision Rule After Baseline

1. If accuracy >= 80% and FP rate = 0%: minor rule fixes, then wire into hint path
2. If accuracy < 80% or FP rate > 0%: inspect failure patterns, decide scope of fixes
3. Do not backfill or wire until eval passes acceptance threshold

## Expected Baseline Prediction

Given that `normalizeSeniorityFromText()` is a pure keyword matcher:

- **Will pass**: any headline containing an explicit keyword (senior, staff, lead, manager, director, vp, principal, intern, junior)
- **Will miss**: implicit mid (no keyword), C-suite titles (CTO, CEO, CFO, COO), compound prefixes (SVP, EVP), abbreviations not in regex (Sr.), compound rankings handled by scan order (e.g., "Senior Staff" → staff, "Senior Lead" → lead)
- **FP rate expected to be low**: function only matches known keywords, but can FP when seniority words appear in non-seniority contexts (e.g., "Senior Living Solutions" → `senior`, "Director's Cut" → `director`)

Predicted baseline: high precision, moderate recall, low FP rate. The eval will confirm.

## Deliverables

1. `research/datasets/seniority-fixtures-core.jsonl`
2. `research/datasets/seniority-fixtures-adversarial.jsonl`
3. `scripts/eval-seniority.ts`
4. Baseline results + failure analysis
