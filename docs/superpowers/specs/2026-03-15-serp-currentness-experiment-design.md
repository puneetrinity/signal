# Phase 5: SERP Currentness Experiment

## Recruiter questions

1. **Is this the candidate's current title/role?** — or a former position from the snippet timeline?
2. **Is this the candidate's current location?** — or somewhere they used to be?

## Problem

SERP snippets mix present and past:

```
Senior Engineer at Google. Jan 2024 - Present. Previously Staff Engineer
at Meta. 2019-2023. Based in San Francisco.
```

```
Product Manager at Stripe · Mumbai, India · Former PM at Flipkart ·
Bangalore, India · 2018-2021
```

Current hint extraction treats everything as current. A candidate who moved from Mumbai to NYC still gets `locationHint: "Mumbai"` if that appears first in the snippet. A candidate who left Google in 2022 still gets `headlineHint: "Engineer at Google"`.

## Current state

- `extractHeadlineFromTitle()` — takes everything after first delimiter in SERP title. No temporal parsing.
- `extractLocationFromSnippet()` — 6 extraction patterns, all positional. No temporal awareness.
- Confidence scoring exists but has no temporal penalty.
- The only temporal hint: headline extraction stops at commas, which incidentally avoids some "formerly at" patterns.

## Scope

Can we tell whether SERP title/location evidence is current vs historical?

Not in scope: identity, ranking weight changes, enrichment pipeline changes.

## Approach

### Signal taxonomy

**Strong current markers:**
- `present` (in date range: "Jan 2024 - Present")
- `currently`, `current`
- `now at`, `now based in`, `now in`
- CJK: `現在` (Japanese/Chinese for Present), `2020年4月 - 現在`
- Non-English: `presente` (Spanish/Portuguese), `atual` (Portuguese)
- `joined` / `since YYYY`
- `promoted from/to`
- `I've been at/here/with`
- `present at the company`

**Strong historical markers:**
- `formerly`, `former` (with false-positive guard for company names like "Former's Brewing")
- `previously`, `previous`
- `ex-` (prefix: "Ex-Google", with exclusion for expert/experience/etc.)
- Date range with end date: `2019 - 2023`, `Jan 2020 - Dec 2022`
- `left in YYYY`, `departed`, `resigned`
- `previously in`, `formerly in` (location-specific)

**Direction-aware relocation markers:**
- `moved to X` / `relocated to X` → X is current (destination)
- `moved from X` / `relocated from X` → X is historical (origin)
- Generic `relocated`/`moved` without direction: not used as standalone signal

**Ambiguous (not enough on their own):**
- `based in` — could be current or biographical
- `active` — too broad without heavy constraint (dropped from strong markers)
- Bare date: `2020` — could be start or end
- `at Company` — could be current or historical headline

**False-positive guards:**
- `presenter`, `presentation`, `presenting` — not "present" temporal marker
- `former's`, `formers` — company name or possessive, not "former" temporal marker

### Detection approach

Narrow deterministic rules, not NLP:

1. Scan snippet for temporal markers
2. Associate markers with nearby title/location mentions
3. Output a currentness signal per hint: `current`, `historical`, `unknown`

### Fixture format

```json
{
  "id": "curr_001",
  "searchTitle": "Jane Doe - Senior Engineer at Google | LinkedIn",
  "searchSnippet": "Senior Engineer at Google. Jan 2024 - Present. San Francisco Bay Area.",
  "evaluated_location": "San Francisco Bay Area",
  "gold": {
    "title_currentness": "current",
    "location_currentness": "current"
  },
  "note": "Present marker makes both current"
}
```

Gold labels: `current`, `historical`, `unknown` (genuinely ambiguous).

`evaluated_location` decouples currentness detection from location extraction — the gold label refers to this specific location's currentness, regardless of which location the extractor would pick.

### Evaluator metrics

- `current_title_accuracy` — % correct on title currentness
- `current_location_accuracy` — % correct on location currentness
- `stale_title_fp_rate` — % of historical titles classified as current
- `stale_location_fp_rate` — % of historical locations classified as current
- `unknown_rate` — % classified as unknown (measure of coverage)

### Target

- Stale title FP rate < 10%
- Stale location FP rate < 10%
- Unknown rate < 40%

### v1 Results (2026-03-15)

45 fixtures across 3 datasets (15 title-core, 15 location-core, 15 adversarial).

| Metric | Result | Target | Status |
|---|---|---|---|
| Overall accuracy | 90.0% (54/60) | — | — |
| Title accuracy | 96.7% (29/30) | — | — |
| Location accuracy | 83.3% (25/30) | — | — |
| Stale title FP rate | **0%** (0/7) | <10% | PASS |
| Stale location FP rate | **0%** (0/5) | <10% | PASS |
| Title unknown rate | 33.3% (10/30) | <40% | PASS |
| Location unknown rate | 43.3% (13/30) | <40% | MARGINAL |

Location unknown rate is slightly above target. Accepted because:
- FP is 0% — no dangerous overclaiming
- Remaining misses are exactly the ambiguous cases intentionally left conservative
- Fixing them requires broader inference (current role implies current location) which risks raising FP

**Remaining 6 misses (all conservative):**
- 1 title: clause reach (Present two clauses from title mention)
- 4 location: no direct temporal marker in location clause (Mumbai, Austin, NY, Mountain View)
- 1 location: promoted marker bleeds into location classification

**What NOT to do next:**
- Do not use currentness in ranking until prod audit completes
- Do not chase the remaining conservative misses — they require broader inference and risk FP

## Fixture categories

### Title currentness core (~15 fixtures)
- "Present" date range with current role
- "Currently" in snippet
- No temporal markers (ambiguous)
- Single role, no timeline

### Location currentness core (~15 fixtures)
- Location with "Present" nearby
- "Based in" with current role
- Location only with historical role
- Multiple locations in timeline

### Adversarial (~15 fixtures)
- "Present" as a gift/noun, not temporal
- "Former" in company name ("Former's Brewing Co")
- Mixed timeline: current title but historical location
- Short snippet with no temporal signals
- Non-English date formats

## Implementation plan

1. ~~Build fixtures~~ — DONE (45 fixtures across 3 datasets)
2. ~~Build evaluator with baseline~~ — DONE
3. ~~Add `detectCurrentness(searchTitle, searchSnippet)` helper~~ — DONE (in evaluator, not yet in production code)
4. Prod audit on timeline-heavy snippets — NEXT
5. Wire into hint extraction as metadata (not blocking extraction) — after prod audit
6. Ranking weight changes — after prod audit confirms safety

## Key files

- `src/lib/enrichment/hint-extraction.ts` — likely home for temporal parsing
- `scripts/eval-serp-currentness.ts` — evaluator
- `research/datasets/serp-currentness-*.jsonl` — fixtures

## What NOT to do

- Don't block hint extraction on currentness. Extract first, annotate after.
- Don't build broad NLP. Stick to narrow marker rules.
- Don't change ranking weights yet. Measure first.
- Don't mix with identity/reachability experiments.
