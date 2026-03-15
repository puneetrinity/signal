# Title Extraction Experiment — Phase 1: Extraction Accuracy

## Recruiter Decision

"Is this the right kind of person?"

The headline shown to recruiters must faithfully represent what the SERP says about the candidate. Phase 1 measures whether `extractHeadlineFromTitle` and `extractCompanyFromHeadline` correctly parse LinkedIn SERP titles.

Phase 1 does **not** address whether the headline is current (that is Phase 2: currentness).

## Extraction Functions Under Test

```
extractHeadlineFromTitle(title: string): string | null
extractCompanyFromHeadline(headline: string | null): string | null
```

Both live in `src/lib/enrichment/hint-extraction.ts`. These are pure functions with no tunable knobs.

## Fixture Format

```jsonl
{
  "id": "ttl_001",
  "linkedinId": "sarah-chen-dev",
  "caseType": "standard_dash",
  "serp": {
    "title": "Sarah Chen - Senior Software Engineer at Stripe | LinkedIn",
    "snippet": "...",
    "meta": {}
  },
  "gold": {
    "headline": "Senior Software Engineer at Stripe",
    "company": "Stripe"
  }
}
```

### Gold label rules

- `headline` — the exact headline the SERP title contains after the name delimiter. null if no headline is present or parseable.
- `company` — the company extracted from the headline. null if no company in headline.
- Both reflect what the SERP **says**, not ground-truth career data. This evaluator measures extraction accuracy, not data quality.
- Every fixture has a single deterministic expected output. No ambiguous "depends on parse" cases.

### Fields

- `id` — unique fixture identifier (ttl_NNN for core, ttl_adv_NNN for adversarial)
- `linkedinId` — LinkedIn slug (used as display identifier)
- `caseType` — optional tag for pattern classification (e.g. `notification_badge`, `company_only`)
- `serp.title` — the scored input for Phase 1
- `serp.snippet` — context only, not scored in Phase 1
- `serp.meta` — context only, not scored in Phase 1
- `gold.headline` — expected headline extraction result
- `gold.company` — expected company extraction result

### Fixture files

- `research/datasets/title-fixtures-core.jsonl` — ~25 standard patterns
- `research/datasets/title-fixtures-adversarial.jsonl` — ~20 edge cases

## Core Fixture Coverage

Standard patterns that should all produce correct extractions:

- Standard dash: `"Name - Title at Company | LinkedIn"`
- Standard pipe: `"Name | Title at Company | LinkedIn"`
- Middot: `"Name · Title · Company | LinkedIn"`
- Mixed middot+pipe: `"Name · Staff Engineer at SAP | LinkedIn"`
- @ company: `"Name - Designer @ Figma | LinkedIn"`
- Multi-dash: `"Name - VP Engineering - Databricks | LinkedIn"`
- No company: `"Name - Backend Engineer | LinkedIn"`
- Name only: `"Name | LinkedIn"` → headline=null
- Comma name format: `"Last, First - Title at Company | LinkedIn"`
- Long headline: `"Name - Co-Founder & CEO at Startup, Board Member | LinkedIn"`
- Non-English name: `"田中裕子 - シニアエンジニア | LinkedIn"`
- Non-English headline+company: `"Hans Müller - Entwickler bei SAP | LinkedIn"` → gold.headline=`"Entwickler bei SAP"`, gold.company=null. Current code does not recognize `bei` as a company indicator via the `at`/`@` pattern, but `isLikelyCompany` matches the full headline as a false positive (returning `"Entwickler bei SAP"` as company). Gold is set to null per Phase 1 scoping — adding `bei`/`chez`/`en` support is a code change, not a baseline label.
- "at the" pattern: `"Name - Researcher at the Allen Institute | LinkedIn"` → gold.company=`"the Allen Institute"`. The academic filter only rejects `the university|college|institute|school` immediately after "the"; "the Allen Institute" starts with "the Allen" so it passes and is returned correctly.
- Stopword company: `"Name - Engineer at Bank of America | LinkedIn"`
- Punctuation company: `"Name - Engineer at AT&T | LinkedIn"`, `"Name - PM at J.P. Morgan | LinkedIn"`
- Credentials in name: `"John Smith, MBA - VP Product at Acme | LinkedIn"`
- Minimal dash suffix: `"Name - LinkedIn"` → headline=null

## Adversarial Fixture Coverage

Edge cases that must return null or handle gracefully:

- `notification_badge`: `"(3) Name - Title at Company | LinkedIn"` → should strip badge, extract normally
- `multi_badge`: `"(3) (1) Name - Title at Company | LinkedIn"` → extracts normally; the current regex strips the leading `(3)` and the `(1)` ends up in the discarded name portion before the delimiter, so extraction succeeds via delimiter position rather than multi-badge stripping
- `bare_linkedin`: `"LinkedIn"` → null/null
- `company_only`: `"Stripe | LinkedIn"` → null/null (can't distinguish from name)
- `truncated`: `"Senior Softwa..."` → null/null
- `no_delimiter`: `"JohnSmithSoftwareEngineer"` → null/null
- `url_as_title`: `"https://www.linkedin.com/in/jsmith"` → null/null
- `credential_noise`: `"Dr. Sarah Lee, PhD, PMP - Consultant | LinkedIn"` → headline="Consultant", company=null
- `stale_fragment`: `"John Doe - Former CTO at Acme | LinkedIn"` → headline=`"Former CTO at Acme"`, company=`"Acme"`. This is intentionally treated as correct Phase 1 extraction — the title literally says "Former CTO at Acme" and the extractor faithfully reproduces it. Detecting staleness ("Former") is a Phase 2 currentness concern, not a Phase 1 extraction error.
- `empty_after_dash`: `"Sarah Chen - | LinkedIn"` → null/null
- `all_caps`: `"JOHN DOE - SENIOR MANAGER AT IBM | LinkedIn"` → headline="SENIOR MANAGER AT IBM", company="IBM"
- `html_entities`: `"Name - Engineer &amp; Designer | LinkedIn"` → as-is extraction
- `emoji_in_title`: `"Name - 🚀 Engineer at Startup | LinkedIn"` → gold.headline=`"🚀 Engineer at Startup"`, gold.company=`"Startup"`. Emoji is passthrough; delimiter parsing unaffected.
- `very_long`: `"Name - Head of Engineering, Platform Infrastructure, Developer Experience, and Cloud Architecture at MegaCorp International Holdings Group | LinkedIn"` → gold.headline=full string after delimiter, gold.company=`"MegaCorp International Holdings Group"`. Tests that long headlines are not truncated.
- `reversed_company_title`: `"Acme Corp - John Doe | LinkedIn"` → gold.headline=`"John Doe"`, gold.company=null. The parser takes everything after the first ` - ` delimiter as headline; "John Doe" is a name, not a company, so company extraction returns null. This documents a known false headline (name parsed as headline when company comes first).
- `non_linkedin_suffix`: `"Name - Engineer at Acme | Indeed"` → headline=`"Engineer at Acme | Indeed"`, company=`"Acme"`. The current code only strips `| LinkedIn`, so `| Indeed` stays in the headline. Gold labels reflect current behavior; if we later want to strip arbitrary site suffixes, that's a code change tracked by a new fixture.

## Evaluator

**File:** `scripts/eval-title-hints.ts`

### Pipeline (per fixture)

1. `extractHeadlineFromTitle(fixture.serp.title)` → extracted headline
2. `extractCompanyFromHeadline(extractedHeadline)` → extracted company
3. Compare headline against `gold.headline`
4. Compare company against `gold.company` **independently** — company verdict is compared against gold.company regardless of headline verdict. Note: company extraction receives the *extracted* headline as input (step 2), so a headline extraction error can cascade into a company error. "Independently" means the scoring/verdict is separate, not that the pipeline is decoupled.

### Normalization

```typescript
function normalizeForComparison(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}
```

Only lowercase, trim, and whitespace collapse. No semantic normalization. Differences in seniority words (senior, staff, lead), company names, or any meaningful content are real failures.

### Verdicts (per field)

- `MATCH` — normalized extracted === normalized gold
- `MISMATCH` — both non-null, don't match
- `FALSE_POSITIVE` — gold=null, extracted!=null
- `MISS` — gold!=null, extracted=null
- `PARTIAL` — one contains the other but not exact match (diagnostic only; does not contribute to headline_accuracy, null_miss_rate, or false_headline_rate — it reduces accuracy implicitly by not being a MATCH)

### Metrics

| Metric | Formula | Denominator |
|--------|---------|-------------|
| `headline_accuracy` | headline MATCH count / denominator | fixtures where `gold.headline != null` |
| `company_accuracy` | company MATCH count / denominator | fixtures where `gold.company != null` |
| `false_headline_rate` | headline FALSE_POSITIVE count / total | all fixtures |
| `false_company_rate` | company FALSE_POSITIVE count / total | all fixtures |
| `null_miss_rate` | headline MISS count / denominator | fixtures where `gold.headline != null` |
| `headline_partial_match_rate` | headline PARTIAL count / denominator | fixtures where `gold.headline != null` |
| `company_partial_match_rate` | company PARTIAL count / denominator | fixtures where `gold.company != null` |

### Objective function

```
headline_accuracy + 0.25 * company_accuracy - false_headline_rate - 0.5 * null_miss_rate
```

- Headline accuracy is primary
- Company accuracy weighted at 0.25 (secondary signal)
- False positives penalized at full weight (inventing a headline is worse than missing one)
- Misses penalized at half weight

### Failure output

For every MISMATCH, FALSE_POSITIVE, or MISS, print:

- fixture id
- caseType (if present)
- raw extracted value (before normalization)
- normalized compared values (after normalization)
- gold value

Grouped by verdict type for easy scanning.

### CLI

```
npx tsx scripts/eval-title-hints.ts
npx tsx scripts/eval-title-hints.ts --verbose
npx tsx scripts/eval-title-hints.ts --fixtures research/datasets/title-fixtures-adversarial.jsonl
```

### Export

```typescript
export async function run(config: Record<string, unknown>): Promise<EvalResult>
```

Returns `{ objective, metrics, artifacts }` — compatible with research-runner when knobs appear later.

## Research Program

No research program file for Phase 1. The extraction functions have no tunable knobs (no thresholds, no toggles, no confidence floors). Run the evaluator directly.

When knobs appear (e.g. delimiter priority, confidence thresholds, KG override policy), create `research/programs/enrichment-title-hints.json`.

## Improvement Cycle

After fixtures and evaluator are built:

1. Run eval on core fixtures → establish baseline headline_accuracy and company_accuracy
2. Run eval on adversarial fixtures → find false positives and parsing failures
3. Fix extraction code in `hint-extraction.ts` where eval reveals real bugs
4. Re-run both fixture sets → confirm fixes, no regressions
5. Build `scripts/audit-title-backfill.ts` → query prod DB, re-extract from stored `searchTitle`, compare against stored `headlineHint`
6. Generate ID list of candidates where extraction improved
7. Targeted backfill: dry-run first, then apply

## Out of Scope (Phase 1)

- Currentness / isCurrent labels (Phase 2)
- Snippet-based title extraction
- KG/answerBox override scoring (meta in fixtures but not scored)
- Seniority classification (Phase 3)
- Research program / parameter tuning (no knobs yet)
- Backfill (comes after baseline measurement + fixes)
