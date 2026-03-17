# Signal Debug Agent Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only terminal debug agent that investigates why Signal ranked/enriched/bridged candidates the way it did.

**Architecture:** A TypeScript script (`scripts/signal-debug-agent.ts`) using the Claude Agent SDK. 5 custom tools (DB lookups + raw SQL) registered via `createSdkMcpServer`, plus built-in `Read`/`Grep`/`Glob` for code inspection. All readonly, 12-turn max.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`, `@prisma/client`, `zod`

**Spec:** `docs/superpowers/specs/2026-03-17-signal-debug-agent-design.md`

---

## File Structure

```
scripts/
  signal-debug-agent.ts              # CLI entry point: arg parsing, Agent SDK query()
  debug-agent/
    sql-validator.ts                  # SQL validation (10 guardrails)
    formatters.ts                     # Prisma result → normalized summary transforms
    tools.ts                          # 5 MCP tool definitions + implementations
    prompt.ts                         # System prompt builder from CLI args
```

**Responsibilities:**
- `sql-validator.ts` — Pure function: string in, `{ valid, query?, error? }` out. No DB access. Testable in isolation.
- `formatters.ts` — Pure functions: raw Prisma results in, normalized summaries out. No DB access. Testable in isolation.
- `tools.ts` — Wires Prisma queries + formatters into MCP tool definitions. Imports `prisma` from `@/lib/prisma`. Imports formatters and validator.
- `prompt.ts` — Pure function: CLI args in, system prompt string out.
- `signal-debug-agent.ts` — Glue: parses CLI args, creates MCP server from tools, calls Agent SDK `query()`, prints output.

---

## Chunk 1: SQL Validator

### Task 1: SQL validator — core validation logic

**Files:**
- Create: `scripts/debug-agent/sql-validator.ts`

- [ ] **Step 1: Create sql-validator.ts with `validateSql` function**

```typescript
// scripts/debug-agent/sql-validator.ts

/**
 * Validates a SQL string for read-only execution.
 * Returns the cleaned query or an error message.
 */
export function validateSql(raw: string): { valid: true; query: string } | { valid: false; error: string } {
  // 1. Trim whitespace
  let q = raw.trim();

  // 2. Strip one trailing semicolon
  if (q.endsWith(';')) {
    q = q.slice(0, -1).trim();
  }

  // 3. Reject internal semicolons
  if (q.includes(';')) {
    return { valid: false, error: 'Multiple statements not allowed (internal semicolon detected)' };
  }

  // 4. Require starts with SELECT or WITH (case-insensitive)
  const upper = q.toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    return { valid: false, error: 'Query must start with SELECT or WITH' };
  }

  // 5. Reject mutation keywords (word-boundary match)
  const BLOCKED_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'CREATE',
    'TRUNCATE', 'GRANT', 'REVOKE', 'COPY',
  ];
  for (const kw of BLOCKED_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(q)) {
      return { valid: false, error: `Blocked keyword: ${kw}` };
    }
  }

  // 6. Reject Postgres file functions
  const BLOCKED_FUNCTIONS = [
    'pg_read_file', 'pg_read_binary_file', 'lo_export', 'pg_ls_dir', 'pg_stat_file',
  ];
  for (const fn of BLOCKED_FUNCTIONS) {
    if (q.toLowerCase().includes(fn)) {
      return { valid: false, error: `Blocked function: ${fn}` };
    }
  }

  // 7. Reject SQL comments
  if (q.includes('--') || q.includes('/*')) {
    return { valid: false, error: 'SQL comments not allowed' };
  }

  // 8. Append LIMIT 100 if no LIMIT clause
  if (!/\bLIMIT\b/i.test(q)) {
    q = `${q} LIMIT 100`;
  }

  return { valid: true, query: q };
}

/**
 * Truncate query results: max rows and max chars per cell.
 */
export function truncateResults(
  rows: Record<string, unknown>[],
  maxRows = 100,
  maxCellChars = 2000,
): { rows: Record<string, unknown>[]; truncated: boolean } {
  const truncated = rows.length > maxRows;
  const limited = rows.slice(0, maxRows);

  const cleaned = limited.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string' && v.length > maxCellChars) {
        out[k] = v.slice(0, maxCellChars) + '…';
      } else {
        out[k] = v;
      }
    }
    return out;
  });

  return { rows: cleaned, truncated };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/ews/peoplehub/pepolehub && npx tsx --eval "import { validateSql } from './scripts/debug-agent/sql-validator'; console.log(validateSql('SELECT 1'))"`
Expected: `{ valid: true, query: 'SELECT 1 LIMIT 100' }`

- [ ] **Step 3: Write inline smoke tests**

Add to the bottom of `sql-validator.ts`:

```typescript
// ---- Smoke tests (run directly: npx tsx scripts/debug-agent/sql-validator.ts) ----
if (process.argv[1]?.endsWith('sql-validator.ts')) {
  const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

  // Valid queries
  const r1 = validateSql('SELECT * FROM candidates');
  assert(r1.valid && r1.query === 'SELECT * FROM candidates LIMIT 100', 'basic select');

  const r2 = validateSql('  SELECT 1;  ');
  assert(r2.valid && r2.query === 'SELECT 1 LIMIT 100', 'trim + trailing semi');

  const r3 = validateSql('WITH cte AS (SELECT 1) SELECT * FROM cte LIMIT 10');
  assert(r3.valid && r3.query.includes('LIMIT 10'), 'WITH + existing LIMIT preserved');

  // Blocked queries
  const r4 = validateSql('DELETE FROM candidates');
  assert(!r4.valid, 'reject DELETE');

  const r5 = validateSql('SELECT 1; DROP TABLE candidates');
  assert(!r5.valid, 'reject multi-statement');

  const r6 = validateSql('SELECT pg_read_file(\'/etc/passwd\')');
  assert(!r6.valid, 'reject pg_read_file');

  const r7 = validateSql('SELECT * FROM candidates -- comment');
  assert(!r7.valid, 'reject comments');

  const r8 = validateSql('EXPLAIN ANALYZE SELECT 1');
  assert(!r8.valid, 'reject EXPLAIN (not SELECT/WITH)');

  // Truncation
  const bigRows = Array.from({ length: 150 }, (_, i) => ({ id: i, long: 'x'.repeat(3000) }));
  const tr = truncateResults(bigRows);
  assert(tr.truncated, 'truncation flag');
  assert(tr.rows.length === 100, 'row limit');
  assert((tr.rows[0].long as string).length <= 2001, 'cell truncation');

  console.log('All sql-validator smoke tests passed');
}
```

- [ ] **Step 4: Run smoke tests**

Run: `cd /home/ews/peoplehub/pepolehub && npx tsx scripts/debug-agent/sql-validator.ts`
Expected: `All sql-validator smoke tests passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/debug-agent/sql-validator.ts
git commit -m "feat(debug-agent): add SQL validator with 10 guardrails"
```

---

## Chunk 2: Formatters

### Task 2: Prisma result formatters

**Files:**
- Create: `scripts/debug-agent/formatters.ts`

These are pure functions that transform raw Prisma query results into the normalized summaries defined in the spec. No DB access — they receive already-fetched data.

- [ ] **Step 1: Create formatters.ts with all 5 formatter functions**

```typescript
// scripts/debug-agent/formatters.ts

/**
 * Pure transforms: raw Prisma results → normalized summaries.
 * Shapes match the spec in docs/superpowers/specs/2026-03-17-signal-debug-agent-design.md
 */

// ---- Types (input shapes from Prisma) ----

// We use loose types here since these come from Prisma includes with JSON fields.
// The formatters extract and reshape only the fields the agent needs.

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Row = Record<string, unknown>;

// ---- Helpers ----

function safeJson<T = JsonValue>(val: unknown): T | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val as T;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return null; }
  }
  return null;
}

function pick<T extends Row, K extends string>(obj: T, keys: K[]): Partial<T> {
  const out: Row = {};
  for (const k of keys) {
    if (k in obj) out[k] = obj[k];
  }
  return out as Partial<T>;
}

// ---- 1. formatRequestResults ----

export function formatRequestResults(
  request: Row,
  allCandidates: Row[],
  opts: { limit: number; offset: number; includeDiagnostics: boolean },
) {
  const diagnostics = safeJson<Row>(request.diagnostics);
  const trackDecision = opts.includeDiagnostics ? diagnostics?.trackDecision ?? null : null;

  // Count aggregations over ALL candidates (not just the page)
  const counts = {
    total: allCandidates.length,
    enriched: allCandidates.filter((c) => c.enrichmentStatus === 'completed').length,
    withSnapshot: allCandidates.filter((c) => c.hasSnapshot).length,
    withIdentity: allCandidates.filter((c) => (c.identityCount as number) > 0).length,
    byLocationMatchType: countBy(allCandidates, 'locationMatchType'),
    bySkillScoreMethod: countBy(allCandidates, 'skillScoreMethod'),
  };

  // Paginated candidates
  const page = allCandidates.slice(opts.offset, opts.offset + opts.limit);

  return {
    request: {
      id: request.id,
      externalJobId: request.externalJobId,
      status: request.status,
      resultCount: request.resultCount,
      queriesExecuted: request.queriesExecuted,
      requestedAt: request.requestedAt,
      completedAt: request.completedAt,
      lastRerankedAt: request.lastRerankedAt,
      trackDecision,
    },
    candidateCounts: counts,
    candidates: page,
  };
}

function countBy(rows: Row[], field: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const val = String(row[field] ?? 'unknown');
    out[val] = (out[val] ?? 0) + 1;
  }
  return out;
}

// ---- 2. formatCandidateDetails ----

export function formatCandidateDetails(
  candidate: Row,
  snapshots: Row[],
  identities: Row[],
  confirmedIdentities: Row[],
  sessions: Row[],
) {
  return {
    candidate: pick(candidate, [
      'id', 'linkedinUrl', 'linkedinId', 'nameHint', 'headlineHint', 'locationHint',
      'companyHint', 'seniorityHint', 'enrichmentStatus', 'confidenceScore',
      'locationConfidence', 'locationSource',
    ]),
    snapshots: snapshots.map((s) => pick(s, [
      'id', 'track', 'skillsNormalized', 'roleType', 'seniorityBand', 'location',
      'activityRecencyDays', 'computedAt', 'staleAfter',
    ])),
    identities: identities.map((i) => ({
      ...pick(i, [
        'id', 'platform', 'platformId', 'profileUrl', 'confidence', 'confidenceBucket',
        'bridgeTier', 'bridgeSignals', 'status', 'hasContradiction', 'contradictionNote',
      ]),
      scoreBreakdown: extractScoreBreakdown(i.scoreBreakdown),
    })),
    confirmedIdentities: confirmedIdentities.map((c) => pick(c, [
      'id', 'platform', 'platformId', 'confirmedBy', 'confirmedAt',
    ])),
    sessions: sessions.map(formatSessionSummary),
  };
}

function extractScoreBreakdown(raw: unknown): Row | null {
  const sb = safeJson<Row>(raw);
  if (!sb) return null;
  return pick(sb as Row, ['bridgeWeight', 'nameMatch', 'handleMatch', 'companyMatch', 'locationMatch', 'total']);
}

// ---- 3. formatRequestCandidate ----

export function formatRequestCandidate(
  request: Row,
  jsc: Row,
  candidate: Row,
  snapshot: Row | null,
  identities: Row[],
  session: Row | null,
) {
  const diagnostics = safeJson<Row>(request.diagnostics);
  const fitBreakdown = safeJson<Row>(jsc.fitBreakdown);

  return {
    request: {
      id: request.id,
      externalJobId: request.externalJobId,
      status: request.status,
      trackDecision: diagnostics?.trackDecision ?? null,
    },
    candidateInRequest: {
      rank: jsc.rank,
      fitScore: jsc.fitScore,
      fitBreakdown: fitBreakdown ? pick(fitBreakdown as Row, [
        'skillScore', 'skillScoreMethod', 'roleScore', 'seniorityScore',
        'effectiveSeniorityScore', 'activityFreshnessScore', 'locationBoost',
        'matchTier', 'locationMatchType', 'dataConfidence', 'unknownLocationPromotion',
      ]) : null,
      enrichmentStatus: jsc.enrichmentStatus,
    },
    candidate: pick(candidate, [
      'linkedinUrl', 'linkedinId', 'nameHint', 'headlineHint', 'locationHint',
      'companyHint', 'seniorityHint', 'enrichmentStatus', 'confidenceScore',
    ]),
    snapshot: snapshot ? pick(snapshot, [
      'track', 'skillsNormalized', 'roleType', 'seniorityBand', 'location',
      'activityRecencyDays', 'computedAt',
    ]) : null,
    topIdentities: identities.slice(0, 5).map((i) => ({
      ...pick(i, ['platform', 'platformId', 'confidence', 'bridgeTier', 'bridgeSignals']),
      scoreBreakdown: extractScoreBreakdown(i.scoreBreakdown),
    })),
    latestSession: session ? formatSessionSummary(session) : null,
  };
}

// ---- 4. formatJobSummary ----

export function formatJobSummary(requests: Row[]) {
  return {
    requests: requests.map((r) => {
      const diagnostics = safeJson<Row>(r.diagnostics);
      const candidates = (r.candidates as Row[]) ?? [];
      return {
        id: r.id,
        externalJobId: r.externalJobId,
        status: r.status,
        resultCount: r.resultCount,
        requestedAt: r.requestedAt,
        completedAt: r.completedAt,
        trackDecision: diagnostics?.trackDecision ?? null,
        topCandidates: candidates.slice(0, 5).map((c) => {
          const fb = safeJson<Row>(c.fitBreakdown);
          return {
            rank: c.rank,
            candidateId: c.candidateId,
            fitScore: c.fitScore,
            fitBreakdown: fb ? pick(fb as Row, ['skillScore', 'roleScore', 'locationBoost']) : null,
          };
        }),
      };
    }),
  };
}

// ---- Session summary helper ----

function formatSessionSummary(session: Row) {
  const trace = safeJson<Row>(session.runTrace);
  const final_ = trace?.final as Row | undefined;
  const platformResults = trace?.platformResults as Record<string, Row> | undefined;
  const summaryMeta = trace?.summaryMeta as Row | undefined;

  const perPlatform: Record<string, Row> = {};
  if (platformResults) {
    for (const [platform, pd] of Object.entries(platformResults)) {
      perPlatform[platform] = {
        queries: pd.queriesExecuted ?? 0,
        matched: pd.matchedResultCount ?? pd.rawResultCount ?? 0,
        persisted: pd.identitiesPersisted ?? 0,
        bestConfidence: pd.bestConfidence ?? 0,
      };
    }
  }

  return {
    id: session.id,
    status: session.status,
    roleType: session.roleType,
    createdAt: session.createdAt,
    queriesExecuted: session.queriesExecuted,
    identitiesFound: session.identitiesFound,
    finalConfidence: session.finalConfidence,
    identitiesPersisted: final_?.identitiesPersisted ?? null,
    earlyStopReason: session.earlyStopReason,
    runTraceSummary: {
      totalQueries: final_?.totalQueriesExecuted ?? session.queriesExecuted ?? 0,
      platformsQueried: final_?.platformsQueried ?? Object.keys(perPlatform).length,
      platformsWithHits: final_?.platformsWithHits ?? 0,
      bestConfidence: final_?.bestConfidence ?? 0,
      durationMs: final_?.durationMs ?? 0,
      tier1Enforced: final_?.tier1Enforced ?? 0,
      tier1EnforceThreshold: final_?.tier1EnforceThreshold ?? null,
      perPlatform,
    },
    summaryMeta: summaryMeta ? pick(summaryMeta, ['mode', 'confirmedCount', 'identityKey']) : null,
    errorMessage: session.errorMessage ?? null,
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/ews/peoplehub/pepolehub && npx tsx --eval "import { formatRequestResults } from './scripts/debug-agent/formatters'; console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/debug-agent/formatters.ts
git commit -m "feat(debug-agent): add Prisma result formatters"
```

---

## Chunk 3: Tools (MCP tool definitions + Prisma queries)

### Task 3: Custom MCP tools

**Files:**
- Create: `scripts/debug-agent/tools.ts`

This file wires together Prisma queries, formatters, and the SQL validator into 5 MCP tool definitions.

**Key reference files:**
- Prisma client: `src/lib/prisma.ts`
- Prisma schema: `prisma/schema.prisma` (for table/field names)
- Existing query patterns: `src/app/api/v3/jobs/[id]/results/route.ts`

- [ ] **Step 1: Create tools.ts**

```typescript
// scripts/debug-agent/tools.ts

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { prisma } from '../../src/lib/prisma';
import { validateSql, truncateResults } from './sql-validator';
import {
  formatRequestResults,
  formatCandidateDetails,
  formatRequestCandidate,
  formatJobSummary,
} from './formatters';

// Note: imports use relative paths because scripts/ is outside src/.
// The prisma import uses ../src/lib/prisma since @/ alias may not resolve
// from scripts/. If it does (tsx respects tsconfig paths), use @/lib/prisma.

// ---- 1. get_request_results ----

export const getRequestResults = tool(
  'get_request_results',
  'Fetch a sourcing request with ranked candidates. Returns request metadata, candidate distribution counts, and paginated candidate rows with fit breakdowns.',
  {
    requestId: z.string().describe('JobSourcingRequest.id (UUID)'),
    limit: z.number().default(25).describe('Max candidates to return (default 25)'),
    offset: z.number().default(0).describe('Pagination offset (default 0)'),
    includeDiagnostics: z.boolean().default(true).describe('Include track decision from diagnostics JSON'),
  },
  async (args) => {
    const request = await prisma.jobSourcingRequest.findUnique({
      where: { id: args.requestId },
    });
    if (!request) {
      return { content: [{ type: 'text' as const, text: `Request ${args.requestId} not found` }] };
    }

    const jscRows = await prisma.jobSourcingCandidate.findMany({
      where: { sourcingRequestId: args.requestId },
      orderBy: { rank: 'asc' },
      include: {
        candidate: {
          select: {
            linkedinUrl: true, nameHint: true, headlineHint: true, locationHint: true,
            enrichmentStatus: true,
            intelligenceSnapshots: { orderBy: { computedAt: 'desc' }, take: 1 },
            _count: { select: { identityCandidates: true } },
            identityCandidates: { orderBy: { confidence: 'desc' }, take: 1, select: { confidence: true } },
          },
        },
      },
    });

    // Flatten for formatter
    const allCandidates = jscRows.map((jsc) => {
      const fb = jsc.fitBreakdown as Record<string, unknown> | null;
      return {
        rank: jsc.rank,
        candidateId: jsc.candidateId,
        linkedinUrl: jsc.candidate.linkedinUrl,
        nameHint: jsc.candidate.nameHint,
        headlineHint: jsc.candidate.headlineHint,
        locationHint: jsc.candidate.locationHint,
        fitScore: jsc.fitScore,
        fitBreakdown: fb,
        skillScoreMethod: fb?.skillScoreMethod ?? 'unknown',
        locationMatchType: fb?.locationMatchType ?? 'unknown',
        matchTier: fb?.matchTier ?? 'unknown',
        enrichmentStatus: jsc.candidate.enrichmentStatus ?? jsc.enrichmentStatus,
        hasSnapshot: jsc.candidate.intelligenceSnapshots.length > 0,
        identityCount: jsc.candidate._count.identityCandidates,
        topIdentityConfidence: jsc.candidate.identityCandidates[0]?.confidence ?? null,
      };
    });

    const result = formatRequestResults(request as Record<string, unknown>, allCandidates, {
      limit: args.limit,
      offset: args.offset,
      includeDiagnostics: args.includeDiagnostics,
    });

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ---- 2. get_candidate_details ----

export const getCandidateDetails = tool(
  'get_candidate_details',
  'Fetch a candidate with enrichment history, identities, snapshots, and session diagnostics.',
  {
    candidateId: z.string().describe('Candidate.id (UUID)'),
    sessionLimit: z.number().default(3).describe('Max enrichment sessions to return (default 3)'),
  },
  async (args) => {
    const candidate = await prisma.candidate.findUnique({
      where: { id: args.candidateId },
    });
    if (!candidate) {
      return { content: [{ type: 'text' as const, text: `Candidate ${args.candidateId} not found` }] };
    }

    const [snapshots, identities, confirmedIdentities, sessions] = await Promise.all([
      prisma.candidateIntelligenceSnapshot.findMany({
        where: { candidateId: args.candidateId },
        orderBy: { computedAt: 'desc' },
      }),
      prisma.identityCandidate.findMany({
        where: { candidateId: args.candidateId },
        orderBy: { confidence: 'desc' },
        take: 10,
      }),
      prisma.confirmedIdentity.findMany({
        where: { candidateId: args.candidateId },
        orderBy: { confirmedAt: 'desc' },
      }),
      prisma.enrichmentSession.findMany({
        where: { candidateId: args.candidateId },
        orderBy: { createdAt: 'desc' },
        take: args.sessionLimit,
      }),
    ]);

    const result = formatCandidateDetails(
      candidate as unknown as Record<string, unknown>,
      snapshots as unknown as Record<string, unknown>[],
      identities as unknown as Record<string, unknown>[],
      confirmedIdentities as unknown as Record<string, unknown>[],
      sessions as unknown as Record<string, unknown>[],
    );

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ---- 3. get_request_candidate ----

export const getRequestCandidate = tool(
  'get_request_candidate',
  'Fetch a specific candidate within a sourcing request. The primary tool for "why this person?" and candidate comparison investigations.',
  {
    requestId: z.string().describe('JobSourcingRequest.id (UUID)'),
    candidateId: z.string().describe('Candidate.id (UUID)'),
  },
  async (args) => {
    const jsc = await prisma.jobSourcingCandidate.findFirst({
      where: { sourcingRequestId: args.requestId, candidateId: args.candidateId },
      include: { sourcingRequest: true },
    });
    if (!jsc) {
      return { content: [{ type: 'text' as const, text: `Candidate ${args.candidateId} not in request ${args.requestId}` }] };
    }

    const candidate = await prisma.candidate.findUnique({ where: { id: args.candidateId } });
    if (!candidate) {
      return { content: [{ type: 'text' as const, text: `Candidate ${args.candidateId} not found` }] };
    }

    const [snapshots, identities, sessions] = await Promise.all([
      prisma.candidateIntelligenceSnapshot.findMany({
        where: { candidateId: args.candidateId },
        orderBy: { computedAt: 'desc' },
        take: 1,
      }),
      prisma.identityCandidate.findMany({
        where: { candidateId: args.candidateId },
        orderBy: { confidence: 'desc' },
        take: 5,
      }),
      prisma.enrichmentSession.findMany({
        where: { candidateId: args.candidateId },
        orderBy: { createdAt: 'desc' },
        take: 1,
      }),
    ]);

    const result = formatRequestCandidate(
      jsc.sourcingRequest as unknown as Record<string, unknown>,
      jsc as unknown as Record<string, unknown>,
      candidate as unknown as Record<string, unknown>,
      (snapshots[0] as unknown as Record<string, unknown>) ?? null,
      identities as unknown as Record<string, unknown>[],
      (sessions[0] as unknown as Record<string, unknown>) ?? null,
    );

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ---- 4. run_sql_readonly ----

export const runSqlReadonly = tool(
  'run_sql_readonly',
  'Execute a validated read-only SQL query. Only SELECT/WITH allowed. Max 100 rows. Use for ad-hoc investigation when structured tools are insufficient.',
  {
    query: z.string().describe('SQL SELECT statement'),
  },
  async (args) => {
    const validation = validateSql(args.query);
    if (!validation.valid) {
      return { content: [{ type: 'text' as const, text: `SQL validation failed: ${validation.error}` }] };
    }

    console.log(`[run_sql_readonly] ${validation.query}`);

    try {
      const rawRows = await prisma.$queryRawUnsafe(validation.query) as Record<string, unknown>[];
      const { rows, truncated } = truncateResults(rawRows);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ rowCount: rows.length, truncated, columns, rows }, null, 2),
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `SQL error: ${msg}` }] };
    }
  },
);

// ---- 5. get_job_summary ----

export const getJobSummary = tool(
  'get_job_summary',
  'Fetch sourcing request metadata by external job ID. Returns all requests for that job (there may be multiple). Requires tenantId because externalJobId is not globally unique.',
  {
    externalJobId: z.string().describe('External job identifier'),
    tenantId: z.string().describe('Tenant ID (required — externalJobId is not globally unique)'),
  },
  async (args) => {
    const requests = await prisma.jobSourcingRequest.findMany({
      where: { externalJobId: args.externalJobId, tenantId: args.tenantId },
      orderBy: { requestedAt: 'desc' },
      include: {
        candidates: {
          orderBy: { rank: 'asc' },
          take: 5,
        },
      },
    });

    if (requests.length === 0) {
      return { content: [{ type: 'text' as const, text: `No requests found for job ${args.externalJobId} in tenant ${args.tenantId}` }] };
    }

    const result = formatJobSummary(requests as unknown as Record<string, unknown>[]);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

export const allTools = [getRequestResults, getCandidateDetails, getRequestCandidate, runSqlReadonly, getJobSummary];
```

**Import paths:** Since `tools.ts` is in `scripts/debug-agent/`, use `../../src/lib/prisma` (two levels up to project root). The `@/` alias may not resolve from `scripts/` via `tsx`.

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/ews/peoplehub/pepolehub && npx tsx --eval "import { allTools } from './scripts/debug-agent/tools'; console.log(allTools.length)"`

If the `@/lib/prisma` import fails, switch to relative: `import { prisma } from '../../src/lib/prisma'` (from `scripts/debug-agent/tools.ts`).

Expected: `5` (or the tool names if the SDK exposes `.name`)

- [ ] **Step 3: Commit**

```bash
git add scripts/debug-agent/tools.ts
git commit -m "feat(debug-agent): add 5 MCP tool definitions with Prisma queries"
```

---

## Chunk 4: System Prompt + Entry Point

### Task 4: System prompt builder

**Files:**
- Create: `scripts/debug-agent/prompt.ts`

- [ ] **Step 1: Create prompt.ts**

```typescript
// scripts/debug-agent/prompt.ts

export interface DebugAgentArgs {
  requestId?: string;
  candidateId?: string;
  externalJobId?: string;
  tenantId?: string;
  question?: string;
}

export function buildPrompt(args: DebugAgentArgs): string {
  const contextLines: string[] = [];

  if (args.requestId) {
    contextLines.push(`Sourcing request ID: ${args.requestId}`);
  }
  if (args.candidateId) {
    contextLines.push(`Candidate ID: ${args.candidateId}`);
  }
  if (args.externalJobId) {
    contextLines.push(`External job ID: ${args.externalJobId} (tenant: ${args.tenantId})`);
  }
  if (args.question) {
    contextLines.push(`User question: ${args.question}`);
  }

  const contextBlock = contextLines.length > 0
    ? `\n## Investigation Context\n\n${contextLines.join('\n')}\n`
    : '';

  return `${SYSTEM_PROMPT}${contextBlock}

Begin your investigation now. Start by fetching the relevant data using the structured tools, then follow the investigation protocol.`;
}

const SYSTEM_PROMPT = `You are a Signal Debug Agent — an investigator that diagnoses why the Signal sourcing system behaved the way it did.

You have access to:
- **get_request_results** — fetch a sourcing request with ranked candidates and fit breakdowns
- **get_candidate_details** — fetch a candidate with enrichment history, identities, and snapshots
- **get_request_candidate** — fetch a specific candidate within a request (best for comparisons)
- **get_job_summary** — fetch sourcing request metadata by external job ID
- **run_sql_readonly** — execute ad-hoc read-only SQL for unexpected investigations
- **Read, Grep, Glob** — inspect source code when you suspect a scoring bug

## Investigation Protocol

1. **Inspect the shortlist** — fetch request results or candidate details based on the input
2. **Inspect fit breakdowns** — identify which scoring components drove or suppressed ranking
3. **Inspect snapshot/summary/hint state** — check if data was missing or stale
4. **Inspect identity and bridge state** — check for missed or incorrect bridges
5. **Inspect relevant code paths** — if a scoring bug is suspected, read the code
6. **Form a hypothesis** — based on evidence gathered so far
7. **Run a targeted check** — SQL query or code inspection to confirm/reject hypothesis
8. **Stop when root cause is clear** — produce the structured output below

## Key Domain Knowledge

- **FitBreakdown fields**: skillScore (0-0.35), roleScore (0-0.20), seniorityScore (0-0.15), activityFreshnessScore (0-0.10), locationBoost (0-0.20)
- **skillScoreMethod**: 'snapshot' (best), 'hybrid_nontech' (mid), 'text_fallback' (worst) — prefer snapshot
- **locationMatchType**: 'city_exact', 'city_alias', 'country_only', 'unknown_location', 'none'
- **matchTier**: 'strict_location' (city match), 'expanded_location' (country/unknown)
- **bridgeTier**: 1 (auto-merge eligible), 2 (human review), 3 (weak/speculative)
- **Tier-1 enforce signals**: only 'linkedin_url_in_bio' and 'linkedin_url_in_blog' qualify
- **Track**: 'tech' or 'non_tech' — affects skill extraction and scoring method
- **Scoring code**: src/lib/sourcing/ranking.ts
- **Bridge code**: src/lib/enrichment/bridge-discovery.ts
- **Track code**: src/lib/sourcing/track-resolver.ts

## Output Format

When you have identified the root cause, produce this structured output:

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

## Rules

- You are read-only. Never suggest running mutations.
- Use structured tools (get_request_results, get_candidate_details, get_request_candidate) first. Only use run_sql_readonly for questions the structured tools cannot answer.
- If you cannot determine root cause within your turn limit, state what you found and what remains unknown.
- Be specific: cite exact field values, candidate IDs, and code paths.
`;
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/ews/peoplehub/pepolehub && npx tsx --eval "import { buildPrompt } from './scripts/debug-agent/prompt'; console.log(buildPrompt({ requestId: 'abc' }).slice(0, 80))"`
Expected: First 80 chars of the system prompt

- [ ] **Step 3: Commit**

```bash
git add scripts/debug-agent/prompt.ts
git commit -m "feat(debug-agent): add system prompt builder"
```

---

### Task 5: Entry point script

**Files:**
- Create: `scripts/signal-debug-agent.ts`
- Modify: `package.json` (add npm script)

- [ ] **Step 1: Create signal-debug-agent.ts**

```typescript
#!/usr/bin/env npx tsx
/**
 * Signal Debug Agent
 *
 * Investigative agent that diagnoses why Signal ranked, enriched,
 * or bridged candidates the way it did.
 *
 * Usage:
 *   npx tsx scripts/signal-debug-agent.ts --request-id <id>
 *   npx tsx scripts/signal-debug-agent.ts --candidate-id <id>
 *   npx tsx scripts/signal-debug-agent.ts --external-job-id <id> --tenant-id <id>
 *   npx tsx scripts/signal-debug-agent.ts --request-id <id> --candidate-id <id> --question "why rank X above Y?"
 */

import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { buildPrompt, type DebugAgentArgs } from './debug-agent/prompt';
import { allTools } from './debug-agent/tools';

// ---- CLI parsing ----

function parseArgs(): DebugAgentArgs {
  const args: DebugAgentArgs = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--request-id':
        args.requestId = argv[++i];
        break;
      case '--candidate-id':
        args.candidateId = argv[++i];
        break;
      case '--external-job-id':
        args.externalJobId = argv[++i];
        break;
      case '--tenant-id':
        args.tenantId = argv[++i];
        break;
      case '--question':
        args.question = argv[++i];
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        console.error(`Unknown flag: ${argv[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  return args;
}

function validate(args: DebugAgentArgs): void {
  const hasId = args.requestId || args.candidateId || args.externalJobId;
  if (!hasId) {
    console.error('Error: At least one ID flag is required.');
    printUsage();
    process.exit(1);
  }
  if (args.externalJobId && !args.tenantId) {
    console.error('Error: --tenant-id is required when using --external-job-id');
    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
Signal Debug Agent — investigate why Signal behaved a certain way.

Usage:
  npx tsx scripts/signal-debug-agent.ts --request-id <id>
  npx tsx scripts/signal-debug-agent.ts --candidate-id <id>
  npx tsx scripts/signal-debug-agent.ts --external-job-id <id> --tenant-id <id>

Flags:
  --request-id <id>        JobSourcingRequest UUID
  --candidate-id <id>      Candidate UUID
  --external-job-id <id>   External job ID (requires --tenant-id)
  --tenant-id <id>         Tenant UUID (required with --external-job-id)
  --question <text>        Supplementary question (requires at least one ID flag)
`);
}

// ---- Main ----

async function main() {
  const args = parseArgs();
  validate(args);

  const prompt = buildPrompt(args);

  console.log('Starting Signal Debug Agent...');
  console.log(`  Request ID: ${args.requestId ?? '-'}`);
  console.log(`  Candidate ID: ${args.candidateId ?? '-'}`);
  console.log(`  External Job ID: ${args.externalJobId ?? '-'}`);
  console.log(`  Question: ${args.question ?? '-'}`);
  console.log('');

  const signalTools = createSdkMcpServer({ name: 'signal-debug', tools: allTools });

  for await (const message of query({
    prompt,
    options: {
      cwd: process.cwd(),
      allowedTools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'dontAsk',
      maxTurns: 12,
      mcpServers: { 'signal-debug': signalTools },
    },
  })) {
    if ('result' in message) {
      console.log('\n' + message.result);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script to package.json**

Add to the `"scripts"` section in `package.json`:

```json
"debug-agent": "tsx scripts/signal-debug-agent.ts"
```

So it can be invoked as: `npm run debug-agent -- --request-id <id>`

- [ ] **Step 3: Install Agent SDK dependency**

Run: `cd /home/ews/peoplehub/pepolehub && npm install @anthropic-ai/claude-agent-sdk`

If the package name is wrong (the reviewer flagged this as a build-time risk), check:
- `npm info @anthropic-ai/claude-agent-sdk` — if it exists, use it
- Otherwise try `claude-agent-sdk` or check `https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk`

- [ ] **Step 4: Verify entry point compiles**

Run: `cd /home/ews/peoplehub/pepolehub && npx tsx scripts/signal-debug-agent.ts --help`

Expected: Usage help text and exit 0. (May fail if Agent SDK is not yet installed — in that case, install first via step 3.)

- [ ] **Step 5: Commit**

```bash
git add scripts/signal-debug-agent.ts package.json package-lock.json
git commit -m "feat(debug-agent): add entry point script and npm script"
```

---

## Chunk 5: Integration Test + Smoke Run

### Task 6: End-to-end smoke test

This is a manual verification step — not an automated test suite. The debug agent is a diagnostic tool; its correctness is validated by whether its output is useful, not by assertion-based tests.

- [ ] **Step 1: Verify full import chain compiles**

Run: `cd /home/ews/peoplehub/pepolehub && npx tsx --eval "import './scripts/signal-debug-agent'" 2>&1 | head -5`

Fix any import path issues (most likely: `@/lib/prisma` resolution from `scripts/`).

- [ ] **Step 2: Run against a real request (if DATABASE_URL is available)**

Run: `cd /home/ews/peoplehub/pepolehub && npx tsx scripts/signal-debug-agent.ts --request-id <pick-a-real-request-id>`

To find a real request ID:
```bash
cd /home/ews/peoplehub/pepolehub && npx tsx --eval "
import { prisma } from './src/lib/prisma';
const r = await prisma.jobSourcingRequest.findFirst({ orderBy: { requestedAt: 'desc' }, select: { id: true, externalJobId: true } });
console.log(r);
await prisma.\$disconnect();
"
```

Expected: The agent should:
1. Fetch request results using `get_request_results`
2. Inspect fit breakdowns
3. Potentially use `get_candidate_details` or `get_request_candidate` for deeper investigation
4. Produce structured output with Root Cause / Evidence / Classification sections

If the agent errors, note the error. Common issues:
- Agent SDK auth: needs `ANTHROPIC_API_KEY` or Claude Code CLI
- Import paths: `@/` alias may not resolve from scripts/
- Prisma: needs `DATABASE_URL`

- [ ] **Step 3: Run SQL validator edge case check**

Run: `cd /home/ews/peoplehub/pepolehub && npx tsx scripts/debug-agent/sql-validator.ts`
Expected: `All sql-validator smoke tests passed`

- [ ] **Step 4: Final commit (if any fixes were needed)**

```bash
git add -u
git commit -m "fix(debug-agent): resolve import paths and integration issues"
```

---

## Summary

| Task | Files | What it does |
|------|-------|-------------|
| 1 | `scripts/debug-agent/sql-validator.ts` | SQL validation + truncation (pure, testable) |
| 2 | `scripts/debug-agent/formatters.ts` | Prisma → normalized summary transforms (pure) |
| 3 | `scripts/debug-agent/tools.ts` | 5 MCP tools wiring Prisma + formatters |
| 4 | `scripts/debug-agent/prompt.ts` | System prompt builder from CLI args |
| 5 | `scripts/signal-debug-agent.ts` + `package.json` | CLI entry point + Agent SDK glue |
| 6 | (manual) | End-to-end smoke test against real DB |

Total: 5 new files + 1 modified file. No changes to existing production code.
