# SERP Metadata Improvements — Implementation Plan

**Created:** 2026-02-12
**Status:** Ready for Implementation
**Scope:** Improve utilization of Serper.dev metadata across bridge discovery, hint extraction, and scoring

---

## Problem Statement

Serper.dev returns rich metadata (Knowledge Graph, answerBox, organic results with position) but we currently extract only 4 fields (`title`, `link`, `snippet`, `position`) and discard the rest. The hint extraction pipeline is ASCII-only and hardcoded. Bridge discovery underutilizes available hints when name confidence is low. These gaps reduce recall and confidence accuracy.

---

## Current Architecture (Before)

```
Serper API (returns KG, answerBox, organic[])
    ↓ discards KG, answerBox
SerperOrganicResult { title, link, snippet, position }
    ↓ recalculates position as results.length + 1
RawSearchResult { url, title, snippet, position, score }
    ↓
ProfileSummary (parse name/headline/location from title/snippet)
    ↓ stored on Candidate (searchTitle, searchSnippet, hints)
    ↓
loadCandidateNode() → CandidateHints (drops serpTitle, serpSnippet)
    ↓
discoverGitHubIdentities()
    ↓ calls extractAllHintsWithConfidence(nameHint, headlineHint)
    ↓ ← passes parsed hints as pseudo title/snippet (BUG)
buildSearchQueries() → confidence-gated queries (no company_only/company_location)
    ↓
URL-anchored reverse search → title/snippet stored but never analyzed
    ↓
scoring.ts → hardcoded confidence, no hint provenance, no SERP position
```

## Target Architecture (After)

```
Serper API (returns KG, answerBox, organic[])
    ↓ captures KG + answerBox into providerMeta
RawSearchResult { url, title, snippet, position, score, providerMeta? }
    ↓ position = ((page - 1) * numPerPage) + (r.position || idx + 1)
ProfileSummary → stored on Candidate (searchTitle, searchSnippet, searchMeta)
    ↓
loadCandidateNode() → CandidateHints (includes serpTitle, serpSnippet, serpMeta)
    ↓ mergeHintsFromSerpMeta(): KG > answerBox > title > snippet > slug
    ↓
discoverGitHubIdentities()
    ↓ calls extractAllHintsWithConfidence(serpTitle, serpSnippet) ← real SERP data
buildSearchQueries() → company_only, company_location when name is weak
    ↓
URL-anchored reverse search → title/snippet analyzed for company/location corroboration
    ↓ assigns linkedin_url_in_team_page when /team|/about|/people detected
    ↓ merges Serper + Brave results (dedup by URL)
    ↓
scoring.ts → dynamic confidence (shadow mode), serpPosition tiebreaker
```

---

## Implementation Steps

### Step 1: SERP Metadata Plumbing (KG + answerBox)

**Files:**
- `src/lib/search/providers/types.ts`
- `src/lib/search/providers/serper.ts`
- `src/lib/enrichment/sources/search-executor.ts`
- `src/app/api/v2/search/route.ts`
- `src/types/linkedin.ts`
- `src/lib/search/providers/index.ts`
- `prisma/schema.prisma`

**Changes:**

1. **types.ts** — Add `providerMeta?: Record<string, unknown>` to `RawSearchResult` (keep `engines?` as legacy for SearXNG):
   ```typescript
   export interface RawSearchResult {
     url: string;
     title: string;
     snippet: string;
     position: number;
     score?: number;
     engines?: string[];  // legacy SearXNG only
     providerMeta?: Record<string, unknown>;
   }
   ```

2. **serper.ts** — Extend `SerperResponse` to capture KG + answerBox:
   ```typescript
   interface SerperKnowledgeGraph {
     title?: string;
     type?: string;
     description?: string;
     attributes?: Record<string, string>;
   }

   interface SerperAnswerBox {
     title?: string;
     answer?: string;
     snippet?: string;
   }

   interface SerperResponse {
     organic?: SerperOrganicResult[];
     knowledgeGraph?: SerperKnowledgeGraph;
     answerBox?: SerperAnswerBox;
   }
   ```
   Attach to each result in `searchRaw()` and `searchLinkedInProfiles()`:
   ```typescript
   providerMeta: {
     ...(response.knowledgeGraph ? { knowledgeGraph: response.knowledgeGraph } : {}),
     ...(response.answerBox ? { answerBox: response.answerBox } : {}),
   }
   ```

3. **schema.prisma** — Add `searchMeta Json?` to Candidate model (nullable, backward-compatible migration)

4. **route.ts** — In `upsertCandidates()`, pass `providerMeta` through `ProfileSummary` and write to `Candidate.searchMeta` in both `create` and `update` blocks

5. **linkedin.ts** — Add `providerMeta?: Record<string, unknown>` to `ProfileSummary` interface

6. **search/providers/index.ts** — Ensure `searchLinkedInProfilesWithMeta()` returns `ProfileSummary` with `providerMeta` intact (no strip/transform)

7. **search-executor.ts** — Pass `providerMeta` through replay mode mock results (set to `undefined`)

**Migration:** `npx prisma migrate dev --name add_candidate_search_meta`

**Eval impact:** None — no scoring or hint logic changes

---

### Step 2: Stale Comment Cleanup

**Files:**
- `src/lib/search/providers/types.ts` — Line 4: change "BrightData, SearXNG, Brave" → "Serper, Brave (legacy: BrightData, SearXNG)"
- `src/lib/enrichment/sources/search-executor.ts` — Lines 3, 9, 14: update to "Serper (primary), Brave (fallback)"
- `src/lib/enrichment/bridge-discovery.ts` — Lines 414, 467: "Brave/SearXNG" → "Serper + Brave"
- `prisma/schema.prisma` — `SearchCacheV2.provider` comment (line 413): add 'serper'
- `SearchProviderType` union: keep `'brightdata' | 'searxng'` but add `// legacy` comment

**Eval impact:** None — comments only

---

### Step 3: Fix Hint Data Loss (Real SERP Data Flow)

**Files:**
- `src/lib/enrichment/bridge-discovery.ts` — `CandidateHints` interface
- `src/lib/enrichment/index.ts` — `candidateToHints()` function (line 69)
- `src/lib/enrichment/graph/nodes.ts` — `loadCandidateNode()` function (line 193)
- `src/lib/enrichment/graph/types.ts` — `EnrichmentHints` interface

**Changes:**

1. **CandidateHints** — Add optional fields:
   ```typescript
   export interface CandidateHints {
     // ... existing fields ...
     serpTitle?: string;
     serpSnippet?: string;
     serpMeta?: Record<string, unknown>;
   }
   ```

2. **EnrichmentHints** (graph/types.ts) — Add same fields so the graph state carries SERP data

3. **candidateToHints()** (index.ts:69) — Map `candidate.searchTitle`, `candidate.searchSnippet`, `candidate.searchMeta`:
   ```typescript
   function candidateToHints(candidate: Candidate): CandidateHints {
     return {
       // ... existing fields ...
       serpTitle: candidate.searchTitle ?? undefined,
       serpSnippet: candidate.searchSnippet ?? undefined,
       serpMeta: candidate.searchMeta as Record<string, unknown> ?? undefined,
     };
   }
   ```

4. **loadCandidateNode()** (nodes.ts:263) — Include SERP fields in hints object

5. **discoverGitHubIdentities()** (bridge-discovery.ts:635) — Use `hints.serpTitle` and `hints.serpSnippet` instead of `hints.nameHint` and `hints.headlineHint`:
   ```typescript
   const enrichedHints = extractAllHintsWithConfidence(
     hints.linkedinId,
     hints.linkedinUrl,
     hints.serpTitle || hints.nameHint || '',   // real SERP title
     hints.serpSnippet || hints.headlineHint || '',  // real SERP snippet
     hints.roleType
   );
   ```

**Eval impact:** Confidence scores may shift slightly since hints are now derived from real SERP data instead of pre-parsed values. Run eval to verify.

---

### Step 4: Integrate KG + answerBox into Hints

**Files:**
- `src/lib/enrichment/hint-extraction.ts`
- `src/lib/enrichment/bridge-types.ts`
- `src/lib/enrichment/graph/nodes.ts`

**Changes:**

1. **bridge-types.ts** — Add HintSource values:
   ```typescript
   export type HintSource =
     | 'serp_title'
     | 'serp_snippet'
     | 'serp_knowledge_graph'  // NEW
     | 'serp_answer_box'       // NEW
     | 'url_slug'
     | 'search_query'
     | 'headline_parse'
     | 'unknown';
   ```

2. **hint-extraction.ts** — Add `mergeHintsFromSerpMeta()`:
   ```typescript
   export function mergeHintsFromSerpMeta(
     existing: EnrichedHints,
     serpMeta?: Record<string, unknown>
   ): EnrichedHints {
     if (!serpMeta) return existing;

     const kg = serpMeta.knowledgeGraph as SerperKnowledgeGraph | undefined;
     const ab = serpMeta.answerBox as SerperAnswerBox | undefined;

     // Precedence: KG (0.95) > answerBox (0.90) > existing
     // Only upgrade if KG/AB confidence exceeds existing
     // ... merge logic with fallback path when metadata absent
   }
   ```

3. **nodes.ts loadCandidateNode()** — Call merge in this order:
   1. Load stored hints from Candidate fields (existing lines 229-242)
   2. Call `mergeHintsFromSerpMeta(candidate.searchMeta)` — can upgrade any hint
   3. Null-fill remaining gaps from `extractAllHints(searchTitle, searchSnippet)` (existing lines 244-255)
   4. Last resort: slug name extraction (existing lines 258-260)

**Eval impact:** KG data is rare (well-known people only). Most candidates will follow existing path. Add eval fixtures with KG present.

---

### Step 5: SERP Ranking Fix + Tiebreaker

**Files:**
- `src/lib/search/providers/serper.ts`
- `src/lib/enrichment/bridge-discovery.ts`
- `src/lib/enrichment/sources/types.ts`
- `src/lib/enrichment/sources/base-source.ts`

**Changes:**

1. **serper.ts searchRaw()** (line 283-306) — Fix position calculation:
   ```typescript
   for (let page = 1; page <= maxPages && results.length < maxResults; page++) {
     const pageOffset = (page - 1) * numPerPage;
     // ... existing fetch logic ...
      for (const [idx, r] of organic.entries()) {
        // ...
        results.push({
          url,
          title: r.title || '',
          snippet: r.snippet || '',
          position: pageOffset + (r.position ?? (idx + 1)),
        });
      }
    }
    ```

2. **bridge-discovery.ts DiscoveredIdentity** — Add `serpPosition?: number`

3. **sources/types.ts DiscoveredIdentity** — Add `serpPosition?: number` for search-based discoveries

4. **bridge-discovery.ts** — Populate serpPosition from URL-anchored results in `processLogin()` via `reverseBridgeMap`

5. **base-source.ts** — Carry `result.position` into discovered identities as `serpPosition`

6. **base-source.ts** — Apply tiebreaker in search-based sorting (confidence desc, then serpPosition asc when |Δ| ≤ 0.01)

7. **bridge-discovery.ts sort** (line 869) — Tiebreaker with 0.01 epsilon:
   ```typescript
   identitiesFound.sort((a, b) => {
     const tierDiff = (a.bridgeTier || 3) - (b.bridgeTier || 3);
     if (tierDiff !== 0) return tierDiff;
     const confDiff = b.confidence - a.confidence;
     if (Math.abs(confDiff) > 0.01) return confDiff;
     return (a.serpPosition ?? Infinity) - (b.serpPosition ?? Infinity);
   });
   ```

**Design decision:** SERP position is ordering-only, no confidence mutation. 0.01 epsilon = smallest meaningful scoring signal (profileCompleteness 0.05 * 0.2).

**Eval impact:** Sort order may change within 0.01 bands. No confidence values change.

---

### Step 6: Expand Bridge Queries (company_only, company_location, budget)

**Files:**
- `src/lib/enrichment/bridge-types.ts`
- `src/lib/enrichment/bridge-discovery.ts`

**Changes:**

1. **bridge-types.ts QueryType** — Add new types:
   ```typescript
   export type QueryType =
     | 'name_only'
     | 'name_company'
     | 'name_location'
     | 'company_only'        // NEW
     | 'company_location'    // NEW
     | 'slug_based'
     | 'handle_based'
     | 'url_reverse'
     | 'company_amplified';
   ```
   Also add to `createEmptyMetrics()` initializer.

2. **bridge-discovery.ts buildSearchQueries()** — Add new query phase:
   ```typescript
   // === Phase 1.5: Company/Location-centric queries (when name is weak) ===
   if (companyHint && companyConfidence >= 0.85 && nameConfidence < CONFIDENCE_THRESHOLDS.MEDIUM) {
     addQuery(`"${companyHint}" linkedin`, 'company_only', 'company_only');
     if (hints.locationHint && locationConfidence >= CONFIDENCE_THRESHOLDS.MEDIUM) {
       addQuery(`"${companyHint}" ${hints.locationHint}`, 'company_location', 'company+location');
     }
   }
   ```

3. **Query budget** — Add `ENRICHMENT_BRIDGE_QUERY_BUDGET` (default 8) and enforce in `buildSearchQueries()`:
   ```typescript
   const MAX_QUERIES = parseInt(process.env.ENRICHMENT_BRIDGE_QUERY_BUDGET || '8', 10);
   // ... at end of function:
   return queries.slice(0, MAX_QUERIES);
   ```

4. **Role gating** — Only generate `name+tech` queries for technical roleTypes:
   ```typescript
   if (hints.headlineHint && (hints.roleType === 'engineer' || hints.roleType === 'data_scientist' || hints.roleType === 'researcher')) {
     const techKeywords = extractTechKeywords(hints.headlineHint);
     // ...
   }
   ```

**Eval impact:** More queries generated for low-name-confidence candidates. Recall should improve. Add fixtures with weak name + strong company.

---

### Step 7: Hint Extraction Low-Risk Fixes (3a)

**File:** `src/lib/enrichment/hint-extraction.ts`

**Changes:**

1. **Location regex** — Support `City, ST` (two-letter state codes):
   ```typescript
   // Pattern 2: support "San Francisco, CA"
   const cityMatch = snippet.match(/^([A-Z][A-Za-z\s]+(?:,\s*[A-Z]{2,}[A-Za-z\s]*))\s*·/);
   ```

2. **Pipe separator** — Add `' | '` to snippet segment splitting:
   ```typescript
   const segments = snippet.split(/\s[·|]\s/);
   ```

3. **Emoji prefix** — Strip leading emoji before location extraction:
   ```typescript
   const cleaned = snippet.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}]\s*/u, '');
   ```

4. **"at the University" false positive** — Add university keywords to exclusion:
   ```typescript
   // In extractCompanyFromHeadline, after atMatch:
   if (atMatch) {
     const candidate = atMatch[1].trim();
     // Reject if it's clearly not a company
     if (/^the\s+(university|college|institute|school)\b/i.test(candidate)) {
       // Fall through to next pattern
     } else {
       return cleanCompanyName(candidate);
     }
   }
   ```

5. **Relax ASCII constraint for company** — Allow non-ASCII first characters in `isLikelyCompany`:
   ```typescript
   // Replace /^[A-Z]/.test(str) with:
   if (/^\p{Lu}/u.test(str) && str.length >= 2 && str.length <= 40) {
   ```

**Eval impact:** Higher recall for location/company extraction. Add fixtures for `City, ST`, emoji, pipe formats.

---

### Step 8: URL-Anchored Improvements

**Files:**
- `src/lib/enrichment/sources/search-executor.ts`
- `src/lib/enrichment/bridge-discovery.ts`
- `src/lib/enrichment/bridge-types.ts`

**Changes:**

1. **Merged Serper + Brave for URL-anchored** — Add helper in `search-executor.ts` to merge Serper + Brave results (dedup by URL, keep best position), used only by URL-anchored discovery:
   ```typescript
   async function searchRawMergedProviders(query: string, max: number): Promise<RawSearchResult[]> {
     // query serper + brave in parallel, merge + dedup by URL
   }
   ```

2. **Carry title/snippet into reverseBridgeMap** — Extend the map value type:
   ```typescript
   const reverseBridgeMap = new Map<string, {
     bridgeUrl: string | null;
     signals: BridgeSignal[];
     title?: string;    // NEW
     snippet?: string;  // NEW
   }>();
   ```

3. **Extract hints from reverse-link title/snippet** — After platform detection (line 514), run hint extraction on the page title/snippet to corroborate company/location with candidate hints

4. **Assign `linkedin_url_in_team_page`** — When `detectPlatformFromUrl` returns `platform: 'companyteam'`, change signal from `'linkedin_url_in_page'` to `'linkedin_url_in_team_page'` (line 517):
   ```typescript
   const signal: BridgeSignal = platform === 'companyteam'
     ? 'linkedin_url_in_team_page'
     : 'linkedin_url_in_page';
   ```

5. **Discount LinkedIn-adjacent domains** — Skip results from domains like `linkedin-leads.com`, `linkedhelper.com` etc.

**Eval impact:** More bridge signals detected. `linkedin_url_in_team_page` is Tier 2 (already defined in bridge-types.ts:142 but never assigned). Add team-page signal fixtures.

---

### Step 9: i18n Hint Extraction (3b — Higher Risk)

**File:** `src/lib/enrichment/hint-extraction.ts`

**Changes:**

1. **Unicode-property name parsing** — Replace `/^[A-Z]/` with `/^\p{Lu}/u`:
   - `isLikelyName()` line 328
   - `extractCompanyFromHeadline()` line 188
   - `isLikelyLocation()` line 418
   - `calculateNameConfidence()` line 448

2. **"Last, First" format** — In `extractNameFromTitle()`, detect comma-first pattern:
   ```typescript
   // If first delimiter is comma and result looks like "Last, First"
   if (delim === ', ' && parts.length === 2 && isLikelyName(parts[1].trim())) {
     const reversed = `${parts[1].trim()} ${parts[0].trim()}`;
     if (isLikelyName(reversed)) return reversed;
   }
   ```

3. **Non-Latin company names** — Allow broader character classes in `extractCompanyFromHeadline()` regex

**Eval impact:** Higher risk of regression on existing English-language fixtures. Ship separately from step 7. Add i18n-specific fixtures.

---

### Step 10: Dynamic Confidence Scoring (Shadow Mode)

**Files:**
- `src/lib/enrichment/hint-extraction.ts`
- `src/lib/enrichment/scoring.ts`
- `src/lib/enrichment/graph/nodes.ts`

**Changes:**

1. **hint-extraction.ts** — Replace hardcoded confidence constants with rule-based scoring considering:
   - Evidence source (KG vs title vs snippet vs slug)
   - Extraction quality indicators (delimiter presence, name length, known city match)
   - Penalties for conflicting signals

2. **scoring.ts** — Add optional `hintConfidence` fields to `ScoringInput`:
   ```typescript
   nameHintConfidence?: number;    // from EnrichedHints
   companyHintConfidence?: number;
   locationHintConfidence?: number;
   ```
   Modulate weights: low-confidence hints get reduced match weights.

3. **Shadow mode** — Compute dynamic confidence alongside existing scoring. Log both to `EnrichmentSession.runTrace`. Do NOT switch scoring path.

4. **Cutover** — Only after eval confirms dynamic scores maintain:
   - Auto-merge precision >= 98%
   - Tier-1 recall >= 85%
   - Persisted identity rate >= 50%

**Eval impact:** Shadow only — no production scoring changes until manual cutover.

---

### Step 11: Tests + Eval Fixtures (Inline with Each Step)

**Files:** `eval/*`, test files

**Fixtures to add per step:**

| Step | Fixtures |
|------|----------|
| 1 | 2-3 candidates with KG data in mock Serper response |
| 3 | Candidate with stored searchTitle/searchSnippet to verify real SERP flow |
| 4 | KG-present + KG-absent candidates (verify fallback) |
| 5 | Two candidates with identical confidence, different positions |
| 6 | Candidate where name confidence < 0.5 but company confidence > 0.85 |
| 7 | `"San Francisco, CA"`, emoji location, pipe separator |
| 8 | Team-page URL signals, LinkedIn-adjacent domain filtering |
| 9 | Non-Latin names, "Last, First" format |
| 10 | Shadow score comparison in eval summary |

---

## Dependency Graph

```
Step 1 (plumbing) ──→ Step 3 (data loss fix) ──→ Step 4 (KG hints)
      │                       │                         │
      ↓                       ↓                         ↓
Step 2 (comments)     Step 5 (position)          Step 10 (dynamic scoring)
                              │
Step 6 (bridge queries)    Step 7 (3a fixes) ──→ Step 8 (URL-anchored) ──→ Step 9 (i18n 3b)
```

**Recommended execution order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11

(Step 7 before 8 so URL-anchored hint extraction benefits from improved parsers)

---

## Files Changed (Summary)

| File | Steps |
|------|-------|
| `src/lib/search/providers/types.ts` | 1, 2 |
| `src/lib/search/providers/serper.ts` | 1, 5 |
| `src/lib/enrichment/sources/search-executor.ts` | 1, 2, 8 |
| `src/app/api/v2/search/route.ts` | 1 |
| `src/types/linkedin.ts` | 1 |
| `prisma/schema.prisma` | 1, 2 |
| `src/lib/enrichment/hint-extraction.ts` | 4, 7, 9, 10 |
| `src/lib/enrichment/bridge-types.ts` | 4, 6, 8 |
| `src/lib/enrichment/bridge-discovery.ts` | 3, 5, 6, 8 |
| `src/lib/enrichment/scoring.ts` | 10 |
| `src/lib/enrichment/index.ts` | 3 |
| `src/lib/enrichment/graph/nodes.ts` | 3, 4, 10 |
| `src/lib/enrichment/graph/types.ts` | 3 |
| `src/lib/enrichment/sources/types.ts` | 5 |
| `src/lib/enrichment/sources/base-source.ts` | 5 |
| `src/lib/search/providers/index.ts` | 1 |
| `eval/*` | 11 |

---

## Eval Gate Invariants

All changes must maintain (from eval/TODO.md):
- Auto-merge precision >= 98%
- Tier-1 recall >= 85%
- Persisted identity rate >= 50%

Run `npm run eval` after each step. Shadow scoring (step 10) logs both old and new scores without affecting production.

---

## Risk Assessment

| Step | Risk | Mitigation |
|------|------|------------|
| 1 | Schema migration | Nullable column, backward-compatible |
| 3 | Confidence shift from real SERP data | Run eval immediately after |
| 4 | KG absent for most candidates | Clean fallback path, test with null KG |
| 6 | More queries = more API cost | Query budget cap (8) |
| 7 | Regex changes may regress | Targeted fixes only, eval per change |
| 8 | Merged Serper+Brave = 2x API calls | Only for URL-anchored queries (max 4) |
| 9 | i18n regex is broad | Ship separately, dedicated eval fixtures |
| 10 | Scoring changes | Shadow-only, manual cutover |

---

**Last Updated:** 2026-02-12
**Owner:** Engineering
