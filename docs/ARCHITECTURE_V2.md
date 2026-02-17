# V2 Enrichment System Architecture

> **Last Updated:** 2026-02-15
> **Status:** Production-ready, eval harness protected, Tier-1 enforce live

## Executive Summary

The v2 enrichment system is a multi-platform identity discovery pipeline built on **LangGraph**, **BullMQ**, and **Prisma**. It discovers linked platform identities for LinkedIn candidates, scores them with confidence metrics, and generates AI summaries.

**Tech Stack:**
- **LangGraph** - Graph-based orchestration with checkpointing
- **BullMQ + Redis** - Async job queue
- **Prisma + Postgres** - Data persistence
- **Groq LLM** - AI summary generation
- **SearXNG/Brave** - Web search APIs
- **GitHub API** - Direct profile discovery

**Key Metrics (eval harness):**
- Auto-merge precision: **100%** (>= 98% threshold)
- Tier-1 detection recall: **88.9%** (>= 85% threshold)
- Persisted identity rate: **75%** (>= 50% threshold)

---

## Table of Contents

1. [Entry Points](#1-entry-points)
2. [LangGraph Implementation](#2-langgraph-implementation)
3. [Enrichment Pipeline Flow](#3-enrichment-pipeline-flow)
4. [Bridge Discovery](#4-bridge-discovery)
5. [Scoring System](#5-scoring-system)
6. [External APIs](#6-external-apis)
7. [Data Flow](#7-data-flow)
8. [Queue/Worker System](#8-queueworker-system)
9. [Configuration](#9-configuration)
10. [Key Invariants](#10-key-invariants)
11. [Observability](#11-observability)
12. [Key Files](#12-key-files)

---

## 1. Entry Points

### API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/v2/enrich` | POST | Sync enrichment (single/batch, max 10) |
| `/api/v2/enrich/async` | POST | Async enrichment → returns sessionId |
| `/api/v2/enrich/session` | GET | Query session status |
| `/api/v2/enrich/session/stream` | GET | SSE real-time progress |

### Sync Enrichment Request

```typescript
// POST /api/v2/enrich
{
  candidateId?: string;
  candidateIds?: string[];  // Batch mode (max 10)
  options?: {
    platforms?: string[];
    maxIdentitiesPerPlatform?: number;
    enableMultiPlatform?: boolean;
    maxSources?: number;
  };
}
```

### Async Enrichment Request

```typescript
// POST /api/v2/enrich/async
{
  candidateId: string;  // Required
  roleType?: RoleType;
  budget?: Partial<EnrichmentBudget>;
  priority?: number;  // 0 = normal, higher = urgent
}

// Response
{
  success: true,
  sessionId: string,
  jobId: string,
  statusUrl: string,   // GET /api/v2/enrich/session?sessionId=...
  streamUrl: string,   // SSE /api/v2/enrich/session/stream?sessionId=...
}
```

### Programmatic Entry Points

**Sync:** `enrichCandidate()`
```typescript
// src/lib/enrichment/index.ts
export async function enrichCandidate(
  candidateId: string,
  options: EnrichmentOptions
): Promise<EnrichmentResult>
```

**Async:** `createEnrichmentSession()`
```typescript
// src/lib/enrichment/queue/index.ts
export async function createEnrichmentSession(
  tenantId: string,
  candidateId: string,
  options?: {
    roleType?: RoleType;
    budget?: Partial<EnrichmentBudget>;
    priority?: number;
  }
): Promise<{ sessionId: string; jobId: string }>
```

---

## 2. LangGraph Implementation

### State Annotation

The graph uses LangGraph's `Annotation.Root` with **reducers** for parallel node execution:

```typescript
// src/lib/enrichment/graph/types.ts
export const EnrichmentStateAnnotation = Annotation.Root({
  // Input state
  tenantId: Annotation<string>,
  candidateId: Annotation<string>,
  sessionId: Annotation<string>,
  roleType: Annotation<RoleType>,
  hints: Annotation<EnrichmentHints>,
  budget: Annotation<EnrichmentBudget>,

  // Platforms
  platformsToQuery: Annotation<EnrichmentPlatform[]>,
  platformsRemaining: Annotation<EnrichmentPlatform[]>,

  // Results (with reducers for parallel merging)
  identitiesFound: Annotation<DiscoveredIdentity[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  platformResults: Annotation<PlatformQueryResult[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  // Counters (with reducers)
  queriesExecuted: Annotation<number>({
    reducer: (current, update) => current + update,
    default: () => 0,
  }),
  sourcesExecuted: Annotation<string[]>({
    reducer: (current, update) => [...new Set([...current, ...update])],
    default: () => [],
  }),

  // Control flow
  status: Annotation<'pending' | 'running' | 'completed' | 'failed' | 'early_stopped'>,
  earlyStopReason: Annotation<string | null>,
  bestConfidence: Annotation<number | null>,

  // Observability
  progressPct: Annotation<number>({
    reducer: (current, update) => Math.max(current, update),
    default: () => 0,
  }),

  // Summary output
  summaryText: Annotation<string | null>,
  summaryStructured: Annotation<Record<string, unknown> | null>,
  summaryEvidence: Annotation<Array<Record<string, unknown>> | null>,
  summaryModel: Annotation<string | null>,
})
```

### Graph Structure

```
START
  │
  ▼
┌─────────────────────┐
│  loadCandidateNode  │  Load hints, prepare platforms
│     (10% progress)  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  githubBridgeNode   │  Direct GitHub API search
│     (30% progress)  │
└─────────┬───────────┘
          │
          ├──── high confidence (≥0.9)? ────► skip search
          │
          ▼
┌─────────────────────────────┐
│  searchPlatformsBatchNode   │  20-30 platforms batch execution
│        (50% progress)       │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────┐
│ aggregateResultsNode│  Merge + dedup + rank
│     (70% progress)  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ persistResultsNode  │  Filter by threshold + store to DB
│     (80% progress)  │
└─────────┬───────────┘
          │
          ▼
┌──────────────────────┐
│fetchPlatformDataNode │  Fetch extra profile data (repos, etc.)
│     (85% progress)   │
└─────────┬────────────┘
          │
          ▼
┌─────────────────────┐
│ generateSummaryNode │  AI summary via Groq LLM
│     (90% progress)  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ persistSummaryNode  │  Store summary + runTrace
│    (100% progress)  │
└─────────┬───────────┘
          │
          ▼
         END
```

### Node Implementations

| Node | File | Purpose |
|------|------|---------|
| `loadCandidateNode` | `graph/nodes.ts` | Load candidate, extract hints, determine platforms |
| `githubBridgeNode` | `graph/nodes.ts` | Direct GitHub API search (not search-based) |
| `searchPlatformsBatchNode` | `graph/nodes.ts` | Batch execution for 20-30 platforms |
| `aggregateResultsNode` | `graph/nodes.ts` | Merge, deduplicate, rank by confidence |
| `persistResultsNode` | `graph/nodes.ts` | Apply filters, upsert to IdentityCandidate |
| `fetchPlatformDataNode` | `graph/nodes.ts` | Fetch extra profile data for summary |
| `generateSummaryNode` | `graph/nodes.ts` | Generate AI summary via Groq |
| `persistSummaryNode` | `graph/nodes.ts` | Store summary and runTrace to DB |

### Budget Configuration

```typescript
interface EnrichmentBudget {
  maxQueries: number;              // Total across all platforms (default: 30)
  maxPlatforms: number;            // Platforms to query (default: 8)
  maxIdentitiesPerPlatform: number; // Results per platform (default: 3)
  timeoutMs: number;               // Overall timeout (60000ms)
  minConfidenceForEarlyStop: number; // 0.9
  maxParallelPlatforms: number;    // Parallel execution (default: 3)
}
```

### Checkpointing (Optional)

Enable resumable workflows with Postgres checkpointer:

```bash
USE_LANGGRAPH_CHECKPOINTER=true
DIRECT_URL=postgresql://...
```

---

## 3. Enrichment Pipeline Flow

### Complete Flow Diagram

```
Candidate Input
  │
  ├─ linkedinId, linkedinUrl
  ├─ nameHint, headlineHint
  ├─ locationHint, companyHint
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1: GitHub Bridge Discovery (Direct API)              │
│                                                             │
│  1. Search by name in GitHub                                │
│  2. Fetch profiles                                          │
│  3. Extract commit evidence (optional)                      │
│  4. Score with name/company/location match                  │
│  5. Check for LinkedIn URL in bio → Tier 1 bridge           │
│                                                             │
│  Output: confidence 0.0-1.0                                 │
│  Early stop if confidence ≥ 0.9                             │
└─────────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│ PHASE 2: Search-Based Discovery (20-30 platforms)          │
│                                                             │
│  For each platform (batch):                                 │
│    1. Get platform source instance                          │
│    2. Build search queries (name, company, location)        │
│    3. Execute search via SearXNG/Brave                      │
│    4. Parse results                                         │
│    5. Score identities                                      │
│    6. Collect evidence pointers                             │
│                                                             │
│  Platforms: GitHub, Stack Overflow, npm, PyPI, Docker,      │
│    Kaggle, ORCID, Scholar, Medium, Twitter, YouTube, etc.   │
└─────────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│ PHASE 3: Aggregation & Deduplication                        │
│                                                             │
│  1. Merge results from all platforms                        │
│  2. Sort by confidence (descending)                         │
│  3. Detect duplicates (cross-platform matches)              │
│  4. Calculate best confidence                               │
└─────────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│ PHASE 4: Filtering & Persistence                            │
│                                                             │
│  1. Filter by minConfidence threshold (default: 0.35)       │
│  2. Apply shouldPersistIdentity guards                      │
│  3. Upsert to IdentityCandidate table (tenant-scoped)       │
│  4. Track statistics                                        │
│  5. Build runTrace                                          │
└─────────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│ PHASE 5: Summary Generation (AI)                            │
│                                                             │
│  1. Load top identities (top 25)                            │
│  2. Fetch platform data (GitHub repos, etc.)                │
│  3. Call Groq LLM                                           │
│  4. Generate:                                               │
│     - Summary text (2-3 sentences)                          │
│     - Skills array                                          │
│     - Highlights array                                      │
│     - Talking points array                                  │
│     - Confidence score                                      │
│     - Caveats                                               │
│  5. Evidence pointers                                       │
└─────────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│ PHASE 6: Final Persistence                                  │
│                                                             │
│  1. Store summary to EnrichmentSession                      │
│  2. Store runTrace (observability)                          │
│  3. Update candidate status                                 │
│  4. Return EnrichmentGraphOutput                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Bridge Discovery

### Bridge Tier Classification

| Tier | Description | Confidence Floor | Auto-merge | Enforce | Cap |
|------|-------------|------------------|------------|---------|-----|
| **1** | Explicit bidirectional link | 0.83 | Yes | Strict subset only | Unlimited |
| **2** | Strong unidirectional signals | 0.50 | No (review) | N/A | 3 per run |
| **3** | Weak/speculative | 0.00 | No (review) | N/A | Threshold-based |

### Bridge Signals

```typescript
type BridgeSignal =
  // Tier 1 (Auto-merge eligible)
  | 'linkedin_url_in_bio'       // LinkedIn URL in GitHub bio
  | 'linkedin_url_in_blog'      // LinkedIn URL in website field
  | 'linkedin_url_in_page'      // Found via reverse page search
  | 'mutual_reference'          // Both profiles link to each other

  // Tier 2 (Human review)
  | 'linkedin_url_in_team_page' // Team page with multiple profiles
  | 'commit_email_domain'       // Commit email matches company domain
  | 'cross_platform_handle'     // Same username across platforms
  | 'verified_domain'           // Verified company domain
  | 'email_in_public_page'      // Email in public page matching pattern
  | 'conference_speaker'        // Listed as conference speaker with LinkedIn

  // Tier 3 (Speculative)
  | 'none';                     // No bridge signals
```

### URL-Anchored Bridge Discovery

Searches for pages containing the candidate's LinkedIn URL:

```typescript
// Query patterns
"https://linkedin.com/in/{linkedinId}"
"https://linkedin.com/in/{linkedinId}" site:github.com
"https://linkedin.com/in/{linkedinId}" (github OR portfolio OR about)
```

**Regex pattern** (with punctuation boundaries):
```typescript
const boundaryPattern = `(?:[/?#\\s)\\]}"',\\.;:]|$)`;
const linkedinIdPattern = new RegExp(
  `(?:https?://)?(?:www\\.|m\\.)?linkedin\\.com/in/${escapeRegExp(linkedinId)}${boundaryPattern}`,
  'i'
);
```

**Iterative decode loop** (max 3 passes for URL-encoded strings):
```typescript
const haystacks = [rawHaystack];
let decoded = rawHaystack;
for (let i = 0; i < 3; i++) {
  try {
    const next = decoded
      .replace(/%2F/gi, '/')
      .replace(/%3A/gi, ':')
      .replace(/%3D/gi, '=')
      .replace(/%26/gi, '&')
      .replace(/%3F/gi, '?')
      .replace(/\+/g, ' ');
    const fullDecoded = decodeURIComponent(next);
    if (fullDecoded === decoded) break;
    decoded = fullDecoded;
    haystacks.push(decoded);
  } catch { break; }
}
```

### Bridge Detection Flow

```
GitHub Profile
  │
  ├─ Check bio field for LinkedIn URL
  │    └─ Found? → Tier 1: linkedin_url_in_bio
  │
  ├─ Check blog/website field for LinkedIn URL
  │    └─ Found? → Tier 1: linkedin_url_in_blog
  │
  ├─ URL-anchored reverse search
  │    └─ Found on personal page? → Tier 1: linkedin_url_in_page
  │    └─ Found on team page? → Tier 2: linkedin_url_in_team_page
  │
  ├─ Check commit email domain
  │    └─ Matches company? → Tier 2: commit_email_domain
  │
  └─ No signals → Tier 3: name-based scoring only
```

### Tier-1 Strict-Subset Enforcement

When `ENRICHMENT_TIER1_ENFORCE=true`, a strict subset of Tier-1 bridges are eligible for automatic confirmation. Non-qualifying Tier-1 candidates are downgraded to Tier-2.

**Enforce-eligible signals** (defined in `TIER_1_ENFORCE_SIGNALS`):
- `linkedin_url_in_bio` — LinkedIn URL in GitHub profile bio
- `linkedin_url_in_blog` — LinkedIn URL in GitHub website/blog field

**NOT enforce-eligible** (remain Tier-1 for shadow telemetry, but treated as Tier-2 when enforce is on):
- `linkedin_url_in_page` — Found via reverse page search (higher false positive risk)
- `mutual_reference` — Both profiles link to each other

**Enforce predicate:**
```typescript
const wouldAutoMerge =
  bridge.tier === 1 &&
  bridge.signals.some(s => TIER_1_ENFORCE_SIGNALS.includes(s)) &&
  confidence >= TIER1_ENFORCE_MIN_CONFIDENCE &&  // default 0.83
  !hasContradiction &&
  !nameMismatch &&
  !hasTeamPageSignal &&
  !hasIdMismatch;

const tier1Enforced = TIER1_ENFORCE && wouldAutoMerge;
```

**Effective bridge downgrade** — when enforce is on, non-qualifying Tier-1 identities are downgraded:
```typescript
const effectiveBridge = TIER1_ENFORCE && isTier1 && !tier1Enforced
  ? { ...bridge, tier: 2, autoMergeEligible: false }
  : bridge;
```

**Important:** The `tier1AutoConfirmed` flag is diagnostic only. `IdentityCandidate.status` remains `unconfirmed` in the database — the existing confirm/audit flow is preserved.

**Kill switch:** Set `ENRICHMENT_TIER1_ENFORCE=false` on Railway. Process restarts and all enforcement stops immediately.

**Rollout data (Feb 2026):** 210 sessions, 30 enforced, 100% precision, 0 failures.

---

## 5. Scoring System

### Score Breakdown

```typescript
interface ScoreBreakdown {
  bridgeWeight: number;        // 0-0.40 (LinkedIn link or commit evidence)
  nameMatch: number;           // 0-0.30 (Jaccard token similarity)
  handleMatch: number;         // 0-0.30 (exact handle match on handle-platforms)
  companyMatch: number;        // 0-0.15 (company in headline match)
  locationMatch: number;       // 0-0.10 (location match)
  profileCompleteness: number; // 0-0.05 (bio, repos, followers)
  activityScore: number;       // 0-1.0 (derived from completeness)
  total: number;               // Sum (capped at 1.0)
  bridgeTier?: 1 | 2 | 3;
  bridgeSignals?: BridgeSignal[];
  bridgeUrl?: string | null;
}
```

### Scoring Algorithm

```typescript
function calculateConfidenceScore(input: ScoringInput): ScoreBreakdown {
  // 1. Bridge weight (strongest signal)
  let bridgeWeight = 0;
  if (input.hasProfileLink) {
    bridgeWeight = 0.4;  // LinkedIn link in bio
  } else if (input.hasCommitEvidence) {
    bridgeWeight = Math.min(0.3, 0.15 + input.commitCount * 0.05);
  }

  // 2. Name match (Jaccard token similarity)
  const nameSimilarity = calculateNameSimilarity(
    input.candidateName,
    input.platformName
  );
  const nameMatch = nameSimilarity * 0.30;

  // 3. Company match
  const companyMatch = calculateCompanyMatch(...) * 0.15;

  // 4. Location match
  const locationMatch = calculateLocationMatch(...) * 0.10;

  // 5. Profile completeness
  const profileCompleteness = calculateProfileCompleteness(...) * 0.05;

  // Total (capped at 1.0)
  const total = Math.min(1,
    bridgeWeight + nameMatch + companyMatch +
    locationMatch + profileCompleteness
  );

  return { bridgeWeight, nameMatch, companyMatch, locationMatch, profileCompleteness, total };
}
```

### Name Similarity (Jaccard)

```typescript
function calculateNameSimilarity(name1: string | null, name2: string | null): number {
  // Normalize: lowercase, remove diacritics, special chars
  const tokens1 = normalize(name1).split(/\s+/).filter(t => t.length > 1);
  const tokens2 = normalize(name2).split(/\s+/).filter(t => t.length > 1);

  // Jaccard similarity: intersection / union
  const intersection = tokens1.filter(t => tokens2.includes(t)).length;
  const union = new Set([...tokens1, ...tokens2]).size;
  const jaccard = intersection / union;

  // Bonus for first/last name match
  const firstNameBonus = tokens1[0] === tokens2[0] ? 0.1 : 0;
  const lastNameBonus = tokens1.at(-1) === tokens2.at(-1) ? 0.1 : 0;

  return Math.min(1, jaccard + firstNameBonus + lastNameBonus);
}
```

### Confidence Buckets

| Bucket | Threshold | Action |
|--------|-----------|--------|
| `auto_merge` | ≥ 0.90 | Auto-confirm identity |
| `suggest` | ≥ 0.70 | Recommend to recruiter |
| `low` | ≥ 0.35 | Possible match, needs review |
| `rejected` | < 0.35 | Unlikely match, not stored |

### Tier-1 Score Boost

Strict Tier-1 matches get a +0.08 boost to help clear the 0.90 auto-merge threshold:

```typescript
const isStrictTier1 = bridge.tier === 1 &&
  !bridge.signals.includes('linkedin_url_in_team_page') &&
  !hasContradiction;

const TIER_1_BOOST = 0.08;
const boostedTotal = isStrictTier1
  ? Math.min(1.0, baseScore.total + TIER_1_BOOST)
  : baseScore.total;
```

### Persistence Guards

```typescript
function shouldPersistIdentity(breakdown: ScoreBreakdown): boolean {
  const threshold = 0.35;  // ENRICHMENT_MIN_CONFIDENCE

  // Must meet minimum threshold
  if (breakdown.total < threshold) return false;

  // Bridge evidence → always persist
  if (breakdown.bridgeWeight > 0) return true;

  // Handle match (for handle-platforms like GitHub, npm)
  if ((breakdown.handleMatch ?? 0) >= 0.25) return true;

  // Otherwise, require name match + secondary signal
  const hasNameMatch = breakdown.nameMatch >= 0.15;
  const hasSecondarySignal =
    breakdown.companyMatch > 0 ||
    breakdown.locationMatch > 0 ||
    breakdown.profileCompleteness >= 0.03;

  return hasNameMatch && hasSecondarySignal;
}
```

### Contradiction Detection

```typescript
function detectContradictions(input: ScoringInput): {
  hasContradiction: boolean;
  note?: string;
} {
  // Name completely different despite bridge evidence
  if (nameSimilarity < 0.2 && (input.hasCommitEvidence || input.hasProfileLink)) {
    return {
      hasContradiction: true,
      note: `Name mismatch despite strong bridge evidence`,
    };
  }

  // Location in different countries
  if (country1 !== country2) {
    return {
      hasContradiction: true,
      note: `Location mismatch: different countries`,
    };
  }

  return { hasContradiction: false };
}
```

---

## 6. External APIs

### GitHub API

**File:** `src/lib/enrichment/github.ts`

```typescript
export class GitHubClient {
  async searchUsers(query: string): Promise<GitHubUserSearchResult[]>;
  async getUser(username: string): Promise<GitHubUserProfile>;
  async getCommits(repo: string, author: string): Promise<GitHubCommit[]>;
  async healthCheck(): Promise<object>;
}
```

**Rate Limits:**
- 60 requests/hour (unauthenticated)
- 5,000 requests/hour (with `GITHUB_TOKEN`)

**Retry Strategy:**
```typescript
const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,  // Exponential backoff
};
```

**Evidence Extraction:**
- LinkedIn URL from bio field
- LinkedIn URL from blog/website field
- Commit email evidence (when enabled)

### Web Search APIs

**File:** `src/lib/enrichment/sources/search-executor.ts`

**Providers (priority order):**
1. SearXNG (primary, self-hosted)
2. Brave Search API
3. BrightData (residential proxies)
4. Serper (fallback)

**Query Building:**
```typescript
function buildQueryFromPattern(
  basePattern: string,
  hints: { nameHint?, companyHint?, locationHint? }
): string {
  // Substitutes {name}, {company}, {location} placeholders
  // Applies query validation and normalization
  // Handles diacritics: Löf → Lof, João → Joao
}
```

### LLM Integration (Summary)

**File:** `src/lib/enrichment/summary/generate.ts`

**Provider:** Groq
**Model:** `meta-llama/llama-4-scout-17b` (configurable via `ENRICHMENT_SUMMARY_MODEL`)

**Output Schema:**
```typescript
interface CandidateSummary {
  summary: string;  // Max 2000 chars, 2-3 sentences
  structured: {
    skills: string[];        // Max 30, each max 60 chars
    highlights: string[];    // Max 12, each max 200 chars
    talkingPoints: string[]; // Max 12, each max 200 chars
  };
  confidence: number;  // 0-1
  caveats: string[];   // Max 10, each max 200 chars
}
```

**Summary Modes:**
- **Draft:** Generated during initial enrichment, cautious language
- **Verified:** Generated after identity confirmation, confident language

### Supported Platforms (30+)

**Code & Engineering:**
GitHub, Stack Overflow, npm, PyPI, Docker, Leetcode, HackerEarth, CodePen, GitLab, Gist, Dev.to

**Data Science & ML:**
Kaggle, Hugging Face, Papers with Code, OpenReview

**Academic & Authority:**
ORCID, Google Scholar, Semantic Scholar, ResearchGate, arXiv, Patents, University

**Business & Founder:**
SEC, Company Team pages, AngelList, Crunchbase

**Content & Thought Leadership:**
Medium, Substack, YouTube, Twitter

**Design:**
Dribbble, Behance

---

## 7. Data Flow

### Data Transformation Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│ Candidate (Prisma Model)                                    │
│                                                             │
│  id, tenantId, linkedinId, linkedinUrl,                     │
│  nameHint, headlineHint, locationHint, companyHint,         │
│  roleType, enrichmentStatus, confidenceScore                │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ extract hints
┌─────────────────────────────────────────────────────────────┐
│ EnrichmentHints                                             │
│                                                             │
│  linkedinId, linkedinUrl, nameHint, headlineHint,           │
│  locationHint, companyHint, roleType                        │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ discovery
┌─────────────────────────────────────────────────────────────┐
│ DiscoveredIdentity[]                                        │
│                                                             │
│  platform, platformId, profileUrl, displayName,             │
│  confidence, confidenceBucket, scoreBreakdown,              │
│  evidence[], hasContradiction, contradictionNote,           │
│  platformProfile: { name, bio, company, location }          │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ filter + persist
┌─────────────────────────────────────────────────────────────┐
│ IdentityCandidate (Prisma Model)                            │
│                                                             │
│  id, tenantId, candidateId, platform, platformId,           │
│  profileUrl, confidence, confidenceBucket,                  │
│  scoreBreakdown (JSON), evidence (JSON),                    │
│  hasContradiction, contradictionNote, discoveredBy,         │
│  searchQuery, status, createdAt, updatedAt                  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ AI summary
┌─────────────────────────────────────────────────────────────┐
│ CandidateSummary                                            │
│                                                             │
│  summary (text), structured: { skills, highlights,          │
│  talkingPoints }, confidence, caveats                       │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ store
┌─────────────────────────────────────────────────────────────┐
│ EnrichmentSession (Prisma Model)                            │
│                                                             │
│  id, tenantId, candidateId, status,                         │
│  sourcesExecuted, queriesExecuted,                          │
│  identitiesFound, finalConfidence,                          │
│  summary, summaryStructured, summaryEvidence,               │
│  summaryModel, summaryTokens, summaryGeneratedAt,           │
│  runTrace (JSON), durationMs, completedAt                   │
└─────────────────────────────────────────────────────────────┘
```

### Evidence Pointers (NOT PII)

```typescript
interface EvidencePointer {
  type: 'commit_email' | 'profile_link' | 'publication' |
        'patent' | 'package' | 'post' | 'project';
  sourceUrl: string;         // URL to evidence
  sourcePlatform: string;
  description: string;
  capturedAt: string;        // ISO timestamp
  metadata?: Record<string, unknown>;
}
```

**Commit Email Evidence** (when enabled):
```typescript
{
  type: 'commit_email',
  commitUrl: 'https://github.com/user/repo/commit/abc123',
  commitSha: 'abc123def456',
  repoFullName: 'user/repo',
  authorName: 'John Doe',
  // NOTE: Email NOT stored - extracted on-demand at confirmation
}
```

---

## 8. Queue/Worker System

### BullMQ Setup

**File:** `src/lib/enrichment/queue/index.ts`

**Queue Name:** `enrichment`
**Default Concurrency:** 3

```typescript
interface EnrichmentJobData {
  sessionId: string;
  candidateId: string;
  tenantId: string;        // Required for multi-tenancy
  jobType?: 'enrich' | 'summary_only';
  roleType?: RoleType;
  budget?: Partial<EnrichmentBudget>;
  priority?: number;
}

interface EnrichmentJobResult {
  sessionId: string;
  candidateId: string;
  status: 'completed' | 'failed';
  identitiesFound: number;
  bestConfidence: number | null;
  durationMs: number;
  error?: string;
}
```

### Job Configuration

```typescript
{
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000,  // Start with 5s
  },
  removeOnComplete: {
    count: 1000,
    age: 24 * 3600,  // 24 hours
  },
  removeOnFail: {
    count: 5000,
    age: 7 * 24 * 3600,  // 7 days
  },
}
```

### Job Flow

```
createEnrichmentSession(tenantId, candidateId, options)
  │
  ├─ Create EnrichmentSession (status: 'queued')
  │
  ├─ Enqueue BullMQ job with tenantId
  │
  └─ Return { sessionId, jobId }
        │
        ▼
Worker picks up job
  │
  ├─ Update session (status: 'running')
  │
  ├─ Run LangGraph enrichment
  │    └─ Stream progress events
  │
  ├─ Update session with results
  │
  └─ Return EnrichmentJobResult
```

### Progress Tracking

**Via Job Progress:**
```typescript
await job.updateProgress({
  event: 'node_complete',
  platform: 'github',
  data: { identitiesFound: 2, confidence: 0.92 },
  timestamp: new Date().toISOString(),
});
```

**Via SSE Stream:**
```
event: progress
data: {"type":"progress","sessionId":"...","progress":{...}}

event: completed
data: {"type":"completed","sessionId":"...","result":{...}}
```

### Worker Commands

**Start worker:**
```bash
npm run worker:enrichment
# or
tsx src/lib/enrichment/worker.ts
```

**Queue stats:**
```typescript
const stats = await getQueueStats();
// { waiting: 5, active: 3, completed: 100, failed: 2, delayed: 0 }
```

---

## 9. Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| **Core** |||
| `USE_LANGGRAPH_ENRICHMENT` | `false` | Enable LangGraph async enrichment |
| `USE_LANGGRAPH_CHECKPOINTER` | `false` | Enable Postgres checkpointer |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ connection |
| **Budget** |||
| `ENRICHMENT_MAX_QUERIES` | `30` | Total queries across platforms |
| `ENRICHMENT_MAX_PLATFORMS` | `8` | Platforms to query |
| `ENRICHMENT_MAX_IDENTITIES_PER_PLATFORM` | `3` | Results per platform |
| `ENRICHMENT_MAX_PARALLEL_PLATFORMS` | `3` | Parallel execution |
| **Scoring** |||
| `ENRICHMENT_MIN_CONFIDENCE` | `0.35` | Storage threshold |
| `ENRICHMENT_TIER2_CAP` | `3` | Max Tier-2 bridges per run |
| **Tier-1 Enforce** |||
| `ENRICHMENT_TIER1_ENFORCE` | `false` | Enable strict-subset auto-confirmation |
| `ENRICHMENT_TIER1_ENFORCE_MIN_CONFIDENCE` | `0.83` | Minimum confidence for enforce |
| **Features** |||
| `ENABLE_COMMIT_EMAIL_EVIDENCE` | `false` | Extract commit emails |
| `ENRICHMENT_ENABLE_QUERY_NORMALIZATION` | `true` | Normalize diacritics |
| `SKIP_UNRELIABLE_PLATFORMS` | `false` | Skip problematic platforms |
| **External APIs** |||
| `GITHUB_TOKEN` | - | GitHub API auth (5000 req/hr) |
| `GROQ_API_KEY` | - | Groq LLM API |
| `ENRICHMENT_SUMMARY_MODEL` | `meta-llama/llama-4-scout-17b` | LLM model |
| `SEARXNG_URL` | - | SearXNG instance |
| `BRAVE_API_KEY` | - | Brave Search API |
| **Eval** |||
| `ENRICHMENT_EVAL_REPLAY` | `0` | Enable replay mode |

---

## 10. Key Invariants

### Multi-Tenancy
- **Every DB query filters by `tenantId`**
- EnrichmentSession, IdentityCandidate, Candidate all tenant-scoped
- API routes require auth + tenantId extraction
- SessionId becomes graph thread_id (unique per tenant+candidate)

### Bridge-First Design
- Tier 1 bridges → auto-merge eligible (≥ 0.83 confidence with enforce, ≥ 0.90 without)
- Tier 1 enforce → strict subset only (`linkedin_url_in_bio`, `linkedin_url_in_blog`), no contradictions
- Tier 1 non-qualifying → downgraded to Tier 2 when enforce is on
- Tier 2 bridges → capped at 3 per run
- Tier 3 → requires traditional threshold (0.35)
- `IdentityCandidate.status` stays `unconfirmed` — enforce is diagnostic, confirm flow is separate

### Evidence Pointers (NOT PII)
- Store URLs to evidence, not sensitive data
- Emails only extracted on explicit user confirmation
- Commit evidence includes repo name but not email address

### Early Stopping
- High-confidence GitHub match (≥ 0.9) stops search
- Reason: `'high_confidence_github'`
- Saves API calls and reduces latency

### Reducers for Parallel Execution
- State uses LangGraph reducers to merge parallel node updates
- `identitiesFound`: array concatenation
- `queriesExecuted`: summation
- `progressPct`: maximum (keep highest)
- `lastCompletedNode`: last writer wins

### Summary Mode (Draft vs. Verified)
- **Draft:** Generated during initial enrichment, unconfirmed sources
- **Verified:** Generated after identity confirmation
- Affects LLM prompt and confidence capping
- Tracked in summaryMeta for staleness detection

---

## 11. Observability

### Run Trace

Stored in `EnrichmentSession.runTrace`:

```typescript
interface EnrichmentRunTrace {
  input: { candidateId, linkedinId, linkedinUrl };
  seed: { nameHint, headlineHint, locationHint, companyHint, roleType };
  platformResults: Record<string, {
    queriesExecuted: number;
    rawResultCount: number;
    identitiesFound: number;
    bestConfidence: number | null;
    durationMs: number;
    error?: string;
    rateLimited?: boolean;
  }>;
  final: {
    totalQueriesExecuted: number;
    platformsQueried: number;
    identitiesPersisted: number;
    bestConfidence: number | null;
    durationMs: number;
    // Tier-1 enforce telemetry
    tier1Enforced?: number;
    tier1EnforceThreshold?: number;
    tier1EnforceReason?: string;
    // Shadow diagnostics
    tier1Shadow?: Tier1ShadowDiagnostics;
    tier1Gap?: Tier1GapDiagnostics;
  };
}
```

### Per-Platform Diagnostics

```typescript
interface PlatformDiagnostics {
  queriesAttempted: number;
  queriesRejected: number;
  rejectionReasons: string[];
  rawResultCount: number;
  matchedResultCount: number;
  identitiesAboveThreshold: number;
  rateLimited: boolean;
  provider?: string;
}
```

### Logging Prefixes

- `[v2/enrich]` - API routes
- `[EnrichmentQueue]` - Queue operations
- `[EnrichmentWorker]` - Worker processing
- `[GitHub]` - GitHub client
- `[BridgeDiscovery]` - Bridge detection
- `[UrlAnchoredDiscovery]` - Reverse URL search

### Eval Harness

**Run eval:**
```bash
npm run eval         # Standard run
npm run eval:verbose # With detailed output
```

**CI Gates:**
- Auto-merge precision: ≥ 98%
- Tier-1 detection recall: ≥ 85%
- Persisted identity rate: ≥ 50%

**See:** `eval/TODO.md` for invariants and metrics

---

## 12. Key Files

| File | Purpose |
|------|---------|
| **Entry Points** ||
| `src/lib/enrichment/index.ts` | Main entry point, `enrichCandidate()` |
| `src/app/api/v2/enrich/route.ts` | Sync API route |
| `src/app/api/v2/enrich/async/route.ts` | Async API route |
| **LangGraph** ||
| `src/lib/enrichment/graph/builder.ts` | Graph construction |
| `src/lib/enrichment/graph/nodes.ts` | Node implementations |
| `src/lib/enrichment/graph/types.ts` | State annotation |
| **Queue** ||
| `src/lib/enrichment/queue/index.ts` | BullMQ queue/worker |
| `src/lib/enrichment/worker.ts` | Standalone worker process |
| **Scoring & Bridge** ||
| `src/lib/enrichment/scoring.ts` | Confidence scoring |
| `src/lib/enrichment/bridge-discovery.ts` | Bridge detection + enforce predicate |
| `src/lib/enrichment/bridge-types.ts` | Tier/signal types + enforce constants |
| `src/lib/enrichment/config.ts` | Threshold configuration (enforce, etc.) |
| **External** ||
| `src/lib/enrichment/github.ts` | GitHub client |
| `src/lib/enrichment/sources/search-executor.ts` | Web search |
| `src/lib/enrichment/summary/generate.ts` | AI summary |
| **Eval** ||
| `scripts/eval-enrichment.ts` | Eval runner |
| `eval/fixtures/candidates.jsonl` | Test fixtures |
| `eval/TODO.md` | Locked invariants |

---

## Appendix: Type Definitions

### Enum Types

```typescript
type EnrichmentPlatform =
  | 'github' | 'stackoverflow' | 'npm' | 'pypi' | 'docker'
  | 'kaggle' | 'orcid' | 'scholar' | 'medium' | 'twitter'
  | 'youtube' | 'dribbble' | 'behance' | 'huggingface'
  | 'papersWithCode' | 'openreview' | 'arxiv' | 'patents'
  | 'sec' | 'crunchbase' | 'angellist' | 'substack'
  | 'devto' | 'gitlab' | 'gist' | 'leetcode' | 'hackerearth'
  | 'codepen' | 'researchgate' | 'semanticscholar' | 'university';

type ConfidenceBucket = 'auto_merge' | 'suggest' | 'low' | 'rejected';

type BridgeTier = 1 | 2 | 3;

type QueryType =
  | 'name_only' | 'name_company' | 'name_location'
  | 'slug_based' | 'handle_based' | 'url_reverse' | 'company_amplified';

type EnrichmentSessionStatus =
  | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

type SummaryMode = 'draft' | 'verified';
```

---

> **Note:** Bridge tiering + auto-merge logic is protected by offline eval harness.
> Changes require fixture updates + CI gate review.
> See `eval/TODO.md` for invariants and metrics.
