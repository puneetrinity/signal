/**
 * Enrichment Orchestrator
 *
 * Main entry point for identity enrichment. Coordinates:
 * - Bridge discovery across platforms
 * - Database persistence (IdentityCandidate, EnrichmentSession)
 * - Confidence scoring and bucketing
 * - Audit logging
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { prisma } from '@/lib/prisma';
import {
  discoverGitHubIdentities,
  discoverAllPlatformIdentities,
  getPlatformsForRoleType,
  type CandidateHints,
  type DiscoveredIdentity,
  type BridgeDiscoveryOptions,
} from './bridge-discovery';
import type { Candidate, EnrichmentSession, IdentityCandidate } from '@prisma/client';
import { applySerpMetaOverrides } from './hint-extraction';

// Re-export types
export * from './github';
export * from './scoring';
export * from './bridge-discovery';

/**
 * Enrichment options
 */
export interface EnrichmentOptions extends BridgeDiscoveryOptions {
  tenantId: string; // Required for multi-tenancy
  platforms?: string[];
  maxIdentitiesPerPlatform?: number;
  enableMultiPlatform?: boolean;
  maxSources?: number;
}

/**
 * Failure stage for batch enrichment errors
 */
export type EnrichmentFailureStage =
  | 'candidate_not_found'
  | 'discovery_error'
  | 'persist_error'
  | 'unknown_error';

/**
 * Enrichment result
 */
export interface EnrichmentResult {
  candidateId: string;
  sessionId: string | null; // null if session couldn't be created
  status: 'completed' | 'failed' | 'partial';
  identitiesFound: number;
  identitiesStored: number;
  platformsQueried: string[];
  queriesExecuted: number;
  earlyStopReason: string | null;
  durationMs: number;
  error?: string;
  failureStage?: EnrichmentFailureStage;
}

/**
 * Convert Candidate to CandidateHints for discovery
 */
function candidateToHints(candidate: Candidate): CandidateHints {
  let nameHint = candidate.nameHint;
  let headlineHint = candidate.headlineHint;
  let companyHint = candidate.companyHint;
  let locationHint = candidate.locationHint;

  // Upgrade hints from KG/answerBox when present
  if (candidate.searchMeta) {
    const upgraded = applySerpMetaOverrides(
      { nameHint, headlineHint, companyHint, locationHint },
      candidate.searchMeta as Record<string, unknown>,
      candidate.linkedinId,
      candidate.linkedinUrl,
      candidate.searchTitle || '',
      candidate.searchSnippet || '',
      candidate.roleType || null
    );
    nameHint = upgraded.nameHint;
    headlineHint = upgraded.headlineHint;
    companyHint = upgraded.companyHint;
    locationHint = upgraded.locationHint;
  }

  return {
    linkedinId: candidate.linkedinId,
    linkedinUrl: candidate.linkedinUrl,
    nameHint,
    headlineHint,
    locationHint,
    companyHint,
    roleType: candidate.roleType,
    serpTitle: candidate.searchTitle ?? undefined,
    serpSnippet: candidate.searchSnippet ?? undefined,
    serpMeta: (candidate.searchMeta as Record<string, unknown>) ?? undefined,
  };
}

/**
 * Store discovered identity in database (tenant-scoped)
 */
async function storeIdentityCandidate(
  tenantId: string,
  candidateId: string,
  identity: DiscoveredIdentity,
  sessionId: string,
  searchQuery?: string
): Promise<IdentityCandidate> {
  return prisma.identityCandidate.upsert({
    where: {
      tenantId_candidateId_platform_platformId: {
        tenantId,
        candidateId,
        platform: identity.platform,
        platformId: identity.platformId,
      },
    },
    update: {
      confidence: identity.confidence,
      confidenceBucket: identity.confidenceBucket,
      scoreBreakdown: JSON.parse(JSON.stringify(identity.scoreBreakdown)),
      evidence: identity.evidence ? JSON.parse(JSON.stringify(identity.evidence)) : undefined,
      hasContradiction: identity.hasContradiction,
      contradictionNote: identity.contradictionNote,
      discoveredBy: sessionId,
      updatedAt: new Date(),
    },
    create: {
      tenantId,
      candidateId,
      platform: identity.platform,
      platformId: identity.platformId,
      profileUrl: identity.profileUrl,
      confidence: identity.confidence,
      confidenceBucket: identity.confidenceBucket,
      scoreBreakdown: JSON.parse(JSON.stringify(identity.scoreBreakdown)),
      evidence: identity.evidence ? JSON.parse(JSON.stringify(identity.evidence)) : undefined,
      hasContradiction: identity.hasContradiction,
      contradictionNote: identity.contradictionNote,
      discoveredBy: sessionId,
      searchQuery,
    },
  });
}

/**
 * Create enrichment session (tenant-scoped)
 */
async function createSession(
  tenantId: string,
  candidateId: string,
  roleType: string | null,
  platforms: string[]
): Promise<EnrichmentSession> {
  return prisma.enrichmentSession.create({
    data: {
      tenantId,
      candidateId,
      status: 'running',
      roleType,
      sourcesPlanned: platforms,
      startedAt: new Date(),
    },
  });
}

/**
 * Update enrichment session on completion
 */
async function completeSession(
  sessionId: string,
  result: {
    status: 'completed' | 'failed' | 'partial';
    sourcesExecuted: string[];
    queriesExecuted: number;
    identitiesFound: number;
    identitiesConfirmed: number;
    finalConfidence: number | null;
    earlyStopReason: string | null;
    errorMessage?: string;
    errorDetails?: object;
    durationMs: number;
  }
): Promise<void> {
  await prisma.enrichmentSession.update({
    where: { id: sessionId },
    data: {
      status: result.status,
      sourcesExecuted: result.sourcesExecuted,
      queriesExecuted: result.queriesExecuted,
      identitiesFound: result.identitiesFound,
      identitiesConfirmed: result.identitiesConfirmed,
      finalConfidence: result.finalConfidence,
      earlyStopReason: result.earlyStopReason,
      errorMessage: result.errorMessage,
      errorDetails: result.errorDetails ? JSON.parse(JSON.stringify(result.errorDetails)) : undefined,
      completedAt: new Date(),
      durationMs: result.durationMs,
    },
  });
}

/**
 * Update candidate enrichment status
 */
async function updateCandidateStatus(
  candidateId: string,
  status: string,
  confidenceScore: number | null
): Promise<void> {
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      enrichmentStatus: status,
      lastEnrichedAt: new Date(),
      confidenceScore,
    },
  });
}

/**
 * Log enrichment action to audit log (uses centralized audit module)
 */
async function logEnrichmentAction(
  action: 'enrichment.started' | 'enrichment.completed' | 'enrichment.failed',
  candidateId: string,
  sessionId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  // Import dynamically to avoid circular dependency
  const { logEnrichment } = await import('@/lib/audit');
  await logEnrichment(candidateId, sessionId, action, metadata);
}

/**
 * Enrich a single candidate
 *
 * Main entry point for enrichment. Discovers identities across platforms,
 * stores results, and updates candidate status.
 */
export async function enrichCandidate(
  candidateId: string,
  options: EnrichmentOptions
): Promise<EnrichmentResult> {
  const startTime = Date.now();
  const { tenantId } = options;

  // Fetch candidate - must belong to tenant
  const candidate = await prisma.candidate.findFirst({
    where: { id: candidateId, tenantId },
  });

  if (!candidate) {
    throw new Error(`Candidate not found: ${candidateId}`);
  }

  // Determine platforms to query
  const platforms =
    options.platforms || getPlatformsForRoleType(candidate.roleType);

  if (platforms.length === 0) {
    return {
      candidateId,
      sessionId: '',
      status: 'completed',
      identitiesFound: 0,
      identitiesStored: 0,
      platformsQueried: [],
      queriesExecuted: 0,
      earlyStopReason: 'no_platforms',
      durationMs: Date.now() - startTime,
    };
  }

  // Create session (tenant-scoped)
  const session = await createSession(tenantId, candidateId, candidate.roleType, platforms);

  // Update candidate status
  await updateCandidateStatus(candidateId, 'in_progress', null);

  const hints = candidateToHints(candidate);
  const allIdentities: DiscoveredIdentity[] = [];
  let totalQueries = 0;
  let earlyStopReason: string | null = null;
  const sourcesExecuted: string[] = [];

  try {
    // Check if multi-platform discovery is enabled (default: true)
    const enableMultiPlatform = options.enableMultiPlatform !== false;

    if (enableMultiPlatform) {
      // Use new multi-platform discovery
      console.log(`[Enrichment] Multi-platform discovery for ${candidateId} (role: ${candidate.roleType})`);

      const multiResult = await discoverAllPlatformIdentities(candidateId, hints, {
        ...options,
        maxSources: options.maxSources || 5,
        includeSearchSources: true,
      });

      allIdentities.push(...multiResult.allIdentities);
      totalQueries = multiResult.totalQueriesExecuted;

      // Track which sources were executed
      sourcesExecuted.push('github');
      if (multiResult.searchResult) {
        sourcesExecuted.push(...multiResult.searchResult.sourcesQueried);
      }

      // Check for early stop
      if (multiResult.githubResult.earlyStopReason) {
        earlyStopReason = multiResult.githubResult.earlyStopReason;
      }
    } else {
      // Legacy single-platform discovery
      for (const platform of platforms) {
        if (earlyStopReason) break;

        sourcesExecuted.push(platform);

        if (platform === 'github') {
          const result = await discoverGitHubIdentities(candidateId, hints, options);
          allIdentities.push(...result.identitiesFound);
          totalQueries += result.queriesExecuted;

          if (result.earlyStopReason) {
            earlyStopReason = result.earlyStopReason;
          }
        }
      }
    }

    // Store identities in database (tenant-scoped)
    let identitiesStored = 0;
    for (const identity of allIdentities) {
      try {
        await storeIdentityCandidate(
          tenantId,
          candidateId,
          identity,
          session.id,
          candidate.searchQuery || undefined
        );
        identitiesStored++;
      } catch (error) {
        console.error(
          `[Enrichment] Failed to store identity ${identity.platformId}:`,
          error
        );
      }
    }

    // Calculate best confidence score
    const bestConfidence =
      allIdentities.length > 0
        ? Math.max(...allIdentities.map((i) => i.confidence))
        : null;

    // Complete session
    await completeSession(session.id, {
      status: 'completed',
      sourcesExecuted,
      queriesExecuted: totalQueries,
      identitiesFound: allIdentities.length,
      identitiesConfirmed: 0, // Confirmation happens separately
      finalConfidence: bestConfidence,
      earlyStopReason,
      durationMs: Date.now() - startTime,
    });

    // Update candidate status
    await updateCandidateStatus(candidateId, 'completed', bestConfidence);

    // Audit log
    await logEnrichmentAction('enrichment.completed', candidateId, session.id, {
      identitiesFound: allIdentities.length,
      bestConfidence,
      platforms: sourcesExecuted,
    });

    return {
      candidateId,
      sessionId: session.id,
      status: 'completed',
      identitiesFound: allIdentities.length,
      identitiesStored,
      platformsQueried: sourcesExecuted,
      queriesExecuted: totalQueries,
      earlyStopReason,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    // Complete session with error
    await completeSession(session.id, {
      status: 'failed',
      sourcesExecuted,
      queriesExecuted: totalQueries,
      identitiesFound: allIdentities.length,
      identitiesConfirmed: 0,
      finalConfidence: null,
      earlyStopReason: null,
      errorMessage,
      errorDetails: error instanceof Error ? { stack: error.stack } : {},
      durationMs: Date.now() - startTime,
    });

    // Update candidate status
    await updateCandidateStatus(candidateId, 'failed', null);

    // Audit log
    await logEnrichmentAction('enrichment.failed', candidateId, session.id, {
      error: errorMessage,
    });

    return {
      candidateId,
      sessionId: session.id,
      status: 'failed',
      identitiesFound: allIdentities.length,
      identitiesStored: 0,
      platformsQueried: sourcesExecuted,
      queriesExecuted: totalQueries,
      earlyStopReason: null,
      durationMs: Date.now() - startTime,
      error: errorMessage,
    };
  }
}

/**
 * Determine failure stage from error
 */
function determineFailureStage(error: unknown): EnrichmentFailureStage {
  const message = error instanceof Error ? error.message.toLowerCase() : '';

  if (message.includes('not found') || message.includes('does not exist')) {
    return 'candidate_not_found';
  }
  if (message.includes('persist') || message.includes('database') || message.includes('prisma')) {
    return 'persist_error';
  }
  if (message.includes('discovery') || message.includes('github') || message.includes('search')) {
    return 'discovery_error';
  }
  return 'unknown_error';
}

/**
 * Enrich multiple candidates in batch
 */
export async function enrichCandidates(
  candidateIds: string[],
  options: EnrichmentOptions
): Promise<EnrichmentResult[]> {
  const results: EnrichmentResult[] = [];

  for (const candidateId of candidateIds) {
    const startTime = Date.now();
    try {
      const result = await enrichCandidate(candidateId, options);
      results.push(result);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const failureStage = determineFailureStage(error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error(`[Enrichment] Failed to enrich ${candidateId} (${failureStage}):`, error);

      results.push({
        candidateId,
        sessionId: null, // Session couldn't be created
        status: 'failed',
        identitiesFound: 0,
        identitiesStored: 0,
        platformsQueried: [],
        queriesExecuted: 0,
        earlyStopReason: null,
        durationMs,
        error: errorMessage,
        failureStage,
      });
    }
  }

  return results;
}

/**
 * Get enrichment session details
 */
export async function getEnrichmentSession(
  sessionId: string
): Promise<EnrichmentSession | null> {
  return prisma.enrichmentSession.findUnique({
    where: { id: sessionId },
  });
}

/**
 * Get identity candidates for a candidate (tenant-scoped)
 */
export async function getIdentityCandidates(
  tenantId: string,
  candidateId: string
): Promise<IdentityCandidate[]> {
  return prisma.identityCandidate.findMany({
    where: { candidateId, tenantId },
    orderBy: { confidence: 'desc' },
  });
}

export default {
  enrichCandidate,
  enrichCandidates,
  getEnrichmentSession,
  getIdentityCandidates,
};
