# Signal Debug Agent — Design Spec

## Purpose

A read-only, terminal-first investigative agent that answers: **"Why did Signal behave this way?"**

Not a production component. A diagnostic tool for post-hoc analysis of ranking regressions, identity misses, bridge misses, location mistakes, non-tech skill gaps, and "why this person, not that person?" questions.

## Scope

### In scope

- Ranking investigations (why did candidate X rank above/below Y?)
- Identity miss analysis (why was a bridge not detected?)
- Fit breakdown inspection (which scoring component suppressed a candidate?)
- Track classification debugging (why tech vs non-tech?)
- Snapshot/summary state inspection
- Fixture generation from real failures

### Out of scope

- No writes to the database
- No production identity persistence
- No runtime shortlist decisions
- No replacing orchestrator logic
- No autofix or mutation tools

---

## Architecture

### Entry Point

`scripts/signal-debug-agent.ts`

```
npx tsx scripts/signal-debug-agent.ts --request-id <id>
npx tsx scripts/signal-debug-agent.ts --candidate-id <id>
npx tsx scripts/signal-debug-agent.ts --external-job-id <id>
npx tsx scripts/signal-debug-agent.ts --question "why did request X rank candidate Y above Z?"
```

Flags can be combined: `--request-id <id> --candidate-id <id>` narrows to a specific candidate within a request.

`--question` is supplementary context — at least one ID flag is required. If only `--question` is provided, exit with usage help.

### Agent SDK Configuration

```typescript
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

const signalTools = createSdkMcpServer({ name: "signal-debug", tools: [...] });

for await (const message of query({
  prompt: buildPrompt(args),
  options: {
    cwd: "/home/ews/peoplehub/pepolehub",
    allowedTools: ["Read", "Grep", "Glob"],
    permissionMode: "dontAsk",
    maxTurns: 12,
    mcpServers: { "signal-debug": signalTools },
  },
})) { ... }
```

- **Built-in tools**: `Read`, `Grep`, `Glob` (code inspection)
- **Custom tools**: 5 tools via `createSdkMcpServer` — MCP server tools from `mcpServers` are automatically available alongside `allowedTools`
- **Permission mode**: `dontAsk` (all tools are readonly)
- **Max turns**: 12 (if root cause is not clear by then, the toolset/prompt is the problem)
- **Working directory**: `pepolehub/` (so Read/Grep can inspect code)

---

## Custom Tools

All custom tools are local in-process functions registered via `createSdkMcpServer`. No external MCP server infrastructure.

### 1. `get_request_results`

Fetch a sourcing request with ranked candidates.

**Parameters:**
- `requestId` (string, required) — JobSourcingRequest.id
- `limit` (number, default 25) — max candidates to return
- `offset` (number, default 0) — pagination offset
- `includeDiagnostics` (boolean, default true) — include track decision

**Returns normalized summary:**
```
{
  request: {
    id, externalJobId, status, resultCount, queriesExecuted,
    requestedAt, completedAt, lastRerankedAt,
    trackDecision: { track, confidence, method, ... } | null
    // Extracted from request.diagnostics JSON
  },
  candidateCounts: {
    total, enriched, withSnapshot, withIdentity,
    byLocationMatchType: { city_exact, city_alias, country_only, unknown, none },
    bySkillScoreMethod: { snapshot, text_fallback, hybrid_nontech }
  },
  candidates: [
    {
      rank, candidateId, linkedinUrl, nameHint, headlineHint, locationHint,
      fitScore,
      fitBreakdown: { skillScore, skillScoreMethod, roleScore, seniorityScore,
                      activityFreshnessScore, locationBoost,
                      matchTier, locationMatchType },
      enrichmentStatus,
      hasSnapshot: boolean,
      identityCount: number,
      topIdentityConfidence: number | null
    }
  ]
}
```

### 2. `get_candidate_details`

Fetch a candidate with enrichment history, identities, and snapshots.

**Parameters:**
- `candidateId` (string, required) — Candidate.id
- `sessionLimit` (number, default 3) — max enrichment sessions to return

**Returns normalized summary:**
```
{
  candidate: {
    id, linkedinUrl, linkedinId, nameHint, headlineHint, locationHint,
    companyHint, seniorityHint, enrichmentStatus, confidenceScore,
    locationConfidence, locationSource
  },
  snapshots: [
    {
      id, track, skillsNormalized, roleType, seniorityBand, location,
      activityRecencyDays, computedAt, staleAfter
    }
  ],
  identities: [
    {
      id, platform, platformId, profileUrl, confidence, confidenceBucket,
      bridgeTier, bridgeSignals,
      scoreBreakdown: { bridgeWeight, nameMatch, handleMatch, companyMatch,
                        locationMatch, total },
      status, hasContradiction, contradictionNote
    }
  ],
  confirmedIdentities: [
    { id, platform, platformId, confirmedBy, confirmedAt }
  ],
  sessions: [
    {
      id, status, roleType, createdAt,
      queriesExecuted, identitiesFound, finalConfidence,
      identitiesPersisted,  // Derived from runTrace.final, not a direct column
      earlyStopReason,
      runTraceSummary: {
        totalQueries, platformsQueried, platformsWithHits,
        bestConfidence, durationMs,
        tier1Enforced, tier1EnforceThreshold,
        perPlatform: { [platform]: { queries, matched, persisted, bestConfidence } }
      },
      summaryMeta: { mode, confirmedCount, identityKey } | null,
      errorMessage | null
    }
  ]
}
```

### 3. `get_request_candidate`

Fetch a specific candidate's state within a specific sourcing request. The primary tool for "why this person in this request?" and comparison investigations.

**Parameters:**
- `requestId` (string, required) — JobSourcingRequest.id
- `candidateId` (string, required) — Candidate.id

**Returns normalized summary:**
```
{
  request: {
    id, externalJobId, status,
    trackDecision: { track, confidence, method }
  },
  candidateInRequest: {
    rank, fitScore,
    fitBreakdown: { skillScore, skillScoreMethod, roleScore, seniorityScore,
                    effectiveSeniorityScore, activityFreshnessScore, locationBoost,
                    matchTier, locationMatchType, dataConfidence,
                    unknownLocationPromotion },
    enrichmentStatus
  },
  candidate: {
    linkedinUrl, linkedinId, nameHint, headlineHint, locationHint,
    companyHint, seniorityHint, enrichmentStatus, confidenceScore
  },
  snapshot: {
    track, skillsNormalized, roleType, seniorityBand, location,
    activityRecencyDays, computedAt
  } | null,
  topIdentities: [
    {
      platform, platformId, confidence, bridgeTier, bridgeSignals,
      scoreBreakdown: { bridgeWeight, nameMatch, handleMatch, total }
    }
  ],
  latestSession: {
    id, status, queriesExecuted, identitiesFound, finalConfidence,
    runTraceSummary: { totalQueries, platformsQueried, bestConfidence, durationMs }
  } | null
}
```

### 4. `run_sql_readonly`

Execute a validated read-only SQL query against the database.

**Parameters:**
- `query` (string, required) — SQL SELECT statement

**Guardrails:**
1. Strip one trailing semicolon if present
2. Reject any internal semicolons (no multi-statement)
3. Require query starts with `SELECT` or `WITH` (case-insensitive, after trimming)
4. Reject keywords: INSERT, UPDATE, DELETE, ALTER, DROP, CREATE, TRUNCATE, GRANT, REVOKE, COPY
5. Reject Postgres file functions: `pg_read_file`, `pg_read_binary_file`, `lo_export`, `pg_ls_dir`
6. Reject SQL comments (`--`, `/* */`)
7. If no `LIMIT` clause present, append `LIMIT 100`
8. Hard truncate: max 100 rows, max 2000 chars per cell
9. Query timeout: 10 seconds
10. Log executed SQL to stdout before execution

**Execution:** `prisma.$queryRawUnsafe(validatedQuery)`

**Returns:**
```
{
  rowCount: number,
  truncated: boolean,
  columns: string[],
  rows: Record<string, unknown>[]
}
```

### 5. `get_job_summary`

Fetch sourcing request metadata by external job ID.

**Parameters:**
- `externalJobId` (string, required) — the external job identifier

**Returns normalized summary:**
```
{
  requests: [
    {
      id, externalJobId, status, resultCount, requestedAt, completedAt,
      trackDecision: { track, confidence, method } | null,
      topCandidates: [
        { rank, candidateId, fitScore, fitBreakdown: { skillScore, roleScore, locationBoost } }
      ]
    }
  ]
}
```

Note: returns an array because multiple sourcing requests can exist for the same external job ID. Ordered by `requestedAt` descending. Top 5 candidates per request.

---

## System Prompt

The system prompt instructs the agent to act as an investigator. It receives the CLI context (which IDs were provided, what question was asked) and follows this investigation protocol:

1. **Inspect the shortlist** — fetch request results or candidate details based on input
2. **Inspect fit breakdowns** — identify which scoring components drove or suppressed ranking
3. **Inspect snapshot/summary/hint state** — check if data was missing or stale
4. **Inspect identity and bridge state** — check for missed or incorrect bridges
5. **Inspect relevant code paths** — if a scoring bug is suspected, read the code
6. **Form a hypothesis** — based on evidence gathered so far
7. **Run a targeted check** — SQL query or code inspection to confirm/reject hypothesis
8. **Stop when root cause is clear** — produce structured output

### Output Format

```
## Root Cause
<1-2 sentences>

## Evidence
- <data point 1>
- <data point 2>
- ...

## Affected Code Path
- <file:line reference 1>
- <file:line reference 2>

## Classification
<one or more of: data gap | scoring bug | policy issue | observability mismatch>

## Recommended Fix
<specific action>

## Verification Query
<SQL or script command to confirm the fix worked>
```

Classification allows multiple labels because real cases are often compound (e.g., data gap + policy issue, or observability mismatch + scoring bug).

---

## File Structure

```
scripts/
  signal-debug-agent.ts          # Entry point: CLI parsing + Agent SDK query()

  debug-agent/
    tools.ts                     # Custom tool implementations (5 tools)
    sql-validator.ts             # SQL validation and guardrails
    prompt.ts                    # System prompt builder
    formatters.ts                # Prisma result → normalized summary transforms
```

All files under `scripts/debug-agent/` — no src/lib placement until the workflow stabilizes.

---

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — Agent SDK (new dependency)
- `@prisma/client` — already in project
- `zod` — already in project (for tool input validation)

No other new dependencies.

---

## Environment

Requires:
- `DATABASE_URL` — Prisma connection string (existing)
- `ANTHROPIC_API_KEY` — for Agent SDK (or uses Claude Code CLI auth via Pro plan)

---

## Constraints

- **Read-only**: no database mutations, no file writes, no production side effects
- **Terminal-only**: stdout output, no API endpoints, no UI
- **12-turn limit**: if root cause is not clear, the toolset or prompt needs work
- **Size-bounded tools**: structured tools return summaries, not raw Prisma payloads
- **Logged SQL**: every raw query printed to stdout before execution
- **No autofix**: output is diagnosis, not remediation execution
