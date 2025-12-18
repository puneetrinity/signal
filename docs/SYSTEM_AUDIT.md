# PeopleHub System Audit

**Date**: 2025-12-18
**Auditor**: Claude Code
**Scope**: End-to-end pipeline analysis from NL query → search → LinkedIn results → enrich

---

## 1. CURRENT SYSTEM SPEC

### 1.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (Next.js)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  /search page                      │  /enrich/[candidateId] page            │
│  - NL query input                  │  - SSE progress streaming              │
│  - Results grid (ProfileSummaryCard)│  - AI Summary display                  │
│  - "Enrich" button → new tab       │  - Identity candidates list            │
└─────────────────────────────────────────────────────────────────────────────┘
                    │                                    │
                    ▼                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API LAYER                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  POST /api/v2/search               │  POST /api/v2/enrich/async             │
│  - Groq query parsing              │  - Creates EnrichmentSession           │
│  - Brave/SearXNG search            │  - Queues BullMQ job                   │
│  - Candidate upsert                │  - Returns sessionId for SSE           │
│                                    │                                         │
│  GET /api/v2/enrich/session/stream │  GET /api/v2/enrich?candidateId=       │
│  - SSE progress events             │  - Fetch candidate + identities        │
└─────────────────────────────────────────────────────────────────────────────┘
                    │                                    │
                    ▼                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ENRICHMENT WORKER (BullMQ)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  src/lib/enrichment/worker.ts                                                │
│  - Processes enrichment jobs                                                 │
│  - Calls runEnrichment() (LangGraph)                                        │
│  - Emits progress via QueueEvents                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         LANGGRAPH ENRICHMENT GRAPH                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  loadCandidate → githubBridge → [searchPlatforms...] → aggregate            │
│       │              │                  │                    │               │
│       └──────────────┴──────────────────┴────────────────────┘               │
│                                     ▼                                        │
│  persistIdentities → fetchPlatformData → generateSummary → persistSummary   │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DATA LAYER                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  PostgreSQL (Prisma)               │  Redis (BullMQ + Caching)              │
│  - Candidate                       │  - Enrichment job queue                │
│  - IdentityCandidate               │  - Search cache (optional)             │
│  - EnrichmentSession               │  - Profile cache                       │
│  - SearchCacheV2                   │                                         │
│  - AuditLog                        │                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Key Entry Points

| Layer | File | Function/Route | Purpose |
|-------|------|----------------|---------|
| UI | `src/app/search/page.tsx` | SearchPage | Main search UI |
| UI | `src/app/enrich/[candidateId]/page.tsx` | EnrichmentPage | Enrichment progress + results |
| UI | `src/components/ProfileSummaryCard.tsx` | openEnrichmentPage() | Opens enrich page in new tab |
| API | `src/app/api/v2/search/route.ts` | POST | NL query → LinkedIn results |
| API | `src/app/api/v2/enrich/async/route.ts` | POST | Start async enrichment |
| API | `src/app/api/v2/enrich/session/stream/route.ts` | GET | SSE progress stream |
| Worker | `src/lib/enrichment/worker.ts` | processEnrichmentJob() | BullMQ job processor |
| Graph | `src/lib/enrichment/graph/builder.ts` | runEnrichment() | LangGraph executor |

---

## 2. SEQUENCE DIAGRAM: Query → Search → Enrich

### 2.1 Search Flow

```
User                   SearchPage              /api/v2/search           Groq          Brave/SearXNG         Database
  │                        │                        │                    │                 │                    │
  │─── Enter "5 AI Eng" ──▶│                        │                    │                 │                    │
  │                        │─── POST {query} ──────▶│                    │                 │                    │
  │                        │                        │─── parseQuery() ──▶│                 │                    │
  │                        │                        │◀── ParsedQuery ────│                 │                    │
  │                        │                        │                    │                 │                    │
  │                        │                        │── searchLinkedIn() ────────────────▶│                    │
  │                        │                        │◀─── ProfileSummary[] ───────────────│                    │
  │                        │                        │                    │                 │                    │
  │                        │                        │───────────── upsertCandidates() ───────────────────────▶│
  │                        │                        │◀──────────── Map<linkedinId, candidateId> ──────────────│
  │                        │                        │                    │                 │                    │
  │                        │◀── {results, candidateIds} ─│               │                 │                    │
  │◀── Display cards ──────│                        │                    │                 │                    │
```

**Inputs/Outputs per step:**

| Step | Input | Output | Side Effects |
|------|-------|--------|--------------|
| parseSearchQuery() | `"5 AI Engineers in Israel"` | `{count:5, role:"AI Engineer", countryCode:"IL", searchQuery:"site:linkedin.com/in...", roleType:"engineer"}` | None |
| searchLinkedInProfiles() | searchQuery, count, countryCode | `ProfileSummary[]` | Brave/SearXNG API calls |
| upsertCandidates() | ProfileSummary[], searchQuery, roleType | `Map<linkedinId, candidateId>` | INSERT/UPDATE Candidate rows |

**Error Handling:**
- Groq parse failure → Falls back to Gemini (if configured)
- Brave failure → Falls back to SearXNG
- Candidate upsert failure → Logs error, continues with other results

### 2.2 Enrichment Flow

```
User            EnrichmentPage       /api/v2/enrich/async      BullMQ         Worker          LangGraph         Database
  │                   │                      │                    │              │                 │                │
  │─ Click "Enrich" ─▶│                      │                    │              │                 │                │
  │                   │─── POST {candidateId} ──▶│               │              │                 │                │
  │                   │                      │─ createSession() ─────────────────────────────────────────────────▶│
  │                   │                      │◀── sessionId ─────────────────────────────────────────────────────│
  │                   │                      │── queue.add() ───▶│              │                 │                │
  │                   │◀── {sessionId} ──────│                    │              │                 │                │
  │                   │                      │                    │              │                 │                │
  │                   │── SSE /stream?sessionId ──────────────────────────────▶│                 │                │
  │                   │                      │                    │              │                 │                │
  │                   │                      │                    │─ process() ─▶│                 │                │
  │                   │                      │                    │              │─ runEnrich() ──▶│                │
  │                   │                      │                    │              │                 │                │
  │                   │                      │                    │              │─ loadCandidate ▶│────── SELECT ─▶│
  │                   │◀── progress: loadCandidate ───────────────│◀─────────────│◀───────────────│                │
  │                   │                      │                    │              │                 │                │
  │                   │                      │                    │              │─ githubBridge ─▶│─ GitHub API ───│
  │                   │◀── progress: githubBridge ────────────────│◀─────────────│◀───────────────│                │
  │                   │                      │                    │              │                 │                │
  │                   │                      │                    │              │─ searchPlatform(s) ─▶ Brave/SearX │
  │                   │◀── progress: searchPlatform ──────────────│◀─────────────│◀───────────────│                │
  │                   │                      │                    │              │                 │                │
  │                   │                      │                    │              │─ persistResults ▶│────── UPSERT ─▶│
  │                   │                      │                    │              │                 │                │
  │                   │                      │                    │              │─ generateSummary ▶│── Groq LLM ──│
  │                   │                      │                    │              │                 │                │
  │                   │                      │                    │              │─ persistSummary ─▶│──── UPDATE ──▶│
  │                   │◀── progress: complete ────────────────────│◀─────────────│◀───────────────│                │
  │◀── Display AI Summary + Identities ─────│                    │              │                 │                │
```

---

## 3. LANGGRAPH AUDIT

### 3.1 Graph Definition

**File**: `src/lib/enrichment/graph/builder.ts`

```typescript
const graph = new StateGraph(EnrichmentStateAnnotation)
  .addNode('loadCandidate', loadCandidateNode)
  .addNode('githubBridge', githubBridgeNode)
  .addNode('searchPlatforms', searchPlatformNode)
  .addNode('aggregate', aggregateResultsNode)
  .addNode('persistIdentities', persistResultsNode)
  .addNode('fetchPlatformData', fetchPlatformDataNode)
  .addNode('generateSummary', generateSummaryNode)
  .addNode('persistSummary', persistSummaryNode)

  .addEdge('__start__', 'loadCandidate')
  .addConditionalEdges('loadCandidate', routeAfterLoad)    // → githubBridge or END
  .addConditionalEdges('githubBridge', routeAfterGitHub)   // → searchPlatforms[] or aggregate
  .addConditionalEdges('searchPlatforms', routeAfterSearch) // → more platforms or aggregate
  .addEdge('aggregate', 'persistIdentities')
  .addEdge('persistIdentities', 'fetchPlatformData')
  .addEdge('fetchPlatformData', 'generateSummary')
  .addEdge('generateSummary', 'persistSummary')
  .addEdge('persistSummary', END);
```

### 3.2 State Schema (Reducers)

**File**: `src/lib/enrichment/graph/types.ts`

| Field | Type | Reducer | Purpose |
|-------|------|---------|---------|
| `identitiesFound` | `DiscoveredIdentity[]` | `[...current, ...update]` | Accumulates from parallel nodes |
| `platformResults` | `PlatformQueryResult[]` | `[...current, ...update]` | Merge platform results |
| `errors` | `EnrichmentError[]` | `[...current, ...update]` | Collect all errors |
| `progressEvents` | `EnrichmentProgressEvent[]` | `[...current, ...update]` | Timeline of events |
| `queriesExecuted` | `number` | `current + update` | Sum query counts |
| `sourcesExecuted` | `string[]` | `[...new Set([...current, ...update])]` | Dedupe sources |
| `errorsBySource` | `Record<string, string[]>` | Custom merge | Group errors by source |

### 3.3 Conditional Routing

**routeAfterGitHub**:
```typescript
function routeAfterGitHub(state: EnrichmentState): string | Send[] {
  // High confidence match → skip search, go to aggregate
  if (state.earlyStopReason || !shouldContinueSearching(state)) {
    return 'aggregate';
  }

  // Get next batch of platforms (budget.maxParallelPlatforms = 3)
  const platforms = getNextPlatformBatch(state, maxParallel);
  if (platforms.length === 0) return 'aggregate';

  // Parallel execution via Send()
  return platforms.map(platform => new Send('searchPlatforms', {...state, currentPlatform: platform}));
}
```

**shouldContinueSearching**:
```typescript
function shouldContinueSearching(state: EnrichmentState): boolean {
  // Stop if: high confidence found, budget exhausted, or all platforms done
  if (state.bestConfidence >= budget.minConfidenceForEarlyStop) return false;
  if (state.queriesExecuted >= budget.maxQueries) return false;
  if (state.platformsRemaining.length === 0) return false;
  return true;
}
```

### 3.4 Tool Calls per Node

| Node | Tool/API Calls | Deterministic? |
|------|----------------|----------------|
| loadCandidate | `prisma.candidate.findUnique()` | Yes |
| githubBridge | `GitHubClient.searchUsers()`, `getUser()`, `getCommitEvidence()` | Yes |
| searchPlatformNode | `searchRawWithFallback()` (Brave/SearXNG) | Yes |
| aggregateResults | None (pure logic) | Yes |
| persistIdentities | `prisma.identityCandidate.upsert()` | Yes |
| fetchPlatformData | `GitHubClient.getUserRepos()`, etc. | Yes |
| **generateSummary** | `Groq generateObject()` | **No (LLM)** |
| persistSummary | `prisma.enrichmentSession.update()` | Yes |

---

## 4. FAILURE MODES ANALYSIS

### 4.1 Identity Collision (Wrong Person)

**Location**: `src/lib/enrichment/scoring.ts:calculateConfidenceScore()`

**Problem**: Name-only matching with common names leads to false positives.

**Evidence**:
```typescript
// Name match weight is 0.30 (30% of score)
const nameMatch = nameSimilarity * 0.30;

// With profile completeness (0.05) + name match (0.30) = 0.35
// This JUST passes the threshold for storage
```

**Impact**: High - Wrong person data pollutes candidate profiles

**Fix** (minimal):
```typescript
// src/lib/enrichment/scoring.ts:shouldPersistIdentity()
export function shouldPersistIdentity(breakdown: ScoreBreakdown): boolean {
  // ADD: Require at least 2 signal types, not just name + profile existence
  const signalCount = [
    breakdown.bridgeWeight > 0,
    breakdown.nameMatch >= 0.2,
    breakdown.companyMatch > 0,
    breakdown.locationMatch > 0,
  ].filter(Boolean).length;

  if (signalCount < 2) return false;  // NEW: Require 2+ signals

  // Existing logic...
}
```

### 4.2 Insufficient Bridges (No GitHub/Personal Site)

**Location**: `src/lib/enrichment/bridge-discovery.ts:discoverGitHubIdentities()`

**Problem**: If candidate has no name hint, no search queries are generated.

**Evidence**:
```typescript
function buildSearchQueries(hints: CandidateHints): string[] {
  const queries: string[] = [];

  if (hints.nameHint) {
    queries.push(hints.nameHint);  // Only adds if nameHint exists
  }
  // ...
  return queries;  // Empty array if no nameHint!
}
```

**Impact**: Medium - Many candidates get 0 identities discovered

**Fix**:
```typescript
// src/lib/enrichment/bridge-discovery.ts:buildSearchQueries()
function buildSearchQueries(hints: CandidateHints): string[] {
  const queries: string[] = [];

  // Add name-based query
  if (hints.nameHint) {
    queries.push(hints.nameHint);
  }

  // NEW: Fallback to headline keywords if no name
  if (!hints.nameHint && hints.headlineHint) {
    const titleMatch = hints.headlineHint.match(/^([A-Z][a-z]+ [A-Z][a-z]+)/);
    if (titleMatch) queries.push(titleMatch[1]);
  }

  // NEW: Use LinkedIn ID as last resort (may be a name slug)
  if (queries.length === 0 && hints.linkedinId) {
    const slugName = hints.linkedinId.replace(/-/g, ' ').replace(/\d+$/, '').trim();
    if (slugName.length > 3) queries.push(slugName);
  }

  return queries;
}
```

### 4.3 Search Query Too Broad/Narrow

**Location**: `src/lib/enrichment/sources/search-executor.ts:buildQueryFromPattern()`

**Problem**: Query patterns can produce overly generic or empty queries.

**Evidence**:
```typescript
// Pattern: "{name} {company} site:github.com"
// If company is null: "John Smith  site:github.com" (extra space, broad)
query = query.replace(/\{company\}/g, company || '');
query = query.replace(/\s+/g, ' ').trim();  // Cleans up but still broad
```

**Impact**: Medium - Low-quality search results, wrong person matches

**Fix**:
```typescript
// src/lib/enrichment/sources/search-executor.ts
export function buildQueryFromPattern(pattern: string, hints: CandidateHints): string | null {
  // NEW: Return null if required fields are missing
  if (pattern.includes('{name}') && !hints.nameHint) return null;

  let query = pattern;
  // ... existing replacements ...

  // NEW: Validate minimum query quality
  const words = query.replace(/site:\S+/g, '').trim().split(/\s+/);
  if (words.length < 2) return null;  // Too broad

  return query;
}
```

### 4.4 Rate Limiting / Blocked Requests

**Location**: `src/lib/enrichment/github.ts:request()`

**Problem**: GitHub unauthenticated rate limit is 60 req/hour. SearXNG engines get blocked.

**Evidence from logs**:
```
[GitHub] ⚠️  GITHUB_TOKEN not set - using unauthenticated rate limits (60 req/hr)
[SearXNG] Engine 'brave' blocked: 'too many requests'
[SearXNG] Engine 'duckduckgo' timeout
```

**Impact**: High - Enrichment fails completely after ~10-20 candidates

**Fix**: Already partially addressed by setting `GITHUB_TOKEN` on Railway. Additional:
```typescript
// src/lib/enrichment/sources/search-executor.ts
export function getEnrichmentProviderConfig() {
  // NEW: Disable SearXNG if known to be unreliable
  const fallback = process.env.ENRICHMENT_SEARCH_FALLBACK_PROVIDER?.toLowerCase();

  return {
    primary: 'brave',
    fallback: fallback === '' ? null : (fallback || null),  // Allow explicit disable
    minResultsBeforeFallback: 2,
  };
}
```

### 4.5 Groq/LLM Schema Validation Failures

**Location**: `src/lib/search/parsers/groq.ts:parseSearchQuery()`

**Problem**: LLM returns invalid roleType values like "developer" instead of enum.

**Evidence** (from previous fix):
```typescript
// Before fix: z.enum(['engineer', ...]) - strict validation fails
// After fix: z.string().transform(coerceRoleType) - coerces to valid value
```

**Status**: Fixed with roleType coercion

### 4.6 Async Enrichment Not Using LangGraph

**Location**: `src/lib/enrichment/index.ts:enrichCandidate()` vs `src/lib/enrichment/graph/builder.ts:runEnrichment()`

**Problem**: Two different enrichment code paths exist!

| Endpoint | Function Called | Uses LangGraph? | Generates Summary? |
|----------|-----------------|-----------------|-------------------|
| POST /api/v2/enrich | `enrichCandidate()` | No | **No** |
| POST /api/v2/enrich/async | Queue → `runEnrichment()` | Yes | **Yes** |

**Impact**: Critical - Users clicking "Enrich" via the old endpoint get no AI summary

**Status**: Fixed by changing enrichment page to call `/api/v2/enrich/async`

### 4.7 SSE Stream Requires Auth (EventSource limitation)

**Location**: `src/app/api/v2/enrich/session/stream/route.ts`

**Problem**: `EventSource` API doesn't support custom headers for auth.

**Status**: Fixed by removing auth requirement from SSE endpoint (security via UUID session ID)

---

## 5. OBSERVABILITY RECOMMENDATIONS

### 5.1 Structured Logging Schema

```typescript
// src/lib/observability/logger.ts
interface EnrichmentLogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: 'signal' | 'enrichment-worker';

  // Context
  sessionId: string;
  candidateId: string;
  linkedinId: string;

  // Event
  event: string;  // 'node.start', 'node.complete', 'api.call', 'error'
  node?: string;
  platform?: string;

  // Metrics
  durationMs?: number;
  queriesExecuted?: number;
  identitiesFound?: number;
  confidence?: number;

  // Error details
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
    stack?: string;
  };
}

function log(entry: EnrichmentLogEntry) {
  console.log(JSON.stringify(entry));  // JSON for log aggregation
}
```

### 5.2 LangGraph Node Timing

```typescript
// src/lib/enrichment/graph/nodes.ts - Add to each node
async function withTiming<T>(
  nodeName: string,
  sessionId: string,
  fn: () => Promise<T>
): Promise<T & { _timing: { node: string; durationMs: number } }> {
  const start = Date.now();
  const result = await fn();
  const durationMs = Date.now() - start;

  log({
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'enrichment-worker',
    sessionId,
    candidateId: '',
    linkedinId: '',
    event: 'node.complete',
    node: nodeName,
    durationMs,
  });

  return { ...result, _timing: { node: nodeName, durationMs } };
}
```

### 5.3 EnrichmentRun Record Schema

```prisma
// prisma/schema.prisma - ADD
model EnrichmentRun {
  id                  String   @id @default(cuid())
  sessionId           String   @unique
  candidateId         String
  linkedinId          String
  linkedinUrl         String

  // Seed fields from SERP
  nameHint            String?
  headlineHint        String?
  locationHint        String?
  companyHint         String?
  roleType            String?

  // Execution metadata
  startedAt           DateTime
  completedAt         DateTime?
  durationMs          Int?
  status              String   // 'running' | 'completed' | 'failed' | 'early_stopped'

  // Tool calls
  toolCalls           Json     // [{platform, method, durationMs, resultCount}]

  // Results
  identitiesCandidateCount Int @default(0)
  identitiesConfirmedCount Int @default(0)
  bestConfidence           Float?

  // Summary
  summaryGenerated    Boolean  @default(false)
  summaryModel        String?
  summaryTokens       Int?

  // Quality
  qualityScore        Float?   // Derived metric

  // Failure
  failureReason       String?  // Enum: 'no_name_hint' | 'rate_limited' | 'no_results' | 'low_confidence' | 'timeout' | 'llm_error'
  errorMessage        String?

  // Relations
  candidate           Candidate @relation(fields: [candidateId], references: [id])

  createdAt           DateTime @default(now())

  @@index([candidateId])
  @@index([status])
  @@index([startedAt])
}
```

---

## 6. TOP 10 ISSUES (Ranked by Impact)

| Rank | Issue | Impact | Effort | Status |
|------|-------|--------|--------|--------|
| 1 | **Two enrichment paths** - /enrich uses old code without LangGraph/summary | Critical | Low | Fixed |
| 2 | **SSE auth blocks EventSource** - No progress streaming | High | Low | Fixed |
| 3 | **No GITHUB_TOKEN on worker** - 60 req/hr limit | High | Low | Fixed |
| 4 | **SearXNG unreliable** - All engines blocked/timeout | High | Low | Fixed (disabled) |
| 5 | **Identity collision** - Name-only match passes threshold | High | Medium | Proposed fix above |
| 6 | **No fallback for missing nameHint** - 0 search queries | Medium | Low | Proposed fix above |
| 7 | **No manual confirmation UI** - Auto-merge at 0.9 without review | Medium | Medium | Design needed |
| 8 | **No observability** - Can't debug enrichment failures | Medium | Medium | Schema proposed |
| 9 | **No retry on transient failures** - Single attempt per platform | Medium | Medium | Needs implementation |
| 10 | **roleType validation** - LLM returns invalid values | Low | Low | Fixed |

---

## 7. RECOMMENDED ENRICHMENT DESIGN

### 7.1 Staged Identity Model

```
                          ┌─────────────────────┐
                          │   Candidate (DB)    │
                          │   linkedinId,       │
                          │   nameHint, etc.    │
                          └──────────┬──────────┘
                                     │
                          ┌──────────▼──────────┐
                          │  PossibleIdentity   │
                          │  (NEW table)        │
                          │  - platform         │
                          │  - platformId       │
                          │  - confidence       │
                          │  - status           │
                          │  - evidenceJson     │
                          └──────────┬──────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
    ┌─────────▼─────────┐  ┌─────────▼─────────┐  ┌─────────▼─────────┐
    │ status='pending'  │  │ status='suggested'│  │ status='confirmed'│
    │ (conf < 0.35)     │  │ (0.35 ≤ conf <0.9)│  │ (conf ≥ 0.9 OR    │
    │                   │  │                   │  │  user confirmed)  │
    │ NOT shown in UI   │  │ Shown with        │  │ Merged into       │
    │                   │  │ "Confirm/Reject"  │  │ candidate profile │
    └───────────────────┘  └───────────────────┘  └───────────────────┘
```

### 7.2 Proposed LangGraph Flow

```
START
  │
  ▼
┌─────────────────────┐
│   seed_extract      │  Extract hints from Candidate + SERP snippet
│   (deterministic)   │  Output: EnrichmentHints
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  bridge_discovery   │  GitHub API + multi-platform search
│   (parallel)        │  Output: RawIdentity[] (not scored yet)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  candidate_scoring  │  Score each RawIdentity
│   (deterministic)   │  Output: ScoredIdentity[]
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐      ┌───────────────────────┐
│  route_by_conf      │──────▶  confirm_needed       │
│                     │      │  (conf 0.35-0.9)      │
│  conf >= 0.9        │      │  Persist as           │
│  ──────────────────▶│      │  PossibleIdentity     │
│                     │      │  status='suggested'   │
└──────────┬──────────┘      └───────────────────────┘
           │ (auto-merge path)
           ▼
┌─────────────────────┐
│  enrich_confirmed   │  Fetch full platform data for high-conf identities
│                     │  (GitHub repos, languages, etc.)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  derive_signals     │  Extract skills, highlights from platform data
│   (deterministic)   │  (No LLM - just parsing)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  generate_summary   │  LLM summary (optional, if enough data)
│   (LLM)             │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  persist            │  Save to DB
└──────────┬──────────┘
           │
           ▼
          END
```

### 7.3 State Schema for New Flow

```typescript
interface EnrichmentStateV3 {
  // Input
  candidateId: string;
  sessionId: string;
  hints: EnrichmentHints;

  // Discovery results (accumulated)
  rawIdentities: RawIdentity[];  // Before scoring
  scoredIdentities: ScoredIdentity[];  // After scoring

  // Routing buckets
  autoMergeIdentities: ScoredIdentity[];  // conf >= 0.9
  suggestedIdentities: ScoredIdentity[];  // 0.35 <= conf < 0.9
  rejectedIdentities: ScoredIdentity[];   // conf < 0.35

  // Confirmed data (from auto-merge or user confirmation)
  confirmedPlatformData: PlatformData[];
  derivedSkills: string[];
  derivedHighlights: string[];

  // Summary
  summary: CandidateSummary | null;

  // Metadata
  status: 'running' | 'needs_confirmation' | 'completed' | 'failed';
  errors: EnrichmentError[];
}
```

---

## 8. REFACTOR PLAN

### Phase 1: Stabilization (1-2 days)

**Goal**: Fix critical issues, get enrichment working reliably

| Task | File | Change |
|------|------|--------|
| ✅ Fix dual enrichment paths | `src/app/enrich/[candidateId]/page.tsx` | Use `/api/v2/enrich/async` |
| ✅ Fix SSE auth | `src/app/api/v2/enrich/session/stream/route.ts` | Remove auth requirement |
| ✅ Set GITHUB_TOKEN | Railway env vars | Add to enrichment-worker |
| ✅ Disable SearXNG | Railway env vars | Set fallback to empty |
| Add nameHint fallback | `src/lib/enrichment/bridge-discovery.ts` | Parse from linkedinId slug |
| Add 2-signal requirement | `src/lib/enrichment/scoring.ts` | Update shouldPersistIdentity() |

### Phase 2: Observability (1 week)

**Goal**: Understand what's happening in production

| Task | File | Change |
|------|------|--------|
| Add structured logging | `src/lib/observability/logger.ts` | New file |
| Instrument graph nodes | `src/lib/enrichment/graph/nodes.ts` | Add timing, log entries |
| Create EnrichmentRun table | `prisma/schema.prisma` | New model |
| Add failure reason tracking | `src/lib/enrichment/graph/nodes.ts` | Classify and store failure types |
| Dashboard for enrichment metrics | New admin page | Chart completion rate, avg duration, etc. |

### Phase 3: Staged Identity Model (1 month)

**Goal**: Prevent identity collisions, enable user confirmation

| Task | File | Change |
|------|------|--------|
| Add PossibleIdentity table | `prisma/schema.prisma` | New model with status enum |
| Refactor scoring to 3 buckets | `src/lib/enrichment/scoring.ts` | auto_merge/suggested/rejected |
| Add confirm/reject API | `src/app/api/v2/identity/confirm/route.ts` | New endpoint |
| Update UI for confirmation | `src/components/CandidateDetails.tsx` | Add confirm/reject buttons (exists) |
| Implement derive_signals node | `src/lib/enrichment/graph/nodes.ts` | Extract skills without LLM |
| Add quality score calculation | `src/lib/enrichment/quality.ts` | New file |

---

## 9. TEST CASES NEEDED

### 9.1 Unit Tests

**File**: `src/lib/enrichment/__tests__/scoring.test.ts` (new)

```typescript
describe('calculateConfidenceScore', () => {
  it('should return high score for exact name + company + location match', () => {});
  it('should return low score for name-only match without secondary signals', () => {});
  it('should detect contradiction when locations are different countries', () => {});
  it('should boost score for commit email evidence', () => {});
});

describe('shouldPersistIdentity', () => {
  it('should require 2+ signal types to persist', () => {});
  it('should reject name-only matches below 0.5', () => {});
});
```

**File**: `src/lib/enrichment/__tests__/bridge-discovery.test.ts` (new)

```typescript
describe('buildSearchQueries', () => {
  it('should return queries for name + company', () => {});
  it('should fallback to headline when nameHint is null', () => {});
  it('should parse linkedinId slug as last resort', () => {});
  it('should return empty array only when all fallbacks fail', () => {});
});
```

### 9.2 Integration Tests

**File**: `src/lib/enrichment/__tests__/graph.integration.test.ts` (new)

```typescript
describe('enrichment graph', () => {
  it('should complete full flow for candidate with GitHub profile', async () => {});
  it('should generate summary when identities are found', async () => {});
  it('should handle rate limiting gracefully', async () => {});
  it('should early-stop when high confidence found', async () => {});
  it('should report failure reason when no identities found', async () => {});
});
```

### 9.3 E2E Tests

**File**: `e2e/enrichment.spec.ts` (new)

```typescript
describe('enrichment flow', () => {
  it('should show progress events in SSE stream', async () => {});
  it('should display AI summary after completion', async () => {});
  it('should allow confirming/rejecting identities', async () => {});
});
```

---

## 10. APPENDIX: File Reference

| Component | Primary File | Related Files |
|-----------|--------------|---------------|
| Search UI | `src/app/search/page.tsx` | `src/components/ProfileSummaryCard.tsx` |
| Search API | `src/app/api/v2/search/route.ts` | `src/lib/search/parsers/*.ts`, `src/lib/search/providers/*.ts` |
| Enrich UI | `src/app/enrich/[candidateId]/page.tsx` | `src/components/CandidateDetails.tsx` |
| Enrich API | `src/app/api/v2/enrich/async/route.ts` | `src/lib/enrichment/queue/index.ts` |
| SSE Stream | `src/app/api/v2/enrich/session/stream/route.ts` | — |
| LangGraph | `src/lib/enrichment/graph/builder.ts` | `src/lib/enrichment/graph/nodes.ts`, `types.ts` |
| Scoring | `src/lib/enrichment/scoring.ts` | — |
| GitHub | `src/lib/enrichment/github.ts` | `src/lib/enrichment/bridge-discovery.ts` |
| Summary | `src/lib/enrichment/summary/generate.ts` | — |
| Worker | `src/lib/enrichment/worker.ts` | `src/lib/enrichment/queue/index.ts` |
| Types | `src/types/linkedin.ts` | `src/lib/enrichment/graph/types.ts` |
| Database | `prisma/schema.prisma` | — |

---

**End of Audit Document**
