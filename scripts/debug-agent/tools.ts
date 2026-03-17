/**
 * Custom MCP tool definitions for the Signal Debug Agent.
 * 5 tools: 3 structured DB lookups, 1 raw SQL, 1 job summary.
 */

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

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

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
      return textResult(`Request ${args.requestId} not found`);
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

    const result = formatRequestResults(request as unknown as Record<string, unknown>, allCandidates, {
      limit: args.limit,
      offset: args.offset,
      includeDiagnostics: args.includeDiagnostics,
    });

    return textResult(JSON.stringify(result, null, 2));
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
      return textResult(`Candidate ${args.candidateId} not found`);
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

    return textResult(JSON.stringify(result, null, 2));
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
      return textResult(`Candidate ${args.candidateId} not in request ${args.requestId}`);
    }

    const candidate = await prisma.candidate.findUnique({ where: { id: args.candidateId } });
    if (!candidate) {
      return textResult(`Candidate ${args.candidateId} not found`);
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

    return textResult(JSON.stringify(result, null, 2));
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
      return textResult(`SQL validation failed: ${validation.error}`);
    }

    console.log(`[run_sql_readonly] ${validation.query}`);

    try {
      const rawRows = await prisma.$queryRawUnsafe(validation.query) as Record<string, unknown>[];
      const { rows, truncated } = truncateResults(rawRows);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

      return textResult(JSON.stringify({ rowCount: rows.length, truncated, columns, rows }, null, 2));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return textResult(`SQL error: ${msg}`);
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
      return textResult(`No requests found for job ${args.externalJobId} in tenant ${args.tenantId}`);
    }

    const result = formatJobSummary(requests as unknown as Record<string, unknown>[]);
    return textResult(JSON.stringify(result, null, 2));
  },
);

export const allTools = [getRequestResults, getCandidateDetails, getRequestCandidate, runSqlReadonly, getJobSummary];
