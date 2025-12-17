/**
 * v2 Enrichment API
 *
 * POST /api/v2/enrich
 * - Enriches a candidate by discovering platform identities
 * - Uses bridge discovery (GitHub, etc.) to find linked profiles
 * - Stores IdentityCandidate records with evidence pointers (NOT PII)
 * - Returns discovered identities with confidence scores
 *
 * GET /api/v2/enrich?candidateId=xxx
 * - Returns existing identity candidates for a candidate
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  enrichCandidate,
  enrichCandidates,
  getIdentityCandidates,
  type EnrichmentOptions,
} from '@/lib/enrichment';
import { getGitHubClient } from '@/lib/enrichment/github';
import {
  withRateLimit,
  ENRICH_RATE_LIMIT,
  rateLimitHeaders,
} from '@/lib/rate-limit';
import { withAuth } from '@/lib/auth';

/**
 * POST /api/v2/enrich
 *
 * Enrich one or more candidates by discovering platform identities.
 *
 * Request body:
 * - candidateId: string (single candidate)
 * - candidateIds: string[] (batch mode)
 * - options?: EnrichmentOptions
 */
export async function POST(request: NextRequest) {
  // Auth check - recruiter role required for enrichment
  const authCheck = await withAuth('recruiter');
  if (!authCheck.authorized) {
    return authCheck.response;
  }

  // Rate limit by API key if authenticated, otherwise by IP
  const rateLimitKey = authCheck.context.apiKeyId || undefined;
  const rateLimitCheck = await withRateLimit(ENRICH_RATE_LIMIT, rateLimitKey);
  if (!rateLimitCheck.allowed) {
    return rateLimitCheck.response;
  }

  try {
    const body = await request.json();
    const { candidateId, candidateIds, options = {} } = body as {
      candidateId?: string;
      candidateIds?: string[];
      options?: EnrichmentOptions;
    };

    // Validate input
    if (!candidateId && (!candidateIds || candidateIds.length === 0)) {
      return NextResponse.json(
        { success: false, error: 'candidateId or candidateIds is required' },
        { status: 400 }
      );
    }

    // Batch mode
    if (candidateIds && candidateIds.length > 0) {
      // Limit batch size
      if (candidateIds.length > 10) {
        return NextResponse.json(
          { success: false, error: 'Maximum 10 candidates per batch' },
          { status: 400 }
        );
      }

      console.log(`[v2/enrich] Batch enrichment for ${candidateIds.length} candidates`);

      const results = await enrichCandidates(candidateIds, options);

      const summary = {
        total: results.length,
        completed: results.filter((r) => r.status === 'completed').length,
        failed: results.filter((r) => r.status === 'failed').length,
        totalIdentitiesFound: results.reduce((sum, r) => sum + r.identitiesFound, 0),
        totalQueriesExecuted: results.reduce((sum, r) => sum + r.queriesExecuted, 0),
      };

      return NextResponse.json(
        {
          success: true,
          version: 'v2',
          mode: 'batch',
          summary,
          results,
          timestamp: Date.now(),
        },
        { headers: rateLimitHeaders(rateLimitCheck.result) }
      );
    }

    // Single candidate mode
    console.log(`[v2/enrich] Single enrichment for candidate: ${candidateId}`);

    const result = await enrichCandidate(candidateId!, options);

    // Fetch the stored identity candidates for the response
    const identityCandidates = await getIdentityCandidates(candidateId!);

    return NextResponse.json(
      {
        success: true,
        version: 'v2',
        mode: 'single',
        result,
        identityCandidates: identityCandidates.map((ic) => ({
          id: ic.id,
          platform: ic.platform,
          platformId: ic.platformId,
          profileUrl: ic.profileUrl,
          confidence: ic.confidence,
          confidenceBucket: ic.confidenceBucket,
          scoreBreakdown: ic.scoreBreakdown,
          hasContradiction: ic.hasContradiction,
          contradictionNote: ic.contradictionNote,
          status: ic.status,
          createdAt: ic.createdAt,
        })),
        timestamp: Date.now(),
      },
      { headers: rateLimitHeaders(rateLimitCheck.result) }
    );
  } catch (error) {
    console.error('[v2/enrich] Error:', error);

    // Handle specific errors
    if (error instanceof Error && error.message.includes('not found')) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Enrichment failed',
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/v2/enrich
 *
 * Get existing identity candidates for a candidate, or health check.
 *
 * Query params:
 * - candidateId: Get identities for this candidate
 * - (none): Return health check
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const candidateId = searchParams.get('candidateId');

  // If candidateId provided, return identity candidates
  if (candidateId) {
    try {
      // Verify candidate exists
      const candidate = await prisma.candidate.findUnique({
        where: { id: candidateId },
        select: {
          id: true,
          linkedinId: true,
          linkedinUrl: true,
          nameHint: true,
          enrichmentStatus: true,
          confidenceScore: true,
          lastEnrichedAt: true,
        },
      });

      if (!candidate) {
        return NextResponse.json(
          { success: false, error: 'Candidate not found' },
          { status: 404 }
        );
      }

      const identityCandidates = await getIdentityCandidates(candidateId);

      // Get recent enrichment sessions (including AI summary)
      const sessions = await prisma.enrichmentSession.findMany({
        where: { candidateId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          sourcesExecuted: true,
          queriesExecuted: true,
          identitiesFound: true,
          finalConfidence: true,
          durationMs: true,
          createdAt: true,
          completedAt: true,
          // AI Summary fields
          summary: true,
          summaryStructured: true,
          summaryModel: true,
          summaryGeneratedAt: true,
        },
      });

      return NextResponse.json({
        success: true,
        version: 'v2',
        candidate,
        identityCandidates: identityCandidates.map((ic) => ({
          id: ic.id,
          platform: ic.platform,
          platformId: ic.platformId,
          profileUrl: ic.profileUrl,
          confidence: ic.confidence,
          confidenceBucket: ic.confidenceBucket,
          scoreBreakdown: ic.scoreBreakdown,
          hasContradiction: ic.hasContradiction,
          contradictionNote: ic.contradictionNote,
          status: ic.status,
          evidence: ic.evidence, // Include evidence pointers
          createdAt: ic.createdAt,
          updatedAt: ic.updatedAt,
        })),
        sessions,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('[v2/enrich] GET error:', error);
      return NextResponse.json(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch identities',
        },
        { status: 500 }
      );
    }
  }

  // Health check
  try {
    const github = getGitHubClient();
    const githubHealth = await github.healthCheck();

    return NextResponse.json({
      version: 'v2',
      status: 'ok',
      platforms: {
        github: githubHealth,
      },
      features: {
        bridgeDiscovery: true,
        confidenceScoring: true,
        evidencePointers: true,
        batchEnrichment: true,
      },
    });
  } catch (error) {
    return NextResponse.json({
      version: 'v2',
      status: 'degraded',
      error: error instanceof Error ? error.message : 'Health check failed',
    });
  }
}
