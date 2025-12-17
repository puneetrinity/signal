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
import { getGitHubClient } from '../github';
import {
  clearEphemeralPlatformData,
  getEphemeralPlatformData,
  setEphemeralPlatformData,
  type EphemeralPlatformDataItem,
} from './ephemeral';
import { generateCandidateSummary } from '../summary/generate';
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
      minConfidence: 0.35,
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
    // Filter and transform identities for persistence
    const identitiesToPersist = state.identitiesFound
      .filter((i) => i.confidence >= 0.35); // Only persist above threshold

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
          discoveredBy: state.sessionId || undefined,
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
          discoveredBy: state.sessionId || undefined,
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
      node: 'persistIdentities',
      data: { identitiesFound: identitiesToPersist.length },
      timestamp: new Date().toISOString(),
    };

    return {
      progressEvents: [progressEvent, completeEvent],
      lastCompletedNode: 'persistIdentities',
      progressPct: NODE_PROGRESS.persistIdentities,
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

    const sessionId = state.sessionId;
    let platformData = sessionId ? getEphemeralPlatformData(sessionId) : null;
    if (!platformData) {
      platformData = await buildEphemeralPlatformData(state);
    }

    const identities = [...state.identitiesFound].sort((a, b) => b.confidence - a.confidence).slice(0, 10);

    const { summary, evidence, model, tokens } = await generateCandidateSummary({
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
    });

    if (sessionId) {
      clearEphemeralPlatformData(sessionId);
    }

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
      summaryGeneratedAt: state.summaryGeneratedAt ? new Date(state.summaryGeneratedAt) : new Date(),
    };

    await prisma.enrichmentSession.update({
      where: { id: sessionId },
      data: updateData,
    });

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
