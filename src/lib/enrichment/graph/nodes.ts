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
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import {
  type EnrichmentState,
  type PartialEnrichmentState,
  type EnrichmentHints,
  type EnrichmentError,
  type EnrichmentProgressEvent,
  type PlatformQueryResult,
  DEFAULT_BUDGET,
} from './types';

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

    // Build hints from candidate data (using Prisma schema field names)
    const hints: EnrichmentHints = {
      linkedinId: candidate.linkedinId || candidate.id,
      linkedinUrl: candidate.linkedinUrl || `https://linkedin.com/in/${candidate.linkedinId}`,
      nameHint: candidate.nameHint || null,
      headlineHint: candidate.headlineHint || null,
      locationHint: candidate.locationHint || null,
      companyHint: null, // Extract from headline if needed
      roleType: (candidate.roleType as RoleType) || state.roleType || null,
    };

    // Determine role type
    const roleType = hints.roleType || state.roleType || 'general';

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

    const result = await discoverGitHubIdentities(state.candidateId, candidateHints, {
      maxGitHubResults: state.budget?.maxIdentitiesPerPlatform || 5,
      includeCommitEvidence: true,
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
        activityScore: i.scoreBreakdown.profileCompleteness || 0, // Map missing field
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
      minConfidence: 0.4,
    });

    const platformResult: PlatformQueryResult = {
      platform,
      identities: result.identities,
      queriesExecuted: result.queriesExecuted,
      searchQueries: result.searchQueries,
      durationMs: result.durationMs,
      error: result.error,
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
    };
  }
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

  return {
    status,
    bestConfidence,
    earlyStopReason,
    completedAt: new Date().toISOString(),
    identitiesFound: sortedIdentities,
    progressEvents: [progressEvent, completeEvent],
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
    node: 'persistResults',
    timestamp: new Date().toISOString(),
  };

  try {
    // Filter and transform identities for persistence
    const identitiesToPersist = state.identitiesFound
      .filter((i) => i.confidence >= 0.4); // Only persist above threshold

    // Upsert identity candidates using Prisma
    for (const identity of identitiesToPersist) {
      const scoreBreakdown = identity.scoreBreakdown
        ? (JSON.parse(JSON.stringify(identity.scoreBreakdown)) as Prisma.InputJsonValue)
        : undefined;
      const evidence = identity.evidence
        ? (JSON.parse(JSON.stringify(identity.evidence)) as Prisma.InputJsonValue)
        : undefined;

      await prisma.identityCandidate.upsert({
        where: {
          candidateId_platform_platformId: {
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
        },
        create: {
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
        },
      });
    }

    // Update candidate's last enriched timestamp
    await prisma.candidate.update({
      where: { id: state.candidateId },
      data: { lastEnrichedAt: new Date() },
    });

    const completeEvent: EnrichmentProgressEvent = {
      type: 'node_complete',
      node: 'persistResults',
      data: { identitiesFound: identitiesToPersist.length },
      timestamp: new Date().toISOString(),
    };

    return {
      progressEvents: [progressEvent, completeEvent],
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
