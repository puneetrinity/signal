import { prisma } from '@/lib/prisma';
import { extractLinkedInIdFromUrl } from './discovery';
import { Prisma } from '@prisma/client';
import { redis } from '@/lib/redis/client';
import { toJsonValue } from '@/lib/prisma/json';
import { createLogger } from '@/lib/logger';
import { buildJobRequirements, type SourcingJobContextInput } from './jd-digest';
import { rankCandidates } from './ranking-new';
import { discoverCandidates, type DiscoveredCandidate, type DiscoveryTelemetry } from './discovery';
import { getLocationBoostWeight, getSourcingConfig } from './config';
import { isMeaningfulLocation, isNoisyLocationHint, canonicalizeLocation, extractPrimaryCity, orderByFitScoreWithConfidence, STRONG_LOCATION_TYPES } from './ranking-new';
import { getRecentlyExposedCandidateIds } from './novelty';
import type { CandidateForRanking, FitBreakdown, MatchTier, LocationMatchType, ScoredCandidate } from './ranking-new';
import type { TrackDecision } from './types';
import { jobTrackToDbFilter } from './types';
import { guardedTopKSwap } from './top20-guards';
import { buildLayer1SlugIndex, selectTwoLayerCandidateIds } from './two-layer-pool';
import {
  buildFineQueryFingerprint,
  buildRelaxationRungs,
  isProviderShortfall,
  selectSpillRung,
  type RelaxationState,
} from './relaxation-ladder';
import {
  acquireCrustdataSearchForRequest,
  CrustdataAcquisitionSafetyError,
  findCrustdataAcquisitionReceipt,
  markCrustdataReceiptMemoryIngested,
  type AcquiredCrustdataSearch,
} from './crustdata-acquisition';
import { applyCrustdataLadderObservationOnce } from './crustdata-ladder-effect';
import {
  resolveRoleDeterministic,
  resolveRolesBatch,
  type RoleResolution,
  type RoleResolutionMetrics,
  type RoleBatchEntry,
} from '@/lib/taxonomy/role-service';
import {
  resolveLocationsBatch,
  deriveCountryCodeFromLocationText,
  type LocationResolution,
  type LocationResolutionMetrics,
  type LocationBatchEntry,
} from '@/lib/taxonomy/location-service';
import {
  assessLocationCountryConsistency,
  computeSerpEvidence,
  extractSerpSignals,
} from '@/lib/search/serp-signals';
import {
  buildPublicMarketsForQuery,
  canApplyPlatformPublicExclusions,
  mergePublicExclusionIds,
  type PublicMarket,
} from './public-memory';
import {
  applyCandidateMaterializationResults,
  assertPersistableCandidateIds,
  buildObservedCandidatePublicMarket,
  ensureCandidateGlobalLink,
  materializePublicMemoryCandidates,
  makeGlobalTemporaryCandidateId,
  MAX_MATERIALIZATION_FAILURE_DETAILS,
  parseGlobalTemporaryCandidateId,
  resolvePublicCandidateRoleFamily,
  type PublicMemoryMaterializationEntry,
  type PublicMemoryMaterializationFailure,
} from './public-memory-materialization';
import type {
  GlobalPoolSearchResult,
  PublicMarketExclusionResponse,
  TenantPrivateSearchResult,
} from './activegraph-client';
import {
  attachLocalCandidatesToPublicMemoryOutbox,
  enqueuePublicMemoryIngestOutbox,
} from './public-memory-ingest-outbox';
import {
  buildTenantPrivateRankingCandidate,
  makeTenantPrivateTemporaryId,
  mergeTenantPrivateEvidence,
} from './tenant-private-memory';
import {
  addExpectedGlobalIdentityReceipt,
  buildExpectedGlobalIdentityReceipts,
  candidatePublicIdentityKey,
  expectedGlobalCandidateIdForCandidate,
} from './public-memory-identity';
import { persistSourcingCandidatesForRequest } from './sourcing-candidate-persistence';

import {
  logSourcingRaw,
  logRankingResult,
  resetPipelineLogTimers,
} from './debug-pipeline-logs';

const log = createLogger('SourcingOrchestrator');
const CRUSTDATA_REQUEST_LIMIT = 300;

class PublicMemoryOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicMemoryOutboxError';
  }
}

export interface OrchestratorResult {
  candidateCount: number;
  poolCount: number;
  discoveredCount: number;
  discoveryShortfallRate: number; // 0.0 = no shortfall, 1.0 = total miss (0 when no discovery needed)
  queriesExecuted: number;
  qualityGateTriggered: boolean;
  avgFitTopK: number;
  countAboveThreshold: number;
  strictTopKCount: number;
  strictCoverageRate: number;
  effectiveStrategy: 'pool_first' | 'discovery_first' | 'crustdata_primary';
  executionPath: 'crustdata_primary' | 'legacy_assembly';
  discoveryReason: 'pool_deficit' | 'low_quality_pool' | 'deficit_and_low_quality' | 'minimum_discovery_floor' | 'pool_role_mismatch' | 'deficit_and_role_mismatch' | 'strategy_discovery_first' | 'crustdata_primary' | null;
  discoverySkippedReason: 'daily_serp_cap_reached' | 'cap_guard_unavailable' | null;
  discoveryTelemetry: DiscoveryTelemetry | null;
  snapshotReuseCount: number;
  snapshotStaleServedCount: number;

  strictMatchedCount: number;
  expandedCount: number;
  expansionReason: 'insufficient_strict_location_matches' | 'strict_low_quality' | null;
  requestedLocation: string | null;
  skillScoreDiagnostics: {
    withSnapshotSkills: number;
    usingTextFallback: number;
    avgSkillScoreBySourceType: Record<string, number>;
  };
  locationHintCoverage: number;
  strictDemotedCount: number;
  strictRescuedCount: number;
  strictRescueApplied: boolean;
  strictRescueMinFitScoreUsed: number | null;
  locationMatchCounts: { city_exact: number; city_alias: number; country_only: number; unknown_location: number; none: number };
  demotedStrictWithCityMatch: number;
  strictBeforeDemotion: number;
  countryGuardFilteredCount: number;
  countryGuardSerpLocaleSkippedCount: number;
  countryGuardEscapeCounts: { no_location: number; country_match: number; city_only_unknown_country: number };
  // Stage-3 two-layer pool read telemetry. Null when the flag is off.
  twoLayerPool: {
    enabled: boolean;
    layer1Size: number;
    layer1CapHit: boolean;
    layer1EligibleCount: number;
    layer2Size: number;
    vectorLaneResolved: number;
    recentLaneAdded: number;
    fallbackHydrateUsed: boolean;
    freshSurvivorRefreshes: number;
  } | null;
  selectedSnapshotTrack: string;
  locationCoverageTriggered: boolean;
  noveltySuppressedCount: number;
  noveltyWindowDays: number;
  noveltyKey: string | null;
  noveltyHint: string | null;
  discoveredOrphanCount: number;
  dynamicQueryBudgetUsed: boolean;
  minDiscoveryPerRunApplied: number;
  minDiscoveredInOutputApplied: number;
  discoveredPromotedCount: number;
  discoveredPromotedInTopCount: number;
  unknownLocationPromotedCount: number;
  discoveredPromotionRejections: {
    total: number;
    locationGate: number;
    fitGate: number;
    roleGate: number;
    confidence: number;
    phase: number;
    unknownCap: number;
  };
  discoveredDeferredFromFrontLoad: number;
  unknownLocationAssemblyCapRejected: number;
  unknownLocationPoolCapRejected: number;
  unknownLocationPoolAssembledCount: number;
  unknownLocationDiscoveredAssembledCount: number;
  unknownLocationPenaltyApplied: number;
  unknownLocationPoolPenaltyApplied: number;
  nonTechLocationMismatchPenaltyApplied: number;
  unknownLocationTop20DemotedInitial: number;
  unknownLocationTop20DemotedFinal: number;
  // Top-20 quality guards (tech only)
  roleGuardTop20Demoted: number;
  roleGuardNoReplacementCount: number;
  roleGuardEpsilonBlockedCount: number;
  skillFloorTop20Demoted: number;
  skillFloorBypassCount: number;
  skillFloorNoReplacementCount: number;
  skillFloorEpsilonBlockedCount: number;
  // Supply diagnostics
  eligibleTechRoleCount: number | null;
  eligibleTechSkillCount: number | null;
  preGuardLowRoleTop20: number | null;
  preGuardLowSkillTop20: number | null;
  postGuardLowRoleTop20: number | null;
  postGuardLowSkillTop20: number | null;
  // Runtime thresholds snapshot (for SQL alignment)
  techTop20Thresholds: { roleMin: number; roleCap: number; skillMin: number; guardsEnabled: boolean } | null;
  roleResolutionMetrics: RoleResolutionMetrics | null;
  locationResolutionMetrics: LocationResolutionMetrics | null;
  sourceMetrics?: SourceMetrics;
  publicMemory: PublicMemoryTelemetry;
  relaxationLadder?: {
    scope: 'tenant';
    scopeKey: string;
    fineQueryFingerprint: string;
    enabled: boolean;
    submittedExclusionCount: number;
    exact: {
      requestedLimit: number;
      providerTotal: number | null;
      rawReturnedCount: number;
      shortfall: boolean;
    };
    spill: {
      rung: string;
      description: string;
      requestedLimit: number;
      providerTotal: number | null;
      rawReturnedCount: number;
      shortfall: boolean;
      nextActiveRung: string;
    } | null;
    error: string | null;
  } | null;
  crustdataAcquisition?: {
    generation: number;
    exact: {
      receiptId: string;
      reused: boolean;
      requestFingerprint: string;
      requestFingerprintMatched: boolean;
      acquiredAt: string;
      memoryIngestReused: boolean;
    };
    spill: {
      receiptId: string;
      reused: boolean;
      requestFingerprint: string;
      requestFingerprintMatched: boolean;
      acquiredAt: string;
      memoryIngestReused: boolean;
    } | null;
  } | null;
}

interface AssembledCandidate {
  candidateId: string;
  fitScore: number | null;
  fitBreakdown: FitBreakdown | null;
  matchTier: MatchTier | null;
  locationMatchType: LocationMatchType | null;
  sourceType: string;
  dataConfidence: 'high' | 'medium' | 'low';
  rank: number;
}

type CandidateSourceType = 'pool' | 'pool_enriched' | 'discovered';

interface SourceMetricEntry {
  count: number;
  share: number;
  fitScore: { min: number; median: number; max: number } | null;
}

interface SourceMetrics {
  eligible: Record<CandidateSourceType, SourceMetricEntry>;
  top20: Record<CandidateSourceType, SourceMetricEntry>;
  top100: Record<CandidateSourceType, SourceMetricEntry>;
  served: Record<CandidateSourceType, SourceMetricEntry>;
}

type PublicExclusionSource =
  | 'off'
  | 'memory_public'
  | 'memory_public_plus_local'
  | 'tenant_public'
  | 'local_public_fallback'
  | 'unresolved_market';

interface PublicMemoryExclusionTelemetry {
  marketKeys: string[];
  source: PublicExclusionSource;
  count: number;
  totalMatched: number | null;
  classifiedMatched: number | null;
  unclassifiedMatched: number | null;
  unclassifiedReturned: number | null;
  truncated: boolean | null;
}

function parseReceiptPublicExclusionTelemetry(
  value: Record<string, unknown> | undefined,
): PublicMemoryExclusionTelemetry | null {
  if (!value) return null;
  const nullableNumber = (entry: unknown): boolean =>
    entry === null || typeof entry === 'number';
  const validSources = new Set<PublicExclusionSource>([
    'off',
    'memory_public',
    'memory_public_plus_local',
    'tenant_public',
    'local_public_fallback',
    'unresolved_market',
  ]);
  if (
    !Array.isArray(value.marketKeys) ||
    !value.marketKeys.every((key) => typeof key === 'string') ||
    typeof value.source !== 'string' ||
    !validSources.has(value.source as PublicExclusionSource) ||
    typeof value.count !== 'number' ||
    !nullableNumber(value.totalMatched) ||
    !nullableNumber(value.classifiedMatched) ||
    !nullableNumber(value.unclassifiedMatched) ||
    !nullableNumber(value.unclassifiedReturned) ||
    (value.truncated !== null &&
      typeof value.truncated !== 'boolean')
  ) {
    return null;
  }
  return value as unknown as PublicMemoryExclusionTelemetry;
}

interface PublicMemoryTelemetry {
  hydrationEnabled: boolean;
  platformExclusionConfigured: boolean;
  platformExclusionActive: boolean;
  searchSurface: 'off' | 'legacy_v0' | 'public_v1';
  searchAvailable: boolean | null;
  vectorReturned: number;
  resolvedByGlobalLink: number;
  resolvedByLinkedin: number;
  temporaryCandidates: number;
  identityReceiptConflicts: number;
  privateSearchAvailable: boolean | null;
  privateRetrieved: number;
  privateMaterialized: number;
  privateSkippedNoLinkedin: number;
  materializedCandidates: number;
  materializationRaceWins: number;
  materializationFailures: number;
  materializationFailureDetails: PublicMemoryMaterializationFailure[];
  exactExclusion: PublicMemoryExclusionTelemetry;
  spillExclusion: PublicMemoryExclusionTelemetry | null;
  ingestQueued: number;
  ingestPending: number;
  ingestConfirmed: number;
  ingestFailed: number;
  asyncLinksConfirmed: number;
  asyncLinksFailed: number;
  linksRetained: number;
  linkFailures: number;
}

const CANDIDATE_SOURCE_TYPES: CandidateSourceType[] = ['pool', 'pool_enriched', 'discovered'];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarizeSourceMetrics(
  candidates: Array<{ sourceType: CandidateSourceType; fitScore: number | null }>,
): Record<CandidateSourceType, SourceMetricEntry> {
  return Object.fromEntries(CANDIDATE_SOURCE_TYPES.map((sourceType) => {
    const matching = candidates.filter((candidate) => candidate.sourceType === sourceType);
    const scores = matching
      .map((candidate) => candidate.fitScore)
      .filter((score): score is number => Number.isFinite(score));
    return [sourceType, {
      count: matching.length,
      share: candidates.length === 0 ? 0 : matching.length / candidates.length,
      fitScore: scores.length === 0
        ? null
        : { min: Math.min(...scores), median: median(scores), max: Math.max(...scores) },
    }];
  })) as Record<CandidateSourceType, SourceMetricEntry>;
}

function formatUtcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function secondsUntilUtcDayEnd(date = new Date()): number {
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return Math.max(1, Math.ceil((end.getTime() - date.getTime()) / 1000));
}

async function getDiscoveryQueryBudget(
  tenantId: string,
  maxQueries: number,
  dailyCap: number,
): Promise<{
  allowed: boolean;
  maxQueries: number;
  key: string | null;
  reservedQueries: number;
  skippedReason: OrchestratorResult['discoverySkippedReason'];
}> {
  if (dailyCap <= 0) {
    return { allowed: true, maxQueries, key: null, reservedQueries: 0, skippedReason: null };
  }

  try {
    const ping = await redis.ping();
    if (ping !== 'PONG') {
      return { allowed: false, maxQueries: 0, key: null, reservedQueries: 0, skippedReason: 'cap_guard_unavailable' };
    }

    const key = `sourcing:serper:${tenantId}:${formatUtcDay()}`;
    const ttl = secondsUntilUtcDayEnd();

    // Reserve queries atomically; shrink reservation until it fits under cap.
    for (let reserve = maxQueries; reserve >= 1; reserve--) {
      const newTotal = await redis.incrby(key, reserve);
      await redis.expire(key, ttl);
      if (newTotal <= dailyCap) {
        return { allowed: true, maxQueries: reserve, key, reservedQueries: reserve, skippedReason: null };
      }
      await redis.decrby(key, reserve);
    }

    return { allowed: false, maxQueries: 0, key, reservedQueries: 0, skippedReason: 'daily_serp_cap_reached' };
  } catch (error) {
    log.warn({ tenantId, error }, 'Failed to read discovery budget, skipping discovery for spend safety');
    return { allowed: false, maxQueries: 0, key: null, reservedQueries: 0, skippedReason: 'cap_guard_unavailable' };
  }
}

async function releaseUnusedReservedQueries(
  key: string | null,
  reservedQueries: number,
  usedQueries: number,
): Promise<void> {
  if (!key || reservedQueries <= 0) return;
  const unused = reservedQueries - usedQueries;
  if (unused <= 0) return;
  try {
    await redis.decrby(key, unused);
  } catch (error) {
    log.warn({ key, reservedQueries, usedQueries, error }, 'Failed to release unused reserved discovery queries');
  }
}

export async function runSourcingOrchestrator(
  requestId: string,
  tenantId: string,
  jobContext: SourcingJobContextInput,
  trackDecision?: TrackDecision,
  acquisitionGeneration = 1,
  executionAttemptId?: string,
  processingLeaseId?: string,
): Promise<OrchestratorResult> {
  const config = getSourcingConfig();
  const requirements = buildJobRequirements(jobContext);
  const publicMemory: PublicMemoryTelemetry = {
    hydrationEnabled: config.publicMemoryHydrationEnabled,
    platformExclusionConfigured: config.platformExclusionEnabled,
    // Becomes active only after public hydration answers successfully.
    // Excluding platform-known people while that retrieval path is unavailable
    // would hide candidates from both the buy and the served pool.
    platformExclusionActive: false,
    searchSurface: config.publicMemoryHydrationEnabled
      ? 'public_v1'
      : 'off',
    searchAvailable: null,
    vectorReturned: 0,
    resolvedByGlobalLink: 0,
    resolvedByLinkedin: 0,
    temporaryCandidates: 0,
    identityReceiptConflicts: 0,
    privateSearchAvailable: null,
    privateRetrieved: 0,
    privateMaterialized: 0,
    privateSkippedNoLinkedin: 0,
    materializedCandidates: 0,
    materializationRaceWins: 0,
    materializationFailures: 0,
    materializationFailureDetails: [],
    exactExclusion: {
      marketKeys: [],
      source: 'off',
      count: 0,
      totalMatched: null,
      classifiedMatched: null,
      unclassifiedMatched: null,
      unclassifiedReturned: null,
      truncated: null,
    },
    spillExclusion: null,
    ingestQueued: 0,
    ingestPending: 0,
    ingestConfirmed: 0,
    ingestFailed: 0,
    asyncLinksConfirmed: 0,
    asyncLinksFailed: 0,
    linksRetained: 0,
    linkFailures: 0,
  };
  const executionFence = executionAttemptId && processingLeaseId
    ? { acquisitionGeneration, executionAttemptId, processingLeaseId }
    : undefined;
  const assertCurrentExecution = async (): Promise<void> => {
    if (!executionFence) return;
    const current = await prisma.jobSourcingRequest.count({
      where: {
        id: requestId,
        tenantId,
        acquisitionGeneration,
        executionAttemptId,
        processingLeaseId,
      },
    });
    if (current !== 1) {
      throw new Error('Sourcing execution was superseded');
    }
  };
  const persistSourcingCandidates = async (
    data: Prisma.JobSourcingCandidateCreateManyInput[],
  ): Promise<void> =>
    persistSourcingCandidatesForRequest({
      requestId,
      tenantId,
      data,
      executionFence,
      materializationDiagnostics: {
        failureCount: publicMemory.materializationFailures,
        failures: publicMemory.materializationFailureDetails,
      },
    });

  const sendProgressCallback = async (event: string, eventData: any = {}) => {
    try {
      const r = await prisma.jobSourcingRequest.findUnique({
        where: { id: requestId },
        select: {
          callbackUrl: true,
          externalJobId: true,
          acquisitionGeneration: true,
          executionAttemptId: true,
          processingLeaseId: true,
        }
      });
      if (
        executionFence &&
        (r?.acquisitionGeneration !== acquisitionGeneration ||
          r.executionAttemptId !== executionAttemptId ||
          r.processingLeaseId !== processingLeaseId)
      ) {
        return;
      }
      if (r?.callbackUrl) {
        const { deliverCallback } = await import('./callback');
        await deliverCallback(requestId, tenantId, r.callbackUrl, {
          version: 1,
          requestId,
          externalJobId: r.externalJobId,
          acquisitionGeneration,
          executionAttemptId,
          status: 'partial',
          candidateCount: 0,
          event: event as any,
          candidateData: eventData
        }, false, executionFence);
      }
    } catch (err) {
      log.error({ err, event }, 'Failed to send progress callback');
    }
  };

  await sendProgressCallback('phase_started');


  log.info(
    {
      requestId,
      tenantId,
      topSkills: requirements.topSkills,
      roleFamily: requirements.roleFamily,
      location: requirements.location,
      resolvedTrack: trackDecision ? { track: trackDecision.track, confidence: trackDecision.confidence, method: trackDecision.method } : null,
    },
    'Starting orchestrator',
  );

  // Reset per-run debug log timers
  resetPipelineLogTimers();

  // 1. Query tenant pool
  const snapshotTrackFilter = jobTrackToDbFilter(trackDecision?.track);
  const selectedSnapshotTrack = snapshotTrackFilter.length === 1
    ? snapshotTrackFilter[0]
    : 'tech'; // blended uses deterministic tech-first preference

  // Hoisted from section 2.5: the two-layer read below needs the vector search
  // before hydration; 2.5 reuses the prefetched result (one Memory call/run).
  const {
    generateTagsFromJD,
    searchHomePool,
    searchGlobalPool,
    searchPublicGlobalPool,
    searchTenantPrivateCandidates,
    resolvePublicIdentities,
    getPublicMarketExclusions,
    HOME_POOL_LIMIT,
    HOME_POOL_ENABLED,
  } = await import('./activegraph-client');
  const publicHydrationEnabled = config.publicMemoryHydrationEnabled;
  const homePoolReadEnabled = publicHydrationEnabled || HOME_POOL_ENABLED;
  if (!publicHydrationEnabled && HOME_POOL_ENABLED) {
    publicMemory.searchSurface = 'legacy_v0';
  }

  const poolSelect = {
    id: true,
    linkedinId: true,
    linkedinUrl: true,
    headlineHint: true,
    seniorityHint: true,
    locationHint: true,
    searchTitle: true,
    searchSnippet: true,
    enrichmentStatus: true,
    lastEnrichedAt: true,
    searchMeta: true,
    intelligenceSnapshots: {
      where: { track: { in: snapshotTrackFilter } },
      orderBy: { computedAt: 'desc' },
    },
  } satisfies Prisma.CandidateSelect;

  // ── Stage-3 two-layer pool read ────────────────────────────────────────────
  // Layer 1: slim full-width projection of the tenant pool (no blobs, no
  // snapshots — ~200 bytes/row) keeps the discovery gates, dedup sets, country
  // guard and funnel metrics truthful at any pool size. If this query ever
  // shows up in run latency it is cacheable per-tenant with a short TTL.
  // Layer 2: only vector top-N ∪ recent-K rows are hydrated full-width and
  // ranked, so ranking cost stays constant as Memory grows.
  type SlimPoolRow = {
    id: string;
    linkedinId: string;
    linkedinUrl: string | null;
    locationHint: string | null;
    serper: Prisma.JsonValue | null;
  };
  let slimPool: SlimPoolRow[] = [];
  const slimById = new Map<string, SlimPoolRow>();
  const slimBySlug = new Map<string, SlimPoolRow>();
  let layer1CapHit = false;
  let recentLaneAdded = 0;
  let vectorLaneResolved = 0;
  let fallbackHydrateUsed = false;
  let freshSurvivorRefreshes = 0;
  let prefetchedVectorResults: Awaited<ReturnType<typeof searchGlobalPool>> = null;
  const prefetchedLocalIdByGlobalId = new Map<string, string>();

  const fetchPoolByIds = (ids: string[]) =>
    prisma.candidate.findMany({ where: { tenantId, id: { in: ids } }, select: poolSelect });
  let poolRows: Awaited<ReturnType<typeof fetchPoolByIds>>;

  if (config.twoLayerPoolEnabled) {
    slimPool = await prisma.$queryRaw<SlimPoolRow[]>`
      SELECT "id", "linkedinId", "linkedinUrl", "locationHint",
             "searchMeta"->'serper' AS "serper"
      FROM "candidates"
      WHERE "tenantId" = ${tenantId}
      ORDER BY "updatedAt" DESC
      LIMIT ${config.poolLayer1Cap}
    `;
    layer1CapHit = slimPool.length >= config.poolLayer1Cap;
    if (layer1CapHit) {
      log.warn(
        { requestId, layer1Cap: config.poolLayer1Cap },
        'Layer-1 cap hit — gates/dedup/metrics see a truncated pool',
      );
    }
    for (const r of slimPool) {
      slimById.set(r.id, r);
      if (r.linkedinId) slimBySlug.set(r.linkedinId.toLowerCase(), r);
      if (r.linkedinUrl) {
        const slug = extractLinkedInIdFromUrl(r.linkedinUrl);
        if (slug) slimBySlug.set(slug.toLowerCase(), r);
      }
    }

    if (homePoolReadEnabled) {
      try {
        if (publicHydrationEnabled) {
          const response = await searchPublicGlobalPool(
            requirements,
            tenantId,
            HOME_POOL_LIMIT,
            requestId,
          );
          publicMemory.searchAvailable = response !== null;
          publicMemory.vectorReturned = response?.results.length ?? 0;
          prefetchedVectorResults = response?.results ?? null;
        } else {
          prefetchedVectorResults = await searchGlobalPool(
            requirements,
            tenantId,
            HOME_POOL_LIMIT,
            requestId,
          );
          publicMemory.searchAvailable = prefetchedVectorResults !== null;
          publicMemory.vectorReturned = prefetchedVectorResults?.length ?? 0;
        }
      } catch (err) {
        log.error({ err, requestId }, 'Global pool vector search threw');
        publicMemory.searchAvailable = false;
      }
    }

    if (publicHydrationEnabled && prefetchedVectorResults?.length) {
      const globalCandidateIds = Array.from(
        new Set(prefetchedVectorResults.map((result) => result.id)),
      );
      const links = await prisma.candidateGlobalLink.findMany({
        where: {
          tenantId,
          globalCandidateId: { in: globalCandidateIds },
        },
        select: {
          globalCandidateId: true,
          candidateId: true,
        },
      });
      for (const link of links) {
        prefetchedLocalIdByGlobalId.set(
          link.globalCandidateId,
          link.candidateId,
        );
      }
    }

    const layer2Selection = selectTwoLayerCandidateIds({
      slimPool,
      slimBySlug: buildLayer1SlugIndex(slimPool),
      vectorResults: prefetchedVectorResults,
      resolvedVectorIdByGlobalId: prefetchedLocalIdByGlobalId,
      recentK: config.poolRecentK,
      fallbackHydrateCap: config.poolFallbackHydrateCap,
    });
    const layer2Ids = layer2Selection.ids;
    vectorLaneResolved = layer2Selection.vectorLaneResolved;
    recentLaneAdded = layer2Selection.recentLaneAdded;
    fallbackHydrateUsed = layer2Selection.fallbackHydrateUsed;

    poolRows = layer2Ids.size > 0 ? await fetchPoolByIds(Array.from(layer2Ids)) : [];
    log.info(
      {
        requestId,
        layer1Size: slimPool.length,
        layer1CapHit,
        layer2Size: poolRows.length,
        vectorLaneResolved,
        recentLaneAdded,
        fallbackHydrateUsed,
      },
      'Two-layer pool read',
    );
  } else {
    // Legacy single-layer read (capped at 5000 most recent, full-width).
    poolRows = await prisma.candidate.findMany({
      where: { tenantId },
      select: poolSelect,
      take: 5000,
      orderBy: { updatedAt: 'desc' },
    });
  }

  const poolById = new Map(poolRows.map((r) => [r.id, r]));
  log.info({ requestId, poolSize: poolRows.length }, 'Pool queried');

  const toRankingCandidate = (
    row: {
      id: string;
      headlineHint: string | null;
      seniorityHint: string | null;
      locationHint: string | null;
      searchTitle: string | null;
      searchSnippet: string | null;
      enrichmentStatus: string;
      lastEnrichedAt: Date | null;
      intelligenceSnapshots: Array<{
        track: string;
        skillsNormalized: string[];
        roleType: string | null;
        seniorityBand: string | null;
        location: string | null;
        activityRecencyDays: number | null;
        computedAt: Date;
        staleAfter: Date;
      }>;
      searchMeta: Prisma.JsonValue | null;
    },
  ): CandidateForRanking => {
    const latestTechSnap = row.intelligenceSnapshots.find((s) => s.track === 'tech') ?? null;
    const latestNonTechSnap = row.intelligenceSnapshots.find((s) => s.track === 'non-tech') ?? null;
    const selectedSnapshot = snapshotTrackFilter.length === 1
      ? (row.intelligenceSnapshots[0] ?? null)
      : (latestTechSnap ?? latestNonTechSnap);

    return {
      id: row.id,
      headlineHint: row.headlineHint,
      seniorityHint: row.seniorityHint,
      locationHint: row.locationHint,
      searchTitle: row.searchTitle,
      searchSnippet: row.searchSnippet,
      enrichmentStatus: row.enrichmentStatus,
      lastEnrichedAt: row.lastEnrichedAt,
      crustdata: (row.searchMeta as any)?.crustdata ?? null,
      snapshot: selectedSnapshot
        ? {
          skillsNormalized: selectedSnapshot.skillsNormalized,
          roleType: selectedSnapshot.roleType,
          seniorityBand: selectedSnapshot.seniorityBand,
          location: selectedSnapshot.location,
          activityRecencyDays: selectedSnapshot.activityRecencyDays ?? null,
          computedAt: selectedSnapshot.computedAt,
          staleAfter: selectedSnapshot.staleAfter,
        }
        : null,
    };
  };

  // 2. Rank pool candidates
  const poolForRanking: CandidateForRanking[] = poolRows.map((r) => toRankingCandidate(r));
  const poolForRankingById = new Map(poolForRanking.map((r) => [r.id, r]));
  const publicTemporaryCandidateById = new Map<
    string,
    GlobalPoolSearchResult
  >();
  const tenantPrivateCandidateByTemporaryId = new Map<
    string,
    {
      result: TenantPrivateSearchResult;
      linkedinUrl: string;
      linkedinId: string;
    }
  >();
  const tenantPrivateGlobalIdByRankingId = new Map<string, string>();
  const publicGlobalIdByIdentity = new Map<string, string>();
  const conflictedPublicIdentityKeys = new Set<string>();

  // 2.5 ActiveGraph Home Pool Search — vector search over the platform pool
  // (#29 slice 5). Legacy mode retains tag fallback. Public-v1 never falls
  // back to the tenant tag endpoint because that would silently change the
  // requested evidence surface.
  let addedFromHome = 0;
  let homeSearchMode:
    | 'public_vector'
    | 'public_unavailable'
    | 'vector'
    | 'tags'
    | 'off' = 'off';
  if (homePoolReadEnabled) {
    let vectorResults: Awaited<ReturnType<typeof searchGlobalPool>> = null;
    if (config.twoLayerPoolEnabled) {
      vectorResults = prefetchedVectorResults;
    } else {
      try {
        if (publicHydrationEnabled) {
          const response = await searchPublicGlobalPool(
            requirements,
            tenantId,
            HOME_POOL_LIMIT,
            requestId,
          );
          publicMemory.searchAvailable = response !== null;
          publicMemory.vectorReturned = response?.results.length ?? 0;
          vectorResults = response?.results ?? null;
        } else {
          vectorResults = await searchGlobalPool(
            requirements,
            tenantId,
            HOME_POOL_LIMIT,
            requestId,
          );
          publicMemory.searchAvailable = vectorResults !== null;
          publicMemory.vectorReturned = vectorResults?.length ?? 0;
        }
      } catch (err) {
        log.error({ err, requestId }, 'Global pool vector search threw');
        publicMemory.searchAvailable = false;
      }
    }

    if (vectorResults !== null) {
      homeSearchMode = publicHydrationEnabled ? 'public_vector' : 'vector';
      let skippedNoProfile = 0;
      let skippedNoLocalId = 0;
      if (publicHydrationEnabled) {
        const receipts = buildExpectedGlobalIdentityReceipts(vectorResults);
        for (const [key, globalCandidateId] of receipts.expectedByIdentity) {
          publicGlobalIdByIdentity.set(key, globalCandidateId);
        }
        for (const key of receipts.conflictedIdentityKeys) {
          conflictedPublicIdentityKeys.add(key);
        }
        publicMemory.identityReceiptConflicts =
          conflictedPublicIdentityKeys.size;
      }
      const globalCandidateIds = Array.from(
        new Set(vectorResults.map((result) => result.id)),
      );
      const localIdByGlobalId = new Map(prefetchedLocalIdByGlobalId);
      if (publicHydrationEnabled && !config.twoLayerPoolEnabled) {
        const links = await prisma.candidateGlobalLink.findMany({
          where: {
            tenantId,
            globalCandidateId: { in: globalCandidateIds },
          },
          select: {
            globalCandidateId: true,
            candidateId: true,
          },
        });
        for (const link of links) {
          localIdByGlobalId.set(link.globalCandidateId, link.candidateId);
        }
      }

      const urls = vectorResults.map((g) => g.linkedin_url).filter((u): u is string => !!u);
      const slugs = vectorResults.map((g) => g.linkedin_id).filter((s): s is string => !!s);
      const linkedLocalIds = Array.from(new Set(localIdByGlobalId.values()));
      const localRows = urls.length || slugs.length || linkedLocalIds.length
        ? await prisma.candidate.findMany({
            where: {
              tenantId,
              OR: [
                ...(linkedLocalIds.length ? [{ id: { in: linkedLocalIds } }] : []),
                ...(urls.length
                  ? [
                      {
                        linkedinUrl: {
                          in: urls,
                          mode: Prisma.QueryMode.insensitive,
                        },
                      },
                    ]
                  : []),
                ...(slugs.length
                  ? [
                      {
                        linkedinId: {
                          in: slugs,
                          mode: Prisma.QueryMode.insensitive,
                        },
                      },
                    ]
                  : []),
              ],
            },
            select: { id: true, linkedinId: true, linkedinUrl: true },
          })
        : [];
      const localBySlug = new Map<string, string>();
      for (const c of localRows) {
        if (c.linkedinId) localBySlug.set(c.linkedinId.toLowerCase(), c.id);
        if (c.linkedinUrl) {
          const slug = extractLinkedInIdFromUrl(c.linkedinUrl);
          if (slug) localBySlug.set(slug.toLowerCase(), c.id);
        }
      }
      const linkedinResolvedLinks: Array<{
        candidateId: string;
        globalCandidateId: string;
      }> = [];
      for (const gc of vectorResults) {
        const slug = (gc.linkedin_id || (gc.linkedin_url ? extractLinkedInIdFromUrl(gc.linkedin_url) : null) || '').toLowerCase();
        const linkedLocalId = publicHydrationEnabled
          ? localIdByGlobalId.get(gc.id) ?? null
          : null;
        const localId = linkedLocalId ?? (slug ? localBySlug.get(slug) ?? null : null);
        if (linkedLocalId) {
          publicMemory.resolvedByGlobalLink++;
        } else if (localId) {
          publicMemory.resolvedByLinkedin++;
          if (publicHydrationEnabled) {
            linkedinResolvedLinks.push({
              candidateId: localId,
              globalCandidateId: gc.id,
            });
          }
        }
        if (!localId) {
          if (
            publicHydrationEnabled &&
            gc.evidence_surface === 'public' &&
            gc.crustdata_profile
          ) {
            const temporaryId = makeGlobalTemporaryCandidateId(gc.id);
            const mappedCandidate: CandidateForRanking = {
              id: temporaryId,
              headlineHint:
                gc.headline ??
                gc.crustdata_profile.basic_profile?.headline ??
                null,
              seniorityHint: gc.seniority_band,
              locationHint:
                gc.location_city ??
                gc.crustdata_profile.basic_profile?.location?.full_location ??
                null,
              searchTitle:
                gc.crustdata_profile.basic_profile?.current_title ?? null,
              searchSnippet: null,
              enrichmentStatus: 'completed',
              lastEnrichedAt: null,
              crustdata: gc.crustdata_profile,
              semanticSimilarity: gc.similarity,
              // Public profile skills are not verified candidate evidence.
              // The ranker uses its neutral text fallback until this tenant
              // has its own verified snapshot.
              snapshot: null,
            };
            poolForRanking.push(mappedCandidate);
            poolForRankingById.set(temporaryId, mappedCandidate);
            publicTemporaryCandidateById.set(temporaryId, gc);
            publicMemory.temporaryCandidates++;
            addedFromHome++;
            continue;
          }
          skippedNoLocalId++;
          continue;
        }
        const alreadyPooled = poolForRankingById.get(localId);
        if (alreadyPooled) {
          if (Number.isFinite(gc.similarity)) {
            alreadyPooled.semanticSimilarity = Math.max(
              alreadyPooled.semanticSimilarity ?? Number.NEGATIVE_INFINITY,
              gc.similarity,
            );
          }
          // Legacy rows can carry tenant-private verified skills. Public-v1
          // rows never create a snapshot from public profile evidence.
          const carriesTenantPrivateEvidence = !publicHydrationEnabled;
          if (
            carriesTenantPrivateEvidence &&
            !alreadyPooled.snapshot &&
            (gc.skills_normalized?.length ||
              gc.role_family ||
              gc.seniority_band)
          ) {
            const now = new Date();
            alreadyPooled.snapshot = {
              skillsNormalized: gc.skills_normalized ?? [],
              roleType: gc.role_family,
              seniorityBand: gc.seniority_band,
              location: gc.location_city,
              computedAt: now,
              staleAfter: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            };
          }
          if (!alreadyPooled.crustdata && gc.crustdata_profile) {
            alreadyPooled.crustdata = gc.crustdata_profile;
          }
          continue;
        }
        if (!gc.crustdata_profile) {
          // No hydrated blob (cross-tenant public row) — the ranker would
          // floor it at fitScore 10. Deferred to #12 blob sharing.
          skippedNoProfile++;
          continue;
        }
        const now = new Date();
        const mappedCandidate: CandidateForRanking = {
          id: localId,
          headlineHint: gc.headline ?? gc.crustdata_profile?.basic_profile?.headline ?? null,
          locationHint: gc.location_city ?? gc.crustdata_profile?.basic_profile?.location?.full_location ?? null,
          searchTitle: gc.crustdata_profile?.basic_profile?.current_title ?? null,
          searchSnippet: null,
          enrichmentStatus: 'completed',
          lastEnrichedAt: now,
          crustdata: gc.crustdata_profile,
          semanticSimilarity: gc.similarity,
          snapshot: publicHydrationEnabled
            ? null
            : {
                skillsNormalized: gc.skills_normalized ?? [],
                roleType: gc.role_family,
                seniorityBand: gc.seniority_band,
                location: gc.location_city,
                computedAt: now,
                staleAfter: new Date(now.getTime() + 24 * 60 * 60 * 1000),
              },
        };
        poolForRanking.push(mappedCandidate);
        poolForRankingById.set(mappedCandidate.id, mappedCandidate);
        addedFromHome++;
      }
      for (let index = 0; index < linkedinResolvedLinks.length; index += 20) {
        const outcomes = await Promise.allSettled(
          linkedinResolvedLinks
            .slice(index, index + 20)
            .map((entry) =>
              ensureCandidateGlobalLink({
                tenantId,
                candidateId: entry.candidateId,
                globalCandidateId: entry.globalCandidateId,
                matchMethod: 'linkedin_id_exact',
                linkConfidence: 1,
              }),
            ),
        );
        for (const outcome of outcomes) {
          if (outcome.status === 'fulfilled') {
            publicMemory.linksRetained++;
          } else {
            publicMemory.linkFailures++;
          }
        }
      }
      log.info(
        { requestId, found: vectorResults.length, added: addedFromHome, skippedNoProfile, skippedNoLocalId },
        'Global pool vector search merged'
      );
    } else if (!publicHydrationEnabled) {
      // Fallback: legacy tag search.
      homeSearchMode = 'tags';
      const homeTags = generateTagsFromJD(requirements);
      let homeCandidates: any[] = [];
      try {
        const homeResult = await searchHomePool(homeTags, tenantId, HOME_POOL_LIMIT, requestId);
        if (homeResult === null) {
          log.warn({ requestId, tags: homeTags }, 'ActiveGraph home pool UNAVAILABLE — proceeding without it');
        } else {
          homeCandidates = homeResult;
          log.info({ requestId, tags: homeTags, found: homeCandidates.length }, 'ActiveGraph home pool searched (tags)');
        }
      } catch (err) {
        log.error({ err, requestId }, 'Failed to search ActiveGraph home pool');
      }
      for (const hc of homeCandidates) {
        if (!poolForRankingById.has(hc.signal_candidate_id)) {
          const mappedCandidate: CandidateForRanking = {
            id: hc.signal_candidate_id,
            headlineHint: hc.profile?.basic_profile?.headline ?? null,
            locationHint: hc.profile?.basic_profile?.location?.full_location ?? null,
            searchTitle: null,
            searchSnippet: null,
            enrichmentStatus: 'completed',
            lastEnrichedAt: new Date(),
            crustdata: hc.profile, // Map the full Crustdata blob for the ranker
            snapshot: null,
          };
          poolForRanking.push(mappedCandidate);
          poolForRankingById.set(mappedCandidate.id, mappedCandidate);
          addedFromHome++;
        }
      }
    } else {
      homeSearchMode = 'public_unavailable';
      log.warn(
        { requestId },
        'Public Memory vector search unavailable; continuing with the separate tenant-private tag lane',
      );
    }

    if (publicHydrationEnabled) {
      let privateResponse: Awaited<
        ReturnType<typeof searchTenantPrivateCandidates>
      > = null;
      try {
        privateResponse = await searchTenantPrivateCandidates(
          requirements,
          tenantId,
          HOME_POOL_LIMIT,
          requestId,
        );
      } catch (error) {
        log.error(
          { requestId, err: String(error) },
          'Tenant-private Memory search threw',
        );
      }
      publicMemory.privateSearchAvailable = privateResponse !== null;
      publicMemory.privateRetrieved = privateResponse?.results.length ?? 0;

      if (privateResponse?.results.length) {
        const prepared = privateResponse.results.flatMap((result) => {
          const candidate = buildTenantPrivateRankingCandidate(result);
          if (!candidate) {
            publicMemory.privateSkippedNoLinkedin++;
            return [];
          }
          return [{ result, ...candidate }];
        });
        const linkedinUrls = prepared.map(
          (candidate) => candidate.anchor.linkedinUrl,
        );
        const linkedinIds = prepared.map(
          (candidate) => candidate.anchor.linkedinId,
        );
        const privateRows =
          linkedinUrls.length || linkedinIds.length
            ? await prisma.candidate.findMany({
                where: {
                  tenantId,
                  OR: [
                    ...(linkedinUrls.length
                      ? [
                          {
                            linkedinUrl: {
                              in: linkedinUrls,
                              mode: Prisma.QueryMode.insensitive,
                            },
                          },
                        ]
                      : []),
                    ...(linkedinIds.length
                      ? [
                          {
                            linkedinId: {
                              in: linkedinIds,
                              mode: Prisma.QueryMode.insensitive,
                            },
                          },
                        ]
                      : []),
                  ],
                },
                select: poolSelect,
              })
            : [];
        const privateRowBySlug = new Map<string, (typeof privateRows)[number]>();
        for (const row of privateRows) {
          privateRowBySlug.set(row.linkedinId.toLowerCase(), row);
          if (row.linkedinUrl) {
            const slug = extractLinkedInIdFromUrl(row.linkedinUrl);
            if (slug) privateRowBySlug.set(slug.toLowerCase(), row);
          }
        }

        for (const candidate of prepared) {
          const slugKey = candidate.anchor.linkedinId.toLowerCase();
          const localRow = privateRowBySlug.get(slugKey);
          const rankingId =
            localRow?.id ??
            makeTenantPrivateTemporaryId(candidate.result.candidateId);
          const existing = poolForRankingById.get(rankingId);
          if (existing) {
            mergeTenantPrivateEvidence(existing, candidate.result);
          } else if (localRow) {
            const mapped = mergeTenantPrivateEvidence(
              toRankingCandidate(localRow),
              candidate.result,
            );
            poolForRanking.push(mapped);
            poolForRankingById.set(mapped.id, mapped);
            addedFromHome++;
          } else {
            poolForRanking.push(candidate.rankingCandidate);
            poolForRankingById.set(
              candidate.rankingCandidate.id,
              candidate.rankingCandidate,
            );
            tenantPrivateCandidateByTemporaryId.set(
              candidate.rankingCandidate.id,
              {
                result: candidate.result,
                linkedinUrl: candidate.anchor.linkedinUrl,
                linkedinId: candidate.anchor.linkedinId,
              },
            );
            addedFromHome++;
          }
          if (candidate.result.globalCandidateId) {
            tenantPrivateGlobalIdByRankingId.set(
              rankingId,
              candidate.result.globalCandidateId,
            );
          }
        }
      }
    }
  } else {
    log.info(
      { requestId },
      'ActiveGraph home pool disabled (legacy and public hydration flags are false)',
    );
  }
  publicMemory.platformExclusionActive =
    canApplyPlatformPublicExclusions({
      excludeKnownEnabled: config.excludeKnownEnabled,
      publicMemoryHydrationEnabled:
        config.publicMemoryHydrationEnabled,
      platformExclusionEnabled: config.platformExclusionEnabled,
      publicSearchAvailable: publicMemory.searchAvailable,
    });
  log.info({ requestId, addedFromHome, homeSearchMode, totalPool: poolForRanking.length }, 'Merged ActiveGraph candidates into ranking pool');

  const materializedPublicLocalIds = new Set<string>();
  const materializedPrivateLocalIds = new Set<string>();
  const materializeServedPublicCandidates = async (
    candidateIds: string[],
  ): Promise<Map<string, string>> => {
    const temporaryIds = Array.from(
      new Set(
        candidateIds.filter((candidateId) =>
          publicTemporaryCandidateById.has(candidateId),
        ),
      ),
    );
    if (temporaryIds.length === 0) return new Map();

    const entries: PublicMemoryMaterializationEntry[] = [];
    const preparationFailures: PublicMemoryMaterializationFailure[] = [];
    for (const temporaryId of temporaryIds) {
      const result = publicTemporaryCandidateById.get(temporaryId);
      const rankedCandidate = poolForRankingById.get(temporaryId);
      const publicProfile =
        rankedCandidate?.crustdata ?? result?.crustdata_profile ?? null;
      if (!result || !publicProfile) {
        preparationFailures.push({
          globalCandidateId:
            result?.id ?? parseGlobalTemporaryCandidateId(temporaryId),
          code: 'missing_public_profile',
        });
        continue;
      }
      const linkedinUrl =
        result.linkedin_url ??
        publicProfile.social_handles
          ?.professional_network_identifier?.profile_url ??
        null;
      const linkedinId =
        result.linkedin_id ??
        (linkedinUrl ? extractLinkedInIdFromUrl(linkedinUrl) : null);
      if (!linkedinUrl || !linkedinId) {
        preparationFailures.push({
          globalCandidateId: result.id,
          code: 'missing_linkedin_anchor',
        });
        continue;
      }
      entries.push({
        temporaryId,
        globalCandidateId: result.id,
        profile: {
          title:
            publicProfile.basic_profile?.current_title ??
            rankedCandidate?.searchTitle ??
            result.headline ??
            '',
          snippet:
            rankedCandidate?.searchSnippet ?? result.headline ?? '',
          linkedinUrl,
          linkedinId,
          canonicalLinkedinId: linkedinId,
          name:
            result.name ??
            publicProfile.basic_profile?.name ??
            undefined,
          headline:
            rankedCandidate?.headlineHint ??
            result.headline ??
            publicProfile.basic_profile?.headline ??
            undefined,
          location:
            rankedCandidate?.locationHint ??
            publicProfile.basic_profile?.location?.full_location ??
            result.location_city ??
            undefined,
          crustdata: publicProfile,
          providerMeta: {
            publicMemory: {
              surface: 'public_v1',
              globalCandidateId: result.id,
            },
          },
        },
      });
    }

    const materialization = await materializePublicMemoryCandidates({
      tenantId,
      entries,
    });
    const failures = [
      ...preparationFailures,
      ...materialization.failures,
    ];
    for (
      const candidateId of
      materialization.materializedByTemporaryId.values()
    ) {
      materializedPublicLocalIds.add(candidateId);
    }
    publicMemory.materializedCandidates +=
      materialization.materializedByTemporaryId.size;
    publicMemory.materializationRaceWins += materialization.raceWins;
    publicMemory.linksRetained +=
      materialization.materializedByTemporaryId.size;
    publicMemory.linkFailures += failures.filter(
      (failure) => failure.code === 'global_link_failed',
    ).length;

    if (failures.length > 0) {
      publicMemory.materializationFailures += failures.length;
      const remainingDetailCapacity =
        MAX_MATERIALIZATION_FAILURE_DETAILS -
        publicMemory.materializationFailureDetails.length;
      if (remainingDetailCapacity > 0) {
        publicMemory.materializationFailureDetails.push(
          ...failures.slice(0, remainingDetailCapacity),
        );
      }
      log.warn(
        {
          requestId,
          failureCount: failures.length,
          failureCodes: failures.reduce<Record<string, number>>(
            (counts, failure) => ({
              ...counts,
              [failure.code]: (counts[failure.code] ?? 0) + 1,
            }),
            {},
          ),
        },
        'Skipped public Memory candidates that could not be materialized',
      );
    }
    return materialization.materializedByTemporaryId;
  };

  const materializeServedTenantPrivateCandidates = async (
    candidateIds: string[],
  ): Promise<Map<string, string>> => {
    const uniqueCandidateIds = Array.from(new Set(candidateIds));
    const temporaryEntries = uniqueCandidateIds.flatMap((candidateId) => {
      const entry = tenantPrivateCandidateByTemporaryId.get(candidateId);
      return entry ? [{ temporaryId: candidateId, ...entry }] : [];
    });
    const replacements = new Map<string, string>();

    if (temporaryEntries.length > 0) {
      const { upsertDiscoveredCandidates } = await import(
        './upsert-candidates'
      );
      const profiles = temporaryEntries.map((entry) => ({
        title: entry.result.headline ?? '',
        snippet: '',
        linkedinUrl: entry.linkedinUrl,
        linkedinId: entry.linkedinId,
        canonicalLinkedinId: entry.linkedinId,
        name: entry.result.displayName ?? undefined,
        headline: entry.result.headline ?? undefined,
        location: entry.result.locationRaw ?? undefined,
        providerMeta: {
          activegraphPrivate: {
            evidenceSurface: 'tenant_private_v1',
            sourceCandidateId: entry.result.candidateId,
            globalCandidateId: entry.result.globalCandidateId,
          },
        },
      }));
      const candidateMap = await upsertDiscoveredCandidates(
        tenantId,
        profiles,
        'tenant_private_memory',
        'activegraph_private',
        {
          captureSource: 'activegraph_private',
          preserveExistingProvenance: true,
        },
      );
      for (const entry of temporaryEntries) {
        const candidateId = candidateMap.get(entry.linkedinId);
        if (!candidateId) {
          throw new Error(
            `Failed to materialize tenant-private Memory candidate ${entry.temporaryId}`,
          );
        }
        replacements.set(entry.temporaryId, candidateId);
        materializedPrivateLocalIds.add(candidateId);
        publicMemory.privateMaterialized++;
        const rankingCandidate = poolForRankingById.get(entry.temporaryId);
        if (rankingCandidate) {
          poolForRankingById.set(candidateId, rankingCandidate);
        }
      }
    }

    for (const originalCandidateId of uniqueCandidateIds) {
      const candidateId =
        replacements.get(originalCandidateId) ?? originalCandidateId;
      const globalCandidateId =
        tenantPrivateGlobalIdByRankingId.get(originalCandidateId);
      if (!globalCandidateId) continue;
      const link = await ensureCandidateGlobalLink({
        tenantId,
        candidateId,
        globalCandidateId,
        matchMethod: 'tenant_private_global_id',
        linkConfidence: 1,
      });
      if (link.candidateId !== candidateId) {
        replacements.set(originalCandidateId, link.candidateId);
      }
      materializedPrivateLocalIds.add(link.candidateId);
      publicMemory.linksRetained++;
      if (link.raceResolved) publicMemory.materializationRaceWins++;
    }
    return replacements;
  };

  const hasLocationConstraint = Boolean(requirements.location?.trim());
  const requestedCountryCode = config.countryGuardEnabled && hasLocationConstraint
    ? deriveCountryCodeFromLocationText(requirements.location)
    : null;

  // Role resolution: batch-resolve pool candidates (shadow or active)
  let roleResolutionMetrics: RoleResolutionMetrics | null = null;
  const roleResolutionAggregate = {
    total: 0,
    deterministicResolved: 0,
    cacheResolved: 0,
  };
  const mergeRoleResolutionMetrics = (batch: RoleResolutionMetrics): void => {
    const batchTotal = batch.confidenceDistribution.high +
      batch.confidenceDistribution.medium +
      batch.confidenceDistribution.low;
    roleResolutionAggregate.total += batchTotal;
    roleResolutionAggregate.deterministicResolved += batch.deterministicHitRate * batchTotal;
    roleResolutionAggregate.cacheResolved += batch.cacheHitRate * batchTotal;

    if (roleResolutionMetrics) {
      roleResolutionMetrics.llmCallCount += batch.llmCallCount;
      roleResolutionMetrics.llmEligibleCount += batch.llmEligibleCount;
      roleResolutionMetrics.unknownCount += batch.unknownCount;
      roleResolutionMetrics.fallbackCount += batch.fallbackCount;
      roleResolutionMetrics.confidenceDistribution.high += batch.confidenceDistribution.high;
      roleResolutionMetrics.confidenceDistribution.medium += batch.confidenceDistribution.medium;
      roleResolutionMetrics.confidenceDistribution.low += batch.confidenceDistribution.low;
      roleResolutionMetrics.promotionDelta.wouldPromote += batch.promotionDelta.wouldPromote;
      roleResolutionMetrics.promotionDelta.wouldBlock += batch.promotionDelta.wouldBlock;
    } else {
      roleResolutionMetrics = {
        deterministicHitRate: 0,
        cacheHitRate: 0,
        llmCallCount: batch.llmCallCount,
        llmEligibleCount: batch.llmEligibleCount,
        unknownCount: batch.unknownCount,
        fallbackCount: batch.fallbackCount,
        confidenceDistribution: { ...batch.confidenceDistribution },
        promotionDelta: { ...batch.promotionDelta },
      };
    }

    if (roleResolutionMetrics && roleResolutionAggregate.total > 0) {
      roleResolutionMetrics.deterministicHitRate = Number(
        (roleResolutionAggregate.deterministicResolved / roleResolutionAggregate.total).toFixed(4),
      );
      roleResolutionMetrics.cacheHitRate = Number(
        (roleResolutionAggregate.cacheResolved / roleResolutionAggregate.total).toFixed(4),
      );
      roleResolutionMetrics.promotionDelta.wouldPromoteRate = Number(
        (roleResolutionMetrics.promotionDelta.wouldPromote / roleResolutionAggregate.total).toFixed(4),
      );
      roleResolutionMetrics.promotionDelta.wouldBlockRate = Number(
        (roleResolutionMetrics.promotionDelta.wouldBlock / roleResolutionAggregate.total).toFixed(4),
      );
    }
  };
  let poolPreResolvedRoles: Map<string, RoleResolution> | undefined;
  let locationResolutionMetrics: LocationResolutionMetrics | null = null;
  const locationResolutionAggregate = {
    total: 0,
    deterministicResolved: 0,
    cacheResolved: 0,
  };
  const mergeLocationResolutionMetrics = (batch: LocationResolutionMetrics): void => {
    const batchTotal = batch.confidenceDistribution.high +
      batch.confidenceDistribution.medium +
      batch.confidenceDistribution.low;
    locationResolutionAggregate.total += batchTotal;
    locationResolutionAggregate.deterministicResolved += batch.deterministicHitRate * batchTotal;
    locationResolutionAggregate.cacheResolved += batch.cacheHitRate * batchTotal;

    if (locationResolutionMetrics) {
      locationResolutionMetrics.llmCallCount += batch.llmCallCount;
      locationResolutionMetrics.llmEligibleCount += batch.llmEligibleCount;
      locationResolutionMetrics.skippedLlmCount += batch.skippedLlmCount;
      locationResolutionMetrics.unknownCount += batch.unknownCount;
      locationResolutionMetrics.confidenceDistribution.high += batch.confidenceDistribution.high;
      locationResolutionMetrics.confidenceDistribution.medium += batch.confidenceDistribution.medium;
      locationResolutionMetrics.confidenceDistribution.low += batch.confidenceDistribution.low;
    } else {
      locationResolutionMetrics = {
        deterministicHitRate: 0,
        cacheHitRate: 0,
        llmCallCount: batch.llmCallCount,
        llmEligibleCount: batch.llmEligibleCount,
        skippedLlmCount: batch.skippedLlmCount,
        unknownCount: batch.unknownCount,
        confidenceDistribution: { ...batch.confidenceDistribution },
      };
    }

    if (locationResolutionMetrics && locationResolutionAggregate.total > 0) {
      locationResolutionMetrics.deterministicHitRate = Number(
        (locationResolutionAggregate.deterministicResolved / locationResolutionAggregate.total).toFixed(4),
      );
      locationResolutionMetrics.cacheHitRate = Number(
        (locationResolutionAggregate.cacheResolved / locationResolutionAggregate.total).toFixed(4),
      );
    }
  };
  let poolPreResolvedLocations: Map<string, LocationResolution> | undefined;
  if (config.roleGroqEnabled) {
    const poolEntries: RoleBatchEntry[] = poolForRanking.map((c) => ({
      key: c.id,
      title: c.headlineHint ?? c.searchTitle ?? '',
      context: [c.headlineHint, c.searchTitle, c.searchSnippet].filter(Boolean).join(' '),
    }));
    const batchResult = await resolveRolesBatch(poolEntries);
    mergeRoleResolutionMetrics(batchResult.metrics);

    // Active mode: pass pre-resolved roles to ranking
    // Shadow mode: log only, do NOT influence ranking
    if (!config.roleGroqShadowMode) {
      poolPreResolvedRoles = batchResult.resolutions;
    }
    log.info(
      { requestId, mode: config.roleGroqShadowMode ? 'shadow' : 'active', ...batchResult.metrics },
      'Role batch resolution complete (pool)',
    );
  }

  if (config.locationGroqEnabled) {
    const poolLocationEntries: LocationBatchEntry[] = poolForRanking.map((c) => ({
      key: c.id,
      location: c.snapshot?.location ?? c.locationHint,
      context: [c.headlineHint, c.searchTitle, c.searchSnippet, requirements.location].filter(Boolean).join(' '),
    }));
    const batchResult = await resolveLocationsBatch(poolLocationEntries);
    mergeLocationResolutionMetrics(batchResult.metrics);

    if (!config.locationGroqShadowMode) {
      poolPreResolvedLocations = batchResult.resolutions;
    }
    log.info(
      { requestId, mode: config.locationGroqShadowMode ? 'shadow' : 'active', ...batchResult.metrics },
      'Location batch resolution complete (pool)',
    );
  }

  const scoredPoolRaw = rankCandidates(poolForRanking, requirements, {
    fitScoreEpsilon: config.fitScoreEpsilon,
    track: trackDecision?.track,
    semanticSimilarityWeight: config.semanticSimilarityWeight,
  });
  const countryGuardFilteredCandidateIds = new Set<string>();
  let countryGuardSerpLocaleSkippedCount = 0;
  const countryGuardEscapeCounts = { no_location: 0, country_match: 0, city_only_unknown_country: 0 };
  let scoredPool = scoredPoolRaw;
  let unknownLocationPoolPenaltyApplied = 0;
  if (trackDecision?.track !== 'non_tech') {
    for (const sc of scoredPool) {
      if (
        sc.locationMatchType === 'unknown_location' &&
        !(sc.fitScore >= 60 && sc.fitBreakdown.roleScore >= 10.5)
      ) {
        sc.fitScore *= config.unknownLocationPenaltyMultiplier;
        unknownLocationPoolPenaltyApplied++;
      }
    }
    if (unknownLocationPoolPenaltyApplied > 0) {
      scoredPool = orderByFitScoreWithConfidence(scoredPool, config.fitScoreEpsilon);
    }
  }
  let nonTechLocationMismatchPenaltyApplied = 0;
  if (trackDecision?.track === 'non_tech' && hasLocationConstraint) {
    for (const sc of scoredPool) {
      if (sc.locationMatchType === 'none') {
        sc.fitScore *= config.nonTechLocationMismatchPenaltyMultiplier;
        nonTechLocationMismatchPenaltyApplied++;
      }
    }
    if (nonTechLocationMismatchPenaltyApplied > 0) {
      scoredPool = orderByFitScoreWithConfidence(scoredPool, config.fitScoreEpsilon);
    }
  }
  if (requestedCountryCode) {
    scoredPool = scoredPool.filter((sc) => {
      const poolCandidate = poolForRankingById.get(sc.candidateId);
      const poolRow = poolById.get(sc.candidateId);
      const candidateLocation = poolCandidate?.snapshot?.location ?? poolCandidate?.locationHint ?? null;
      const locationCountryCode = deriveCountryCodeFromLocationText(candidateLocation);
      // TODO(Phase 3b): consolidate via computeSerpEvidence(). See serp-signals.ts.
      const serpLocaleCountryCode = extractSerpSignals(poolRow?.searchMeta).localeCountryCode;

      if (locationCountryCode && locationCountryCode !== requestedCountryCode) {
        countryGuardFilteredCandidateIds.add(sc.candidateId);
        return false;
      }

      if (!locationCountryCode && serpLocaleCountryCode && serpLocaleCountryCode !== requestedCountryCode) {
        if (config.countryGuardSerpLocaleEnabled) {
          countryGuardFilteredCandidateIds.add(sc.candidateId);
          return false;
        }
        countryGuardSerpLocaleSkippedCount++;
      }

      // Track why candidate escaped the guard
      if (!candidateLocation) {
        countryGuardEscapeCounts.no_location++;
      } else if (locationCountryCode === requestedCountryCode) {
        countryGuardEscapeCounts.country_match++;
      } else if (!locationCountryCode) {
        countryGuardEscapeCounts.city_only_unknown_country++;
      }

      return true;
    });
  }
  let countryGuardFilteredCount = countryGuardFilteredCandidateIds.size;
  if (countryGuardFilteredCount > 0 || countryGuardEscapeCounts.city_only_unknown_country > 0) {
    log.info(
      {
        requestId,
        requestedCountryCode,
        countryGuardFilteredCount,
        countryGuardEscapeCounts,
      },
      'Country guard filtered pool candidates',
    );
  }

  function hasMeaningfulLocation(loc: string | null | undefined): boolean {
    if (!isMeaningfulLocation(loc)) return false;
    if (isNoisyLocationHint(loc!)) return false;
    return true;
  }

  // Pre-assembly location coverage estimate. Two-layer: computed over the FULL
  // slim pool — the Layer-2 vector selection biases toward text-rich rows, so
  // measuring coverage on the ranked subset would overstate it. Layer 1 only
  // carries locationHint (snapshot-only locations count as uncovered); the
  // prod verification run compares this against the legacy value.
  const poolLocationCoverage = config.twoLayerPoolEnabled
    ? (slimPool.length > 0
      ? slimPool.filter((r) => hasMeaningfulLocation(r.locationHint)).length / slimPool.length
      : 0)
    : (scoredPool.length > 0
      ? scoredPool.filter((sc) => {
        const poolCandidate = poolForRankingById.get(sc.candidateId);
        return hasMeaningfulLocation(poolCandidate?.snapshot?.location) ||
          hasMeaningfulLocation(poolCandidate?.locationHint);
      }).length / scoredPool.length
      : 0);
  const locationCoverageTriggered = hasLocationConstraint && poolLocationCoverage < config.locationCoverageFloor;

  const topK = scoredPool.slice(0, Math.min(scoredPool.length, config.qualityTopK));
  const avgFitTopK = topK.length > 0
    ? topK.reduce((sum, row) => sum + row.fitScore, 0) / topK.length
    : 0;
  const countAboveThreshold = topK.filter((row) => row.fitScore >= config.qualityThreshold).length;
  const strictTopKCount = topK.filter((row) => row.matchTier === 'strict_location').length;
  const strictCoverageRate = topK.length > 0 ? strictTopKCount / topK.length : 0;
  const strictCoverageFloor = hasLocationConstraint
    ? Math.ceil(config.qualityTopK * (config.minStrictMatchesBeforeExpand / Math.max(1, config.targetCount)))
    : 0;
  const strictCoverageTriggered = hasLocationConstraint && topK.length > 0 && strictTopKCount < Math.min(topK.length, strictCoverageFloor);
  const minCountAboveRequired = Math.min(config.qualityMinCountAbove, topK.length);
  const qualityGateTriggered =
    topK.length === 0 ||
    avgFitTopK < config.qualityMinAvgFit ||
    countAboveThreshold < minCountAboveRequired ||
    strictCoverageTriggered ||
    locationCoverageTriggered;

  // 3. Discovery decision (deficit and/or low quality)

  // Compute pool role-match quality for non-tech/blended track
  let poolRoleMismatchRate = 0;
  if (trackDecision?.track !== 'tech' && requirements.roleFamily) {
    const topPoolForRole = scoredPool.slice(0, Math.min(scoredPool.length, config.qualityTopK));
    const neutralOrMismatch = topPoolForRole.filter(sc => sc.fitBreakdown.roleScore <= 0.3).length;
    poolRoleMismatchRate = topPoolForRole.length > 0 ? neutralOrMismatch / topPoolForRole.length : 1;
  }

  // Resolve effective sourcing strategy
  const effectiveStrategy = config.sourcingStrategy === 'adaptive'
    ? (trackDecision?.track !== 'tech' ? 'discovery_first' : 'pool_first')
    : config.sourcingStrategy;

  let discoveredCount = 0;
  let discoveredCandidateIds: string[] = [];
  let discoveredReservedInOutput = 0;
  let discoveredPromotedCount = 0;
  let discoveredPromotedInTopCount = 0;
  let unknownLocationPromotedCount = 0;
  let unknownLocationPenaltyApplied = 0;
  const unknownLocationPromotedIds = new Set<string>();
  const promotedDiscoveredById = new Map<string, ScoredCandidate>();
  const discoveredPromotionRejections = {
    total: 0, locationGate: 0, fitGate: 0, roleGate: 0,
    confidence: 0, phase: 0, unknownCap: 0,
  };
  let discoveredDeferredFromFrontLoad = 0;
  const scoredDiscoveredById = new Map<string, ScoredCandidate>();
  const discoveredRowsById = new Map<string, {
    id: string;
    enrichmentStatus: string;
    locationHint: string | null;
    searchMeta: Prisma.JsonValue | null;
  }>();
  let discoveryTarget = 0;
  let queriesExecuted = 0;
  let discoveryReason: OrchestratorResult['discoveryReason'] = null;
  let discoverySkippedReason: OrchestratorResult['discoverySkippedReason'] = null;
  let discoveryTelemetry: DiscoveryTelemetry | null = null;

  // Two-layer: discovery sizing uses the Layer-1 ELIGIBLE count — the full
  // pool minus rows the country guard would reject (same derivation as the
  // scored-candidate guard above, minus snapshot locations which Layer 1
  // doesn't carry). Using the ranked subset's length here would report a
  // near-constant ~450 "pool" and over-trigger the deficit as Memory grows.
  const layer1EligibleCount = config.twoLayerPoolEnabled
    ? slimPool.filter((r) => {
      if (!requestedCountryCode) return true;
      const cc = deriveCountryCodeFromLocationText(r.locationHint);
      if (cc) return cc === requestedCountryCode;
      if (config.countryGuardSerpLocaleEnabled) {
        const serpCc = extractSerpSignals(r.serper != null ? { serper: r.serper } : null).localeCountryCode;
        if (serpCc && serpCc !== requestedCountryCode) return false;
      }
      return true;
    }).length
    : 0;
  const poolSize = config.twoLayerPoolEnabled ? layer1EligibleCount : scoredPool.length;
  const poolDeficit = Math.max(0, config.targetCount - poolSize);

  // Built lazily at the result sites — freshSurvivorRefreshes mutates later.
  const buildTwoLayerTelemetry = (): OrchestratorResult['twoLayerPool'] =>
    config.twoLayerPoolEnabled
      ? {
        enabled: true,
        layer1Size: slimPool.length,
        layer1CapHit,
        layer1EligibleCount,
        layer2Size: poolRows.length,
        vectorLaneResolved,
        recentLaneAdded,
        fallbackHydrateUsed,
        freshSurvivorRefreshes,
      }
      : null;
  const strictPoolCount = scoredPool.filter((sc) => sc.matchTier === 'strict_location').length;
  const strictCoverageDeficit = hasLocationConstraint
    ? Math.max(0, config.minStrictMatchesBeforeExpand - strictPoolCount)
    : 0;
  // Elevated discovery share when quality gate or pool role mismatch triggers
  const roleMismatchTriggered = poolRoleMismatchRate > 0.8;
  const qualityDrivenTarget = (qualityGateTriggered || roleMismatchTriggered)
    ? Math.ceil(config.targetCount * config.minDiscoveryShareLowQuality)
    : 0;
  const maxDiscoveryTarget = Math.ceil(config.targetCount * config.maxDiscoveryShare);
  const minDiscoveryFloor = Math.min(config.minDiscoveryPerRun, maxDiscoveryTarget);

  let desiredDiscoveryTarget: number;
  if (effectiveStrategy === 'discovery_first') {
    // Discovery-first: always run discovery with full budget
    desiredDiscoveryTarget = maxDiscoveryTarget;
    discoveryReason = 'strategy_discovery_first';
  } else {
    // Pool-first: discovery driven by quality gates and deficits
    desiredDiscoveryTarget = Math.min(
      Math.max(poolDeficit, qualityDrivenTarget, strictCoverageDeficit, minDiscoveryFloor),
      maxDiscoveryTarget,
    );
    if (poolDeficit > 0 && qualityGateTriggered) discoveryReason = 'deficit_and_low_quality';
    else if (poolDeficit > 0 && roleMismatchTriggered) discoveryReason = 'deficit_and_role_mismatch';
    else if (poolDeficit > 0) discoveryReason = 'pool_deficit';
    else if (roleMismatchTriggered) discoveryReason = 'pool_role_mismatch';
    else if (qualityGateTriggered) discoveryReason = 'low_quality_pool';
    else if (minDiscoveryFloor > 0) discoveryReason = 'minimum_discovery_floor';
  }

  const effectiveMaxQueries = (qualityGateTriggered || effectiveStrategy === 'discovery_first')
    ? config.maxSerpQueries * config.dynamicQueryMultiplier
    : config.maxSerpQueries;
  let dynamicQueryBudgetUsed = false;

  if (desiredDiscoveryTarget > 0) {
    discoveryTarget = desiredDiscoveryTarget;
    dynamicQueryBudgetUsed =
      (qualityGateTriggered || effectiveStrategy === 'discovery_first') &&
      config.dynamicQueryMultiplier > 1;
    const budget = await getDiscoveryQueryBudget(
      tenantId,
      effectiveMaxQueries,
      config.dailySerpCapPerTenant,
    );

    if (!budget.allowed || budget.maxQueries <= 0) {
      discoverySkippedReason = budget.skippedReason;
      log.warn(
        {
          requestId,
          tenantId,
          discoveryReason,
          dailyCap: config.dailySerpCapPerTenant,
          discoverySkippedReason,
        },
        'Discovery skipped by spend guard',
      );
    } else {
      // Two-layer: dedup set from Layer 1 — complete at any pool size. The
      // hydrated poolRows subset would let discovery re-buy pool members.
      const existingLinkedinIds = config.twoLayerPoolEnabled
        ? new Set(slimPool.map((r) => r.linkedinId))
        : new Set(poolRows.map((r) => r.linkedinId));
      log.info(
        {
          requestId,
          poolSize,
          poolDeficit,
          qualityGateTriggered,
          avgFitTopK: Number(avgFitTopK.toFixed(3)),
          countAboveThreshold,
          minCountAboveRequired,
          discoveryReason,
          discoveryTarget,
          maxQueries: budget.maxQueries,
        },
        'Starting discovery',
      );

      let usedQueries = 0;
      try {
        let discovery: any = null;
        let crustDataSucceeded = false;
        // Enrichment candidates: primary top 100 + ordered reserve list
        let crustdataPrimaryList: any[] = [];
        let crustdataReserveList: any[] = [];
        let eligibleSourceEntries: Array<{ sourceType: CandidateSourceType; fitScore: number | null }> = [];
        let relaxationLadder: OrchestratorResult['relaxationLadder'] = null;
        let crustdataAcquisition: OrchestratorResult['crustdataAcquisition'] = null;
        let exactAcquisition: AcquiredCrustdataSearch | null = null;

        try {
          console.log('\n' + '🔍'.repeat(20));
          console.log('🚀 [ORCHESTRATOR] INITIATING PRIMARY DISCOVERY (CRUSTDATA /person/search, 300 profiles → rank locally → top 100)');
          await sendProgressCallback('crustdata_fetching');

          // ── Stage-2 exclusion: don't re-buy people refreshed recently. ─────
          // /person/search returns the lowest-person_id slice, so without this
          // every run re-purchases the same ~34% known overlap. Excluding only
          // FRESH-known people (updatedAt within excludeKnownFreshDays) means
          // 9 credits buy NEW people, while stale-known people deliberately
          // cycle back in and get their blobs refreshed (Stage-1 convergence).
          let cachedLocalPublicExclusions: number[] | null = null;
          const loadLocalPublicExclusions = async (): Promise<number[]> => {
            if (cachedLocalPublicExclusions) {
              return cachedLocalPublicExclusions;
            }
            const cutoff = new Date(
              Date.now() -
                config.excludeKnownFreshDays * 24 * 60 * 60 * 1000,
            );
            const rows = await prisma.$queryRaw<{ pid: string | null }[]>`
              SELECT ("searchMeta"->'crustdata'->>'crustdata_person_id') AS pid
              FROM candidates
              WHERE "tenantId" = ${tenantId}
                AND (
                  ("captureSource" = 'sourcing' AND "searchProvider" = 'crustdata')
                  OR "searchProvider" = 'activegraph_public'
                )
                AND "updatedAt" > ${cutoff}
                AND ("searchMeta"->'crustdata'->>'crustdata_person_id') IS NOT NULL
              ORDER BY "updatedAt" DESC
              LIMIT ${config.excludeKnownMax}
            `;
            cachedLocalPublicExclusions = rows
              .map((row) => Number(row.pid))
              .filter(
                (personId) =>
                  Number.isSafeInteger(personId) && personId > 0,
              );
            return cachedLocalPublicExclusions;
          };
          const loadMarketDeliveryLagExclusions = async (
            marketKeys: string[],
          ): Promise<number[]> => {
            if (marketKeys.length === 0) return [];
            const cutoff = new Date(
              Date.now() -
                config.excludeKnownFreshDays * 24 * 60 * 60 * 1000,
            );
            const rows = await prisma.$queryRaw<{ pid: string | null }[]>`
              SELECT DISTINCT
                COALESCE(
                  outbox."payload"->'candidate'->'crustdata'
                    ->>'crustdata_person_id',
                  outbox."payload"->'deliveryLag'
                    ->>'crustdataPersonId'
                ) AS pid
              FROM "public_memory_ingest_outbox" AS outbox
              WHERE outbox."status" IN ('pending', 'processing', 'succeeded')
                AND outbox."updatedAt" > ${cutoff}
                AND (
                  COALESCE(
                    outbox."payload"->'options'->'publicMarket'
                      ->>'coarseMarketKey',
                    outbox."payload"->'deliveryLag'
                      ->>'coarseMarketKey'
                  )
                ) = ANY(${marketKeys}::text[])
                AND COALESCE(
                  outbox."payload"->'candidate'->'crustdata'
                    ->>'crustdata_person_id',
                  outbox."payload"->'deliveryLag'
                    ->>'crustdataPersonId'
                ) IS NOT NULL
              ORDER BY pid
              LIMIT ${config.excludeKnownMax}
            `;
            return rows
              .map((row) => Number(row.pid))
              .filter(
                (personId) =>
                  Number.isSafeInteger(personId) && personId > 0,
              );
          };

          const resolvePublicExclusions = async (
            markets: PublicMarket[],
          ): Promise<{
            ids: number[];
            telemetry: PublicMemoryExclusionTelemetry;
            memory: PublicMarketExclusionResponse[];
          }> => {
            const marketKeys = markets.map((market) => market.coarseMarketKey);
            if (!config.excludeKnownEnabled) {
              return {
                ids: [],
                memory: [],
                telemetry: {
                  marketKeys,
                  source: 'off',
                  count: 0,
                  totalMatched: null,
                  classifiedMatched: null,
                  unclassifiedMatched: null,
                  unclassifiedReturned: null,
                  truncated: null,
                },
              };
            }

            if (
              publicMemory.platformExclusionActive &&
              markets.length > 0
            ) {
              const memory: PublicMarketExclusionResponse[] = [];
              for (const market of markets) {
                const response = await getPublicMarketExclusions(
                  tenantId,
                  market,
                  config.excludeKnownFreshDays,
                  config.excludeKnownMax,
                  requestId,
                );
                if (!response) {
                  memory.length = 0;
                  break;
                }
                memory.push(response);
              }
              if (memory.length === markets.length) {
                const localLagIds =
                  await loadMarketDeliveryLagExclusions(marketKeys);
                const memoryIds = memory.flatMap(
                  (response) => response.crustdataPersonIds,
                );
                const ids = mergePublicExclusionIds(
                  memoryIds,
                  localLagIds,
                  config.excludeKnownMax,
                );
                return {
                  ids,
                  memory,
                  telemetry: {
                    marketKeys,
                    source:
                      localLagIds.length > 0
                        ? 'memory_public_plus_local'
                        : 'memory_public',
                    count: ids.length,
                    totalMatched: memory.reduce(
                      (total, response) => total + response.totalMatched,
                      0,
                    ),
                    classifiedMatched: memory.reduce(
                      (total, response) =>
                        total + response.classifiedMatched,
                      0,
                    ),
                    unclassifiedMatched: memory.reduce(
                      (total, response) =>
                        total + response.unclassifiedMatched,
                      0,
                    ),
                    unclassifiedReturned: memory.reduce(
                      (total, response) =>
                        total + response.unclassifiedReturned,
                      0,
                    ),
                    truncated: memory.some(
                      (response) => response.truncated,
                    ),
                  },
                };
              }
            }

            try {
              const ids = await loadLocalPublicExclusions();
              return {
                ids,
                memory: [],
                telemetry: {
                  marketKeys,
                  source: publicMemory.platformExclusionActive
                    ? (markets.length > 0
                        ? 'local_public_fallback'
                        : 'unresolved_market')
                    : 'tenant_public',
                  count: ids.length,
                  totalMatched: null,
                  classifiedMatched: null,
                  unclassifiedMatched: null,
                  unclassifiedReturned: null,
                  truncated: null,
                },
              };
            } catch (error) {
              log.warn(
                { requestId, err: String(error) },
                'Public exclusion fallback failed; sourcing without exclusions',
              );
              return {
                ids: [],
                memory: [],
                telemetry: {
                  marketKeys,
                  source: publicMemory.platformExclusionActive
                    ? (markets.length > 0
                        ? 'local_public_fallback'
                        : 'unresolved_market')
                    : 'tenant_public',
                  count: 0,
                  totalMatched: null,
                  classifiedMatched: null,
                  unclassifiedMatched: null,
                  unclassifiedReturned: null,
                  truncated: null,
                },
              };
            }
          };

          const exactPublicMarkets = buildPublicMarketsForQuery(requirements);
          const exactExclusion = await resolvePublicExclusions(
            exactPublicMarkets,
          );
          const excludePersonIds = exactExclusion.ids;
          publicMemory.exactExclusion = exactExclusion.telemetry;
          log.info(
            {
              requestId,
              excludedKnown: excludePersonIds.length,
              freshDays: config.excludeKnownFreshDays,
              source: exactExclusion.telemetry.source,
              coarseMarketKeys: exactExclusion.telemetry.marketKeys,
            },
            'Excluding fresh public-sourced people from exact Crustdata query',
          );

          const ladderScope = 'tenant' as const;
          const fineQueryFingerprint = buildFineQueryFingerprint(requirements);
          const ladderRungs = buildRelaxationRungs(
            requirements,
            deriveCountryCodeFromLocationText(requirements.location ?? ''),
            deriveCountryCodeFromLocationText,
            config.relaxationMaxRungs,
          );
          let ladderEnabled = config.relaxationLadderEnabled;
          let ladderError: string | null = null;
          let ladderState: RelaxationState | null = null;

          if (ladderEnabled) {
            try {
              const row = await prisma.sourcingCoverageState.findUnique({
                where: {
                  scope_scopeKey_queryFingerprint: {
                    scope: ladderScope,
                    scopeKey: tenantId,
                    queryFingerprint: fineQueryFingerprint,
                  },
                },
              });
              if (row) {
                ladderState = {
                  activeRung: row.activeRung,
                  shortfallStreak: row.shortfallStreak,
                  lastExactProviderTotal: row.lastExactProviderTotal,
                  lastExactRequestedLimit: row.lastExactRequestedLimit,
                  lastProviderTotal: row.lastProviderTotal,
                  lastRequestedLimit: row.lastRequestedLimit,
                  lastSpillObservedAt: row.lastSpillObservedAt,
                  lastObservedAt: row.lastObservedAt,
                };
              }
            } catch (error) {
              ladderEnabled = false;
              ladderError = error instanceof Error ? error.message : String(error);
              log.warn({ requestId, err: ladderError }, 'Ladder state unavailable; using exact query only');
            }
          }

          await assertCurrentExecution();
          exactAcquisition = await acquireCrustdataSearchForRequest({
            tenantId,
            sourcingRequestId: requestId,
            acquisitionGeneration,
            slot: 'exact',
            requirements,
            limit: CRUSTDATA_REQUEST_LIMIT,
            excludePersonIds,
            metadata: {
              rungId: 'exact',
              rungDescription: 'exact job segment',
              submittedExclusionCount: excludePersonIds.length,
              publicExclusionTelemetry: {
                ...exactExclusion.telemetry,
              },
            },
          });
          const exactReceiptExclusion =
            parseReceiptPublicExclusionTelemetry(
              exactAcquisition.metadata.publicExclusionTelemetry,
            );
          if (exactAcquisition.reused && exactReceiptExclusion) {
            publicMemory.exactExclusion = exactReceiptExclusion;
          }
          const exactSearch = exactAcquisition.result;
          const exactShortfall = isProviderShortfall(
            exactSearch.providerTotal,
            CRUSTDATA_REQUEST_LIMIT,
          );
          const acquisitionRungByProfile = new Map<object, string>();
          for (const profile of exactSearch.profiles) {
            acquisitionRungByProfile.set(profile, 'exact');
          }

          let spillSearch: typeof exactSearch | null = null;
          let spillAcquisition: AcquiredCrustdataSearch | null = null;
          let spillRungId: string | null = null;
          let spillRungDescription: string | null = null;
          let spillNextActiveRung: string | null = null;
          const remainingCapacity = Math.max(0, CRUSTDATA_REQUEST_LIMIT - exactSearch.rawReturnedCount);
          const existingSpillReceipt = await findCrustdataAcquisitionReceipt(
            tenantId,
            requestId,
            acquisitionGeneration,
            'spill',
          );

          // Capacity-fill only: one adjacent query may use exact's unfilled
          // capacity. It never cascades to a second, broader market in-run.
          if (
            existingSpillReceipt ||
            (ladderEnabled && exactShortfall && remainingCapacity > 0)
          ) {
            const selectedSpillRung = selectSpillRung(
              ladderRungs,
              ladderState,
              ladderEnabled,
            );
            if (selectedSpillRung || existingSpillReceipt) {
              const exactPersonIds = exactSearch.profiles
                .map((profile) => profile.crustdata_person_id)
                .filter((id): id is number => Number.isFinite(id));
              const spillExclusion = selectedSpillRung
                ? await resolvePublicExclusions(
                    buildPublicMarketsForQuery(
                      selectedSpillRung.requirements,
                    ),
                  )
                : null;
              if (spillExclusion) {
                publicMemory.spillExclusion = spillExclusion.telemetry;
              }
              const spillExclusionIds = [
                ...new Set([
                  ...(spillExclusion?.ids ?? []),
                  ...exactPersonIds,
                ]),
              ];
              try {
                await assertCurrentExecution();
                spillAcquisition = await acquireCrustdataSearchForRequest({
                  tenantId,
                  sourcingRequestId: requestId,
                  acquisitionGeneration,
                  slot: 'spill',
                  requirements: selectedSpillRung?.requirements ?? requirements,
                  limit: Math.max(1, remainingCapacity),
                  excludePersonIds: spillExclusionIds,
                  metadata: {
                    rungId: selectedSpillRung?.id ?? 'unknown',
                    rungDescription:
                      selectedSpillRung?.description ?? 'previous spill query',
                    submittedExclusionCount: spillExclusionIds.length,
                    ...(spillExclusion
                      ? {
                          publicExclusionTelemetry:
                            { ...spillExclusion.telemetry },
                        }
                      : {}),
                  },
                  reuseOnly: Boolean(existingSpillReceipt),
                });
                spillSearch = spillAcquisition.result;
                spillRungId = spillAcquisition.metadata.rungId;
                spillRungDescription =
                  spillAcquisition.metadata.rungDescription;
                const spillReceiptExclusion =
                  parseReceiptPublicExclusionTelemetry(
                    spillAcquisition.metadata.publicExclusionTelemetry,
                  );
                if (spillAcquisition.reused && spillReceiptExclusion) {
                  publicMemory.spillExclusion = spillReceiptExclusion;
                }
                for (const profile of spillSearch.profiles) {
                  acquisitionRungByProfile.set(profile, spillRungId);
                }
                spillNextActiveRung = spillRungId;
              } catch (error) {
                if (error instanceof CrustdataAcquisitionSafetyError) {
                  throw error;
                }
                ladderError = error instanceof Error ? error.message : String(error);
                log.warn(
                  {
                    requestId,
                    rung: selectedSpillRung?.id ?? 'receipt',
                    err: ladderError,
                  },
                  'Adjacent ladder query failed; continuing with exact results only',
                );
                spillRungId = null;
                spillRungDescription = null;
              }
            }
          }

          crustdataAcquisition = {
            generation: acquisitionGeneration,
            exact: {
              receiptId: exactAcquisition.receiptId,
              reused: exactAcquisition.reused,
              requestFingerprint: exactAcquisition.requestFingerprint,
              requestFingerprintMatched:
                exactAcquisition.requestFingerprintMatched,
              acquiredAt: exactAcquisition.acquiredAt.toISOString(),
              memoryIngestReused: Boolean(
                exactAcquisition.memoryIngestedAt,
              ),
            },
            spill: spillAcquisition
              ? {
                  receiptId: spillAcquisition.receiptId,
                  reused: spillAcquisition.reused,
                  requestFingerprint: spillAcquisition.requestFingerprint,
                  requestFingerprintMatched:
                    spillAcquisition.requestFingerprintMatched,
                  acquiredAt: spillAcquisition.acquiredAt.toISOString(),
                  memoryIngestReused: Boolean(
                    spillAcquisition.memoryIngestedAt,
                  ),
                }
              : null,
          };

          const crustProfiles = [...exactSearch.profiles, ...(spillSearch?.profiles ?? [])];
          relaxationLadder = {
            scope: ladderScope,
            scopeKey: tenantId,
            fineQueryFingerprint,
            enabled: ladderEnabled,
            submittedExclusionCount:
              exactAcquisition.metadata.submittedExclusionCount,
            exact: {
              requestedLimit: CRUSTDATA_REQUEST_LIMIT,
              providerTotal: exactSearch.providerTotal,
              rawReturnedCount: exactSearch.rawReturnedCount,
              shortfall: exactShortfall,
            },
            spill: spillSearch && spillRungId ? {
              rung: spillRungId,
              description: spillRungDescription ?? spillRungId,
              requestedLimit: spillSearch.requestedLimit,
              providerTotal: spillSearch.providerTotal,
              rawReturnedCount: spillSearch.rawReturnedCount,
              shortfall: isProviderShortfall(spillSearch.providerTotal, spillSearch.requestedLimit),
              nextActiveRung: spillNextActiveRung ?? spillRungId,
            } : null,
            error: ladderError,
          };

          if (ladderEnabled) {
            try {
              const effectReceiptId =
                spillAcquisition?.receiptId ?? exactAcquisition.receiptId;
              const effectObservedAt =
                spillAcquisition?.acquiredAt ?? exactAcquisition.acquiredAt;
              const effectResult =
                await applyCrustdataLadderObservationOnce({
                  tenantId,
                  requestId,
                  acquisitionGeneration,
                  executionAttemptId,
                  processingLeaseId,
                  receiptId: effectReceiptId,
                  fineQueryFingerprint,
                  rungs: ladderRungs,
                  exactSearch,
                  exactSubmittedExclusionCount:
                    exactAcquisition.metadata.submittedExclusionCount,
                  spillSearch,
                  spillRungId,
                  observedAt: effectObservedAt,
                  stateStaleBefore: new Date(
                    effectObservedAt.getTime() -
                      config.relaxationStateTtlHours * 60 * 60 * 1000,
                  ),
                  depletionRuns: config.relaxationDepletionRuns,
                });
              spillNextActiveRung = effectResult.metadata.activeRung;
              if (relaxationLadder?.spill && spillNextActiveRung) {
                relaxationLadder.spill.nextActiveRung =
                  spillNextActiveRung;
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (relaxationLadder) relaxationLadder.error = relaxationLadder.error ?? message;
              throw new CrustdataAcquisitionSafetyError(
                'receipt_persistence_failed',
                `Crustdata ladder observation could not be persisted for replay: ${message}`,
              );
            }
          }
          await assertCurrentExecution();
          crustDataSucceeded = true;

          if (crustProfiles.length > 0) {
            logSourcingRaw(requestId, crustProfiles);
            await sendProgressCallback('ranking_started');
            console.log(`✨ [ORCHESTRATOR] CRUSTDATA FOUND ${crustProfiles.length} CANDIDATES! RANKING LOCALLY...`);

            const { extractLinkedInIdFromUrl } = await import('./discovery');

            // Map to rankable shape — URL as temp ID.
            // Actual Crustdata /person/search uses NESTED schema (basic_profile, social_handles,
            // experience.employment_details). Flat schema fields are checked first as a fallback
            // so this code works even if the endpoint changes.
            const mappedForRanking = crustProfiles.map((p: any) => {
              // ── URL ──────────────────────────────────────────────────────────
              // Prefer the clean slug; flat schema has flagship_profile_url, nested uses social_handles.
              const url = p.flagship_profile_url
                || p.social_handles?.professional_network_identifier?.profile_url
                || p.linkedin_profile_url
                || '';

              // ── Core fields: flat first, nested fallback ──────────────────
              const name = p.name || p.basic_profile?.name || '';
              const headline = p.headline || p.basic_profile?.headline || '';
              const location = typeof p.location === 'string'
                ? p.location
                : [
                  p.basic_profile?.location?.city,
                  p.basic_profile?.location?.state,
                  p.basic_profile?.location?.country,
                ].filter(Boolean).join(', ')
                || p.basic_profile?.location?.raw
                || '';

              // ── Profile picture ──────────────────────────────────────────
              // Live API returns it at basic_profile.profile_picture_permalink
              // Legacy flat schema fallback: profile_picture_url
              const profilePictureUrl: string | null =
                p.basic_profile?.profile_picture_permalink
                ?? p.profile_picture_url
                ?? null;

              // ── Employment ───────────────────────────────────────────────
              // Nested: experience.employment_details.{current, past}[]
              //   company name is in .name (NOT .company_name)
              //   rich description is in .description
              // Flat: employer[]
              let employerFlat: any[] = Array.isArray(p.employer) ? p.employer : [];
              const currentJobNested = p.experience?.employment_details?.current?.[0];
              const pastJobsNested: any[] = p.experience?.employment_details?.past ?? [];

              if (employerFlat.length === 0) {
                const currentJobs = p.experience?.employment_details?.current || [];
                employerFlat = [
                  ...currentJobs.map((j: any) => ({ ...j, company_name: j.name, is_current: true })),
                  ...pastJobsNested.map((j: any) => ({ ...j, company_name: j.name, is_current: false }))
                ];
              }

              const currentJob = employerFlat.find((j: any) => j.is_current)
                || employerFlat[0]
                || currentJobNested;

              // ── Education ────────────────────────────────────────────────
              let educationBg: any[] = Array.isArray(p.education_background) ? p.education_background : [];
              const schools: any[] = p.education?.schools ?? [];

              if (educationBg.length === 0 && schools.length > 0) {
                educationBg = schools.map((s: any) => ({
                  institute_name: s.school,
                  degree_name: s.degree,
                  field_of_study: s.field_of_study
                }));
              }

              // ── Rich text snippet ────────────────────────────────────────
              // Includes full job descriptions — the #1 signal for tech skill matching.
              // These descriptions contain the complete tech stack (e.g. "AWS · Kubernetes · Terraform")
              // which dramatically improves skill scoring vs. headline-only extraction.
              const snippetParts: string[] = [headline];

              if (employerFlat.length > 0) {
                // Flat schema
                for (const job of employerFlat.slice(0, 5)) {
                  if (job.title) snippetParts.push(job.title);
                  if (job.company_name) snippetParts.push(job.company_name);
                  if (job.description) snippetParts.push(job.description.substring(0, 400));
                }
              } else {
                // Nested schema (actual Crustdata API)
                if (currentJobNested) {
                  snippetParts.push(currentJobNested.title || '');
                  snippetParts.push(currentJobNested.name || ''); // company name
                  if (currentJobNested.description)
                    snippetParts.push(currentJobNested.description.substring(0, 400));
                }
                for (const job of pastJobsNested.slice(0, 4)) {
                  if (job.title) snippetParts.push(job.title);
                  if (job.name) snippetParts.push(job.name); // company name
                  if (job.description) snippetParts.push(job.description.substring(0, 300));
                }
              }

              for (const edu of educationBg.slice(0, 2)) {
                if (edu.institute_name) snippetParts.push(edu.institute_name);
                if (edu.degree_name) snippetParts.push(edu.degree_name);
              }
              for (const s of schools.slice(0, 2)) {
                if (s.school) snippetParts.push(s.school);
                if (s.degree) snippetParts.push(s.degree);
              }

              // ── Skills ──────────────────────────────────────────────────
              // Person Search does NOT return skills (requires Person Enrich).
              // We extract skills by keyword-matching JD topSkills against job descriptions.
              const rawSkillsFlat: string[] = [];
              const searchSnippetText = snippetParts.filter(Boolean).join(' | ');

              const extractedFromDescriptions: string[] = rawSkillsFlat.length === 0
                ? (requirements.topSkills ?? []).filter((skill: string) => {
                  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  return new RegExp(escaped, 'i').test(searchSnippetText);
                })
                : [];

              const crustdataSkills: string[] = rawSkillsFlat.length > 0
                ? rawSkillsFlat
                : extractedFromDescriptions;

              const skillsNormalized: string[] = crustdataSkills.map((s: string) => s.toLowerCase().trim()).filter(Boolean);
              const uniqueSkillsNormalized = [...new Set(skillsNormalized)];

              // ── Emails (screener provides these directly) ─────────────────
              const emails: string[] = Array.isArray(p.emails) ? (p.emails as string[]).filter(Boolean) : [];

              // ── LinkedIn summary (about section) ─────────────────────────
              const crustdataSummary: string = typeof (p as any).summary === 'string'
                ? (p as any).summary
                : (p.basic_profile?.summary || '');

              // ── Company name ────────────────────────────────────────────
              const companyHint: string | null =
                employerFlat[0]?.company_name
                ?? currentJobNested?.name
                ?? null;
              const searchTitle =
                (currentJob?.title || currentJob?.name) || headline;
              const publicCandidateRoleFamily =
                resolvePublicCandidateRoleFamily({
                  searchTitle,
                  headlineHint: headline,
                  crustdata: p,
                });
              const publicMarket = buildObservedCandidatePublicMarket({
                searchTitle,
                headlineHint: headline,
                seniorityHint:
                  currentJob?.seniority_level ??
                  currentJobNested?.seniority_level ??
                  null,
                locationHint: location,
                crustdata: p,
              });

              return {
                // ── CandidateForRanking fields ──────────────────────────
                id: url,
                headlineHint: headline,
                locationHint: location,
                searchTitle,
                searchSnippet: searchSnippetText,
                enrichmentStatus: 'pending',
                lastEnrichedAt: null as Date | null,
                // Populate snapshot when skills are available → ranker uses "snapshot" path.
                snapshot: uniqueSkillsNormalized.length > 0 ? {
                  skillsNormalized: uniqueSkillsNormalized,
                  roleType: null,
                  seniorityBand: null,
                  location,
                  activityRecencyDays: null as number | null,
                  computedAt: new Date(),
                  staleAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                } : null,
                // ── Extra fields for DB write (not used by ranker) ─────
                linkedinUrl: url,
                name,
                companyHint,
                profilePictureUrl,
                crustdata: p,
                publicCandidateRoleFamily,
                publicMarket,
                // Retrieval provenance is diagnostic-only. Ranking below still
                // receives the original job requirements.
                acquisitionRung: acquisitionRungByProfile.get(p) ?? 'exact',
              };
            }).filter(
              (candidate: any) =>
                extractLinkedInIdFromUrl(candidate.linkedinUrl) !== null,
            );
            if (mappedForRanking.length !== crustProfiles.length) {
              throw new CrustdataAcquisitionSafetyError(
                'memory_ingest_failed',
                `Only ${mappedForRanking.length}/${crustProfiles.length} paid profiles had a durable public identity`,
              );
            }

            try {
              const identityLookup = await resolvePublicIdentities(
                tenantId,
                mappedForRanking.map((candidate) => candidate.linkedinUrl),
                requestId,
              );
              if (identityLookup) {
                for (const identity of identityLookup.results) {
                  const slug = extractLinkedInIdFromUrl(
                    identity.normalizedLinkedinUrl,
                  );
                  if (slug) {
                    addExpectedGlobalIdentityReceipt(
                      {
                        expectedByIdentity: publicGlobalIdByIdentity,
                        conflictedIdentityKeys:
                          conflictedPublicIdentityKeys,
                      },
                      `li:${slug.toLowerCase()}`,
                      identity.globalCandidateId,
                    );
                  }
                }
                publicMemory.identityReceiptConflicts =
                  conflictedPublicIdentityKeys.size;
              }
            } catch (error) {
              log.warn(
                { requestId, err: String(error) },
                'Public identity receipt lookup failed open',
              );
            }
            try {
              await assertCurrentExecution();
              const queued = await enqueuePublicMemoryIngestOutbox({
                  tenantId,
                  sourcingRequestId: requestId,
                  candidates: mappedForRanking.map((candidate) => {
                    const acquisition =
                      candidate.acquisitionRung === 'exact'
                        ? exactAcquisition
                        : spillAcquisition;
                    if (!acquisition) {
                      throw new CrustdataAcquisitionSafetyError(
                        'memory_ingest_failed',
                        `No acquisition receipt matched rung ${candidate.acquisitionRung}`,
                      );
                    }
                    return {
                      candidate,
                      options: {
                        publicMarket: candidate.publicMarket,
                        publicCandidateRoleFamily:
                          candidate.publicCandidateRoleFamily,
                        profileObservedAt: acquisition.acquiredAt,
                        acquisitionGeneration,
                      },
                      expectedGlobalCandidateId:
                        expectedGlobalCandidateIdForCandidate(
                          candidate,
                          publicGlobalIdByIdentity,
                        ),
                    };
                  }),
                });
              publicMemory.ingestQueued += queued;
              publicMemory.ingestPending += queued;
            } catch {
              throw new PublicMemoryOutboxError(
                'Failed to durably queue purchased public profiles',
              );
            }


            // Combine ActiveGraph/Pool candidates with fresh Crustdata candidates
            // Filter out pool candidates that we just fetched from Crustdata to avoid duplicates
            // Identity key that survives id-namespace mismatch: pool candidates
            // carry a LOCAL id while fresh Crustdata candidates carry a linkedin
            // URL as their id, so a plain id-set filter misses the same person in
            // both lists — which duplicated every overlapping candidate through
            // ranking, telemetry AND the served top-100 (the recruiter got ~50
            // instead of ~100). Both lists carry the raw Crustdata blob with a
            // stable crustdata_person_id — dedupe on that (fallbacks: linkedin
            // slug, then raw id).
            // Pool candidates come first so the surviving entry keeps its LOCAL
            // id + DB snapshot linkage — but the FRESH Crustdata blob wins for
            // ranking (Stage-1 freshness): the old rule kept the pool row's
            // stale searchMeta blob and discarded the just-fetched one, and
            // since pool winners were never re-upserted, their stored blob
            // never refreshed either — staleness compounded every run.
            // Memory-only fields (verified snapshot skills) are preserved.
            const combinedRaw = [...poolForRanking, ...mappedForRanking];
            const seenIdentity = new Set<string>();
            const combinedForRanking = combinedRaw.filter((c: any) => {
              const key = candidatePublicIdentityKey(c);
              if (seenIdentity.has(key)) return false;
              seenIdentity.add(key);
              return true;
            });
            const duplicatesRemoved = combinedRaw.length - combinedForRanking.length;

            // Stage-3: a stale-known pool member can cycle back via Crustdata
            // (Stage-2 deliberately lets them) while their pool row sits
            // OUTSIDE the Layer-2 ranking set — the fresh entry is then the
            // only copy in ranking. Match such entries to Layer 1 so they
            // (a) upsert onto the existing row under its case-preserved
            // linkedinId (the URL-derived slug can differ in case, miss
            // tenantId_linkedinId and crash into unique(linkedinUrl)),
            // (b) label as pool members, and (c) still trigger the Stage-1
            // searchMeta re-upsert even when ranked below the served top-100
            // — otherwise "what ranking sees equals what the store holds"
            // silently regresses for exactly the people staleness cycles back.
            const slimMatchByCandidate = new Map<CandidateForRanking, SlimPoolRow>();
            if (config.twoLayerPoolEnabled) {
              for (const c of combinedForRanking) {
                if (poolForRankingById.has(c.id)) continue; // pool copy already in ranking set
                const url = (c as any).linkedinUrl;
                const slug = url ? extractLinkedInIdFromUrl(url) : null;
                const slim = slug ? slimBySlug.get(slug.toLowerCase()) : undefined;
                if (slim) slimMatchByCandidate.set(c, slim);
              }
            }

            // Fresh-blob merge: for every pool entry whose person was ALSO in
            // this run's Crustdata batch, swap in the fresh blob (+picture),
            // keep the pool snapshot, and queue a DB re-upsert so the stored
            // searchMeta converges with what we just ranked.
            const freshByIdentity = new Map(
              mappedForRanking.map((candidate: any) => [
                candidatePublicIdentityKey(candidate),
                candidate,
              ]),
            );
            const poolRefreshProfiles: any[] = [];
            let poolBlobsRefreshed = 0;
            for (const c of combinedForRanking) {
              if (!poolForRankingById.has(c.id)) continue;
              const fresh = freshByIdentity.get(
                candidatePublicIdentityKey(c),
              );
              if (!fresh || fresh === c || !(fresh as any).crustdata) continue;
              (c as any).crustdata = (fresh as any).crustdata;
              if ((fresh as any).profilePictureUrl) (c as any).profilePictureUrl = (fresh as any).profilePictureUrl;
              if (publicTemporaryCandidateById.has(c.id)) {
                // The awaited Memory ingest below refreshes the canonical
                // public profile. Do not create a tenant row unless this
                // candidate is served.
                poolBlobsRefreshed++;
                continue;
              }
              // c.snapshot (Memory-verified skills) intentionally untouched.
              // Upsert key = the POOL ROW's own linkedinId (case-preserved): a
              // case-differing fresh slug would miss tenantId_linkedinId and
              // crash into unique(linkedinUrl) on the create path.
              const linkedinId = poolById.get(c.id)?.linkedinId
                || extractLinkedInIdFromUrl((fresh as any).linkedinUrl || '');
              if (linkedinId) {
                poolRefreshProfiles.push({
                  title: fresh.searchTitle || '',
                  snippet: fresh.searchSnippet || '',
                  linkedinUrl: (fresh as any).linkedinUrl,
                  linkedinId,
                  // Honored by upsertDiscoveredCandidates as the upsert key —
                  // the plain linkedinId field was silently ignored (it
                  // re-extracts from the URL), so case-differing fresh slugs
                  // missed the existing row despite PR#23's intent.
                  canonicalLinkedinId: linkedinId,
                  name: (fresh as any).name,
                  headline: fresh.headlineHint,
                  location: fresh.locationHint || '',
                  companyHint: (fresh as any).companyHint ?? undefined,
                  profilePictureUrl: (fresh as any).profilePictureUrl ?? undefined,
                  crustdata: (fresh as any).crustdata,
                  providerMeta: {
                    sourcing: {
                      ladderRung:
                        fresh.acquisitionRung ?? 'exact',
                      fineQueryFingerprint,
                    },
                  },
                });
              }
              poolBlobsRefreshed++;
            }
            if (duplicatesRemoved > 0 || poolBlobsRefreshed > 0) {
              log.info(
                { requestId, duplicatesRemoved, poolBlobsRefreshed, unique: combinedForRanking.length, raw: combinedRaw.length },
                'Deduped pool+Crustdata candidates; fresh blobs merged onto pool entries'
              );
            }

            // Local ranking against full JD
            const locationBoostWeight = getLocationBoostWeight(config, trackDecision?.track);
            const scored = rankCandidates(combinedForRanking, requirements, {
              fitScoreEpsilon: config.fitScoreEpsilon,
              track: trackDecision?.track,
              semanticSimilarityWeight: config.semanticSimilarityWeight,
            });

            console.log(`📊 [ORCHESTRATOR] LOCAL RANKING DONE — ${scored.length} candidates scored`);
            console.log(`🥇 [ORCHESTRATOR] TOP fit score: ${scored[0]?.fitScore?.toFixed(3) ?? 'N/A'}`);
            console.log(`📉 [ORCHESTRATOR] #100 fit score: ${scored[99]?.fitScore?.toFixed(3) ?? 'N/A'}`);

            const rankedCandidateById = new Map(combinedForRanking.map((candidate) => [candidate.id, candidate]));
            const sourceTypeForScored = (sc: ScoredCandidate): CandidateSourceType => {
              const candidate = rankedCandidateById.get(sc.candidateId);
              const isPoolMember = candidate
                ? poolForRankingById.has(sc.candidateId) || slimMatchByCandidate.has(candidate)
                : false;
              if (!isPoolMember) return 'discovered';
              return sc.fitBreakdown.skillScoreMethod === 'snapshot' ? 'pool_enriched' : 'pool';
            };
            eligibleSourceEntries = scored.map((sc) => ({
              sourceType: sourceTypeForScored(sc),
              fitScore: sc.fitScore,
            }));

            // ── Rank first (CPU-only, ~1s), then upsert only top 100 ──────────
            // Previously all 300 were upserted BEFORE ranking: 20 sequential
            // batches × ~2s Railway RTT = ~40s wasted. Now we rank in-memory
            // first and only write the 100 we actually serve (7 batches ≈ 14s).
            const profileByUrl = new Map(mappedForRanking.map((p) => [p.id, p]));

            // ── Durably ingest all paid profiles into Memory ───────────────
            // A callback may release the large provider receipt only after
            // every profile is present in Memory. Failed internal writes are
            // safe to retry and always retain the provider observation time.
            const {
              ingestCandidateBatchWithResults,
              isConfirmedCandidateIngestResult,
            } = await import('./activegraph-client');
            const ingestReceiptProfiles = async (
              acquisition: AcquiredCrustdataSearch,
              profiles: typeof mappedForRanking,
            ): Promise<boolean> => {
              const currentReceipt = await findCrustdataAcquisitionReceipt(
                tenantId,
                requestId,
                acquisitionGeneration,
                acquisition.metadata.rungId === 'exact' ? 'exact' : 'spill',
              );
              if (currentReceipt?.memoryIngestedAt) return true;

              await assertCurrentExecution();
              const publicOptionsByCandidateId = new Map(
                profiles.map((profile) => [
                  profile.id,
                  {
                    publicMarket: profile.publicMarket,
                    publicCandidateRoleFamily:
                      profile.publicCandidateRoleFamily,
                  },
                ]),
              );
              const results = await ingestCandidateBatchWithResults(
                tenantId,
                profiles,
                requestId,
                10,
                (candidate) => {
                  const publicOptions =
                    publicOptionsByCandidateId.get(candidate.id);
                  return {
                    publicMarket: publicOptions?.publicMarket,
                    publicCandidateRoleFamily:
                      publicOptions?.publicCandidateRoleFamily,
                    profileObservedAt: acquisition.acquiredAt,
                    acquisitionGeneration,
                  };
                },
              );
              for (let index = 0; index < profiles.length; index += 1) {
                const candidate = profiles[index];
                const result = results[index];
                const expectedGlobalCandidateId =
                  expectedGlobalCandidateIdForCandidate(
                    candidate,
                    publicGlobalIdByIdentity,
                  );
                if (!isConfirmedCandidateIngestResult(
                  result,
                  expectedGlobalCandidateId,
                  candidate.id,
                )) {
                  throw new CrustdataAcquisitionSafetyError(
                    'memory_ingest_failed',
                    `Memory did not durably confirm ${candidate.id} from the ${acquisition.metadata.rungId} receipt`,
                  );
                }
              }
              await markCrustdataReceiptMemoryIngested(
                tenantId,
                acquisition.receiptId,
                {
                  candidateCount: results.length,
                  profileObservedAt:
                    acquisition.acquiredAt.toISOString(),
                  acquisitionGeneration,
                },
              );
              return false;
            };

            const exactProfiles = mappedForRanking.filter(
              (profile) => profile.acquisitionRung === 'exact',
            );
            const exactMemoryIngestReused = await ingestReceiptProfiles(
              exactAcquisition,
              exactProfiles,
            );
            if (crustdataAcquisition?.exact) {
              crustdataAcquisition.exact.memoryIngestReused =
                exactMemoryIngestReused;
            }
            if (spillAcquisition) {
              const spillProfiles = mappedForRanking.filter(
                (profile) =>
                  profile.acquisitionRung ===
                  spillAcquisition.metadata.rungId,
              );
              const spillMemoryIngestReused =
                await ingestReceiptProfiles(
                  spillAcquisition,
                  spillProfiles,
                );
              if (crustdataAcquisition?.spill) {
                crustdataAcquisition.spill.memoryIngestReused =
                  spillMemoryIngestReused;
              }
            }
            console.log(
              `📡 [ORCHESTRATOR] MEMORY INGEST CONFIRMED FOR ${mappedForRanking.length} PAID PROFILES`,
            );

            const materializedPublicByTemporaryId =
              await materializeServedPublicCandidates(
                scored.slice(0, 100).map((candidate) => candidate.candidateId),
              );
            const materializedPrivateByCandidateId =
              await materializeServedTenantPrivateCandidates(
                scored.slice(0, 100).map((candidate) => candidate.candidateId),
              );
            const materializedByTemporaryId = new Map([
              ...materializedPublicByTemporaryId,
              ...materializedPrivateByCandidateId,
            ]);

            // Build top-100 profiles for DB write (ranked order already in `scored`)
            const top100Profiles = scored.slice(0, 100).map((sc) => {
              const p = profileByUrl.get(sc.candidateId);
              if (!p) return null; // Was from pool/ActiveGraph, already in DB
              return {
                title: p.searchTitle || '',
                snippet: p.searchSnippet || '',
                linkedinUrl: p.linkedinUrl,
                linkedinId: extractLinkedInIdFromUrl(p.linkedinUrl) || '',
                // Fresh entry whose person is a pool member outside the
                // ranking set: upsert onto the existing row, case-preserved.
                canonicalLinkedinId: slimMatchByCandidate.get(p)?.linkedinId,
                name: p.name,
                headline: p.headlineHint,
                location: p.locationHint || '',
                companyHint: (p as any).companyHint ?? undefined,
                profilePictureUrl: (p as any).profilePictureUrl ?? undefined,
                crustdata: (p as any).crustdata,
                providerMeta: {
                  sourcing: {
                    ladderRung: (p as any).acquisitionRung ?? 'exact',
                    fineQueryFingerprint,
                  },
                },
              };
            }).filter((p): p is NonNullable<typeof p> => p !== null && !!p.linkedinId);

            // Stage-1 convergence for fresh-entry-as-survivor (see the
            // slimMatchByCandidate comment): pool members outside the ranking
            // set whose fresh copy did NOT crack the served top-100 would
            // otherwise never re-upsert — their stored blob stays stale.
            if (config.twoLayerPoolEnabled && slimMatchByCandidate.size > 0) {
              const top100Ids = new Set(scored.slice(0, 100).map((sc) => sc.candidateId));
              for (const [c, slim] of slimMatchByCandidate) {
                if (!(c as any).crustdata) continue;
                if (top100Ids.has(c.id)) {
                  freshSurvivorRefreshes++; // upserted via top100Profiles (canonical key)
                  continue;
                }
                poolRefreshProfiles.push({
                  title: c.searchTitle || '',
                  snippet: c.searchSnippet || '',
                  linkedinUrl: (c as any).linkedinUrl,
                  linkedinId: slim.linkedinId,
                  canonicalLinkedinId: slim.linkedinId,
                  name: (c as any).name,
                  headline: c.headlineHint ?? undefined,
                  location: c.locationHint || '',
                  companyHint: (c as any).companyHint ?? undefined,
                  profilePictureUrl: (c as any).profilePictureUrl ?? undefined,
                  crustdata: (c as any).crustdata,
                  providerMeta: {
                    sourcing: {
                      ladderRung: (c as any).acquisitionRung ?? 'exact',
                      fineQueryFingerprint,
                    },
                  },
                });
                freshSurvivorRefreshes++;
              }
            }

            const { upsertDiscoveredCandidates } = await import('./upsert-candidates');
            // poolRefreshProfiles: pool winners whose person was re-fetched this
            // run — upserting them refreshes their stored searchMeta blob so the
            // DB copy converges with the fresh data we just ranked (Stage-1:
            // "what ranking sees equals what the store holds"). No id churn:
            // upsert keys on (tenantId, linkedinId), the existing row wins.
            await assertCurrentExecution();
            const candidateMap = await upsertDiscoveredCandidates(
              tenantId,
              [...top100Profiles, ...poolRefreshProfiles],
              'crustdata_query',
              'crustdata',
              {
                providerObservedAt: exactAcquisition.acquiredAt,
                providerObservedAtByRung: new Map([
                  ['exact', exactAcquisition.acquiredAt],
                  ...(spillAcquisition
                    ? ([
                        [
                          spillAcquisition.metadata.rungId,
                          spillAcquisition.acquiredAt,
                        ],
                      ] as Array<[string, Date]>)
                    : []),
                ]),
                failOnError: true,
              },
            );
            const candidateIdByLinkedinId = new Map(
              Array.from(candidateMap).map(([linkedinId, candidateId]) => [
                linkedinId.toLowerCase(),
                candidateId,
              ]),
            );
            const materializedIdByIdentity = new Map<string, string>();
            for (const [temporaryId, localCandidateId] of materializedByTemporaryId) {
              const candidate = poolForRankingById.get(temporaryId);
              if (candidate) {
                materializedIdByIdentity.set(
                  candidatePublicIdentityKey(candidate),
                  localCandidateId,
                );
              }
            }
            await attachLocalCandidatesToPublicMemoryOutbox(
              tenantId,
              mappedForRanking.flatMap((candidate) => {
                const linkedinId = extractLinkedInIdFromUrl(
                  candidate.linkedinUrl,
                )?.toLowerCase();
                const localCandidateId =
                  (linkedinId
                    ? candidateIdByLinkedinId.get(linkedinId)
                    : undefined) ??
                  materializedIdByIdentity.get(
                    candidatePublicIdentityKey(candidate),
                  );
                return localCandidateId
                  ? [{
                      signalCandidateId: candidate.id,
                      localCandidateId,
                    }]
                  : [];
              }),
            );

            console.log(`💾 [ORCHESTRATOR] UPSERTED ${candidateMap.size} CANDIDATES TO DB (${poolRefreshProfiles.length} pool-blob refreshes)`);

            const rankedWithCandidateIds = scored.slice(0, 100).map((sc) => {
              const profile = profileByUrl.get(sc.candidateId);
              const poolCandidate = poolForRankingById.get(sc.candidateId);
              const publicResult =
                publicTemporaryCandidateById.get(sc.candidateId);
              const privateResult =
                tenantPrivateCandidateByTemporaryId.get(sc.candidateId);
              
              const linkedinUrl =
                profile?.linkedinUrl ||
                publicResult?.linkedin_url ||
                publicResult?.crustdata_profile?.social_handles
                  ?.professional_network_identifier?.profile_url ||
                privateResult?.linkedinUrl ||
                '';
              // candidateMap is keyed by the canonical (case-preserved) slug
              // when the person matched an existing pool row — look up with
              // the same key or pool-matched fresh entries drop out here.
              const linkedinId = (profile ? slimMatchByCandidate.get(profile)?.linkedinId : undefined)
                ?? extractLinkedInIdFromUrl(linkedinUrl);
              const upsertedId =
                profile && linkedinId
                  ? candidateMap.get(linkedinId)
                  : undefined;
              const dbId =
                upsertedId ??
                materializedByTemporaryId.get(sc.candidateId) ??
                (publicResult || privateResult
                  ? undefined
                  : poolCandidate?.id);

              return {
                candidateId:
                  dbId ??
                  (publicResult ? sc.candidateId : ''),
                linkedinUrl: linkedinUrl,
                name:
                  profile?.name ||
                  publicResult?.name ||
                  privateResult?.result.displayName ||
                  '',
                headlineHint: profile?.headlineHint || poolCandidate?.headlineHint || '',
                locationHint: profile?.locationHint || poolCandidate?.locationHint || '',
                fitScore: sc.fitScore,
                matchTier: sc.matchTier,
                locationMatchType: sc.locationMatchType,
                fitBreakdown: sc.fitBreakdown,
              };
            }).filter((candidate) => candidate.candidateId);
            const allRankedWithIds =
              applyCandidateMaterializationResults({
                candidates: rankedWithCandidateIds,
                replacements: materializedByTemporaryId,
                publicTemporaryCandidateIds: new Set(
                  publicTemporaryCandidateById.keys(),
                ),
              }).candidates;

            crustdataPrimaryList = allRankedWithIds;
            crustdataReserveList = []; // reserve never served — skip DB write

            logRankingResult(requestId, crustdataPrimaryList, crustdataReserveList);

            console.log(`✅ [ORCHESTRATOR] PRIMARY LIST: ${crustdataPrimaryList.length} candidates`);
            console.log(`📦 [ORCHESTRATOR] RESERVE LIST: ${crustdataReserveList.length} candidates`);

            // Enrichment + reranking removed: the initial ranking already uses the full
            // sourcing signal bag (headline + current/past roles + companies + education).
            // This saves Crustdata enrichment credits and eliminates the loading time hit.

            const discovered = allRankedWithIds.map((c) => ({
              candidateId: c.candidateId,
              linkedinId: extractLinkedInIdFromUrl(c.linkedinUrl) || '',
              queryIndex: 0,
            }));

            discovery = {
              candidates: discovered,
              queriesExecuted: 1,
              queriesBuilt: 1,
              telemetry: { queryRuns: [] },
            };
            console.log(`✅ [ORCHESTRATOR] MAPPED ${discovered.length} CANDIDATES FROM CRUSTDATA`);
          } else {
            const exactMemoryIngestApplied =
              await markCrustdataReceiptMemoryIngested(
                tenantId,
                exactAcquisition.receiptId,
                {
                  candidateCount: 0,
                  profileObservedAt:
                    exactAcquisition.acquiredAt.toISOString(),
                  acquisitionGeneration,
                },
              );
            if (crustdataAcquisition?.exact) {
              crustdataAcquisition.exact.memoryIngestReused =
                !exactMemoryIngestApplied;
            }
            if (spillAcquisition) {
              const spillMemoryIngestApplied =
                await markCrustdataReceiptMemoryIngested(
                  tenantId,
                  spillAcquisition.receiptId,
                  {
                    candidateCount: 0,
                    profileObservedAt:
                      spillAcquisition.acquiredAt.toISOString(),
                    acquisitionGeneration,
                  },
                );
              if (crustdataAcquisition?.spill) {
                crustdataAcquisition.spill.memoryIngestReused =
                  !spillMemoryIngestApplied;
              }
            }
            console.log('⚠️ [ORCHESTRATOR] CRUSTDATA RETURNED 0 RESULTS');
            discovery = { candidates: [], queriesExecuted: 1, queriesBuilt: 1, telemetry: { queryRuns: [] } };
          }
        } catch (err) {
          if (
            err instanceof PublicMemoryOutboxError ||
            err instanceof CrustdataAcquisitionSafetyError ||
            exactAcquisition
          ) {
            throw err;
          }
          log.error({ err }, 'Crustdata discovery failed, falling back to Serper');
          console.error('❌ [ORCHESTRATOR] CRUSTDATA FAILED:', err instanceof Error ? err.message : err);
        }

        // Fallback to Serper ONLY if Crustdata threw (connection failure)
        if (!crustDataSucceeded) {
          console.log('🔄 [ORCHESTRATOR] FALLING BACK TO SERPER (CRUSTDATA FAILED TO CONNECT)');
          discovery = await discoverCandidates(
            tenantId,
            requirements,
            discoveryTarget,
            existingLinkedinIds,
            budget.maxQueries,
            { config, track: trackDecision?.track },
          );
        } else {
          console.log('🛑 [ORCHESTRATOR] CRUSTDATA RESPONDED — SKIPPING SERPER FALLBACK');
          // Stage-5 truth-in-labeling: sourceType from POOL MEMBERSHIP, not
          // from which code lane served the candidate. The old blanket
          // 'crustdata_query' label meant pool candidates always displayed as
          // newly-discovered in Flow (toDisplayBucket only knows
          // pool/pool_enriched → talent_pool) and poolCount reported 0 — the
          // recruiter could never see Memory's contribution.
          const finalAssembled: AssembledCandidate[] = crustdataPrimaryList.map((sc, index) => {
            // Two-layer: membership from Layer 1 (full pool), not the ranked
            // subset — a pool member outside vector top-N re-bought from
            // Crustdata upserts onto its existing row id and must still label
            // as pool. slimById is empty when the flag is off.
            const isPoolMember =
              poolForRankingById.has(sc.candidateId) ||
              slimById.has(sc.candidateId) ||
              materializedPublicLocalIds.has(sc.candidateId) ||
              materializedPrivateLocalIds.has(sc.candidateId);
            const hasVerifiedSkills = (sc.fitBreakdown as any)?.skillScoreMethod === 'snapshot';
            const sourceType = isPoolMember
              ? (hasVerifiedSkills ? 'pool_enriched' : 'pool')
              : 'discovered';
            return {
              candidateId: sc.candidateId,
              name: sc.name || '',
              headlineHint: sc.headlineHint || '',
              locationHint: sc.locationHint || '',
              sourceType,
              matchTier: sc.matchTier,
              locationMatchType: sc.locationMatchType,
              fitScore: sc.fitScore,
              fitBreakdown: sc.fitBreakdown,
              rank: index + 1,
              enrichmentStatus: 'pending',
              dataConfidence: hasVerifiedSkills ? 'high' : 'medium',
            };
          });

          await sendProgressCallback('pipeline_complete');

          // A candidate can surface from more than one lane (tenant pool +
          // Crustdata) and upsert to the same local id; dedupe by candidateId
          // (keeping the first/best-ranked) before insert so the
          // (sourcingRequestId, candidateId) unique constraint can't fail.
          const seenFinalIds = new Set<string>();
          const dedupedFinalAssembled = finalAssembled
            .filter((candidate) => {
              if (seenFinalIds.has(candidate.candidateId)) return false;
              seenFinalIds.add(candidate.candidateId);
              return true;
            })
            .map((candidate, index) => ({
              ...candidate,
              rank: index + 1,
            }));
          assertPersistableCandidateIds(
            dedupedFinalAssembled.map((candidate) => candidate.candidateId),
          );
          // Replace the request result under the processor lease so a late
          // stalled delivery cannot overwrite the current candidate set.
          await persistSourcingCandidates(
            dedupedFinalAssembled.map((a) => ({
              tenantId,
              sourcingRequestId: requestId,
              candidateId: a.candidateId,
              fitScore: a.fitScore,
              fitBreakdown: a.fitBreakdown
                ? toJsonValue({ ...a.fitBreakdown, matchTier: a.matchTier, locationMatchType: a.locationMatchType, dataConfidence: a.dataConfidence })
                : toJsonValue({ matchTier: a.matchTier, locationMatchType: a.locationMatchType, dataConfidence: a.dataConfidence }),
              sourceType: a.sourceType, enrichmentStatus: 'pending', rank: a.rank,
            })),
          );

          console.log(`💾 [ORCHESTRATOR] PERSISTED ${dedupedFinalAssembled.length} ENRICHED CANDIDATES TO JOBSOURCINGCANDIDATES!`);

          const avgFitTopK = dedupedFinalAssembled.length > 0
            ? dedupedFinalAssembled.reduce((sum, c) => sum + (c.fitScore ?? 0), 0) / dedupedFinalAssembled.length
            : 0;
          const strictTopKCount = dedupedFinalAssembled.filter((candidate) => candidate.matchTier === 'strict_location').length;
          const sourceMetrics: SourceMetrics = {
            eligible: summarizeSourceMetrics(eligibleSourceEntries),
            top20: summarizeSourceMetrics(eligibleSourceEntries.slice(0, 20)),
            top100: summarizeSourceMetrics(eligibleSourceEntries.slice(0, 100)),
            served: summarizeSourceMetrics(dedupedFinalAssembled.map((candidate) => ({
              sourceType: candidate.sourceType as CandidateSourceType,
              fitScore: candidate.fitScore,
            }))),
          };

          const result: OrchestratorResult = {
            discoveredCount: sourceMetrics.served.discovered.count,
            discoveryShortfallRate: 0,
            candidateCount: dedupedFinalAssembled.length,
            poolCount: dedupedFinalAssembled.filter((a) => a.sourceType === 'pool' || a.sourceType === 'pool_enriched').length,
            queriesExecuted: 1,
            qualityGateTriggered,
            avgFitTopK: Number(avgFitTopK.toFixed(4)),
            countAboveThreshold: dedupedFinalAssembled.filter((candidate) => (candidate.fitScore ?? 0) >= config.qualityThreshold).length,
            strictTopKCount,
            strictCoverageRate: dedupedFinalAssembled.length === 0 ? 0 : strictTopKCount / dedupedFinalAssembled.length,
            effectiveStrategy: 'crustdata_primary',
            executionPath: 'crustdata_primary',
            discoveryReason: 'crustdata_primary',
            discoverySkippedReason: null,
            discoveryTelemetry: null,
            snapshotReuseCount: 0,
            snapshotStaleServedCount: 0,
            strictMatchedCount: dedupedFinalAssembled.length,
            expandedCount: 0,
            expansionReason: null,
            requestedLocation: requirements.location,
            skillScoreDiagnostics: { withSnapshotSkills: 1.0, usingTextFallback: 0, avgSkillScoreBySourceType: {} },
            locationHintCoverage: 1.0,
            strictDemotedCount: 0,
            strictRescuedCount: 0,
            strictRescueApplied: false,
            strictRescueMinFitScoreUsed: null,
            locationMatchCounts: { city_exact: 0, city_alias: 0, country_only: 0, unknown_location: 0, none: 0 },
            demotedStrictWithCityMatch: 0,
            strictBeforeDemotion: 0,
            countryGuardFilteredCount: 0,
            countryGuardSerpLocaleSkippedCount: 0,
            countryGuardEscapeCounts: { totalEscaped: 0, cityAliasEscaped: 0, serpLocaleEscaped: 0 } as any,
            twoLayerPool: buildTwoLayerTelemetry(),
            selectedSnapshotTrack,
            locationCoverageTriggered: false,
            noveltySuppressedCount: 0,
            noveltyWindowDays: config.noveltyWindowDays,
            noveltyKey: null,
            noveltyHint: null,
            discoveredOrphanCount: 0,

            dynamicQueryBudgetUsed: false,
            minDiscoveryPerRunApplied: 0,
            minDiscoveredInOutputApplied: 0,
            discoveredPromotedCount: sourceMetrics.top100.discovered.count,
            discoveredPromotedInTopCount:
              sourceMetrics.served.discovered.count,
            unknownLocationPromotedCount: 0,
            discoveredPromotionRejections: { total: 0, locationGate: 0, fitGate: 0, roleGate: 0, confidence: 0, phase: 0, unknownCap: 0 },
            discoveredDeferredFromFrontLoad: 0,
            unknownLocationAssemblyCapRejected: 0,
            unknownLocationPoolCapRejected: 0,
            unknownLocationPoolAssembledCount: 0,
            unknownLocationDiscoveredAssembledCount: 0,
            unknownLocationPenaltyApplied: 0,
            unknownLocationPoolPenaltyApplied: 0,
            nonTechLocationMismatchPenaltyApplied: 0,
            unknownLocationTop20DemotedInitial: 0,
            unknownLocationTop20DemotedFinal: 0,
            roleGuardTop20Demoted: 0,
            roleGuardNoReplacementCount: 0,
            roleGuardEpsilonBlockedCount: 0,
            skillFloorTop20Demoted: 0,
            skillFloorBypassCount: 0,
            skillFloorNoReplacementCount: 0,
            skillFloorEpsilonBlockedCount: 0,
            eligibleTechRoleCount: finalAssembled.length,
            eligibleTechSkillCount: finalAssembled.length,
            preGuardLowRoleTop20: 0,
            preGuardLowSkillTop20: 0,
            postGuardLowRoleTop20: 0,
            postGuardLowSkillTop20: 0,
            techTop20Thresholds: null,
            roleResolutionMetrics: { totalInputs: 0, cacheHits: 0, groqCalls: 0, groqTokensUsed: 0, durationMs: 0 } as any,
            locationResolutionMetrics: { totalInputs: 0, cacheHits: 0, groqCalls: 0, groqTokensUsed: 0, durationMs: 0 } as any,
            sourceMetrics,
            publicMemory,
            relaxationLadder,
            crustdataAcquisition,
          };

          log.info({ requestId, resolvedTrack: trackDecision?.track ?? null, ...result }, 'Orchestrator complete via Crustdata direct sync pathway');
          return result;
        }

        discoveredCount = discovery.candidates.length;
        discoveredCandidateIds = discovery.candidates.map((d: any) => d.candidateId);
        queriesExecuted = discovery.queriesExecuted;
        discoveryTelemetry = discovery.telemetry;
        usedQueries = queriesExecuted;

        // Build strict/fallback phase query index lookup from discovery telemetry
        const strictQueryIndices = new Set<number>(
          discovery.telemetry.queryRuns
            .filter((qr: any) => qr.phase === 'strict')
            .map((qr: any) => qr.queryIndex)
        );
        const fallbackQueryIndices = new Set<number>(
          discovery.telemetry.queryRuns
            .filter((qr: any) => qr.phase === 'fallback')
            .map((qr: any) => qr.queryIndex)
        );
        const discoveredCandidateByIdMap = new Map<string, DiscoveredCandidate>(
          discovery.candidates.map((dc: any) => [dc.candidateId, dc])
        );
        const fallbackProvisionalFitFloor = trackDecision?.track === 'tech' ? 0.35 : 0.30;
        const fallbackProvisionalMinFitScore = Math.min(config.discoveredPromotionMinFitScore, fallbackProvisionalFitFloor);
        const fallbackProvisionalCap = Math.max(
          config.minDiscoveredInOutput,
          Math.ceil(config.targetCount * 0.2),
        );
        let fallbackProvisionalPromotedCount = 0;

        if (discoveredCandidateIds.length > 0) {
          const discoveredRows = await prisma.candidate.findMany({
            where: { id: { in: discoveredCandidateIds } },

            select: {
              id: true,
              headlineHint: true,
              seniorityHint: true,
              locationHint: true,
              searchTitle: true,
              searchSnippet: true,
              enrichmentStatus: true,
              lastEnrichedAt: true,
              searchMeta: true,
              intelligenceSnapshots: {
                where: { track: { in: snapshotTrackFilter } },
                orderBy: { computedAt: 'desc' },
              },
            },
          });
          const discoveredById = new Map(discoveredRows.map((row) => [row.id, row]));
          const allowedDiscoveredIds: string[] = [];

          for (const candidateId of discoveredCandidateIds) {
            const row = discoveredById.get(candidateId);
            if (!row) continue;

            if (requestedCountryCode) {
              const locationCountryCode = deriveCountryCodeFromLocationText(row.locationHint);
              // TODO(Phase 3b): consolidate via computeSerpEvidence(). See serp-signals.ts.
              const serpLocaleCountryCode = extractSerpSignals(row.searchMeta).localeCountryCode;
              const locationMismatch = Boolean(
                locationCountryCode && locationCountryCode !== requestedCountryCode,
              );
              const serpLocaleMismatch = !locationCountryCode &&
                serpLocaleCountryCode &&
                serpLocaleCountryCode !== requestedCountryCode;

              if (locationMismatch) {
                countryGuardFilteredCandidateIds.add(candidateId);
                continue;
              }
              if (serpLocaleMismatch) {
                if (config.countryGuardSerpLocaleEnabled) {
                  countryGuardFilteredCandidateIds.add(candidateId);
                  continue;
                }
                countryGuardSerpLocaleSkippedCount++;
              }
            }

            discoveredRowsById.set(candidateId, {
              id: row.id,
              enrichmentStatus: row.enrichmentStatus,
              locationHint: row.locationHint,
              searchMeta: row.searchMeta,
            });
            allowedDiscoveredIds.push(candidateId);
          }

          discoveredCandidateIds = allowedDiscoveredIds;
          discoveredCount = discoveredCandidateIds.length;
          countryGuardFilteredCount = countryGuardFilteredCandidateIds.size;

          const discoveredForRanking = discoveredCandidateIds
            .map((candidateId) => discoveredById.get(candidateId))
            .filter((row): row is NonNullable<typeof row> => Boolean(row))
            .map((row) => toRankingCandidate(row));

          // Role resolution for discovered candidates (shadow or active)
          let discoveredPreResolvedRoles: Map<string, RoleResolution> | undefined;
          let discoveredPreResolvedLocations: Map<string, LocationResolution> | undefined;
          if (config.roleGroqEnabled) {
            const discoveredEntries: RoleBatchEntry[] = discoveredForRanking.map((c) => ({
              key: c.id,
              title: c.headlineHint ?? c.searchTitle ?? '',
              context: [c.headlineHint, c.searchTitle, c.searchSnippet].filter(Boolean).join(' '),
            }));
            const discoveredBatch = await resolveRolesBatch(discoveredEntries);
            mergeRoleResolutionMetrics(discoveredBatch.metrics);
            if (!config.roleGroqShadowMode) {
              discoveredPreResolvedRoles = discoveredBatch.resolutions;
            }
            log.info(
              { requestId, mode: config.roleGroqShadowMode ? 'shadow' : 'active', ...discoveredBatch.metrics },
              'Role batch resolution complete (discovered)',
            );
          }

          if (config.locationGroqEnabled) {
            const discoveredLocationEntries: LocationBatchEntry[] = discoveredForRanking.map((c) => ({
              key: c.id,
              location: c.snapshot?.location ?? c.locationHint,
              context: [c.headlineHint, c.searchTitle, c.searchSnippet, requirements.location].filter(Boolean).join(' '),
            }));
            const discoveredLocationBatch = await resolveLocationsBatch(discoveredLocationEntries);
            mergeLocationResolutionMetrics(discoveredLocationBatch.metrics);
            if (!config.locationGroqShadowMode) {
              discoveredPreResolvedLocations = discoveredLocationBatch.resolutions;
            }
            log.info(
              { requestId, mode: config.locationGroqShadowMode ? 'shadow' : 'active', ...discoveredLocationBatch.metrics },
              'Location batch resolution complete (discovered)',
            );
          }

          const scoredDiscovered = rankCandidates(discoveredForRanking, requirements, {
            fitScoreEpsilon: config.fitScoreEpsilon,
            track: trackDecision?.track,
            semanticSimilarityWeight: config.semanticSimilarityWeight,
          });

          // Penalize discovered unknown_location candidates that don't clear quality thresholds
          for (const sc of scoredDiscovered) {
            if (
              sc.locationMatchType === 'unknown_location' &&
              !(sc.fitScore >= 50 && sc.fitBreakdown.roleScore >= 10.5)
            ) {
              sc.fitScore *= config.unknownLocationPenaltyMultiplier;
              unknownLocationPenaltyApplied++;
            }
          }
          // Re-sort after penalty so promotion/front-load ordering reflects demotion.
          if (unknownLocationPenaltyApplied > 0) {
            const reOrderedDiscovered = orderByFitScoreWithConfidence(scoredDiscovered, config.fitScoreEpsilon);
            scoredDiscovered.splice(0, scoredDiscovered.length, ...reOrderedDiscovered);
          }

          for (const sc of scoredDiscovered) {
            scoredDiscoveredById.set(sc.candidateId, sc);

            const passesFitGate = sc.fitScore >= config.discoveredPromotionMinFitScore;

            // Provisional promotion for non-tech/blended discoveries with exact role match.
            // - strict phase: preserve prior behavior (location intent embedded in query)
            // - fallback phase: allow in discovery_first mode when fit clears a safety floor,
            //   so strong role matches are not blocked only due to missing location hints.
            let provisionalPromotion = false;
            let provisionalConfidenceRejected = false;
            let provisionalPhaseRejected = false;
            if (trackDecision?.track !== 'tech' && requirements.roleFamily) {
              const dc = discoveredCandidateByIdMap.get(sc.candidateId);
              const isFromStrictPhase = !!dc && strictQueryIndices.has(dc.queryIndex);
              const isFromFallbackPhase = !!dc && fallbackQueryIndices.has(dc.queryIndex);
              const candidateRow = discoveredById.get(sc.candidateId);
              const candidateTitleForResolution = candidateRow?.headlineHint ?? candidateRow?.searchTitle ?? '';
              const candidateRoleKey = candidateTitleForResolution.trim().toLowerCase();
              // Use pre-resolved role in active mode, deterministic otherwise
              const candidateResolution = discoveredPreResolvedRoles?.get(sc.candidateId)
                ?? discoveredPreResolvedRoles?.get(candidateRoleKey)
                ?? resolveRoleDeterministic(candidateTitleForResolution);
              const candidateRoleFamily = candidateResolution.family;
              // Confidence gate: only allow promotion at >= 0.7 (per plan requirement)
              const passesConfidenceGate = candidateResolution.confidence >= 0.7;
              if (candidateRoleFamily === requirements.roleFamily) {
                if (!passesConfidenceGate) {
                  provisionalConfidenceRejected = true;
                } else if (isFromStrictPhase) {
                  provisionalPromotion = true;
                } else if (
                  effectiveStrategy === 'discovery_first' &&
                  isFromFallbackPhase &&
                  sc.fitScore >= fallbackProvisionalMinFitScore &&
                  fallbackProvisionalPromotedCount < fallbackProvisionalCap
                ) {
                  provisionalPromotion = true;
                  fallbackProvisionalPromotedCount++;
                } else {
                  provisionalPhaseRejected = true;
                }
              }
            }

            const roleGate = sc.fitBreakdown.roleScore >= 10.5;
            const isUnknownLocation = sc.locationMatchType === 'unknown_location';
            const unknownLocationPromotionCapRatio = trackDecision?.track === 'tech' ? 0.1 : 0.15;
            const maxUnknownPromoted = Math.ceil(config.targetCount * unknownLocationPromotionCapRatio);
            const unknownLaneFitFloor = trackDecision?.track === 'tech'
              ? fallbackProvisionalMinFitScore
              : Math.max(fallbackProvisionalMinFitScore, config.unknownLaneFitFloorNonTech);
            const allowUnknownLocationPromotion =
              hasLocationConstraint &&
              effectiveStrategy === 'discovery_first' &&
              isUnknownLocation &&
              roleGate &&
              sc.fitScore >= unknownLaneFitFloor &&
              unknownLocationPromotedCount < maxUnknownPromoted;

            const passesLocationGate = !hasLocationConstraint || STRONG_LOCATION_TYPES.has(sc.locationMatchType);

            const promotedByStandardGates = passesLocationGate && passesFitGate;
            const promotedByUnknownLane =
              allowUnknownLocationPromotion &&
              !provisionalPromotion &&
              !promotedByStandardGates;

            if (promotedByStandardGates || provisionalPromotion || allowUnknownLocationPromotion) {
              if (promotedByUnknownLane) {
                unknownLocationPromotedCount++;
                unknownLocationPromotedIds.add(sc.candidateId);
              }
              promotedDiscoveredById.set(sc.candidateId, sc);
            } else {
              discoveredPromotionRejections.total++;
              if (!passesLocationGate) discoveredPromotionRejections.locationGate++;
              if (!passesFitGate) discoveredPromotionRejections.fitGate++;
              if (!roleGate) discoveredPromotionRejections.roleGate++;
              if (provisionalConfidenceRejected) discoveredPromotionRejections.confidence++;
              if (provisionalPhaseRejected) discoveredPromotionRejections.phase++;
              if (isUnknownLocation && roleGate && sc.fitScore >= unknownLaneFitFloor &&
                unknownLocationPromotedCount >= maxUnknownPromoted) {
                discoveredPromotionRejections.unknownCap++;
              }
            }
          }
          discoveredPromotedCount = promotedDiscoveredById.size;
        }
      } finally {
        await releaseUnusedReservedQueries(budget.key, budget.reservedQueries, usedQueries);
      }

      if (discoveredCount < discoveryTarget) {
        log.warn(
          {
            requestId,
            discoveredCount,
            discoveryTarget,
            shortfall: discoveryTarget - discoveredCount,
          },
          'Discovery under-delivered — deterministic queries yielded insufficient results',
        );
      }
    }
  }

  // 4. Two-tier assembly: strict location first, expanded second (never interleaved)
  const assembled: AssembledCandidate[] = [];
  const assembledIds = new Set<string>();
  let rank = 1;

  const computeDataConfidence = (candidate: Omit<AssembledCandidate, 'rank' | 'dataConfidence'>): 'high' | 'medium' | 'low' => {
    if (candidate.fitScore !== null && candidate.fitBreakdown?.skillScoreMethod === 'snapshot') {
      return 'high';
    }
    if (candidate.fitScore !== null && candidate.fitBreakdown?.skillScoreMethod === 'text_fallback') {
      return 'medium';
    }
    return 'low';
  };

  // Hard cap: limit unknown-location candidates in final assembly (pool + discovered combined)
  const isTechTrack = trackDecision?.track === 'tech';
  const unknownLocationAssemblyCapRatio = trackDecision?.track === 'tech' ? 0.1 : 0.15;
  const maxUnknownLocationInAssembly = Math.ceil(config.targetCount * unknownLocationAssemblyCapRatio);
  const reservedDiscoveredUnknownForTech = isTechTrack
    ? Math.min(config.unknownAssemblyDiscoveredReserveTech, maxUnknownLocationInAssembly)
    : 0;
  const maxPoolUnknownInAssembly = isTechTrack
    ? Math.max(0, maxUnknownLocationInAssembly - reservedDiscoveredUnknownForTech)
    : maxUnknownLocationInAssembly;
  let unknownLocationAssembledCount = 0;
  let unknownLocationPoolAssembledCount = 0;
  let unknownLocationDiscoveredAssembledCount = 0;
  let unknownLocationAssemblyCapRejected = 0;
  let unknownLocationPoolCapRejected = 0;

  const pushCandidate = (candidate: Omit<AssembledCandidate, 'rank' | 'dataConfidence'>): boolean => {
    if (assembled.length >= config.targetCount) return false;
    if (assembledIds.has(candidate.candidateId)) return false;
    // Enforce hard unknown-location cap across all source types
    if (candidate.locationMatchType === 'unknown_location') {
      if (unknownLocationAssembledCount >= maxUnknownLocationInAssembly) {
        unknownLocationAssemblyCapRejected++;
        return false;
      }
      // Tech-specific source-aware split: reserve a portion of unknown slots for discovered
      // so pool unknowns cannot consume the entire unknown budget.
      const isPoolCandidate = candidate.sourceType === 'pool' || candidate.sourceType === 'pool_enriched';
      if (isTechTrack && isPoolCandidate && unknownLocationPoolAssembledCount >= maxPoolUnknownInAssembly) {
        unknownLocationPoolCapRejected++;
        return false;
      }
    }
    const dataConfidence = computeDataConfidence(candidate);
    assembled.push({ ...candidate, dataConfidence, rank: rank++ });
    assembledIds.add(candidate.candidateId);
    if (candidate.locationMatchType === 'unknown_location') {
      unknownLocationAssembledCount++;
      if (candidate.sourceType === 'discovered') {
        unknownLocationDiscoveredAssembledCount++;
      } else {
        unknownLocationPoolAssembledCount++;
      }
    }
    return true;
  };

  // Partition pool into strict vs expanded tiers (sorted by fitScore within each)
  const strictPool = scoredPool.filter((sc) => sc.matchTier === 'strict_location');
  let expandedPool = scoredPool.filter((sc) => sc.matchTier === 'expanded_location');

  // Quality guard: demote strict candidates below fitScore floor to expanded pool.
  // For tech, also require a minimum skill floor for best-match admission so
  // exact location/role/seniority cannot hide zero-skill candidates in strict.
  let strictDemotedCount = 0;
  const qualifiedStrict: typeof strictPool = [];
  const strictBeforeDemotion = strictPool.length;
  const demotedStrictCandidates: typeof strictPool = [];
  let demotedStrictWithCityMatch = 0;
  let strictRescuedCount = 0;
  let strictRescueApplied = false;
  let strictRescueMinFitScoreUsed: number | null = null;
  for (const sc of strictPool) {
    const failsTechStrictSkillFloor =
      trackDecision?.track === 'tech' &&
      sc.fitBreakdown.skillScore < config.techTop20SkillMin;
    if (sc.fitScore < config.bestMatchesMinFitScore || failsTechStrictSkillFloor) {
      sc.matchTier = 'expanded_location';
      expandedPool.push(sc);
      demotedStrictCandidates.push(sc);
      strictDemotedCount++;
      if (sc.locationMatchType === 'city_exact' || sc.locationMatchType === 'city_alias') {
        demotedStrictWithCityMatch++;
      }
    } else {
      qualifiedStrict.push(sc);
    }
  }
  if (strictDemotedCount > 0) {
    expandedPool = orderByFitScoreWithConfidence(expandedPool, config.fitScoreEpsilon);
  }

  // Strict rescue: avoid zero best-pool when all strict candidates miss the default floor.
  if (
    qualifiedStrict.length === 0 &&
    demotedStrictCandidates.length > 0 &&
    config.strictRescueCount > 0
  ) {
    const rescuedStrict = demotedStrictCandidates
      .filter((sc) => {
        if (sc.fitScore < config.strictRescueMinFitScore) return false;
        if (trackDecision?.track === 'tech' && sc.fitBreakdown.skillScore < config.techTop20SkillMin) return false;
        // Role-aware rescue gate: prevents wrong-role candidates from being rescued
        // into the top bucket purely due to location match.
        // Tech: 0.7 keeps exact + strong adjacency (fullstack↔backend), blocks devops/qa.
        // Non-tech/blended: 0.6 keeps exact + adjacency (CS↔TAM), blocks engineers.
        if (trackDecision?.track === 'tech' && sc.fitBreakdown.roleScore < 0.7) return false;
        if (trackDecision?.track !== 'tech' && sc.fitBreakdown.roleScore < 0.6) return false;
        return true;
      })
      .slice(0, config.strictRescueCount);

    if (rescuedStrict.length > 0) {
      const rescuedIds = new Set(rescuedStrict.map((sc) => sc.candidateId));
      for (const sc of rescuedStrict) {
        sc.matchTier = 'strict_location';
      }
      expandedPool = expandedPool.filter((sc) => !rescuedIds.has(sc.candidateId));
      qualifiedStrict.push(...rescuedStrict);
      strictRescuedCount = rescuedStrict.length;
      strictRescueApplied = true;
      strictRescueMinFitScoreUsed = config.strictRescueMinFitScore;
    }
  }

  // Helper: push pool candidates in fitScore order (no enriched-first bias)
  const pushPoolTier = (tier: typeof scoredPool, limit: number): void => {
    for (const sc of tier) {
      if (assembled.length >= limit) return;
      pushCandidate({
        candidateId: sc.candidateId,
        fitScore: sc.fitScore,
        fitBreakdown: sc.fitBreakdown,
        matchTier: sc.matchTier,
        locationMatchType: sc.locationMatchType,
        sourceType: 'pool',
      });
    }
  };

  const promotedDiscoveredIdsOrdered = Array.from(promotedDiscoveredById.values()).map((sc) => sc.candidateId);
  const discoveryFirstReserve = Math.ceil(config.targetCount * 0.5);
  discoveredReservedInOutput = Math.min(
    effectiveStrategy === 'discovery_first' ? discoveryFirstReserve : config.minDiscoveredInOutput,
    discoveredCandidateIds.length,
    config.targetCount,
  );
  const discoveredRoleThreshold = trackDecision?.track === 'tech' ? 0.7 : 0.6;
  const promotedDiscoveredTopIds = (effectiveStrategy === 'discovery_first'
    ? // discovery_first: front-load all promoted discovered sorted by fit (not just strict_location)
    promotedDiscoveredIdsOrdered
      .filter((id) => (promotedDiscoveredById.get(id)?.fitBreakdown.roleScore ?? 0) >= discoveredRoleThreshold)
    : // pool_first: only strict_location promoted
    promotedDiscoveredIdsOrdered
      .filter((id) => promotedDiscoveredById.get(id)?.matchTier === 'strict_location')
  ).slice(0, discoveredReservedInOutput);

  // Delta-based front-load for tech: only front-load discovered candidates
  // whose fitScore is within delta of the top pool candidate. Prevents low-fit
  // discovered from ranking above higher-fit pool with strong location matches.
  const frontLoadDelta = 0.05;
  let frontLoadIds = promotedDiscoveredTopIds;
  const deferredDiscoveredIds: string[] = [];
  if (trackDecision?.track === 'tech' && effectiveStrategy === 'discovery_first') {
    const topPoolFit = qualifiedStrict[0]?.fitScore ?? expandedPool[0]?.fitScore ?? null;
    if (topPoolFit !== null) {
      const minFitForFrontLoad = topPoolFit - frontLoadDelta;
      frontLoadIds = [];
      for (const id of promotedDiscoveredTopIds) {
        const fit = promotedDiscoveredById.get(id)?.fitScore ?? 0;
        if (fit >= minFitForFrontLoad) {
          frontLoadIds.push(id);
        } else {
          deferredDiscoveredIds.push(id);
        }
      }
      discoveredDeferredFromFrontLoad = deferredDiscoveredIds.length;
    }
  }

  discoveredPromotedInTopCount = frontLoadIds.length;
  // Tech with delta: reserve minDiscoveredInOutput (not 50%) to let pool fill more slots.
  const techAdjustedReserve = trackDecision?.track === 'tech' && deferredDiscoveredIds.length > 0
    ? Math.min(config.minDiscoveredInOutput, discoveredCandidateIds.length)
    : discoveredReservedInOutput;
  const discoveredReserveRemaining = Math.max(0, techAdjustedReserve - discoveredPromotedInTopCount);
  const poolFillLimit = Math.max(0, config.targetCount - discoveredReserveRemaining);

  const pushDiscoveredCandidate = (candidateId: string): void => {
    const promoted = promotedDiscoveredById.get(candidateId);
    const enrichmentStatus = discoveredRowsById.get(candidateId)?.enrichmentStatus ?? 'pending';
    if (promoted) {
      pushCandidate({
        candidateId,
        fitScore: promoted.fitScore,
        fitBreakdown: unknownLocationPromotedIds.has(candidateId)
          ? { ...promoted.fitBreakdown, unknownLocationPromotion: true }
          : promoted.fitBreakdown,
        matchTier: promoted.matchTier,
        locationMatchType: promoted.locationMatchType,
        sourceType: 'discovered',
      });
      return;
    }
    const scored = scoredDiscoveredById.get(candidateId);
    pushCandidate({
      candidateId,
      fitScore: scored?.fitScore ?? null,
      fitBreakdown: scored?.fitBreakdown ?? null,
      matchTier: scored?.matchTier ?? 'expanded_location',
      locationMatchType: scored?.locationMatchType ?? 'unknown_location',
      sourceType: 'discovered',
    });
  };

  // Pass 1: place high-confidence discovered candidates at the top (bounded by reserve).
  // For tech: only competitive discovered (within delta of top pool fit) are front-loaded.
  for (const candidateId of frontLoadIds) {
    if (assembled.length >= config.targetCount) break;
    pushDiscoveredCandidate(candidateId);
  }

  // Pass 2: fill from qualified strict pool (above fitScore floor), preserving discovered reserve.
  pushPoolTier(qualifiedStrict, poolFillLimit);
  const strictMatchedCount = assembled.filter((a) => a.matchTier === 'strict_location').length;

  // Pass 3: Expand as needed to reach targetCount; annotate reason when strict
  // location matches are insufficient for a location-constrained job.
  const needsExpansion = assembled.length < poolFillLimit;
  let expansionReason: OrchestratorResult['expansionReason'] = null;
  if (hasLocationConstraint && strictMatchedCount < config.targetCount) {
    expansionReason = strictDemotedCount > 0 ? 'strict_low_quality' : 'insufficient_strict_location_matches';
  }

  if (needsExpansion) {
    // Add expanded pool
    pushPoolTier(expandedPool, poolFillLimit);
  }

  // Pass 4: Fill remaining slots with discovered candidates.
  // Deferred front-load candidates first, then other promoted, then unpromoted backfill.
  const frontLoadIdSet = new Set(frontLoadIds);
  const deferredIdSet = new Set(deferredDiscoveredIds);
  const discoveredFillOrder = [
    ...deferredDiscoveredIds,
    ...promotedDiscoveredIdsOrdered.filter((id) => !frontLoadIdSet.has(id) && !deferredIdSet.has(id)),
    ...discoveredCandidateIds.filter((id) => !promotedDiscoveredById.has(id)),
  ];
  for (const candidateId of discoveredFillOrder) {
    if (assembled.length >= config.targetCount) break;
    pushDiscoveredCandidate(candidateId);
  }

  // Novelty guard: suppress recently-exposed broader-pool candidates
  let noveltySuppressedCount = 0;
  let noveltyKey: string | null = null;
  let noveltyHint: string | null = null;
  const getDiscoveredNoveltyContext = (candidateId: string): { matchTier: MatchTier; fitScore: number | null } => {
    const scored = scoredDiscoveredById.get(candidateId);
    if (scored) {
      return { matchTier: scored.matchTier, fitScore: scored.fitScore };
    }
    return { matchTier: 'expanded_location', fitScore: null };
  };

  if (config.noveltyEnabled && requirements.roleFamily) {
    const targetCity = requirements.location
      ? extractPrimaryCity(canonicalizeLocation(requirements.location))
      : null;
    noveltyKey = `${requirements.roleFamily}+${targetCity ?? 'any'}`;

    const exposedIds = await getRecentlyExposedCandidateIds(
      tenantId,
      requirements.roleFamily,
      requirements.location ?? null,
      config.noveltyWindowDays,
    );

    if (exposedIds.size > 0) {
      // Top 10% fitScore threshold (only from scored candidates)
      const scoredFitScores = assembled
        .filter((a) => a.fitScore !== null)
        .map((a) => a.fitScore!)
        .sort((a, b) => b - a);
      const top10PctThreshold = scoredFitScores.length > 0
        ? scoredFitScores[Math.floor(scoredFitScores.length * 0.1)] ?? 0
        : 0;

      const shouldSuppressNovelty = (
        candidateId: string,
        matchTier: MatchTier | null,
        fitScore: number | null,
      ): boolean => {
        const isExpandedTier = matchTier !== 'strict_location';
        const isExposed = exposedIds.has(candidateId);
        const isTopFit = fitScore !== null && fitScore >= top10PctThreshold;
        return isExpandedTier && isExposed && !isTopFit;
      };

      const kept: AssembledCandidate[] = [];
      for (const a of assembled) {
        if (shouldSuppressNovelty(a.candidateId, a.matchTier, a.fitScore)) {
          noveltySuppressedCount++;
        } else {
          kept.push(a);
        }
      }

      if (noveltySuppressedCount > 0) {
        // Rebuild assembled list, removing suppressed candidates
        const suppressedIds = new Set(
          assembled
            .filter((a) => !kept.some((k) => k.candidateId === a.candidateId))
            .map((a) => a.candidateId),
        );
        assembled.length = 0;
        for (const id of suppressedIds) assembledIds.delete(id);
        let newRank = 1;
        for (const a of kept) {
          a.rank = newRank++;
          assembled.push(a);
        }
        rank = newRank;
        // Recalculate unknown-location count after novelty suppression
        unknownLocationAssembledCount = kept.filter((a) => a.locationMatchType === 'unknown_location').length;
        unknownLocationPoolAssembledCount = kept.filter((a) =>
          a.locationMatchType === 'unknown_location' && a.sourceType !== 'discovered',
        ).length;
        unknownLocationDiscoveredAssembledCount = kept.filter((a) =>
          a.locationMatchType === 'unknown_location' && a.sourceType === 'discovered',
        ).length;

        // Refill from expanded pool and discovered candidates to reach targetCount
        for (const sc of expandedPool) {
          if (assembled.length >= poolFillLimit) break;
          if (assembledIds.has(sc.candidateId)) continue;
          if (shouldSuppressNovelty(sc.candidateId, sc.matchTier, sc.fitScore)) continue;
          pushCandidate({
            candidateId: sc.candidateId,
            fitScore: sc.fitScore,
            fitBreakdown: sc.fitBreakdown,
            matchTier: sc.matchTier,
            locationMatchType: sc.locationMatchType,
            sourceType: 'pool',
          });
        }
        for (const candidateId of discoveredFillOrder) {
          if (assembled.length >= config.targetCount) break;
          if (assembledIds.has(candidateId)) continue;
          const noveltyContext = getDiscoveredNoveltyContext(candidateId);
          if (shouldSuppressNovelty(candidateId, noveltyContext.matchTier, noveltyContext.fitScore)) continue;
          pushDiscoveredCandidate(candidateId);
        }

        noveltyHint = `Suppressed ${noveltySuppressedCount} recently-exposed broader-pool candidates (${noveltyKey}, ${config.noveltyWindowDays}d window)`;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Post-assembly top-20 guards (order: unknown cap → role → skill → unknown re-assert)
  // ---------------------------------------------------------------------------
  const top20Size = Math.min(20, assembled.length);
  const unknownCapRatio = trackDecision?.track === 'tech' ? 0.1 : 0.15;
  const top20UnknownCap = Math.max(1, Math.ceil(top20Size * unknownCapRatio));
  const getFitScoreAssembled = (c: AssembledCandidate) => c.fitScore ?? 0;
  const renumberRanks = () => { for (let i = 0; i < assembled.length; i++) assembled[i].rank = i + 1; };

  // 1. Unknown-location cap (initial)
  const unknownCapInitial = guardedTopKSwap({
    items: assembled,
    topK: top20Size,
    isViolation: (c) => c.locationMatchType === 'unknown_location',
    isEligibleReplacement: (c) => c.locationMatchType !== 'unknown_location',
    cap: top20UnknownCap,
    epsilon: config.fitScoreEpsilon,
    getFitScore: getFitScoreAssembled,
  });
  if (unknownCapInitial.demoted > 0) renumberRanks();

  // Pre-guard supply diagnostics (computed after assembly + initial unknown cap, before role/skill guards)
  const guardsEnabled = config.techTop20GuardsEnabled && trackDecision?.track === 'tech';
  const top100Size = Math.min(100, assembled.length);
  const eligibleTechRoleCount = guardsEnabled
    ? assembled.slice(0, top100Size).filter(c => (c.fitBreakdown?.roleScore ?? 0) >= config.techTop20RoleMin).length
    : null;
  const eligibleTechSkillCount = guardsEnabled
    ? assembled.slice(0, top100Size).filter(c => (c.fitBreakdown?.skillScore ?? 0) >= config.techTop20SkillMin).length
    : null;
  const preGuardLowRoleTop20 = guardsEnabled
    ? assembled.slice(0, top20Size).filter(c => (c.fitBreakdown?.roleScore ?? 0) < config.techTop20RoleMin).length
    : null;
  const preGuardLowSkillTop20 = guardsEnabled
    ? assembled.slice(0, top20Size).filter(c => (c.fitBreakdown?.skillScore ?? 0) < config.techTop20SkillMin).length
    : null;

  // 2. Role guard (tech only) — max techTop20RoleCap candidates with roleScore < techTop20RoleMin
  let roleGuardResult = { demoted: 0, noReplacementCount: 0, epsilonBlockedCount: 0 };
  if (guardsEnabled) {
    roleGuardResult = guardedTopKSwap({
      items: assembled,
      topK: top20Size,
      isViolation: (c) => (c.fitBreakdown?.roleScore ?? 0) < config.techTop20RoleMin,
      isEligibleReplacement: (c) => (c.fitBreakdown?.roleScore ?? 0) >= config.techTop20RoleMin,
      cap: config.techTop20RoleCap,
      epsilon: config.fitScoreEpsilon,
      getFitScore: getFitScoreAssembled,
      // Prefer replacements that meet skill floor AND are non-unknown to avoid guard conflicts
      preferReplacement: (a, b) => {
        const aLocOk = a.locationMatchType !== 'unknown_location' ? 1 : 0;
        const bLocOk = b.locationMatchType !== 'unknown_location' ? 1 : 0;
        if (bLocOk !== aLocOk) return bLocOk - aLocOk;
        const aSkillOk = (a.fitBreakdown?.skillScore ?? 0) >= config.techTop20SkillMin ? 1 : 0;
        const bSkillOk = (b.fitBreakdown?.skillScore ?? 0) >= config.techTop20SkillMin ? 1 : 0;
        return bSkillOk - aSkillOk;
      },
    });
    if (roleGuardResult.demoted > 0) renumberRanks();
  }

  // 3. Skill floor (tech only) — prefer skillScore >= techTop20SkillMin
  let skillFloorResult = { demoted: 0, noReplacementCount: 0, epsilonBlockedCount: 0 };
  if (guardsEnabled) {
    skillFloorResult = guardedTopKSwap({
      items: assembled,
      topK: top20Size,
      isViolation: (c) => (c.fitBreakdown?.skillScore ?? 0) < config.techTop20SkillMin,
      // Require replacements to also meet role guard to avoid undoing role guard's work
      isEligibleReplacement: (c) =>
        (c.fitBreakdown?.skillScore ?? 0) >= config.techTop20SkillMin &&
        (c.fitBreakdown?.roleScore ?? 0) >= config.techTop20RoleMin,
      cap: 0,
      epsilon: config.fitScoreEpsilon,
      getFitScore: getFitScoreAssembled,
      // Prefer non-unknown replacements to avoid leaking unknowns into top-20
      preferReplacement: (a, b) => {
        const aLocOk = a.locationMatchType !== 'unknown_location' ? 1 : 0;
        const bLocOk = b.locationMatchType !== 'unknown_location' ? 1 : 0;
        return bLocOk - aLocOk;
      },
    });
    if (skillFloorResult.demoted > 0) renumberRanks();
  }
  const skillFloorBypassCount = skillFloorResult.noReplacementCount + skillFloorResult.epsilonBlockedCount;

  // 4. Unknown cap re-assertion (only if role/skill guards made swaps that may have re-introduced unknowns)
  let unknownCapFinalDemoted = 0;
  if (guardsEnabled && (roleGuardResult.demoted > 0 || skillFloorResult.demoted > 0)) {
    const unknownCapFinal = guardedTopKSwap({
      items: assembled,
      topK: top20Size,
      isViolation: (c) => c.locationMatchType === 'unknown_location',
      isEligibleReplacement: (c) => c.locationMatchType !== 'unknown_location',
      cap: top20UnknownCap,
      epsilon: config.fitScoreEpsilon,
      getFitScore: getFitScoreAssembled,
    });
    unknownCapFinalDemoted = unknownCapFinal.demoted;
    if (unknownCapFinalDemoted > 0) renumberRanks();
  }

  // Post-guard top-20 counts
  const postGuardLowRoleTop20 = guardsEnabled
    ? assembled.slice(0, top20Size).filter(c => (c.fitBreakdown?.roleScore ?? 0) < config.techTop20RoleMin).length
    : null;
  const postGuardLowSkillTop20 = guardsEnabled
    ? assembled.slice(0, top20Size).filter(c => (c.fitBreakdown?.skillScore ?? 0) < config.techTop20SkillMin).length
    : null;

  const expandedCount = assembled.length - strictMatchedCount;
  const legacyPublicMaterializedByTemporaryId =
    await materializeServedPublicCandidates(
      assembled.map((candidate) => candidate.candidateId),
    );
  const legacyPrivateMaterializedByCandidateId =
    await materializeServedTenantPrivateCandidates(
      assembled.map((candidate) => candidate.candidateId),
    );
  const legacyMaterializedByTemporaryId = new Map([
    ...legacyPublicMaterializedByTemporaryId,
    ...legacyPrivateMaterializedByCandidateId,
  ]);
  const legacyMaterialization = applyCandidateMaterializationResults({
    candidates: assembled,
    replacements: legacyMaterializedByTemporaryId,
    publicTemporaryCandidateIds: new Set(
      publicTemporaryCandidateById.keys(),
    ),
  });
  if (
    legacyMaterialization.skippedTemporaryCandidateIds.length > 0 ||
    legacyMaterializedByTemporaryId.size > 0
  ) {
    assembled.splice(
      0,
      assembled.length,
      ...legacyMaterialization.candidates,
    );
    renumberRanks();
  }

  // Dedupe by candidateId (keep first/best-ranked) so a candidate present in
  // more than one lane can't trip the (sourcingRequestId, candidateId) unique.
  const seenAssembledIds = new Set<string>();
  const dedupedAssembled = assembled.filter((a) => {
    if (seenAssembledIds.has(a.candidateId)) return false;
    seenAssembledIds.add(a.candidateId);
    return true;
  });
  assertPersistableCandidateIds(
    dedupedAssembled.map((candidate) => candidate.candidateId),
  );
  // 5. Persist under the processor lease for retry/stall idempotency.
  await persistSourcingCandidates(
    dedupedAssembled.map((a) => ({
      tenantId,
      sourcingRequestId: requestId,
      candidateId: a.candidateId,
      fitScore: a.fitScore,
      fitBreakdown: a.fitBreakdown
        ? toJsonValue({ ...a.fitBreakdown, matchTier: a.matchTier, locationMatchType: a.locationMatchType, dataConfidence: a.dataConfidence })
        : a.matchTier
          ? toJsonValue({ matchTier: a.matchTier, locationMatchType: a.locationMatchType, dataConfidence: a.dataConfidence })
          : Prisma.JsonNull,
      sourceType: a.sourceType, enrichmentStatus: 'pending', rank: a.rank,
    })),
  );


  const discoveryShortfallRate = discoveryTarget > 0
    ? Math.max(0, 1 - (discoveredCount / discoveryTarget))
    : 0;

  // Snapshot reuse stats: candidates in assembled list with fresh snapshots
  const snapshotReuseCount = assembled.filter((a) => {
    const row = poolById.get(a.candidateId);
    const snap = row?.intelligenceSnapshots?.[0];
    const now = new Date();
    return snap && (!snap.staleAfter || snap.staleAfter >= now);
  }).length;
  const snapshotStaleServedCount = assembled.filter((a) => {
    const row = poolById.get(a.candidateId);
    const snap = row?.intelligenceSnapshots?.[0];
    const now = new Date();
    return snap?.staleAfter && snap.staleAfter < now;
  }).length;

  // Skill score diagnostics: snapshot vs text fallback breakdown
  // Only count pool candidates (discovered have separate scoring context)
  let withSnapshotSkills = 0;
  let usingTextFallback = 0;
  const skillScoreSumBySource: Record<string, { sum: number; count: number }> = {};
  for (const a of assembled) {
    if (a.sourceType === 'discovered') continue; // discovered candidates scored separately
    const poolCandidate = poolForRankingById.get(a.candidateId);
    const hasSnapshot = Boolean(poolCandidate?.snapshot?.skillsNormalized?.length);
    if (hasSnapshot) withSnapshotSkills++;
    else usingTextFallback++;

    const scoredEntry = scoredPool.find((sc) => sc.candidateId === a.candidateId);
    if (scoredEntry) {
      const bucket = skillScoreSumBySource[a.sourceType] ?? { sum: 0, count: 0 };
      bucket.sum += scoredEntry.fitBreakdown.skillScore;
      bucket.count++;
      skillScoreSumBySource[a.sourceType] = bucket;
    }
  }
  const avgSkillScoreBySourceType: Record<string, number> = {};
  for (const [sourceType, { sum, count }] of Object.entries(skillScoreSumBySource)) {
    avgSkillScoreBySourceType[sourceType] = count > 0 ? Number((sum / count).toFixed(4)) : 0;
  }
  const total = withSnapshotSkills + usingTextFallback;
  const skillScoreDiagnostics = {
    withSnapshotSkills: total > 0 ? Number((withSnapshotSkills / total).toFixed(4)) : 0,
    usingTextFallback: total > 0 ? Number((usingTextFallback / total).toFixed(4)) : 0,
    avgSkillScoreBySourceType,
  };

  // Location hint coverage: fraction of pool candidates with a meaningful, non-noisy location
  // Excludes discovered candidates (not in pool, no location data yet)
  const scoredAssembled = assembled.filter((a) => a.sourceType !== 'discovered');
  const candidatesWithLocation = scoredAssembled.filter((a) => {
    const poolCandidate = poolForRankingById.get(a.candidateId);
    return hasMeaningfulLocation(poolCandidate?.snapshot?.location) ||
      hasMeaningfulLocation(poolCandidate?.locationHint);
  }).length;
  const locationHintCoverage = scoredAssembled.length > 0
    ? Number((candidatesWithLocation / scoredAssembled.length).toFixed(4))
    : 0;

  // Computed from full scoredPool (pre-assembly), not the assembled top-N.
  // This gives visibility into the entire candidate distribution for diagnostics.
  const locationMatchCounts = {
    city_exact: scoredPool.filter(sc => sc.locationMatchType === 'city_exact').length,
    city_alias: scoredPool.filter(sc => sc.locationMatchType === 'city_alias').length,
    country_only: scoredPool.filter(sc => sc.locationMatchType === 'country_only').length,
    unknown_location: scoredPool.filter(sc => sc.locationMatchType === 'unknown_location').length,
    none: scoredPool.filter(sc => sc.locationMatchType === 'none').length,
  };

  const result: OrchestratorResult = {
    candidateCount: assembled.length,
    poolCount: assembled.filter((a) => a.sourceType === 'pool').length,
    discoveredCount,
    discoveryShortfallRate,
    queriesExecuted,
    qualityGateTriggered,
    avgFitTopK: Number(avgFitTopK.toFixed(4)),
    countAboveThreshold,
    strictTopKCount,
    strictCoverageRate: Number(strictCoverageRate.toFixed(4)),
    effectiveStrategy,
    executionPath: 'legacy_assembly',
    discoveryReason,
    discoverySkippedReason,
    discoveryTelemetry,
    snapshotReuseCount,
    snapshotStaleServedCount,

    strictMatchedCount,
    expandedCount,
    expansionReason,
    requestedLocation: requirements.location,
    skillScoreDiagnostics,
    locationHintCoverage,
    strictDemotedCount,
    strictRescuedCount,
    strictRescueApplied,
    strictRescueMinFitScoreUsed,
    locationMatchCounts,
    demotedStrictWithCityMatch,
    strictBeforeDemotion,
    countryGuardFilteredCount,
    countryGuardSerpLocaleSkippedCount,
    countryGuardEscapeCounts,
    twoLayerPool: buildTwoLayerTelemetry(),
    selectedSnapshotTrack,
    locationCoverageTriggered,
    noveltySuppressedCount,
    noveltyWindowDays: config.noveltyWindowDays,
    noveltyKey,
    noveltyHint,
    discoveredOrphanCount: 0,
    dynamicQueryBudgetUsed,
    minDiscoveryPerRunApplied: Math.min(config.minDiscoveryPerRun, maxDiscoveryTarget),
    minDiscoveredInOutputApplied: discoveredReservedInOutput,
    discoveredPromotedCount,
    discoveredPromotedInTopCount,
    unknownLocationPromotedCount,
    discoveredPromotionRejections,
    discoveredDeferredFromFrontLoad,
    unknownLocationAssemblyCapRejected,
    unknownLocationPoolCapRejected,
    unknownLocationPoolAssembledCount,
    unknownLocationDiscoveredAssembledCount,
    unknownLocationPenaltyApplied,
    unknownLocationPoolPenaltyApplied,
    nonTechLocationMismatchPenaltyApplied,
    unknownLocationTop20DemotedInitial: unknownCapInitial.demoted,
    unknownLocationTop20DemotedFinal: unknownCapFinalDemoted,
    // Top-20 quality guards
    roleGuardTop20Demoted: roleGuardResult.demoted,
    roleGuardNoReplacementCount: roleGuardResult.noReplacementCount,
    roleGuardEpsilonBlockedCount: roleGuardResult.epsilonBlockedCount,
    skillFloorTop20Demoted: skillFloorResult.demoted,
    skillFloorBypassCount,
    skillFloorNoReplacementCount: skillFloorResult.noReplacementCount,
    skillFloorEpsilonBlockedCount: skillFloorResult.epsilonBlockedCount,
    // Supply diagnostics
    eligibleTechRoleCount,
    eligibleTechSkillCount,
    preGuardLowRoleTop20,
    preGuardLowSkillTop20,
    postGuardLowRoleTop20,
    postGuardLowSkillTop20,
    techTop20Thresholds: guardsEnabled
      ? { roleMin: config.techTop20RoleMin, roleCap: config.techTop20RoleCap, skillMin: config.techTop20SkillMin, guardsEnabled: true }
      : null,
    roleResolutionMetrics,
    locationResolutionMetrics,
    publicMemory,
  };

  log.info({ requestId, resolvedTrack: trackDecision?.track ?? null, ...result }, 'Orchestrator complete');
  return result;
}
