# PeopleHub Architecture v2.1

## Compliant Recruiter Sourcing Tool

**Version:** 2.1
**Last Updated:** December 2025
**Status:** Implementation Ready

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Data Flow Pipeline](#3-data-flow-pipeline)
4. [SearXNG Integration](#4-searxng-integration)
5. [Enrichment Source Matrix](#5-enrichment-source-matrix)
6. [Identity Resolution System](#6-identity-resolution-system)
7. [Scoring Engine](#7-scoring-engine)
8. [LangGraph Design](#8-langgraph-design)
9. [Data Models](#9-data-models)
10. [API Specifications](#10-api-specifications)
11. [Security & Compliance](#11-security--compliance)
12. [Cost Analysis](#12-cost-analysis)

---

## 1. Executive Summary

### Problem Statement

Traditional LinkedIn scraping tools violate LinkedIn's Terms of Service, creating legal risk. The Proxycurl shutdown (January 2025) and ongoing LinkedIn litigation demonstrate this risk is real and growing.

### Solution

A **compliant sourcing tool** that:
- Uses **SearXNG** (self-hosted) for zero-cost discovery
- Captures **LinkedIn URLs only** (not profile data)
- Enriches from **legal sources** (GitHub API, public web)
- Resolves identities with **human-in-the-loop confirmation**
- Stores only **confirmed identities and enriched data**

### Key Principles

| Principle | Implementation |
|-----------|----------------|
| **Zero LinkedIn scraping** | URL capture only via Chrome extension |
| **Bridge-first discovery** | Explicit links > search-based matching |
| **No merge without a bridge** | Human confirmation required for weak signals |
| **Bad recall > Bad precision** | Conservative matching prevents false merges |
| **Provenance tracking** | Every field has source, timestamp, confidence |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        RECRUITER SOURCING TOOL v2.1                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                      │
│  │ User Query  │───▶│ Policy Pass │───▶│ Groq NLP    │                      │
│  │ + Filters   │    │ Normalize   │    │ → JSON Plan │                      │
│  └─────────────┘    │ Blocklist   │    │ + Validate  │                      │
│                     └─────────────┘    └──────┬──────┘                      │
│                                               │                             │
│  ┌────────────────────────────────────────────▼────────────────────────┐    │
│  │                    LINKEDIN DISCOVERY (SearXNG)                     │    │
│  │  site:linkedin.com/in {query} → URLs + snippets → Dedupe → Leads   │    │
│  └────────────────────────────────────────────┬────────────────────────┘    │
│                                               │                             │
│  ┌────────────────────────────────────────────▼────────────────────────┐    │
│  │                         LEADS UI                                    │    │
│  │  Show ranked results │ User clicks "Research" │ Budget allocated   │    │
│  └────────────────────────────────────────────┬────────────────────────┘    │
│                                               │                             │
│  ┌────────────────────────────────────────────▼────────────────────────┐    │
│  │                    ENRICHMENT ENGINE                                │    │
│  │  ┌──────────────────────────────────────────────────────────────┐  │    │
│  │  │ 1. Deterministic queries (v2.1 matrix by role_type)          │  │    │
│  │  │ 2. SearXNG multi-source search (priority order)              │  │    │
│  │  │ 3. GitHub API for confirmed matches (email from commits)     │  │    │
│  │  │ 4. Score signals + apply guards + check contradictions       │  │    │
│  │  │ 5. Early stop if confidence ≥ 0.90                           │  │    │
│  │  └──────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────┬────────────────────────┘    │
│                                               │                             │
│  ┌────────────────────────────────────────────▼────────────────────────┐    │
│  │                    IDENTITY RESOLUTION                              │    │
│  │  ┌──────────────────────────────────────────────────────────────┐  │    │
│  │  │ Candidates (unconfirmed) → Scoring → Threshold check         │  │    │
│  │  │ ≥0.90: Auto-merge │ 0.70-0.89: Suggest │ <0.70: Show only    │  │    │
│  │  │ Contradiction: Cap at 0.40                                   │  │    │
│  │  └──────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────┬────────────────────────┘    │
│                                               │                             │
│  ┌────────────────────────────────────────────▼────────────────────────┐    │
│  │                    CONFIRMATION UI                                  │    │
│  │  Show candidates + evidence │ Confirm/Reject │ Merge/Split         │    │
│  └────────────────────────────────────────────┬────────────────────────┘    │
│                                               │                             │
│  ┌────────────────────────────────────────────▼────────────────────────┐    │
│  │                    STORAGE                                          │    │
│  │  Candidate (anchor) + ConfirmedIdentities + EnrichedData + Evidence │    │
│  │  TTL by confidence │ Stable key matching │ Audit log               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Discovery** | SearXNG (self-hosted) | Multi-engine search aggregation |
| **Query Parsing** | Groq (llama-3.1-70b) | Fast NLP → structured JSON |
| **Enrichment** | SearXNG + GitHub API | Multi-source data gathering |
| **LLM Processing** | Gemini 2.0 Flash | Summarization, report generation |
| **Orchestration** | LangGraph | Stateful workflow execution |
| **Database** | PostgreSQL (Supabase) | Persistent storage |
| **Cache** | Redis | Hot cache, rate limiting |
| **Framework** | Next.js 15 | API + UI |

---

## 3. Data Flow Pipeline

### 3.1 Discovery Flow

```
User Query: "5 senior rust engineers at fintech startups in SF"
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 1: POLICY CHECK                                         │
│ ─────────────────────                                        │
│ • Normalize location strings (SF → San Francisco)            │
│ • Check blocklist (no "email list", "leak", "hack")          │
│ • Enforce caps: max_queries=5, max_pages=3, max_results=50   │
│ • Output: normalizedQuery or REJECT                          │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 2: NLP PARSING (Groq)                                   │
│ ──────────────────────────                                   │
│ Input: "5 senior rust engineers at fintech startups in SF"   │
│                                                              │
│ Output JSON:                                                 │
│ {                                                            │
│   "count": 5,                                                │
│   "role": "Senior Rust Engineer",                            │
│   "location": "San Francisco",                               │
│   "countryCode": "US",                                       │
│   "keywords": ["Rust", "fintech", "startup"],                │
│   "roleType": "engineer",                                    │
│   "linkedinDiscoveryQueries": [                              │
│     "site:linkedin.com/in \"Rust Engineer\" \"San Francisco\" fintech",
│     "site:linkedin.com/in \"Rust Developer\" SF startup"     │
│   ],                                                         │
│   "enrichmentSources": ["github", "stackoverflow", "npm"],   │
│   "negativeTerms": ["-recruiter", "-hiring"],                │
│   "budgets": {                                               │
│     "maxPages": 3,                                           │
│     "maxResultsPerQuery": 10,                                │
│     "maxSources": 6                                          │
│   }                                                          │
│ }                                                            │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 3: QUERY VALIDATION                                     │
│ ────────────────────────                                     │
│ • Drop queries violating policy                              │
│ • Deduplicate near-duplicate queries                         │
│ • Add required variants (quoted/unquoted)                    │
│ • Validate budgets within limits                             │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 4: LINKEDIN DISCOVERY (SearXNG)                         │
│ ────────────────────────────────────                         │
│ Execute: site:linkedin.com/in queries                        │
│ Engines: Google, Brave, DuckDuckGo, Startpage                │
│                                                              │
│ For each result:                                             │
│ • Extract: URL, title, snippet, engine, position             │
│ • Canonicalize LinkedIn URL                                  │
│ • Dedupe by linkedinId                                       │
│ • Rank by: multi-engine agreement > position > queryMatch    │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 5: SAVE AS LEADS                                        │
│ ─────────────────────                                        │
│ Store in Candidate table:                                    │
│ • linkedinUrl (unique anchor)                                │
│ • linkedinId                                                 │
│ • searchSnippet (from SERP, NOT scraped)                     │
│ • searchTitle                                                │
│ • roleType (from search plan)                                │
│ • capturedAt, captureSource='search'                         │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Enrichment Flow

```
User clicks "Research" on Lead
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 1: LOAD CANDIDATE                                       │
│ ──────────────────────                                       │
│ • Fetch from DB: linkedinUrl, linkedinId, roleType           │
│ • Extract name from searchTitle (heuristic)                  │
│ • Check existing identityCandidates                          │
│ • Initialize budget from roleType                            │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 2: GENERATE QUERIES (Deterministic)                     │
│ ────────────────────────────────────────                     │
│ Using v2.1 matrix for roleType='engineer':                   │
│                                                              │
│ Priority 1: site:github.com "{name}" "{company}"             │
│ Priority 2: site:gist.github.com "{handle}"                  │
│ Priority 3: site:stackoverflow.com/users "{name}"            │
│ Priority 4: site:npmjs.com "{name}" author                   │
│ Priority 5: site:leetcode.com "{name}"                       │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 3: EXECUTE ENRICHMENT (SearXNG)                         │
│ ────────────────────────────────────                         │
│ For each source in priority order:                           │
│                                                              │
│   1. Check circuit breaker (source healthy?)                 │
│   2. Execute SearXNG query                                   │
│   3. Extract identity candidates:                            │
│      • GitHub: username, profile URL                         │
│      • SO: user ID, profile URL                              │
│      • NPM: package maintainer                               │
│   4. Check budget (queriesExecuted < maxTotalQueries?)       │
│   5. Check early stop (confidence ≥ 0.90?)                   │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 4: GITHUB API ENRICHMENT                                │
│ ─────────────────────────────                                │
│ For high-confidence GitHub matches:                          │
│                                                              │
│   1. GET /users/{username}                                   │
│      → profile data, public email (often null)               │
│                                                              │
│   2. GET /users/{username}/repos?sort=pushed&per_page=5      │
│      → recent repositories                                   │
│                                                              │
│   3. GET /repos/{owner}/{repo}/commits?per_page=5            │
│      → commit.author.email (often exposed!)                  │
│                                                              │
│   4. Extract unique emails, filter noreply@github.com        │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 5: SCORE CANDIDATES                                     │
│ ────────────────────────                                     │
│ For each identity candidate:                                 │
│                                                              │
│   1. Extract signals (see Section 7)                         │
│   2. Apply weights from v2.1 matrix                          │
│   3. Apply guards (GitLab, Twitter, NPM/PyPI)                │
│   4. Check contradictions                                    │
│   5. Calculate final confidence score                        │
│   6. Assign bucket: auto_merge/suggest/low/rejected          │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 6: AUTO-MERGE (≥0.90)                                   │
│ ──────────────────────────                                   │
│ If confidence ≥ 0.90:                                        │
│   • Create ConfirmedIdentity record                          │
│   • Store enrichedData (GitHub profile, emails)              │
│   • Update IdentityCandidate status='confirmed'              │
│   • Set confirmedBy='auto_merge'                             │
│                                                              │
│ If confidence < 0.90:                                        │
│   • Keep as IdentityCandidate                                │
│   • Status='unconfirmed'                                     │
│   • Show in UI for human review                              │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│ STEP 7: PERSIST                                              │
│ ─────────────                                                │
│ • Update Candidate.lastEnrichedAt                            │
│ • Update Candidate.confidenceLevel                           │
│ • Save EnrichmentSession (audit trail)                       │
│ • Log to AuditLog                                            │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Search Provider Strategy

### 4.1 Hybrid Search Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    SEARCH PROVIDER STRATEGY                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐     results?     ┌─────────────┐              │
│  │  SearXNG    │────────────────▶ │   Return    │              │
│  │  (Primary)  │       YES        │   Results   │              │
│  │    $0       │                  └─────────────┘              │
│  └──────┬──────┘                                               │
│         │ NO results / error                                   │
│         ▼                                                      │
│  ┌─────────────┐     results?     ┌─────────────┐              │
│  │  Brave API  │────────────────▶ │   Return    │              │
│  │  (Fallback) │       YES        │   Results   │              │
│  │  $5/1000    │                  └─────────────┘              │
│  └──────┬──────┘                                               │
│         │ NO results                                           │
│         ▼                                                      │
│  ┌─────────────┐                                               │
│  │   Return    │                                               │
│  │   Empty     │                                               │
│  └─────────────┘                                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Provider Comparison

| Feature | SearXNG (Primary) | Brave API (Fallback) |
|---------|-------------------|----------------------|
| **Cost** | $0 (self-hosted) | $5/1000 queries |
| **Rate Limit** | Upstream-limited | 1-50 req/sec |
| **Monthly Cap** | Unlimited | 2K free, 20M+ paid |
| **Reliability** | Medium (engine failures) | High |
| **Result Quality** | Good (aggregated) | Excellent |
| **Response Time** | ~400-800ms | ~200ms |

### 4.3 SearXNG Instance Configuration

**Base URL:** `https://searxng-railway-production-9236.up.railway.app`

**Enabled Engines:**

| Engine | Median Latency | Reliability | Notes |
|--------|---------------|-------------|-------|
| Google | 0.1s | 100% | Fastest, primary |
| Brave | 0.4s | 100% | Good fallback |
| DuckDuckGo | 0.6s | 100% | May hit CAPTCHAs |
| Startpage | 0.8s | 100% | Privacy-focused |
| Wikidata | 0.9s | 100% | Entity data |
| Wikipedia | - | 100% | Reference data |

### 4.4 Brave API Configuration

**API Endpoint:** `https://api.search.brave.com/res/v1/web/search`

**Pricing Tiers:**

| Plan | Cost | Rate Limit | Monthly Cap |
|------|------|------------|-------------|
| Free | $0 | 1 req/sec | 2,000 queries |
| Base | $5/1000 | 20 req/sec | 20M queries |
| Pro | $9/1000 | 50 req/sec | Unlimited |

**When to use Brave API:**
- SearXNG returns 0 results
- SearXNG engines are unresponsive (CAPTCHAs)
- SearXNG timeout exceeded
- High-priority/premium users (optional)

### 4.5 SearXNG API Usage

**Request Format:**
```
GET /search?q={query}&format=json&engines={engines}
```

**Response Structure:**
```json
{
  "query": "site:github.com \"John Smith\" stripe",
  "number_of_results": 27,
  "results": [
    {
      "url": "https://github.com/johnsmith",
      "title": "johnsmith (John Smith)",
      "content": "Senior Engineer at Stripe. Building payments infrastructure.",
      "engine": "google",
      "score": 9.0,
      "position": 1,
      "parsed_url": ["https", "github.com", "/johnsmith", "", "", ""],
      "engines": ["google", "brave"],
      "positions": [1, 2]
    }
  ],
  "unresponsive_engines": []
}
```

### 4.6 Query Patterns

| Purpose | Query Pattern | Example |
|---------|---------------|---------|
| LinkedIn Discovery | `site:linkedin.com/in {role} {location}` | `site:linkedin.com/in "Software Engineer" "San Francisco"` |
| GitHub Profiles | `site:github.com "{name}" "{company}"` | `site:github.com "John Smith" "Stripe"` |
| Stack Overflow | `site:stackoverflow.com/users "{name}"` | `site:stackoverflow.com/users "John Smith"` |
| Kaggle | `site:kaggle.com "{name}"` | `site:kaggle.com "John Smith" grandmaster` |
| ORCID | `site:orcid.org "{name}"` | `site:orcid.org "John Smith" researcher` |
| Patents | `site:patents.google.com "{name}" inventor` | `site:patents.google.com "John Smith" inventor` |
| Email Discovery | `"{name}" "{company}" email contact` | `"John Smith" "Stripe" email contact` |

### 4.7 Hybrid Client Implementation

```typescript
// src/lib/search/client.ts

// ============================================
// TYPES
// ============================================

interface SearchResult {
  url: string;
  title: string;
  content: string;
  score: number;
  position: number;
  provider: 'searxng' | 'brave';
  engines?: string[];  // SearXNG only
}

interface SearchOptions {
  limit?: number;
  timeout?: number;
  useFallback?: boolean;  // Enable Brave fallback
}

interface SearXNGResponse {
  query: string;
  number_of_results: number;
  results: Array<{
    url: string;
    title: string;
    content: string;
    engine: string;
    engines: string[];
    score: number;
    position: number;
    positions: number[];
  }>;
  unresponsive_engines: string[];
}

interface BraveResponse {
  query: { original: string };
  web: {
    results: Array<{
      url: string;
      title: string;
      description: string;
      page_age?: string;
    }>;
  };
}

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  searxng: {
    baseUrl: process.env.SEARXNG_URL || 'https://searxng-railway-production-9236.up.railway.app',
    timeout: 10000,
    defaultEngines: ['google', 'brave', 'duckduckgo'],
  },
  brave: {
    baseUrl: 'https://api.search.brave.com/res/v1/web/search',
    apiKey: process.env.BRAVE_API_KEY,
    timeout: 8000,
  },
};

// ============================================
// SEARXNG (PRIMARY)
// ============================================

async function searchSearXNG(query: string, limit: number = 20): Promise<SearchResult[]> {
  const url = new URL('/search', CONFIG.searxng.baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const response = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(CONFIG.searxng.timeout),
  });

  if (!response.ok) {
    throw new Error(`SearXNG error: ${response.status}`);
  }

  const data: SearXNGResponse = await response.json();

  // Check if we got actual results
  if (!data.results || data.results.length === 0) {
    return [];
  }

  // Rank by multi-engine agreement
  return data.results
    .map((r, idx) => ({
      url: r.url,
      title: r.title,
      content: r.content,
      score: r.engines.length * 10 + r.score,  // Boost multi-engine results
      position: idx + 1,
      provider: 'searxng' as const,
      engines: r.engines,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ============================================
// BRAVE API (FALLBACK)
// ============================================

async function searchBrave(query: string, limit: number = 20): Promise<SearchResult[]> {
  if (!CONFIG.brave.apiKey) {
    console.warn('[Search] Brave API key not configured, skipping fallback');
    return [];
  }

  const url = new URL(CONFIG.brave.baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(limit, 20)));  // Brave max is 20

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': CONFIG.brave.apiKey,
    },
    signal: AbortSignal.timeout(CONFIG.brave.timeout),
  });

  if (!response.ok) {
    throw new Error(`Brave API error: ${response.status}`);
  }

  const data: BraveResponse = await response.json();

  if (!data.web?.results || data.web.results.length === 0) {
    return [];
  }

  return data.web.results.map((r, idx) => ({
    url: r.url,
    title: r.title,
    content: r.description,
    score: 10 - idx,  // Simple position-based score
    position: idx + 1,
    provider: 'brave' as const,
  }));
}

// ============================================
// HYBRID SEARCH (MAIN EXPORT)
// ============================================

export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 20, useFallback = true } = options;

  // Try SearXNG first
  try {
    console.log(`[Search] Trying SearXNG: "${query}"`);
    const results = await searchSearXNG(query, limit);

    if (results.length > 0) {
      console.log(`[Search] SearXNG returned ${results.length} results`);
      return results;
    }

    console.log('[Search] SearXNG returned 0 results');
  } catch (error) {
    console.error('[Search] SearXNG failed:', error);
  }

  // Fallback to Brave if enabled
  if (useFallback) {
    try {
      console.log(`[Search] Falling back to Brave API: "${query}"`);
      const results = await searchBrave(query, limit);

      if (results.length > 0) {
        console.log(`[Search] Brave returned ${results.length} results`);
        return results;
      }

      console.log('[Search] Brave returned 0 results');
    } catch (error) {
      console.error('[Search] Brave API failed:', error);
    }
  }

  // Both failed or returned no results
  console.log('[Search] No results from any provider');
  return [];
}

// ============================================
// SPECIALIZED SEARCH FUNCTIONS
// ============================================

export async function searchLinkedInProfiles(
  query: string,
  maxResults: number = 10
): Promise<LinkedInLead[]> {
  const siteQuery = `site:linkedin.com/in ${query}`;
  const results = await search(siteQuery, { limit: maxResults * 2, useFallback: true });

  const leads: LinkedInLead[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const linkedinId = extractLinkedInId(result.url);
    if (!linkedinId || seen.has(linkedinId)) continue;

    seen.add(linkedinId);
    leads.push({
      linkedinUrl: normalizeLinkedInUrl(result.url),
      linkedinId,
      title: result.title,
      snippet: result.content,
      provider: result.provider,
      engines: result.engines,
      score: result.score,
    });

    if (leads.length >= maxResults) break;
  }

  return leads;
}

export async function searchEnrichmentSource(
  name: string,
  company: string | null,
  source: EnrichmentSource,
  handle?: string
): Promise<EnrichmentResult[]> {
  const query = buildEnrichmentQuery(name, company, source, handle);
  const results = await search(query, { limit: 10, useFallback: true });

  return results.map(r => ({
    source,
    url: r.url,
    title: r.title,
    snippet: r.content,
    provider: r.provider,
    score: r.score,
  }));
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function extractLinkedInId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/in\/([^\/]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function normalizeLinkedInUrl(url: string): string {
  const id = extractLinkedInId(url);
  return id ? `https://www.linkedin.com/in/${id}` : url;
}

function buildEnrichmentQuery(
  name: string,
  company: string | null,
  source: EnrichmentSource,
  handle?: string
): string {
  const QUERY_TEMPLATES: Record<EnrichmentSource, string> = {
    github: `site:github.com "${name}"${company ? ` "${company}"` : ''}`,
    gist: `site:gist.github.com ${handle || name}`,
    stackoverflow: `site:stackoverflow.com/users "${name}"`,
    kaggle: `site:kaggle.com "${name}"`,
    orcid: `site:orcid.org "${name}"`,
    scholar: `site:scholar.google.com "${name}"`,
    patents: `site:patents.google.com "${name}" inventor`,
    // ... add more sources
  };

  return QUERY_TEMPLATES[source] || `"${name}" ${source}`;
}
```

---

## 5. Enrichment Source Matrix

### 5.1 Code & Engineering

| Source | Query Pattern | Visibility | Weight | Guard | SearXNG |
|--------|---------------|------------|--------|-------|---------|
| **GitHub** | `site:github.com "{name}" "{company}"` | Profile, repos, bio, username | +0.60 | None | ✅ |
| **GitHub Gists** | `site:gist.github.com "{handle}"` | Config files, email leaks | +0.60 | None | ✅ |
| **GitLab** | `site:gitlab.com/users "{name}"` | Profile, repos, orgs | +0.20 | `gitlab` | ⚠️ Weak |
| **Stack Overflow** | `site:stackoverflow.com/users "{name}"` | Profile, reputation, location | +0.15 | None | ✅ |
| **LeetCode** | `site:leetcode.com "{name}"` | Username, bio, experience | +0.15 | None | ✅ |
| **HackerEarth** | `site:hackerearth.com "{name}"` | Profile, current role | +0.15 | None | ✅ |
| **CodePen** | `site:codepen.io "{name}"` | Pens, bio, social links | +0.20 | None | ✅ |
| **NPM** | `site:npmjs.com "{name}" author` | Package author, email | +0.20 | `npm_pypi` | ✅ |
| **PyPI** | `site:pypi.org "{package}" maintainer` | Maintainer name, email | +0.20 | `npm_pypi` | ✅ |
| **Docker Hub** | `site:hub.docker.com "{name}"` | Profile, repos, bio | +0.20 | None | ✅ |

### 5.2 Data Science & ML

| Source | Query Pattern | Visibility | Weight | Guard | SearXNG |
|--------|---------------|------------|--------|-------|---------|
| **Kaggle** | `site:kaggle.com "{name}" grandmaster` | Tier, medals, competitions | +0.25 | None | ✅ |
| **HuggingFace** | `site:huggingface.co "{name}"` | Models, repos, org | +0.25 | None | ✅ |
| **Papers With Code** | `site:paperswithcode.com "{name}"` | Papers ↔ GitHub repos | +0.45 | None | ✅ |
| **OpenReview** | `site:openreview.net "{name}"` | Papers, affiliations | +0.20 | `openreview` | ⚠️ Weak |

### 5.3 Academic & Authority

| Source | Query Pattern | Visibility | Weight | Guard | SearXNG |
|--------|---------------|------------|--------|-------|---------|
| **ORCID** | `site:orcid.org "{name}"` | Verified ID, institution, email | +0.50 | None | ✅ |
| **Google Scholar** | `site:scholar.google.com "{name}"` | Citations, co-authors | +0.25 | None | ✅ |
| **Semantic Scholar** | `site:semanticscholar.org "{name}"` | Papers, citations | +0.20 | None | ✅ |
| **ResearchGate** | `site:researchgate.net "{name}"` | Publications, institution | +0.20 | None | ✅ |
| **ArXiv** | `site:arxiv.org "{name}"` | Papers, timeline | +0.20 | None | ✅ |
| **University Faculty** | `site:.edu "/people" "{name}" email` | Role, email, CV | +0.60 | None | ✅ |
| **Patents** | `site:patents.google.com "{name}" inventor` | Inventor names, co-inventors | +0.40 | None | ✅ |

### 5.4 Business & Founder

| Source | Query Pattern | Visibility | Weight | Guard | SearXNG |
|--------|---------------|------------|--------|-------|---------|
| **SEC EDGAR** | `site:sec.gov "{name}" officer director` | Legal filings, roles | +0.50 | None | ✅ |
| **Company Team Pages** | `"{company}" /team "{name}"` | Role, bio, photo | +0.40 | None | ✅ |
| **AngelList** | `site:angel.co/u "{name}"` | Founder roles | +0.20 | None | ❌ Blocked |
| **Crunchbase** | `site:crunchbase.com` | Blog articles only | 0 | Skip | ❌ Weak |

### 5.5 Content & Thought Leadership

| Source | Query Pattern | Visibility | Weight | Guard | SearXNG |
|--------|---------------|------------|--------|-------|---------|
| **Medium** | `site:medium.com "@{handle}"` | Articles, author handle | +0.15 | None | ✅ |
| **Dev.to** | `site:dev.to "{name}"` | Articles, bio, join date | +0.15 | None | ✅ |
| **Substack** | `site:substack.com "{name}"` | Newsletter, handle | +0.15 | None | ✅ |
| **YouTube** | `site:youtube.com "{name}" talk` | Conference talks, speaker | +0.20 | None | ✅ |
| **Twitter/X** | `site:twitter.com "{name}" {role}` | Handle, bio, location | +0.15 | `twitter` | ✅ |

### 5.6 Design

| Source | Query Pattern | Visibility | Weight | Guard | SearXNG |
|--------|---------------|------------|--------|-------|---------|
| **Dribbble** | `site:dribbble.com "{name}"` | Portfolio, shots | +0.15 | None | ✅ |
| **Behance** | `site:behance.net "{name}"` | Portfolio, views | +0.15 | None | ✅ |

### 5.7 Role-Based Priority Order

```typescript
const ENRICHMENT_PRIORITY: Record<RoleType, EnrichmentSource[]> = {
  engineer: [
    'github', 'gist', 'stackoverflow', 'npm', 'pypi', 'dockerhub', 'leetcode'
  ],
  data_scientist: [
    'github', 'kaggle', 'huggingface', 'paperswithcode', 'scholar', 'stackoverflow'
  ],
  researcher: [
    'orcid', 'scholar', 'semanticscholar', 'researchgate', 'arxiv', 'patents', 'github'
  ],
  designer: [
    'dribbble', 'behance', 'github', 'codepen', 'twitter', 'medium'
  ],
  founder: [
    'sec', 'company_team', 'github', 'twitter', 'medium', 'youtube'
  ],
  content_creator: [
    'twitter', 'medium', 'substack', 'youtube', 'devto', 'github'
  ],
  unknown: [
    'github', 'stackoverflow', 'twitter', 'medium'
  ],
};
```

---

## 6. Identity Resolution System

### 6.1 Core Concepts

**Candidate:** The LinkedIn URL anchor. No LinkedIn data stored, only the URL.

**Identity Candidate:** A potential match from an external source (GitHub, email, etc.) with confidence score and evidence.

**Confirmed Identity:** A verified match after human confirmation or auto-merge (≥0.90 confidence).

**Bridge:** An explicit connection between identities (bio link, shared email, etc.).

### 6.2 Bridge Types

| Bridge Type | Description | Confidence Boost |
|-------------|-------------|------------------|
| **bio_link** | LinkedIn bio links to GitHub/website | +0.60 |
| **email_commit** | Same email in git commits | +0.70 |
| **gist_email** | Email found in GitHub Gist | +0.60 |
| **faculty_email** | Email on university faculty page | +0.60 |
| **orcid_match** | ORCID links to same publications | +0.50 |
| **sec_filing** | Name appears in SEC filing | +0.50 |
| **paperswithcode** | Paper links to GitHub repo | +0.45 |
| **patent_coinventor** | Same name on patent | +0.40 |
| **company_team** | Listed on company team page | +0.40 |
| **domain_ownership** | Personal domain links to both profiles | +0.30 |
| **handle_match** | Same unique handle across platforms | +0.20 |
| **timeline_overlap** | GitHub activity during employment | +0.15 |
| **company_match** | Same company in bio | +0.10 |
| **name_search** | Name + company search result | +0.05 |

### 6.3 Discovery Order

```
1. EXPLICIT BRIDGES (highest confidence)
   └─ bio_links from LinkedIn (requires extension)
   └─ Personal website → check for links
   └─ Email in git commits

2. VERIFIED IDENTITIES
   └─ ORCID (institutional verification)
   └─ SEC filings (legal documents)
   └─ University faculty pages

3. CROSS-PLATFORM VERIFICATION
   └─ Papers With Code (paper ↔ repo)
   └─ Patent co-inventors
   └─ Company team pages

4. SOFT SIGNALS (require corroboration)
   └─ Handle similarity
   └─ Timeline overlap
   └─ Company match in bio

5. SEARCH-BASED (lowest confidence)
   └─ Name + company search
   └─ Only used as candidates, never auto-merged
```

### 6.4 Contradiction Detection

**Hard Contradictions (cap at 0.40):**

| Contradiction | Example |
|---------------|---------|
| **Location mismatch** | LinkedIn: "Tokyo" vs GitHub: "San Francisco" (no relocation evidence) |
| **Timeline impossible** | GitHub created 2020, LinkedIn shows "Software Engineer 2015-2018" |
| **Company conflict** | LinkedIn: "Google" vs GitHub bio: "Microsoft employee" |
| **Name mismatch** | LinkedIn: "John Smith" vs GitHub: "Jane Doe" |
| **Multiple candidates** | Two different GitHub profiles both claim same LinkedIn |

**Soft Contradictions (reduce confidence):**

| Contradiction | Penalty |
|---------------|---------|
| **Timezone mismatch** | -0.10 |
| **Language mismatch** | -0.10 |
| **Seniority gap** | -0.05 |

---

## 7. Scoring Engine

### 7.1 Signal Weights

```typescript
const SIGNAL_WEIGHTS = {
  // EXPLICIT LINKS (Self-Declared)
  bioLink: 0.60,              // LinkedIn bio → GitHub
  personalWebsite: 0.50,      // Website links both profiles

  // VERIFIED IDENTITY
  emailInCommits: 0.70,       // Same email in git commits
  gistEmail: 0.60,            // Email in GitHub Gist
  facultyEmail: 0.60,         // Email on .edu faculty page
  orcidMatch: 0.50,           // ORCID ↔ Scholar match
  secFiling: 0.50,            // SEC filing officer match

  // CROSS-PLATFORM VERIFICATION
  papersWithCode: 0.45,       // Paper ↔ GitHub repo
  patentCoinventor: 0.40,     // Patent co-inventor
  companyTeamPage: 0.40,      // Company team page match
  domainOwnership: 0.30,      // DNS + backlinks

  // SOFT SIGNALS
  uniqueHandle: 0.20,         // Same rare handle
  timelineOverlap: 0.15,      // GitHub active during employment
  companyInBio: 0.10,         // Same company mentioned
  nameSearch: 0.05,           // Name + company search only
};
```

### 7.2 Guards

```typescript
const GUARDS: Record<string, GuardConfig> = {
  // GitLab: only count with handle overlap or outbound bio link
  gitlab: {
    condition: (match) => match.handleOverlapsGitHub || match.bioLinksOutward,
    fallbackWeight: 0,
  },

  // OpenReview: pointer only, never standalone proof
  openreview: {
    condition: () => false, // Never use as standalone
    fallbackWeight: 0,
    useAs: 'affiliation_hint',
  },

  // Twitter/X: require corroboration
  twitter: {
    condition: (match) =>
      match.bioLinksToGitHubOrSite ||
      match.handleAppearsOnTwoPlusPlatforms,
    fallbackWeight: 0, // Show as candidate only
  },

  // NPM/PyPI: guard against homonyms
  npm_pypi: {
    condition: (match) =>
      match.maintainerNameMatches &&
      (match.emailDomainMatchesCompany || match.emailDomainMatchesPersonalSite),
    fallbackWeight: 0.10, // Capped if guard fails
  },
};
```

### 7.3 Scoring Algorithm

```typescript
interface MatchSignals {
  // Explicit links
  hasExplicitLink: boolean;
  explicitLinkSource?: string;

  // Domain & DNS
  hasDomainMatch: boolean;
  domainName?: string;
  hasDnsProof: boolean;

  // Timeline
  hasTimelineOverlap: boolean;
  overlapYears?: number;

  // Handles
  handleSimilarity: number; // 0-1
  linkedinHandle?: string;
  externalHandle?: string;

  // Career
  hasCareerShapeMatch: boolean;

  // Geo & language
  hasGeoMatch: boolean;
  hasLanguageMatch: boolean;

  // Contradictions
  hasContradiction: boolean;
  contradictionDetails?: string;

  // Recruiter
  recruiterConfirmed: boolean;
  confirmedBy?: string;
}

interface ScoreBreakdown {
  explicitLink: number;
  emailMatch: number;
  domainMatch: number;
  timelineOverlap: number;
  handleSimilarity: number;
  careerShape: number;
  geoLanguage: number;
  total: number;
}

interface ConfidenceScore {
  score: number;
  bucket: 'auto_merge' | 'suggest' | 'low' | 'rejected';
  breakdown: ScoreBreakdown;
  cappedReason?: string;
}

function calculateConfidence(
  signals: MatchSignals,
  source: EnrichmentSource,
  guard?: GuardConfig
): ConfidenceScore {
  const breakdown: ScoreBreakdown = {
    explicitLink: 0,
    emailMatch: 0,
    domainMatch: 0,
    timelineOverlap: 0,
    handleSimilarity: 0,
    careerShape: 0,
    geoLanguage: 0,
    total: 0,
  };

  // Check guard first
  if (guard && !guard.condition(signals)) {
    const fallback = guard.fallbackWeight;
    return {
      score: fallback,
      bucket: fallback >= 0.40 ? 'low' : 'rejected',
      breakdown: { ...breakdown, total: fallback },
      cappedReason: `Guard failed for ${source}`,
    };
  }

  // Calculate base score
  if (signals.hasExplicitLink) {
    breakdown.explicitLink = SIGNAL_WEIGHTS.bioLink;
  }

  if (signals.hasDomainMatch) {
    breakdown.domainMatch = SIGNAL_WEIGHTS.domainOwnership;
    if (signals.hasDnsProof) {
      breakdown.domainMatch = SIGNAL_WEIGHTS.domainOwnership + 0.10;
    }
  }

  if (signals.hasTimelineOverlap) {
    breakdown.timelineOverlap = SIGNAL_WEIGHTS.timelineOverlap;
  }

  if (signals.handleSimilarity > 0.8) {
    breakdown.handleSimilarity = SIGNAL_WEIGHTS.uniqueHandle;
  } else if (signals.handleSimilarity > 0.5) {
    breakdown.handleSimilarity = SIGNAL_WEIGHTS.uniqueHandle * 0.5;
  }

  if (signals.hasCareerShapeMatch) {
    breakdown.careerShape = 0.05;
  }

  if (signals.hasGeoMatch && signals.hasLanguageMatch) {
    breakdown.geoLanguage = 0.03;
  }

  // Calculate total
  let total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  // Recruiter override
  if (signals.recruiterConfirmed) {
    return {
      score: 1.0,
      bucket: 'auto_merge',
      breakdown: { ...breakdown, total: 1.0 },
    };
  }

  // Contradiction cap
  let cappedReason: string | undefined;
  if (signals.hasContradiction) {
    total = Math.min(total, 0.40);
    cappedReason = signals.contradictionDetails || 'Contradiction detected';
  }

  // Cap at 1.0
  total = Math.min(total, 1.0);
  breakdown.total = total;

  // Determine bucket
  const bucket =
    total >= 0.90 ? 'auto_merge' :
    total >= 0.70 ? 'suggest' :
    total >= 0.40 ? 'low' :
    'rejected';

  return { score: total, bucket, breakdown, cappedReason };
}
```

### 7.4 Deduplication

```typescript
function dedupeSignals(signals: Signal[]): Signal[] {
  // Prevent double-counting
  const dominated = new Set<string>();

  for (const signal of signals) {
    // bio_link implies "profile exists"
    if (signal.type === 'bioLink') {
      dominated.add('profileExists');
    }
    // email in commits implies "GitHub profile has email"
    if (signal.type === 'emailInCommits') {
      dominated.add('profileHasEmail');
    }
    // ORCID match implies "scholar profile exists"
    if (signal.type === 'orcidMatch') {
      dominated.add('scholarProfileExists');
    }
  }

  return signals.filter(s => !dominated.has(s.type));
}
```

### 7.5 Thresholds

| Score Range | Bucket | Action |
|-------------|--------|--------|
| ≥ 0.90 | `auto_merge` | Automatically confirm identity |
| 0.70 - 0.89 | `suggest` | High confidence, show prominently |
| 0.40 - 0.69 | `low` | Show as candidate, needs review |
| < 0.40 | `rejected` | Show but mark as unlikely |
| Any contradiction | Cap at 0.40 | Never auto-merge |

---

## 8. LangGraph Design

### 8.1 Discovery Graph

```typescript
// src/lib/discovery/graph.ts

import { StateGraph, Annotation, Send, START, END } from '@langchain/langgraph';

// State Definition
export const DiscoveryStateAnnotation = Annotation.Root({
  // Input
  rawQuery: Annotation<string>(),
  filters: Annotation<SearchFilters | null>(),

  // Policy
  policyViolations: Annotation<string[]>({
    default: () => [],
    reducer: (state, update) => [...state, ...update],
  }),
  normalizedQuery: Annotation<string | null>(),

  // Search Plan
  searchPlan: Annotation<SearchPlan | null>(),
  validatedQueries: Annotation<string[]>({ default: () => [] }),

  // Execution
  rawResults: Annotation<SearXNGResult[]>({
    default: () => [],
    reducer: (state, update) => [...state, ...update],
  }),

  // Output
  leads: Annotation<LinkedInLead[]>({ default: () => [] }),

  // Metadata
  status: Annotation<string>({ default: () => 'idle' }),
  errors: Annotation<string[]>({
    default: () => [],
    reducer: (state, update) => [...state, ...update],
  }),
});

// Node Names
export const DiscoveryNodes = {
  POLICY_CHECK: 'policyCheck',
  PARSE_QUERY: 'parseQuery',
  VALIDATE_PLAN: 'validatePlan',
  EXECUTE_SEARCH: 'executeSearch',
  DEDUPE_LEADS: 'dedupeLeads',
  RANK_LEADS: 'rankLeads',
  SAVE_LEADS: 'saveLeads',
} as const;

// Nodes
const policyCheckNode = async (state: DiscoveryState) => {
  const violations: string[] = [];
  const query = state.rawQuery.trim();

  // Blocklist check
  const blocklist = ['email list', 'leak', 'hack', 'password', 'dump'];
  for (const term of blocklist) {
    if (query.toLowerCase().includes(term)) {
      violations.push(`Blocked term: "${term}"`);
    }
  }

  // Length check
  if (query.length < 2) violations.push('Query too short');
  if (query.length > 200) violations.push('Query too long');

  return {
    policyViolations: violations,
    normalizedQuery: violations.length === 0 ? normalizeQuery(query) : null,
    status: violations.length > 0 ? 'Policy violation' : 'Policy passed',
  };
};

const parseQueryNode = async (state: DiscoveryState) => {
  const searchPlan = await parseSearchQueryFast(state.normalizedQuery!);
  return {
    searchPlan,
    status: 'Query parsed',
  };
};

const validatePlanNode = async (state: DiscoveryState) => {
  const plan = state.searchPlan!;
  const validated: string[] = [];

  for (const query of plan.linkedinDiscoveryQueries) {
    // Check each query against policy
    if (!containsBlockedOperators(query)) {
      validated.push(query);
    }
  }

  // Add variants if needed
  if (validated.length === 0 && plan.role) {
    validated.push(`site:linkedin.com/in "${plan.role}"`);
  }

  return {
    validatedQueries: validated.slice(0, plan.budgets.maxPages),
    status: 'Plan validated',
  };
};

const executeSearchNode = async (state: DiscoveryState) => {
  const results: SearXNGResult[] = [];

  for (const query of state.validatedQueries) {
    try {
      const searchResults = await searchSearXNG(query, {
        limit: state.searchPlan!.budgets.maxResultsPerQuery,
      });
      results.push(...searchResults);
    } catch (error) {
      // Log but continue
      console.error(`Search failed for query: ${query}`, error);
    }
  }

  return {
    rawResults: results,
    status: `Searched ${state.validatedQueries.length} queries`,
  };
};

const dedupeLeadsNode = async (state: DiscoveryState) => {
  const seen = new Map<string, LinkedInLead>();

  for (const result of state.rawResults) {
    const linkedinId = extractLinkedInId(result.url);
    if (!linkedinId) continue;

    const existing = seen.get(linkedinId);
    if (!existing) {
      seen.set(linkedinId, {
        linkedinUrl: normalizeLinkedInUrl(result.url),
        linkedinId,
        title: result.title,
        snippet: result.content,
        engines: result.engines,
        positions: result.positions,
        score: result.score,
      });
    } else {
      // Merge engine data
      existing.engines = [...new Set([...existing.engines, ...result.engines])];
      existing.score = Math.max(existing.score, result.score);
    }
  }

  return {
    leads: Array.from(seen.values()),
    status: `Deduped to ${seen.size} unique leads`,
  };
};

const rankLeadsNode = async (state: DiscoveryState) => {
  const ranked = state.leads
    .map(lead => ({
      ...lead,
      rankScore:
        lead.engines.length * 10 +  // Multi-engine agreement
        (10 - average(lead.positions)) +  // Position (inverse)
        lead.score,  // SearXNG score
    }))
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, state.searchPlan!.count);

  return {
    leads: ranked,
    status: `Ranked ${ranked.length} leads`,
  };
};

const saveLeadsNode = async (state: DiscoveryState) => {
  const saved: string[] = [];

  for (const lead of state.leads) {
    try {
      await prisma.candidate.upsert({
        where: { linkedinUrl: lead.linkedinUrl },
        create: {
          linkedinUrl: lead.linkedinUrl,
          linkedinId: lead.linkedinId,
          searchSnippet: lead.snippet,
          searchTitle: lead.title,
          roleType: state.searchPlan?.roleType || 'unknown',
          captureSource: 'search',
        },
        update: {
          searchSnippet: lead.snippet,
          searchTitle: lead.title,
        },
      });
      saved.push(lead.linkedinId);
    } catch (error) {
      console.error(`Failed to save lead: ${lead.linkedinId}`, error);
    }
  }

  return {
    status: `Saved ${saved.length} leads`,
  };
};

// Graph Builder
export function createDiscoveryGraph() {
  const graph = new StateGraph(DiscoveryStateAnnotation);

  // Add nodes
  graph.addNode(DiscoveryNodes.POLICY_CHECK, policyCheckNode);
  graph.addNode(DiscoveryNodes.PARSE_QUERY, parseQueryNode);
  graph.addNode(DiscoveryNodes.VALIDATE_PLAN, validatePlanNode);
  graph.addNode(DiscoveryNodes.EXECUTE_SEARCH, executeSearchNode);
  graph.addNode(DiscoveryNodes.DEDUPE_LEADS, dedupeLeadsNode);
  graph.addNode(DiscoveryNodes.RANK_LEADS, rankLeadsNode);
  graph.addNode(DiscoveryNodes.SAVE_LEADS, saveLeadsNode);

  // Add edges
  graph.addEdge(START, DiscoveryNodes.POLICY_CHECK);

  graph.addConditionalEdges(
    DiscoveryNodes.POLICY_CHECK,
    (state) => state.policyViolations.length > 0 ? END : DiscoveryNodes.PARSE_QUERY
  );

  graph.addEdge(DiscoveryNodes.PARSE_QUERY, DiscoveryNodes.VALIDATE_PLAN);
  graph.addEdge(DiscoveryNodes.VALIDATE_PLAN, DiscoveryNodes.EXECUTE_SEARCH);
  graph.addEdge(DiscoveryNodes.EXECUTE_SEARCH, DiscoveryNodes.DEDUPE_LEADS);
  graph.addEdge(DiscoveryNodes.DEDUPE_LEADS, DiscoveryNodes.RANK_LEADS);
  graph.addEdge(DiscoveryNodes.RANK_LEADS, DiscoveryNodes.SAVE_LEADS);
  graph.addEdge(DiscoveryNodes.SAVE_LEADS, END);

  return graph.compile();
}
```

### 8.2 Enrichment Graph

```typescript
// src/lib/enrichment/graph.ts

import { StateGraph, Annotation, Send, START, END } from '@langchain/langgraph';

// State Definition
export const EnrichmentStateAnnotation = Annotation.Root({
  // Input
  candidateId: Annotation<string>(),
  linkedinUrl: Annotation<string>(),
  linkedinId: Annotation<string>(),
  displayName: Annotation<string | null>(),
  roleType: Annotation<RoleType>({ default: () => 'unknown' }),

  // Budget
  budget: Annotation<EnrichmentBudget>(),
  queriesExecuted: Annotation<number>({ default: () => 0 }),
  sourcesSearched: Annotation<string[]>({ default: () => [] }),
  currentSourceIndex: Annotation<number>({ default: () => 0 }),

  // Discovery
  enrichmentQueries: Annotation<EnrichmentQuery[]>({ default: () => [] }),
  rawResults: Annotation<EnrichmentResult[]>({
    default: () => [],
    reducer: (state, update) => [...state, ...update],
  }),

  // Identity Resolution
  identityCandidates: Annotation<IdentityCandidate[]>({
    default: () => [],
    reducer: (state, update) => [...state, ...update],
  }),
  signals: Annotation<Map<string, MatchSignals>>({ default: () => new Map() }),
  confidenceScores: Annotation<Map<string, ConfidenceScore>>({ default: () => new Map() }),

  // GitHub specific
  gitHubData: Annotation<GitHubEnrichedData | null>(),
  discoveredEmails: Annotation<string[]>({ default: () => [] }),

  // Output
  confirmedIdentities: Annotation<ConfirmedIdentity[]>({ default: () => [] }),

  // Control
  shouldStop: Annotation<boolean>({ default: () => false }),
  stopReason: Annotation<string | null>(),
  status: Annotation<string>({ default: () => 'idle' }),
  errors: Annotation<string[]>({
    default: () => [],
    reducer: (state, update) => [...state, ...update],
  }),
});

// Node Names
export const EnrichmentNodes = {
  LOAD_CANDIDATE: 'loadCandidate',
  GENERATE_QUERIES: 'generateQueries',
  EXECUTE_ENRICHMENT: 'executeEnrichment',
  EXTRACT_IDENTITIES: 'extractIdentities',
  FETCH_GITHUB: 'fetchGitHub',
  SCORE_CANDIDATES: 'scoreCandidates',
  CHECK_CONTRADICTIONS: 'checkContradictions',
  AUTO_MERGE: 'autoMerge',
  PERSIST: 'persist',
} as const;

// Stop Conditions
interface StopConditions {
  confidenceThreshold: number;
  maxConfirmedIdentities: number;
  maxQueriesPerSource: number;
  maxTotalQueries: number;
  maxConsecutiveFailures: number;
  maxTimeMs: number;
  noNewSignalsThreshold: number;
}

const DEFAULT_STOP_CONDITIONS: StopConditions = {
  confidenceThreshold: 0.90,
  maxConfirmedIdentities: 3,
  maxQueriesPerSource: 5,
  maxTotalQueries: 30,
  maxConsecutiveFailures: 3,
  maxTimeMs: 30000,
  noNewSignalsThreshold: 5,
};

// Routing Logic
function routeAfterScoring(state: EnrichmentState): string {
  // Check for auto-merge candidates
  const autoMergeCandidates = Array.from(state.confidenceScores.entries())
    .filter(([_, score]) => score.bucket === 'auto_merge');

  if (autoMergeCandidates.length > 0) {
    return EnrichmentNodes.AUTO_MERGE;
  }

  // Check budget
  if (state.queriesExecuted >= state.budget.maxTotalQueries) {
    return EnrichmentNodes.PERSIST;
  }

  // Check if more sources to search
  if (state.currentSourceIndex < state.enrichmentQueries.length) {
    return EnrichmentNodes.EXECUTE_ENRICHMENT;
  }

  // Check for high-confidence GitHub match needing API enrichment
  const gitHubCandidate = state.identityCandidates.find(
    c => c.type === 'github' && state.confidenceScores.get(c.id)?.score >= 0.60
  );

  if (gitHubCandidate && !state.gitHubData) {
    return EnrichmentNodes.FETCH_GITHUB;
  }

  return EnrichmentNodes.PERSIST;
}

// Graph Builder
export function createEnrichmentGraph() {
  const graph = new StateGraph(EnrichmentStateAnnotation);

  // Add nodes
  graph.addNode(EnrichmentNodes.LOAD_CANDIDATE, loadCandidateNode);
  graph.addNode(EnrichmentNodes.GENERATE_QUERIES, generateQueriesNode);
  graph.addNode(EnrichmentNodes.EXECUTE_ENRICHMENT, executeEnrichmentNode);
  graph.addNode(EnrichmentNodes.EXTRACT_IDENTITIES, extractIdentitiesNode);
  graph.addNode(EnrichmentNodes.FETCH_GITHUB, fetchGitHubNode);
  graph.addNode(EnrichmentNodes.SCORE_CANDIDATES, scoreCandidatesNode);
  graph.addNode(EnrichmentNodes.CHECK_CONTRADICTIONS, checkContradictionsNode);
  graph.addNode(EnrichmentNodes.AUTO_MERGE, autoMergeNode);
  graph.addNode(EnrichmentNodes.PERSIST, persistNode);

  // Add edges
  graph.addEdge(START, EnrichmentNodes.LOAD_CANDIDATE);
  graph.addEdge(EnrichmentNodes.LOAD_CANDIDATE, EnrichmentNodes.GENERATE_QUERIES);
  graph.addEdge(EnrichmentNodes.GENERATE_QUERIES, EnrichmentNodes.EXECUTE_ENRICHMENT);
  graph.addEdge(EnrichmentNodes.EXECUTE_ENRICHMENT, EnrichmentNodes.EXTRACT_IDENTITIES);
  graph.addEdge(EnrichmentNodes.EXTRACT_IDENTITIES, EnrichmentNodes.SCORE_CANDIDATES);
  graph.addEdge(EnrichmentNodes.SCORE_CANDIDATES, EnrichmentNodes.CHECK_CONTRADICTIONS);

  // Conditional routing after contradiction check
  graph.addConditionalEdges(
    EnrichmentNodes.CHECK_CONTRADICTIONS,
    routeAfterScoring
  );

  graph.addEdge(EnrichmentNodes.FETCH_GITHUB, EnrichmentNodes.SCORE_CANDIDATES);
  graph.addEdge(EnrichmentNodes.AUTO_MERGE, EnrichmentNodes.PERSIST);
  graph.addEdge(EnrichmentNodes.PERSIST, END);

  return graph.compile();
}
```

### 8.3 Graph Visualization

```
DISCOVERY GRAPH:
================

    ┌─────────┐
    │  START  │
    └────┬────┘
         │
         ▼
┌─────────────────┐
│  Policy Check   │──── violations? ──── END
└────────┬────────┘
         │ pass
         ▼
┌─────────────────┐
│  Parse Query    │ (Groq)
│  → JSON Plan    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Validate Plan   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Execute Search  │ (SearXNG)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Dedupe Leads   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Rank Leads    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Save Leads    │
└────────┬────────┘
         │
         ▼
    ┌─────────┐
    │   END   │
    └─────────┘


ENRICHMENT GRAPH:
=================

    ┌─────────┐
    │  START  │
    └────┬────┘
         │
         ▼
┌─────────────────┐
│ Load Candidate  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│Generate Queries │ (v2.1 Matrix)
└────────┬────────┘
         │
         ▼
    ┌────────────────────────────────────┐
    │                                    │
    │    ┌─────────────────┐             │
    │    │Execute Enrichmt │◄────────────┤
    │    │   (SearXNG)     │             │
    │    └────────┬────────┘             │
    │             │                      │
    │             ▼                      │
    │    ┌─────────────────┐             │
    │    │Extract Identity │             │
    │    │   Candidates    │             │
    │    └────────┬────────┘             │
    │             │                      │
    │             ▼                      │
    │    ┌─────────────────┐             │
    │    │Score Candidates │             │
    │    └────────┬────────┘             │
    │             │                      │
    │             ▼                      │
    │    ┌─────────────────┐             │
    │    │Check Contradict.│             │
    │    └────────┬────────┘             │
    │             │                      │
    │    ┌────────┴────────┐             │
    │    │                 │             │
    │    ▼                 ▼             │
    │ ≥0.90?            more sources?────┘
    │    │                 │
    │    ▼                 ▼
    │ ┌──────┐        ┌─────────┐
    │ │GitHub│        │ Persist │
    │ │ API  │        │         │
    │ └──┬───┘        └────┬────┘
    │    │                 │
    └────┴────► Persist ◄──┘
                   │
                   ▼
              ┌─────────┐
              │   END   │
              └─────────┘
```

---

## 9. Data Models

### 9.1 Prisma Schema

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

// ============================================
// CANDIDATE (LinkedIn URL Anchor)
// ============================================
model Candidate {
  id              String   @id @default(cuid())
  linkedinUrl     String   @unique
  linkedinId      String   @unique

  // Display name (ONLY if cross-verified from external source)
  // Never from LinkedIn scraping
  displayName     String?

  // Capture metadata
  capturedAt      DateTime @default(now())
  capturedBy      String?  // User ID or 'system'
  captureSource   String   @default("search") // 'search' | 'extension' | 'import'

  // Role classification (from search plan)
  roleType        String?

  // Search context (snippet from SERP, NOT scraped LinkedIn data)
  searchSnippet   String?  @db.Text
  searchTitle     String?

  // Enrichment state
  lastEnrichedAt  DateTime?
  confidenceLevel Float    @default(0)

  // Relations
  identityCandidates   IdentityCandidate[]
  confirmedIdentities  ConfirmedIdentity[]
  enrichmentSessions   EnrichmentSession[]

  @@index([linkedinId])
  @@index([capturedAt])
  @@index([lastEnrichedAt])
  @@index([roleType])
  @@map("candidates")
}

// ============================================
// IDENTITY CANDIDATE (Unconfirmed Match)
// ============================================
model IdentityCandidate {
  id              String   @id @default(cuid())
  candidateId     String
  candidate       Candidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)

  // Identity info
  type            String   // 'github' | 'email' | 'orcid' | 'twitter' | 'stackoverflow' | ...
  value           String   // URL or identifier (e.g., "https://github.com/johnsmith")
  displayName     String?  // Name from external source

  // Scoring
  confidence      Float
  signals         Json     // MatchSignals object
  evidence        Json     // MatchEvidence[] array
  scoreBreakdown  Json?    // ScoreBreakdown object

  // Status
  status          String   @default("unconfirmed") // 'unconfirmed' | 'confirmed' | 'rejected'
  discoveryMethod String   // 'bio_link' | 'search' | 'email_commit' | ...

  // Confirmation/Rejection
  confirmedBy     String?  // User ID or 'auto_merge'
  confirmedAt     DateTime?
  rejectedBy      String?
  rejectedAt      DateTime?
  rejectedReason  String?

  // Timestamps
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([candidateId, type, value])
  @@index([candidateId])
  @@index([status])
  @@index([confidence])
  @@index([type])
  @@map("identity_candidates")
}

// ============================================
// CONFIRMED IDENTITY (Verified Match)
// ============================================
model ConfirmedIdentity {
  id              String   @id @default(cuid())
  candidateId     String
  candidate       Candidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)

  // Identity info
  type            String
  value           String

  // Enriched data (varies by type)
  // GitHub: { username, repos, languages, emails, ... }
  // Email: { email, verified, source, ... }
  // ORCID: { orcidId, publications, institution, ... }
  enrichedData    Json?

  // Confirmation metadata
  confirmedBy     String   // User ID or 'auto_merge'
  confirmedAt     DateTime @default(now())
  confidenceAtConfirmation Float

  // Evidence chain (for audit)
  evidence        Json     // MatchEvidence[] array

  @@unique([candidateId, type, value])
  @@index([candidateId])
  @@index([type])
  @@map("confirmed_identities")
}

// ============================================
// ENRICHMENT SESSION (Audit Trail)
// ============================================
model EnrichmentSession {
  id              String   @id @default(cuid())
  candidateId     String
  candidate       Candidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)

  // Execution status
  status          String   // 'running' | 'completed' | 'failed' | 'stopped'
  startedAt       DateTime @default(now())
  completedAt     DateTime?

  // Budget tracking
  queriesExecuted Int      @default(0)
  sourcesSearched Json     // string[]

  // Results
  identitiesFound Int      @default(0)
  autoMerged      Int      @default(0)

  // Metadata
  stopReason      String?
  errors          Json?    // string[]
  metadata        Json?    // Additional execution data

  @@index([candidateId])
  @@index([status])
  @@index([startedAt])
  @@map("enrichment_sessions")
}

// ============================================
// AUDIT LOG (Compliance)
// ============================================
model AuditLog {
  id              String   @id @default(cuid())

  // Actor
  userId          String?
  ipAddress       String?
  userAgent       String?

  // Action
  action          String   // 'search' | 'enrich' | 'confirm' | 'reject' | 'merge' | 'export' | 'delete'

  // Target
  entityType      String   // 'candidate' | 'identity' | 'session'
  entityId        String

  // Details
  details         Json?    // Action-specific data

  // Timestamp
  createdAt       DateTime @default(now())

  @@index([userId])
  @@index([action])
  @@index([entityType, entityId])
  @@index([createdAt])
  @@map("audit_logs")
}

// ============================================
// SEARCH CACHE (Performance)
// ============================================
model SearchCache {
  id              String   @id @default(cuid())
  queryHash       String   @unique
  query           String   @db.Text

  // Results
  results         Json     // LinkedInLead[]
  searchPlan      Json     // SearchPlan

  // Metadata
  resultCount     Int
  executionTimeMs Int?

  // TTL
  createdAt       DateTime @default(now())
  expiresAt       DateTime

  @@index([queryHash])
  @@index([expiresAt])
  @@map("search_cache")
}
```

### 9.2 TypeScript Types

```typescript
// src/types/identity.ts

// Role Types
export type RoleType =
  | 'engineer'
  | 'data_scientist'
  | 'researcher'
  | 'designer'
  | 'founder'
  | 'content_creator'
  | 'unknown';

// Identity Types
export type IdentityType =
  | 'github'
  | 'email'
  | 'twitter'
  | 'stackoverflow'
  | 'orcid'
  | 'kaggle'
  | 'huggingface'
  | 'website'
  | 'npm'
  | 'pypi';

// Discovery Methods
export type DiscoveryMethod =
  | 'bio_link'
  | 'website_link'
  | 'email_commit'
  | 'gist_email'
  | 'faculty_email'
  | 'handle_search'
  | 'name_company_search'
  | 'orcid_match'
  | 'patent_match'
  | 'recruiter_confirmed'
  | 'dns_proof';

// Match Evidence
export interface MatchEvidence {
  type: DiscoveryMethod;
  source: string;
  value: string;
  capturedAt: Date;
  metadata?: Record<string, unknown>;
}

// Match Signals
export interface MatchSignals {
  hasExplicitLink: boolean;
  explicitLinkSource?: string;
  hasDomainMatch: boolean;
  domainName?: string;
  hasDnsProof: boolean;
  hasTimelineOverlap: boolean;
  overlapYears?: number;
  overlapDetails?: string;
  handleSimilarity: number;
  linkedinHandle?: string;
  externalHandle?: string;
  hasCareerShapeMatch: boolean;
  careerMatchDetails?: string;
  hasGeoMatch: boolean;
  geoDetails?: string;
  hasLanguageMatch: boolean;
  languageDetails?: string;
  hasContradiction: boolean;
  contradictionDetails?: string;
  recruiterConfirmed: boolean;
  confirmedBy?: string;
  confirmedAt?: Date;
}

// Score Breakdown
export interface ScoreBreakdown {
  explicitLink: number;
  emailMatch: number;
  domainMatch: number;
  timelineOverlap: number;
  handleSimilarity: number;
  careerShape: number;
  geoLanguage: number;
  total: number;
}

// Confidence Score
export interface ConfidenceScore {
  score: number;
  bucket: 'auto_merge' | 'suggest' | 'low' | 'rejected';
  breakdown: ScoreBreakdown;
  cappedReason?: string;
}

// Enrichment Budget
export interface EnrichmentBudget {
  maxPages: number;
  maxResultsPerQuery: number;
  maxSources: number;
  maxTotalQueries: number;
  maxTimeMs: number;
}

// Search Plan
export interface SearchPlan {
  count: number;
  role: string | null;
  location: string | null;
  countryCode: string | null;
  keywords: string[];
  roleType: RoleType;
  linkedinDiscoveryQueries: string[];
  enrichmentSources: IdentityType[];
  negativeTerms: string[];
  budgets: EnrichmentBudget;
}

// GitHub Enriched Data
export interface GitHubEnrichedData {
  username: string;
  profileUrl: string;
  name?: string;
  bio?: string;
  company?: string;
  location?: string;
  email?: string;
  hireable?: boolean;
  publicRepos: number;
  followers: number;
  following: number;
  createdAt: string;
  languages: string[];
  discoveredEmails: string[];
  topRepositories: {
    name: string;
    description?: string;
    url: string;
    language?: string;
    stars: number;
    forks: number;
  }[];
}
```

---

## 10. API Specifications

### 10.1 Search API

**Endpoint:** `POST /api/v2/search`

Compatibility: when `USE_NEW_DISCOVERY=true`, the legacy `POST /api/search` route proxies to `POST /api/v2/search` to keep older clients working.

**Request:**
```json
{
  "query": "5 senior rust engineers at fintech startups in SF",
  "filters": {
    "excludeCompanies": ["Google", "Meta"],
    "minConnections": 500
  }
}
```

**Response (Success):**
```json
{
  "success": true,
  "leads": [
    {
      "id": "clxyz123",
      "linkedinUrl": "https://www.linkedin.com/in/johnsmith",
      "linkedinId": "johnsmith",
      "title": "John Smith - Senior Rust Engineer at Stripe",
      "snippet": "Building payments infrastructure with Rust...",
      "engines": ["google", "brave"],
      "score": 9.2,
      "rankScore": 29.2
    }
  ],
  "searchPlan": {
    "count": 5,
    "role": "Senior Rust Engineer",
    "roleType": "engineer",
    "linkedinDiscoveryQueries": [
      "site:linkedin.com/in \"Rust Engineer\" \"San Francisco\" fintech"
    ]
  },
  "cached": false,
  "timestamp": 1702483200000
}
```

**Response (Policy Violation):**
```json
{
  "success": false,
  "error": "Query violates policy",
  "violations": ["Blocked term: \"email list\""]
}
```

### 10.2 Enrich API

**Endpoint:** `POST /api/enrich`

**Request:**
```json
{
  "candidateId": "clxyz123",
  "budget": {
    "maxSources": 6,
    "maxTotalQueries": 20,
    "maxTimeMs": 30000
  }
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "clsession456",
  "status": "running"
}
```

### 10.3 Enrich Status API

**Endpoint:** `GET /api/enrich/{sessionId}`

**Response:**
```json
{
  "success": true,
  "session": {
    "id": "clsession456",
    "status": "completed",
    "queriesExecuted": 12,
    "sourcesSearched": ["github", "stackoverflow", "npm"],
    "identitiesFound": 3,
    "autoMerged": 1
  },
  "identityCandidates": [
    {
      "id": "clident789",
      "type": "github",
      "value": "https://github.com/johnsmith",
      "displayName": "John Smith",
      "confidence": 0.92,
      "bucket": "auto_merge",
      "status": "confirmed",
      "signals": {
        "hasExplicitLink": true,
        "handleSimilarity": 0.95
      }
    },
    {
      "id": "clident790",
      "type": "stackoverflow",
      "value": "https://stackoverflow.com/users/123456/john-smith",
      "confidence": 0.45,
      "bucket": "low",
      "status": "unconfirmed"
    }
  ],
  "confirmedIdentities": [
    {
      "id": "clconf001",
      "type": "github",
      "value": "https://github.com/johnsmith",
      "confirmedBy": "auto_merge",
      "enrichedData": {
        "username": "johnsmith",
        "publicRepos": 42,
        "languages": ["Rust", "TypeScript", "Go"],
        "discoveredEmails": ["john@smith.dev"]
      }
    }
  ]
}
```

### 10.4 Identity Confirmation API

**Endpoint:** `POST /api/identity/confirm`

**Request:**
```json
{
  "identityCandidateId": "clident790",
  "action": "confirm",
  "notes": "Verified via company team page"
}
```

**Response:**
```json
{
  "success": true,
  "confirmedIdentityId": "clconf002"
}
```

### 10.5 Candidate API

**Endpoint:** `GET /api/candidate/{candidateId}`

**Response:**
```json
{
  "success": true,
  "candidate": {
    "id": "clxyz123",
    "linkedinUrl": "https://www.linkedin.com/in/johnsmith",
    "linkedinId": "johnsmith",
    "displayName": "John Smith",
    "roleType": "engineer",
    "capturedAt": "2025-12-16T10:00:00Z",
    "lastEnrichedAt": "2025-12-16T10:05:00Z",
    "confidenceLevel": 0.92,
    "identityCandidates": [...],
    "confirmedIdentities": [...]
  }
}
```

---

## 11. Security & Compliance

### 11.1 Data Handling

| Data Type | Storage Policy |
|-----------|----------------|
| LinkedIn URL | ✅ Store as anchor |
| LinkedIn ID | ✅ Store for deduplication |
| SERP Title/Snippet | ✅ Store (public search results) |
| LinkedIn Profile Data | ❌ Never store |
| GitHub Profile | ✅ Store if confirmed |
| Email Addresses | ✅ Store if from public sources |
| Evidence/Provenance | ✅ Store for audit |

### 11.2 Compliance Checklist

- [ ] No LinkedIn scraping (URL capture only)
- [ ] All stored data has provenance
- [ ] Human confirmation for matches <0.90
- [ ] Audit log for all actions
- [ ] Data export capability (GDPR)
- [ ] Data deletion capability (GDPR)
- [ ] Rate limiting per user
- [ ] IP-based rate limiting

### 11.3 Legal Language

**DO say:**
- "Discovers public professional profiles"
- "Aggregates publicly available information"
- "Identity verification from public sources"

**DON'T say:**
- "Scrapes LinkedIn"
- "Extracts LinkedIn data"
- "Harvests profile information"

### 11.4 Rate Limiting

```typescript
const RATE_LIMITS = {
  search: {
    perMinute: 10,
    perHour: 100,
    perDay: 500,
  },
  enrich: {
    perMinute: 5,
    perHour: 50,
    perDay: 200,
  },
  github: {
    perHour: 5000, // With auth token
  },
  searxng: {
    perMinute: 30, // Self-imposed to avoid upstream blocks
  },
};
```

---

## 12. Cost Analysis

### 12.1 Per-Operation Costs

| Operation | Provider | Cost |
|-----------|----------|------|
| LinkedIn Discovery | SearXNG | $0 |
| GitHub Discovery | SearXNG | $0 |
| Multi-source Enrichment | SearXNG | $0 |
| Query Parsing | Groq | ~$0.0001 |
| GitHub API | GitHub | $0 (5000 req/hr) |
| Summarization | Gemini | ~$0.001 |
| Report Generation | Gemini | ~$0.003 |
| Verified Email | Hunter.io | $0.05 (optional) |

### 12.2 Per-Candidate Cost

| Scenario | Estimated Cost |
|----------|---------------|
| Discovery only | $0.0001 |
| Discovery + Basic Enrichment | $0.001 |
| Full Enrichment + Report | $0.005 |
| With Hunter.io Email | $0.055 |

### 12.3 Monthly Projection

| Volume | Monthly Cost |
|--------|--------------|
| 1,000 candidates | $5 |
| 10,000 candidates | $50 |
| 100,000 candidates | $500 |

**Note:** 95%+ cost reduction vs. Bright Data ($0.015/profile).

---

## Appendix A: Environment Variables

```bash
# ============================================
# Search Provider Configuration
# ============================================

# Primary search provider: 'brightdata' (v1), 'searxng', or 'brave'
SEARCH_PROVIDER=searxng

# Optional fallback provider (recommended: brave)
SEARCH_FALLBACK_PROVIDER=brave

# SearXNG instance URL
SEARXNG_URL=https://searxng-railway-production-9236.up.railway.app
SEARXNG_TIMEOUT=10000

# Brave Search API (fallback)
BRAVE_API_KEY=...
BRAVE_TIMEOUT=8000

# ============================================
# Query Parsing
# ============================================

# Parser provider: 'gemini' (default) or 'groq'
PARSER_PROVIDER=gemini

# Groq API key (if PARSER_PROVIDER=groq)
GROQ_API_KEY=gsk_...

# Google AI (Gemini) API key
GOOGLE_GENERATIVE_AI_API_KEY=...

# ============================================
# Enrichment
# ============================================

# GitHub API token (for higher rate limits: 5000 req/hr vs 60)
GITHUB_TOKEN=ghp_...

# ============================================
# Database & Cache
# ============================================

DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...
REDIS_URL=redis://...

# ============================================
# v2 Feature Flags
# ============================================

# Enable v2 discovery mode (candidates instead of profiles)
# When true, POST /api/search proxies to POST /api/v2/search
USE_NEW_DISCOVERY=false

# Disable v1 scraping endpoints (returns 410 Gone)
DISABLE_V1_SCRAPING=false

# ============================================
# v2 Authentication
# ============================================

# API keys for machine-to-machine auth (comma-separated)
# Generate with: openssl rand -hex 32
API_KEYS=

# Auth enforcement (defaults based on NODE_ENV)
# In production: auth enforced unless DISABLE_AUTH=true
# In development: auth not enforced unless ENFORCE_AUTH=true
ENFORCE_AUTH=false

# ============================================
# Optional Services
# ============================================

# Hunter.io (email verification)
HUNTER_API_KEY=...
```

---

## Appendix B: Migration from v1

### B.1 Migration Steps

```bash
# 1. Run schema migration
npx prisma migrate dev --name add_identity_resolution

# 2. Backfill candidates from existing Person records
npx tsx scripts/migrate-persons-to-candidates.ts

# 3. Enable feature flag
export USE_NEW_DISCOVERY=true

# 4. Deploy and monitor
```

### B.2 v1 Endpoint Deprecation

The following v1 endpoints perform LinkedIn profile scraping via BrightData and are deprecated:

| v1 Endpoint | Action | v2 Replacement |
|-------------|--------|----------------|
| `GET /api/profile/[linkedinId]` | Scrapes full LinkedIn profile | `POST /api/v2/search` + `POST /api/v2/enrich` |
| `POST /api/search` | Scrapes LinkedIn via BrightData | `POST /api/v2/search` |
| `POST /api/profiles/batch` | Batch scrapes LinkedIn profiles | `POST /api/v2/search` + `POST /api/v2/enrich` |

**Safe v1 endpoints (no deprecation):**
- `GET /api/profiles/recent` - Database queries only
- `POST /api/research` - Web research, no LinkedIn scraping

### B.3 Deprecation Guards

**Profile and Batch endpoints** have deprecation guards that check:

```typescript
function isV1ScrapingDisabled(): boolean {
  return process.env.DISABLE_V1_SCRAPING === 'true' ||
         process.env.USE_NEW_DISCOVERY === 'true';
}
```

When the guard triggers, these endpoints return HTTP 410 Gone:

```json
{
  "success": false,
  "error": "This v1 endpoint is deprecated/disabled (LinkedIn profile scraping). Use v2: POST /api/v2/search + POST /api/v2/enrich."
}
```

**Search endpoint** (`POST /api/search`) uses a proxy pattern instead:
- When `USE_NEW_DISCOVERY=true`, it transparently proxies to `POST /api/v2/search`
- This maintains backward compatibility for existing UI clients
- Returns v2 compliant results (URLs + snippets only, no scraped profiles)

### B.4 Migration Strategy

**Phase 1: Soft Migration (Current)**
- Both v1 and v2 endpoints available
- `DISABLE_V1_SCRAPING=false` (default)
- v2 endpoints tested in parallel

**Phase 2: Hard Migration**
- Set `DISABLE_V1_SCRAPING=true` in production
- v1 scraping endpoints return 410 Gone
- Monitor for client errors, update integrations

**Phase 3: Removal**
- Remove v1 scraping endpoint code
- Remove BrightData integration
- Update documentation

---

**Document Version:** 2.1
**Last Updated:** December 2025
