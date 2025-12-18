/**
 * LangGraph Enrichment Nodes
 *
 * Individual node implementations for the enrichment graph.
 * Each node is a pure function that takes state and returns partial state updates.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { v4 as uuidv4 } from 'uuid';
import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, DiscoveredIdentity as SourceDiscoveredIdentity } from '../sources/types';
import { getSourcesForRoleType, getSource } from '../sources';
import { discoverGitHubIdentities, type CandidateHints } from '../bridge-discovery';
import { buildVariantStats } from '../sources/variant-taxonomy';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { getGitHubClient } from '../github';
import {
  clearEphemeralPlatformData,
  getEphemeralPlatformData,
  setEphemeralPlatformData,
  type EphemeralPlatformDataItem,
} from './ephemeral';
import { generateCandidateSummary } from '../summary/generate';
import { shouldPersistIdentity, type ScoreBreakdown } from '../scoring';
import {
  type EnrichmentState,
  type PartialEnrichmentState,
  type EnrichmentHints,
  type EnrichmentError,
  type EnrichmentProgressEvent,
  type PlatformQueryResult,
  type EnrichmentRunTrace,
  DEFAULT_BUDGET,
} from './types';

/**
 * Get the minimum confidence threshold from env or default
 */
function getMinConfidence(): number {
  const envValue = process.env.ENRICHMENT_MIN_CONFIDENCE;
  if (envValue) {
    const parsed = parseFloat(envValue);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed;
    }
  }
  return 0.35;
}

/**
 * Node progress percentages for observability
 */
const NODE_PROGRESS: Record<string, number> = {
  loadCandidate: 10,
  githubBridge: 30,
  searchPlatform: 50,
  aggregateResults: 60,
  persistIdentities: 70,
  fetchPlatformData: 80,
  generateSummary: 90,
  persistSummary: 100,
};

/**
 * Build run trace from state for observability
 * Phase A.5: Per-platform diagnostics for debugging 0-hit enrichments
 * Phase B: Canonical variant stats for metrics aggregation
 */
function buildRunTrace(state: EnrichmentState): EnrichmentRunTrace {
  const platformResults: EnrichmentRunTrace['platformResults'] = {};
  const providersUsed: Record<string, number> = {};
  const rateLimitedProviders = new Set<string>();

  // Aggregate variant IDs across all platforms
  const allExecutedVariants: string[] = [];
  const allRejectedVariants: string[] = [];

  // Aggregate per-platform results
  for (const result of state.platformResults || []) {
    const bestConfidence = result.identities.length > 0
      ? Math.max(...result.identities.map(i => i.confidence))
      : null;

    const provider = result.diagnostics?.provider;
    if (provider) {
      providersUsed[provider] = (providersUsed[provider] || 0) + 1;
      if (result.diagnostics?.rateLimited) {
        rateLimitedProviders.add(provider);
      }
    }

    // Collect variant IDs for canonical aggregation
    if (result.diagnostics?.variantsExecuted) {
      allExecutedVariants.push(...result.diagnostics.variantsExecuted);
    }
    if (result.diagnostics?.variantsRejected) {
      allRejectedVariants.push(...result.diagnostics.variantsRejected);
    }

    platformResults[result.platform] = {
      queriesExecuted: result.queriesExecuted,
      rawResultCount: result.diagnostics?.rawResultCount ?? 0,
      identitiesFound: result.identities.length,
      bestConfidence,
      durationMs: result.durationMs,
      error: result.error,
      rateLimited: result.diagnostics?.rateLimited,
    };
  }

  // Calculate totals
  const totalQueriesExecuted = state.queriesExecuted ?? 0;
  const platformsQueried = Object.keys(platformResults).length;
  const platformsWithHits = Object.values(platformResults).filter(p => p.identitiesFound > 0).length;
  const bestConfidence = state.bestConfidence ?? null;
  const startTime = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
  const durationMs = Date.now() - startTime;

  // Use persist stats if available, otherwise fall back to identitiesFound count
  const persistStats = state.persistStats ?? {
    identitiesFoundTotal: state.identitiesFound?.length ?? 0,
    identitiesAboveMinConfidence: state.identitiesFound?.length ?? 0,
    identitiesPassingPersistGuard: state.identitiesFound?.length ?? 0,
    identitiesPersisted: state.identitiesFound?.length ?? 0,
    persistErrors: 0,
    perPlatform: {},
  };

  // Merge per-platform filter stage counts into platformResults
  if (persistStats.perPlatform) {
    for (const [platform, counts] of Object.entries(persistStats.perPlatform)) {
      if (platformResults[platform]) {
        platformResults[platform].identitiesAboveMinConfidence = counts.aboveMinConfidence;
        platformResults[platform].identitiesPassingPersistGuard = counts.passingPersistGuard;
        platformResults[platform].identitiesPersisted = counts.persisted;
      }
    }
  }

  // Build canonical variant stats (only if we have variant data)
  const variantStats = (allExecutedVariants.length > 0 || allRejectedVariants.length > 0)
    ? buildVariantStats(allExecutedVariants, allRejectedVariants)
    : undefined;

  return {
    input: {
      candidateId: state.candidateId,
      linkedinId: state.hints?.linkedinId ?? '',
      linkedinUrl: state.hints?.linkedinUrl ?? '',
    },
    seed: {
      nameHint: state.hints?.nameHint ?? null,
      headlineHint: state.hints?.headlineHint ?? null,
      locationHint: state.hints?.locationHint ?? null,
      companyHint: state.hints?.companyHint ?? null,
      roleType: state.roleType ?? null,
    },
    platformResults,
    final: {
      totalQueriesExecuted,
      platformsQueried,
      platformsWithHits,
      identitiesFoundTotal: persistStats.identitiesFoundTotal,
      identitiesAboveMinConfidence: persistStats.identitiesAboveMinConfidence,
      identitiesPassingPersistGuard: persistStats.identitiesPassingPersistGuard,
      identitiesPersisted: persistStats.identitiesPersisted,
      persistErrors: persistStats.persistErrors || undefined,
      bestConfidence,
      durationMs,
      providersUsed: Object.keys(providersUsed).length > 0 ? providersUsed : undefined,
      rateLimitedProviders: rateLimitedProviders.size > 0 ? [...rateLimitedProviders] : undefined,
      variantStats,
      // Summary metadata for draft/verified tracking
      summaryMeta: state.summaryMeta ? {
        mode: (state.summaryMeta as { mode?: string }).mode as 'draft' | 'verified' || 'draft',
        confirmedCount: (state.summaryMeta as { confirmedCount?: number }).confirmedCount || 0,
        identityKey: (state.summaryMeta as { identityKey?: string }).identityKey || '',
        identityIds: (state.summaryMeta as { identityIds?: string[] }).identityIds || [],
      } : undefined,
    },
    failureReason: state.status === 'failed' ? state.errors?.[0]?.message : undefined,
  };
}

/**
 * Load candidate data and prepare enrichment hints
 */
export async function loadCandidateNode(
  state: EnrichmentState
): Promise<PartialEnrichmentState> {
  const sessionId = state.sessionId?.trim() ? state.sessionId : uuidv4();
  const startedAt = state.startedAt?.trim() ? state.startedAt : new Date().toISOString();

  const progressEvent: EnrichmentProgressEvent = {
    type: 'node_start',
    node: 'loadCandidate',
    timestamp: new Date().toISOString(),
  };

  try {
    // Fetch candidate data using Prisma
    const candidate = await prisma.candidate.findUnique({
      where: { id: state.candidateId },
    });

    if (!candidate) {
      const errorEntry: EnrichmentError = {
        platform: 'system',
        message: 'Candidate not found',
        timestamp: new Date().toISOString(),
        recoverable: false,
      };
      return {
        sessionId,
        startedAt,
        status: 'failed',
        errors: [errorEntry],
        progressEvents: [progressEvent],
      };
    }

    // Extract company from headline if available
    // Pattern matches "at Company", "@ Company", ", Company" followed by separator or end
    let companyHint: string | null = null;
    if (candidate.headlineHint) {
      const companyMatch = candidate.headlineHint.match(
        /(?:at|@|,)\s*([A-Z][A-Za-z0-9\s&]+?)(?:\s*[-|·]|$)/
      );
      if (companyMatch) {
        companyHint = companyMatch[1].trim();
      }
    }

    // Build hints from candidate data (using Prisma schema field names)
    const hints: EnrichmentHints = {
      linkedinId: candidate.linkedinId || candidate.id,
      linkedinUrl: candidate.linkedinUrl || `https://linkedin.com/in/${candidate.linkedinId}`,
      nameHint: candidate.nameHint || null,
      headlineHint: candidate.headlineHint || null,
      locationHint: candidate.locationHint || null,
      companyHint,
      roleType: (candidate.roleType as RoleType) || state.roleType || null,
    };

    // Determine role type
    const roleType = hints.roleType || state.roleType || 'general';

    // Mark candidate as in progress (best-effort)
    await prisma.candidate
      .update({
        where: { id: state.candidateId },
        data: { enrichmentStatus: 'in_progress' },
      })
      .catch(() => {});

    // Get platforms for this role (excluding github which is handled separately)
    const allPlatforms = getSourcesForRoleType(roleType).map((s) => s.platform);
    const platformsToQuery = allPlatforms
      .filter((p) => p !== 'github')
      .slice(0, state.budget?.maxPlatforms || DEFAULT_BUDGET.maxPlatforms);

    const completeEvent: EnrichmentProgressEvent = {
      type: 'node_complete',
      node: 'loadCandidate',
      data: { identitiesFound: 0 },
      timestamp: new Date().toISOString(),
    };

    return {
      sessionId,
      startedAt,
      status: 'running',
      hints,
      roleType,
      platformsToQuery,
      platformsRemaining: platformsToQuery,
      budget: { ...DEFAULT_BUDGET, ...state.budget },
      progressEvents: [progressEvent, completeEvent],
      lastCompletedNode: 'loadCandidate',
      progressPct: NODE_PROGRESS.loadCandidate,
    };
  } catch (error) {
    const errorEntry: EnrichmentError = {
      platform: 'system',
      message: error instanceof Error ? error.message : 'Unknown error loading candidate',
      timestamp: new Date().toISOString(),
      recoverable: false,
    };
    return {
      sessionId,
      startedAt,
      status: 'failed',
      errors: [errorEntry],
      progressEvents: [progressEvent],
      lastCompletedNode: 'loadCandidate',
      progressPct: NODE_PROGRESS.loadCandidate,
      errorsBySource: { system: [errorEntry.message] },
    };
  }
}

/**
 * Execute GitHub bridge discovery (direct API with commit evidence)
 */
export async function githubBridgeNode(
  state: EnrichmentState
): Promise<PartialEnrichmentState> {
  const progressEvent: EnrichmentProgressEvent = {
    type: 'node_start',
    node: 'githubBridge',
    platform: 'github',
    timestamp: new Date().toISOString(),
  };

  try {
    if (!state.hints) {
      throw new Error('No hints available for GitHub discovery');
    }

    // Convert hints to CandidateHints format
    const candidateHints: CandidateHints = {
      linkedinId: state.hints.linkedinId,
      linkedinUrl: state.hints.linkedinUrl,
      nameHint: state.hints.nameHint,
      headlineHint: state.hints.headlineHint,
      locationHint: state.hints.locationHint,
      roleType: state.hints.roleType,
      companyHint: state.hints.companyHint,
    };

    // Respect ENABLE_COMMIT_EMAIL_EVIDENCE env var (reduces API calls and compliance risk)
    const includeCommitEvidence = process.env.ENABLE_COMMIT_EMAIL_EVIDENCE === 'true';

    const result = await discoverGitHubIdentities(state.candidateId, candidateHints, {
      maxGitHubResults: state.budget?.maxIdentitiesPerPlatform || 5,
      includeCommitEvidence,
    });

    // Convert to DiscoveredIdentity format expected by state
    const identities: SourceDiscoveredIdentity[] = result.identitiesFound.map((i) => ({
      platform: 'github' as EnrichmentPlatform,
      platformId: i.platformId,
      profileUrl: i.profileUrl,
      displayName: i.platformProfile.name,
      confidence: i.confidence,
      confidenceBucket: i.confidenceBucket as 'auto_merge' | 'suggest' | 'low' | 'rejected',
      scoreBreakdown: {
        ...i.scoreBreakdown,
        handleMatch: i.scoreBreakdown.handleMatch ?? 0, // May not exist in GitHub API results
        activityScore: i.scoreBreakdown.activityScore ?? i.scoreBreakdown.profileCompleteness ?? 0,
      },
      evidence: i.evidence?.map((e) => ({
        type: 'commit_email' as const,
        sourceUrl: e.commitUrl,
        sourcePlatform: 'github' as EnrichmentPlatform,
        description: `Commit in ${e.repoFullName} by ${e.authorName}`,
        capturedAt: new Date().toISOString(),
        metadata: { commitSha: e.commitSha, repoFullName: e.repoFullName },
      })) || [],
      hasContradiction: i.hasContradiction,
      contradictionNote: i.contradictionNote,
      platformProfile: {
        name: i.platformProfile.name,
        bio: i.platformProfile.bio,
        company: i.platformProfile.company,
        location: i.platformProfile.location,
        followers: i.platformProfile.followers,
        publicRepos: i.platformProfile.publicRepos,
      },
    }));

    const platformResult: PlatformQueryResult = {
      platform: 'github',
      identities,
      queriesExecuted: result.queriesExecuted,
      searchQueries: [], // GitHub uses API, not search queries
      durationMs: 0, // TODO: track duration
      // GitHub uses direct API, not search - minimal diagnostics
      diagnostics: {
        queriesAttempted: result.queriesExecuted,
        queriesRejected: 0,
        rejectionReasons: [],
        variantsExecuted: [], // GitHub API doesn't use search variants
        variantsRejected: [],
        rawResultCount: identities.length, // API returns exact matches
        matchedResultCount: identities.length,
        identitiesAboveThreshold: identities.length,
        rateLimited: false,
        provider: 'github_api',
      },
    };

    const completeEvent: EnrichmentProgressEvent = {
      type: 'node_complete',
      node: 'githubBridge',
      platform: 'github',
      data: {
        identitiesFound: identities.length,
        queriesExecuted: result.queriesExecuted,
        confidence: identities[0]?.confidence,
      },
      timestamp: new Date().toISOString(),
    };

    // Check for early stop
    const highConfidenceFound = identities.some((i) => i.confidence >= (state.budget?.minConfidenceForEarlyStop || 0.9));

    return {
      identitiesFound: identities,
      platformResults: [platformResult],
      queriesExecuted: result.queriesExecuted,
      sourcesExecuted: ['github'],
      bestConfidence: identities[0]?.confidence || null,
      earlyStopReason: highConfidenceFound ? 'high_confidence_github' : null,
      progressEvents: [progressEvent, completeEvent],
      lastCompletedNode: 'githubBridge',
      progressPct: NODE_PROGRESS.githubBridge,
    };
  } catch (error) {
    const errorEntry: EnrichmentError = {
      platform: 'github',
      message: error instanceof Error ? error.message : 'GitHub discovery failed',
      timestamp: new Date().toISOString(),
      recoverable: true,
    };

    const errorEvent: EnrichmentProgressEvent = {
      type: 'error',
      node: 'githubBridge',
      platform: 'github',
      data: { error: errorEntry.message },
      timestamp: new Date().toISOString(),
    };

    return {
      errors: [errorEntry],
      sourcesExecuted: ['github'],
      progressEvents: [progressEvent, errorEvent],
      lastCompletedNode: 'githubBridge',
      progressPct: NODE_PROGRESS.githubBridge,
      errorsBySource: { github: [errorEntry.message] },
    };
  }
}

/**
 * Execute search-based discovery for a single platform
 * This is used with Send() for parallel execution
 */
export async function searchPlatformNode(
  state: EnrichmentState & { currentPlatform: EnrichmentPlatform }
): Promise<PartialEnrichmentState> {
  const platform = state.currentPlatform;

  const progressEvent: EnrichmentProgressEvent = {
    type: 'node_start',
    node: 'searchPlatform',
    platform,
    timestamp: new Date().toISOString(),
  };

  try {
    const source = getSource(platform);
    if (!source) {
      throw new Error(`No source registered for platform: ${platform}`);
    }

    if (!state.hints) {
      throw new Error('No hints available for platform discovery');
    }

    // Convert hints to source format
    const sourceHints = {
      linkedinId: state.hints.linkedinId,
      linkedinUrl: state.hints.linkedinUrl,
      nameHint: state.hints.nameHint,
      headlineHint: state.hints.headlineHint,
      locationHint: state.hints.locationHint,
      companyHint: state.hints.companyHint,
      roleType: state.hints.roleType,
    };

    const result = await source.discover(sourceHints, {
      maxResults: state.budget?.maxIdentitiesPerPlatform || 5,
      maxQueries: 3,
      minConfidence: getMinConfidence(),
    });

    const platformResult: PlatformQueryResult = {
      platform,
      identities: result.identities,
      queriesExecuted: result.queriesExecuted,
      searchQueries: result.searchQueries,
      durationMs: result.durationMs,
      error: result.error,
      // Phase A.5: Include per-platform diagnostics for runTrace
      diagnostics: result.diagnostics,
    };

    const completeEvent: EnrichmentProgressEvent = {
      type: 'node_complete',
      node: 'searchPlatform',
      platform,
      data: {
        identitiesFound: result.identities.length,
        queriesExecuted: result.queriesExecuted,
        confidence: result.identities[0]?.confidence,
      },
      timestamp: new Date().toISOString(),
    };

    return {
      identitiesFound: result.identities,
      platformResults: [platformResult],
      queriesExecuted: result.queriesExecuted,
      sourcesExecuted: [platform],
      progressEvents: [progressEvent, completeEvent],
      lastCompletedNode: 'searchPlatform',
      progressPct: NODE_PROGRESS.searchPlatform,
    };
  } catch (error) {
    const errorEntry: EnrichmentError = {
      platform,
      message: error instanceof Error ? error.message : `${platform} discovery failed`,
      timestamp: new Date().toISOString(),
      recoverable: true,
    };

    const errorEvent: EnrichmentProgressEvent = {
      type: 'error',
      node: 'searchPlatform',
      platform,
      data: { error: errorEntry.message },
      timestamp: new Date().toISOString(),
    };

    return {
      errors: [errorEntry],
      sourcesExecuted: [platform],
      progressEvents: [progressEvent, errorEvent],
      lastCompletedNode: 'searchPlatform',
      progressPct: NODE_PROGRESS.searchPlatform,
      errorsBySource: { [platform]: [errorEntry.message] },
    };
  }
}

/**
 * Execute search-based discovery across all configured platforms (Phase B hardening).
 *
 * We run this as a single node to ensure:
 * - global budget is respected (no accidental re-dispatch loops)
 * - provider concurrency limiters can smooth outbound traffic
 *
 * NOTE: This reduces per-platform streaming granularity, but is much more robust
 * under rate limits.
 */
export async function searchPlatformsBatchNode(
  state: EnrichmentState
): Promise<PartialEnrichmentState> {
  const progressEvent: EnrichmentProgressEvent = {
    type: 'node_start',
    node: 'searchPlatformsBatch',
    timestamp: new Date().toISOString(),
  };

  if (!state.hints) {
    const errorEntry: EnrichmentError = {
      platform: 'system',
      message: 'No hints available for platform discovery',
      timestamp: new Date().toISOString(),
      recoverable: false,
    };
    return {
      errors: [errorEntry],
      progressEvents: [progressEvent],
      lastCompletedNode: 'searchPlatformsBatch',
      progressPct: NODE_PROGRESS.searchPlatform,
      errorsBySource: { system: [errorEntry.message] },
    };
  }

  const budgetMaxQueries = state.budget?.maxQueries || DEFAULT_BUDGET.maxQueries;
  const perPlatformMaxQueries = 3; // keep consistent with previous behavior
  const maxPlatforms = state.budget?.maxPlatforms || DEFAULT_BUDGET.maxPlatforms;

  const platforms = (state.platformsToQuery || [])
    .filter((p) => p !== 'github')
    .slice(0, maxPlatforms);

  const executedSet = new Set(state.sourcesExecuted);
  const platformsToRun = platforms.filter((p) => !executedSet.has(p));

  // Convert hints to source format
  const sourceHints = {
    linkedinId: state.hints.linkedinId,
    linkedinUrl: state.hints.linkedinUrl,
    nameHint: state.hints.nameHint,
    headlineHint: state.hints.headlineHint,
    locationHint: state.hints.locationHint,
    companyHint: state.hints.companyHint,
    roleType: state.hints.roleType,
  };

  const platformResults: PlatformQueryResult[] = [];
  const identitiesFound: SourceDiscoveredIdentity[] = [];
  const sourcesExecuted: EnrichmentPlatform[] = [];
  const errors: EnrichmentError[] = [];

  let totalQueriesExecuted = 0;
  let earlyStopReason: string | null = null;
  const minConfidenceForEarlyStop =
    state.budget?.minConfidenceForEarlyStop || DEFAULT_BUDGET.minConfidenceForEarlyStop;
  const minConfidenceForPersist = getMinConfidence();
  let persistableCount = 0;
  let bestConfidenceSoFar = state.bestConfidence ?? null;

  for (const platform of platformsToRun) {
    const remainingBudget = budgetMaxQueries - (state.queriesExecuted + totalQueriesExecuted);
    if (remainingBudget <= 0) {
      break;
    }

    const source = getSource(platform);
    if (!source) {
      errors.push({
        platform,
        message: `No source registered for platform: ${platform}`,
        timestamp: new Date().toISOString(),
        recoverable: true,
      });
      continue;
    }

    const maxQueriesForThisPlatform = Math.max(
      1,
      Math.min(perPlatformMaxQueries, remainingBudget)
    );

    try {
      const result = await source.discover(sourceHints, {
        maxResults: state.budget?.maxIdentitiesPerPlatform || 5,
        maxQueries: maxQueriesForThisPlatform,
        minConfidence: getMinConfidence(),
      });

      platformResults.push({
        platform,
        identities: result.identities,
        queriesExecuted: result.queriesExecuted,
        searchQueries: result.searchQueries,
        durationMs: result.durationMs,
        error: result.error,
        diagnostics: result.diagnostics,
      });

      identitiesFound.push(...result.identities);
      sourcesExecuted.push(platform);
      totalQueriesExecuted += result.queriesExecuted;

      // Track "persistable" identities (approximation of identitiesPersisted)
      for (const identity of result.identities) {
        if (identity.scoreBreakdown) {
          if (shouldPersistIdentity(identity.scoreBreakdown as ScoreBreakdown)) {
            persistableCount++;
          }
        } else if (identity.confidence >= minConfidenceForPersist) {
          persistableCount++;
        }
      }

      const platformBest =
        result.identities.length > 0
          ? Math.max(...result.identities.map((i) => i.confidence))
          : null;
      if (platformBest !== null) {
        bestConfidenceSoFar =
          bestConfidenceSoFar === null ? platformBest : Math.max(bestConfidenceSoFar, platformBest);
      }

      // Early stop: once we have at least one persistable identity at high confidence,
      // stop querying more platforms to reduce cost and noise.
      if (bestConfidenceSoFar !== null && bestConfidenceSoFar >= minConfidenceForEarlyStop && persistableCount >= 1) {
        earlyStopReason = 'high_confidence_persistable_found';
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `${platform} discovery failed`;
      errors.push({
        platform,
        message,
        timestamp: new Date().toISOString(),
        recoverable: true,
      });

      platformResults.push({
        platform,
        identities: [],
        queriesExecuted: 0,
        searchQueries: [],
        durationMs: 0,
        error: message,
        diagnostics: {
          queriesAttempted: 0,
          queriesRejected: 0,
          rejectionReasons: [],
          variantsExecuted: [],
          variantsRejected: [],
          rawResultCount: 0,
          matchedResultCount: 0,
          identitiesAboveThreshold: 0,
          rateLimited: /rate.?limit|429|too many requests/i.test(message),
          provider: 'unknown',
        },
      });
    }
  }

  const completeEvent: EnrichmentProgressEvent = {
    type: 'node_complete',
    node: 'searchPlatformsBatch',
    data: {
      identitiesFound: identitiesFound.length,
      queriesExecuted: totalQueriesExecuted,
      confidence: identitiesFound[0]?.confidence,
    },
    timestamp: new Date().toISOString(),
  };

  return {
    identitiesFound,
    platformResults,
    queriesExecuted: totalQueriesExecuted,
    sourcesExecuted,
    errors,
    earlyStopReason,
    bestConfidence: bestConfidenceSoFar ?? undefined,
    progressEvents: [progressEvent, completeEvent],
    lastCompletedNode: 'searchPlatformsBatch',
    progressPct: NODE_PROGRESS.searchPlatform,
    platformsRemaining: [], // exhausted in this batch node
  };
}

/**
 * Aggregate results and determine completion status
 */
export async function aggregateResultsNode(
  state: EnrichmentState
): Promise<PartialEnrichmentState> {
  const progressEvent: EnrichmentProgressEvent = {
    type: 'node_start',
    node: 'aggregateResults',
    timestamp: new Date().toISOString(),
  };

  // Sort identities by confidence
  const sortedIdentities = [...state.identitiesFound].sort((a, b) => b.confidence - a.confidence);
  const bestConfidence = sortedIdentities[0]?.confidence || null;

  // Determine final status
  let status: EnrichmentState['status'] = 'completed';
  let earlyStopReason = state.earlyStopReason;

  if (state.errors.some((e) => !e.recoverable)) {
    status = 'failed';
  } else if (bestConfidence && bestConfidence >= (state.budget?.minConfidenceForEarlyStop || 0.9)) {
    status = 'early_stopped';
    earlyStopReason = earlyStopReason || 'high_confidence_found';
  }

  const completeEvent: EnrichmentProgressEvent = {
    type: 'complete',
    data: {
      identitiesFound: sortedIdentities.length,
      confidence: bestConfidence || undefined,
    },
    timestamp: new Date().toISOString(),
  };

  // NOTE: Do NOT return identitiesFound here. The reducer appends, so returning
  // sortedIdentities would duplicate all identities. Sorting happens in persistResultsNode
  // when reading state.identitiesFound.
  return {
    status,
    bestConfidence,
    earlyStopReason,
    completedAt: new Date().toISOString(),
    progressEvents: [progressEvent, completeEvent],
    lastCompletedNode: 'aggregateResults',
    progressPct: NODE_PROGRESS.aggregateResults,
  };
}

/**
 * Persist results to database
 */
export async function persistResultsNode(
  state: EnrichmentState
): Promise<PartialEnrichmentState> {
  const progressEvent: EnrichmentProgressEvent = {
    type: 'node_start',
    node: 'persistIdentities',
    timestamp: new Date().toISOString(),
  };

  try {
    const minConfidence = getMinConfidence();
    const allIdentities = state.identitiesFound;

    // Stage 1: Count identities above minConfidence
    const aboveMinConfidence = allIdentities.filter((i) => i.confidence >= minConfidence);

    // Stage 2: Count identities passing shouldPersistIdentity (before platform guards)
    const passingPersistGuard = aboveMinConfidence.filter((i) => {
      if (!i.scoreBreakdown) return true; // No breakdown = use minConfidence only
      return shouldPersistIdentity(i.scoreBreakdown as ScoreBreakdown);
    });

    // Stage 3: Apply platform-specific guards and get final list
    const identitiesToPersist = passingPersistGuard.filter((i) => {
      if (!i.scoreBreakdown) return true;

      // Platform-specific guard: GitHub name-only matches need company/location context
      // Prevents false positives like "Michael Johnson" → "CodeNonprofit"
      const breakdown = i.scoreBreakdown as ScoreBreakdown;
      if (
        i.platform === 'github' &&
        (breakdown.bridgeWeight ?? 0) === 0 &&
        (breakdown.handleMatch ?? 0) === 0
      ) {
        // Require company or location match for name-only GitHub matches
        const hasContextSignal =
          (breakdown.companyMatch ?? 0) > 0 || (breakdown.locationMatch ?? 0) > 0;
        if (!hasContextSignal) {
          return false;
        }
      }

      return true;
    });

    // Build persist stats for runTrace
    const persistStats: {
      identitiesFoundTotal: number;
      identitiesAboveMinConfidence: number;
      identitiesPassingPersistGuard: number;
      identitiesPersisted: number;
      persistErrors: number;
      perPlatform: Record<string, {
        found: number;
        aboveMinConfidence: number;
        passingPersistGuard: number;
        persisted: number;
      }>;
    } = {
      identitiesFoundTotal: allIdentities.length,
      identitiesAboveMinConfidence: aboveMinConfidence.length,
      identitiesPassingPersistGuard: identitiesToPersist.length,
      identitiesPersisted: 0,
      persistErrors: 0,
      perPlatform: {},
    };

    // Helper to ensure platform entry exists
    const ensurePlatform = (platform: string) => {
      if (!persistStats.perPlatform[platform]) {
        persistStats.perPlatform[platform] = {
          found: 0,
          aboveMinConfidence: 0,
          passingPersistGuard: 0,
          persisted: 0,
        };
      }
    };

    // Calculate per-platform found counts
    for (const identity of allIdentities) {
      ensurePlatform(identity.platform);
      persistStats.perPlatform[identity.platform].found++;
    }

    // Calculate per-platform aboveMinConfidence counts
    for (const identity of aboveMinConfidence) {
      ensurePlatform(identity.platform);
      persistStats.perPlatform[identity.platform].aboveMinConfidence++;
    }

    // Calculate per-platform passingPersistGuard counts
    for (const identity of identitiesToPersist) {
      ensurePlatform(identity.platform);
      persistStats.perPlatform[identity.platform].passingPersistGuard++;
    }

    // Upsert identity candidates using Prisma, tracking successes and errors
    for (const identity of identitiesToPersist) {
      const scoreBreakdown = identity.scoreBreakdown
        ? (JSON.parse(JSON.stringify(identity.scoreBreakdown)) as Prisma.InputJsonValue)
        : undefined;
      const evidence = identity.evidence
        ? (JSON.parse(JSON.stringify(identity.evidence)) as Prisma.InputJsonValue)
        : undefined;

      try {
        await prisma.identityCandidate.upsert({
          where: {
            tenantId_candidateId_platform_platformId: {
              tenantId: state.tenantId,
              candidateId: state.candidateId,
              platform: identity.platform,
              platformId: identity.platformId,
            },
          },
          update: {
            confidence: identity.confidence,
            confidenceBucket: identity.confidenceBucket,
            scoreBreakdown,
            evidence,
            hasContradiction: identity.hasContradiction,
            contradictionNote: identity.contradictionNote,
            discoveredBy: state.sessionId || undefined,
          },
          create: {
            tenantId: state.tenantId,
            candidateId: state.candidateId,
            platform: identity.platform,
            platformId: identity.platformId,
            profileUrl: identity.profileUrl,
            confidence: identity.confidence,
            confidenceBucket: identity.confidenceBucket,
            scoreBreakdown,
            evidence,
            hasContradiction: identity.hasContradiction,
            contradictionNote: identity.contradictionNote,
            status: 'unconfirmed',
            discoveredBy: state.sessionId || undefined,
          },
        });

        // Track successful persist per platform
        persistStats.identitiesPersisted++;
        ensurePlatform(identity.platform);
        persistStats.perPlatform[identity.platform].persisted++;
      } catch (dbError) {
        // Track DB error but continue with other identities
        persistStats.persistErrors++;
        console.error(
          `[PersistResults] DB error for ${identity.platform}/${identity.platformId}:`,
          dbError instanceof Error ? dbError.message : dbError
        );
      }
    }

    // Update candidate's last enriched timestamp
    await prisma.candidate.update({
      where: { id: state.candidateId },
      data: { lastEnrichedAt: new Date() },
    });

    const completeEvent: EnrichmentProgressEvent = {
      type: 'node_complete',
      node: 'persistIdentities',
      data: {
        identitiesFound: persistStats.identitiesPersisted, // Use persisted count for progress events
      },
      timestamp: new Date().toISOString(),
    };

    return {
      progressEvents: [progressEvent, completeEvent],
      lastCompletedNode: 'persistIdentities',
      progressPct: NODE_PROGRESS.persistIdentities,
      persistStats,
    };
  } catch (error) {
    const errorEntry: EnrichmentError = {
      platform: 'system',
      message: error instanceof Error ? error.message : 'Failed to persist results',
      timestamp: new Date().toISOString(),
      recoverable: true,
    };

    return {
      errors: [errorEntry],
      progressEvents: [progressEvent],
      lastCompletedNode: 'persistIdentities',
      progressPct: NODE_PROGRESS.persistIdentities,
      errorsBySource: { system: [errorEntry.message] },
    };
  }
}

/**
 * Per-platform timeout configuration (ms)
 */
const PLATFORM_TIMEOUTS: Record<string, number> = {
  github: 10000,    // GitHub API is reliable
  crunchbase: 5000, // Often blocked/slow
  angellist: 5000,  // Often blocked/slow
  twitter: 8000,
  default: 8000,
};

/**
 * Wrap a promise with a timeout.
 * Clears the timer when the promise resolves to avoid memory leaks.
 *
 * LIMITATION: The underlying fetch is not aborted - this is just a race.
 * Orphaned requests may continue consuming resources until they complete.
 *
 * SCALE HARDENING (future):
 * For true cancellation under high volume, add AbortSignal support:
 * 1. Add optional `signal?: AbortSignal` to GitHubClient.request()
 * 2. Pass signal to fetch() call in request()
 * 3. In retry loop: check signal.aborted or catch AbortError → exit immediately
 * 4. Thread signal through getUser(), getUserRepos(), extractEmailFromCommit()
 * 5. Apply same pattern to search executors (Brave, SearXNG) if needed
 *
 * @see src/lib/enrichment/github.ts for implementation target
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function buildEphemeralPlatformData(state: EnrichmentState): Promise<EphemeralPlatformDataItem[]> {
  const sessionId = state.sessionId;
  const now = new Date().toISOString();
  const identities = [...state.identitiesFound]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);

  const github = getGitHubClient();

  // Use Promise.allSettled with per-platform timeouts for resilience
  const results = await Promise.allSettled(
    identities.map(async (identity) => {
      const timeout = PLATFORM_TIMEOUTS[identity.platform] || PLATFORM_TIMEOUTS.default;

      if (identity.platform === 'github') {
        return withTimeout(
          (async () => {
            const [profile, repos] = await Promise.all([
              github.getUser(identity.platformId),
              github.getUserRepos(identity.platformId, 10),
            ]);

            // Extract unique languages from repos
            const languages = [...new Set(repos.map((r) => r.language).filter(Boolean))] as string[];

            // Get top repos by stars
            const topRepos = repos
              .sort((a, b) => b.stars - a.stars)
              .slice(0, 5)
              .map((r) => ({ name: r.name, language: r.language, stars: r.stars }));

            return {
              platform: identity.platform,
              platformId: identity.platformId,
              profileUrl: identity.profileUrl,
              fetchedAt: now,
              data: {
                name: profile.name ?? null,
                bio: profile.bio ?? null,
                company: profile.company ?? null,
                location: profile.location ?? null,
                followers: profile.followers ?? null,
                publicRepos: profile.public_repos ?? null,
                blog: profile.blog ?? null,
                createdAt: profile.created_at ?? null,
                languages,
                topRepos,
              },
            } as EphemeralPlatformDataItem;
          })(),
          timeout,
          `github:${identity.platformId}`
        );
      }

      // For platforms without an official API integration, keep minimal public metadata only.
      return {
        platform: identity.platform,
        platformId: identity.platformId,
        profileUrl: identity.profileUrl,
        fetchedAt: now,
        data: {},
      } as EphemeralPlatformDataItem;
    })
  );

  // Collect successful results and create error entries for failures
  const items: EphemeralPlatformDataItem[] = results.map((result, i) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // Return error entry for failed/timed out fetches
    const identity = identities[i];
    return {
      platform: identity.platform,
      platformId: identity.platformId,
      profileUrl: identity.profileUrl,
      fetchedAt: now,
      data: {
        error: result.reason instanceof Error ? result.reason.message : 'Platform fetch failed',
      },
    };
  });

  if (sessionId) {
    setEphemeralPlatformData(sessionId, items);
  }

  return items;
}

/**
 * Fetch additional platform data (ephemeral; not stored in checkpointed state)
 */
export async function fetchPlatformDataNode(
  state: EnrichmentState
): Promise<PartialEnrichmentState> {
  const progressStart: EnrichmentProgressEvent = {
    type: 'node_start',
    node: 'fetchPlatformData',
    timestamp: new Date().toISOString(),
  };

  try {
    await buildEphemeralPlatformData(state);
    const progressComplete: EnrichmentProgressEvent = {
      type: 'node_complete',
      node: 'fetchPlatformData',
      data: { identitiesFound: state.identitiesFound.length },
      timestamp: new Date().toISOString(),
    };

    return {
      progressEvents: [progressStart, progressComplete],
      lastCompletedNode: 'fetchPlatformData',
      progressPct: NODE_PROGRESS.fetchPlatformData,
    };
  } catch (error) {
    const errorEntry: EnrichmentError = {
      platform: 'system',
      message: error instanceof Error ? error.message : 'Failed to fetch platform data',
      timestamp: new Date().toISOString(),
      recoverable: true,
    };
    const errorEvent: EnrichmentProgressEvent = {
      type: 'error',
      node: 'fetchPlatformData',
      data: { error: errorEntry.message },
      timestamp: new Date().toISOString(),
    };
    return {
      errors: [errorEntry],
      progressEvents: [progressStart, errorEvent],
      lastCompletedNode: 'fetchPlatformData',
      progressPct: NODE_PROGRESS.fetchPlatformData,
      errorsBySource: { system: [errorEntry.message] },
    };
  }
}

/**
 * Generate recruiter-facing summary (stored)
 *
 * Draft + Verified Summary Strategy:
 * - During initial enrichment: Always generate a DRAFT summary from top identities
 * - Draft summaries include caveats about unverified sources
 * - Verified summaries are generated separately after user confirms identities
 */
export async function generateSummaryNode(
  state: EnrichmentState
): Promise<PartialEnrichmentState> {
  const progressStart: EnrichmentProgressEvent = {
    type: 'node_start',
    node: 'generateSummary',
    timestamp: new Date().toISOString(),
  };

  try {
    if (!state.hints) {
      throw new Error('Missing candidate hints for summary');
    }

    // Skip summary generation only if no identities were found at all
    if (state.identitiesFound.length === 0) {
      console.log(
        `[generateSummary] Skipping summary generation - no identities found`
      );

      const skipEvent: EnrichmentProgressEvent = {
        type: 'node_complete',
        node: 'generateSummary',
        data: { identitiesFound: 0, confidence: 0 },
        timestamp: new Date().toISOString(),
      };

      return {
        summaryText: null,
        summaryStructured: null,
        summaryEvidence: null,
        summaryModel: null,
        summaryTokens: null,
        summaryGeneratedAt: null,
        summaryMeta: null,
        progressEvents: [progressStart, skipEvent],
        lastCompletedNode: 'generateSummary',
        progressPct: NODE_PROGRESS.generateSummary,
      };
    }

    const sessionId = state.sessionId;
    let platformData = sessionId ? getEphemeralPlatformData(sessionId) : null;
    if (!platformData) {
      platformData = await buildEphemeralPlatformData(state);
    }

    const identities = [...state.identitiesFound].sort((a, b) => b.confidence - a.confidence).slice(0, 10);

    // Generate as DRAFT mode (no confirmed identities during initial enrichment)
    const { summary, evidence, model, tokens, meta } = await generateCandidateSummary({
      candidate: {
        linkedinId: state.hints.linkedinId,
        linkedinUrl: state.hints.linkedinUrl,
        nameHint: state.hints.nameHint,
        headlineHint: state.hints.headlineHint,
        locationHint: state.hints.locationHint,
        companyHint: state.hints.companyHint,
        roleType: state.hints.roleType,
      },
      identities,
      platformData,
      mode: 'draft',
      confirmedCount: 0,
    });

    if (sessionId) {
      clearEphemeralPlatformData(sessionId);
    }

    console.log(
      `[generateSummary] Generated draft summary from ${identities.length} identities (mode: ${meta.mode})`
    );

    const progressComplete: EnrichmentProgressEvent = {
      type: 'node_complete',
      node: 'generateSummary',
      data: { identitiesFound: identities.length, confidence: summary.confidence },
      timestamp: new Date().toISOString(),
    };

    return {
      summaryText: summary.summary,
      summaryStructured: summary.structured as unknown as Record<string, unknown>,
      summaryEvidence: evidence as unknown as Array<Record<string, unknown>>,
      summaryModel: model,
      summaryTokens: tokens,
      summaryGeneratedAt: new Date().toISOString(),
      summaryMeta: meta as unknown as Record<string, unknown>,
      progressEvents: [progressStart, progressComplete],
      lastCompletedNode: 'generateSummary',
      progressPct: NODE_PROGRESS.generateSummary,
    };
  } catch (error) {
    const errorEntry: EnrichmentError = {
      platform: 'system',
      message: error instanceof Error ? error.message : 'Failed to generate summary',
      timestamp: new Date().toISOString(),
      recoverable: true,
    };
    const errorEvent: EnrichmentProgressEvent = {
      type: 'error',
      node: 'generateSummary',
      data: { error: errorEntry.message },
      timestamp: new Date().toISOString(),
    };
    return {
      errors: [errorEntry],
      progressEvents: [progressStart, errorEvent],
      lastCompletedNode: 'generateSummary',
      progressPct: NODE_PROGRESS.generateSummary,
      errorsBySource: { system: [errorEntry.message] },
    };
  }
}

/**
 * Persist summary to EnrichmentSession and update Candidate status
 */
export async function persistSummaryNode(
  state: EnrichmentState
): Promise<PartialEnrichmentState> {
  const progressStart: EnrichmentProgressEvent = {
    type: 'node_start',
    node: 'persistSummary',
    timestamp: new Date().toISOString(),
  };

  try {
    const sessionId = state.sessionId;
    if (!sessionId) {
      throw new Error('Missing sessionId for persistSummary');
    }

    const bestConfidence =
      typeof state.bestConfidence === 'number'
        ? state.bestConfidence
        : state.identitiesFound.length > 0
          ? Math.max(...state.identitiesFound.map((i) => i.confidence))
          : null;

    // Build run trace for observability (Phase A.5)
    const runTrace = buildRunTrace(state);

    // Prisma client types may be stale until `prisma generate` runs in the target environment.
    // Use a narrow `any` cast to allow compilation while keeping runtime behavior correct.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {
      summary: state.summaryText || null,
      summaryStructured: state.summaryStructured
        ? (JSON.parse(JSON.stringify(state.summaryStructured)) as Prisma.InputJsonValue)
        : undefined,
      summaryEvidence: state.summaryEvidence
        ? (JSON.parse(JSON.stringify(state.summaryEvidence)) as Prisma.InputJsonValue)
        : undefined,
      summaryModel: state.summaryModel || null,
      summaryTokens: state.summaryTokens ?? null,
      // Only set summaryGeneratedAt if a summary was actually generated
      summaryGeneratedAt: state.summaryText && state.summaryGeneratedAt
        ? new Date(state.summaryGeneratedAt)
        : undefined,
      // Phase A.5: Store run trace for debugging and optimization
      runTrace: JSON.parse(JSON.stringify(runTrace)) as Prisma.InputJsonValue,
    };

    await prisma.enrichmentSession.update({
      where: { id: sessionId },
      data: updateData,
    });

    // Log key metrics for quick debugging
    // Format: found→aboveMin→passGuard→persisted (errors if any)
    const f = runTrace.final;
    const errorSuffix = f.persistErrors ? ` persistErrors=${f.persistErrors}` : '';
    console.log(`[EnrichmentRunTrace] candidateId=${state.candidateId} ` +
      `queries=${f.totalQueriesExecuted} ` +
      `platformsQueried=${f.platformsQueried} platformsWithHits=${f.platformsWithHits} ` +
      `identities=${f.identitiesFoundTotal}→${f.identitiesAboveMinConfidence}→${f.identitiesPassingPersistGuard}→${f.identitiesPersisted} ` +
      `bestConfidence=${f.bestConfidence?.toFixed(2) ?? 'N/A'} ` +
      `duration=${f.durationMs}ms${errorSuffix}`);

    await prisma.candidate
      .update({
        where: { id: state.candidateId },
        data: {
          enrichmentStatus: state.status === 'failed' ? 'failed' : 'completed',
          confidenceScore: bestConfidence ?? undefined,
          lastEnrichedAt: new Date(),
        },
      })
      .catch(() => {});

    const progressComplete: EnrichmentProgressEvent = {
      type: 'node_complete',
      node: 'persistSummary',
      data: { confidence: bestConfidence ?? undefined },
      timestamp: new Date().toISOString(),
    };

    return {
      progressEvents: [progressStart, progressComplete],
      lastCompletedNode: 'persistSummary',
      progressPct: NODE_PROGRESS.persistSummary,
    };
  } catch (error) {
    const errorEntry: EnrichmentError = {
      platform: 'system',
      message: error instanceof Error ? error.message : 'Failed to persist summary',
      timestamp: new Date().toISOString(),
      recoverable: true,
    };
    const errorEvent: EnrichmentProgressEvent = {
      type: 'error',
      node: 'persistSummary',
      data: { error: errorEntry.message },
      timestamp: new Date().toISOString(),
    };
    return {
      errors: [errorEntry],
      progressEvents: [progressStart, errorEvent],
      lastCompletedNode: 'persistSummary',
      progressPct: NODE_PROGRESS.persistSummary,
      errorsBySource: { system: [errorEntry.message] },
    };
  }
}

/**
 * Conditional edge: should continue to search platforms?
 */
export function shouldContinueSearching(state: EnrichmentState): boolean {
  // Don't continue if we already found a high-confidence match
  if (state.earlyStopReason) {
    return false;
  }

  // Don't continue if we've hit budget limits
  if (state.queriesExecuted >= (state.budget?.maxQueries || DEFAULT_BUDGET.maxQueries)) {
    return false;
  }

  // Don't continue if all platforms have been queried
  if (state.platformsRemaining?.length === 0) {
    return false;
  }

  // Check if we already have a high-confidence match
  const bestConfidence = Math.max(...state.identitiesFound.map((i) => i.confidence), 0);
  if (bestConfidence >= (state.budget?.minConfidenceForEarlyStop || DEFAULT_BUDGET.minConfidenceForEarlyStop)) {
    return false;
  }

  return true;
}

/**
 * Get next batch of platforms to query
 */
export function getNextPlatformBatch(
  state: EnrichmentState,
  batchSize: number = 3
): EnrichmentPlatform[] {
  return (state.platformsRemaining || []).slice(0, batchSize);
}
