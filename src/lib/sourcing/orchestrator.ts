import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { redis } from '@/lib/redis/client';
import { toJsonValue } from '@/lib/prisma/json';
import { createLogger } from '@/lib/logger';
import { buildJobRequirements, type SourcingJobContextInput } from './jd-digest';
import { rankCandidates } from './ranking-new';
import { discoverCandidates, type DiscoveredCandidate, type DiscoveryTelemetry } from './discovery';
import { getLocationBoostWeight, getSourcingConfig } from './config';
import { isMeaningfulLocation, isNoisyLocationHint, canonicalizeLocation, extractPrimaryCity, compareFitWithConfidence, STRONG_LOCATION_TYPES } from './ranking-new';
import { getRecentlyExposedCandidateIds } from './novelty';
import type { CandidateForRanking, FitBreakdown, MatchTier, LocationMatchType, ScoredCandidate } from './ranking-new';
import type { TrackDecision } from './types';
import { jobTrackToDbFilter } from './types';
import { guardedTopKSwap } from './top20-guards';
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
  logSourcingRaw,
  logRankingResult,
  resetPipelineLogTimers,
} from './debug-pipeline-logs';

const log = createLogger('SourcingOrchestrator');

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
  effectiveStrategy: 'pool_first' | 'discovery_first';
  discoveryReason: 'pool_deficit' | 'low_quality_pool' | 'deficit_and_low_quality' | 'minimum_discovery_floor' | 'pool_role_mismatch' | 'deficit_and_role_mismatch' | 'strategy_discovery_first' | null;
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
): Promise<OrchestratorResult> {
  const config = getSourcingConfig();
  const requirements = buildJobRequirements(jobContext);

  const sendProgressCallback = async (event: string, eventData: any = {}) => {
    try {
      const r = await prisma.jobSourcingRequest.findUnique({
        where: { id: requestId },
        select: { callbackUrl: true, externalJobId: true }
      });
      if (r?.callbackUrl) {
        const { deliverCallback } = await import('./callback');
        await deliverCallback(requestId, tenantId, r.callbackUrl, {
          version: 1,
          requestId,
          externalJobId: r.externalJobId,
          status: 'partial',
          candidateCount: 0,
          event: event as any,
          candidateData: eventData
        }, false);
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

  // 1. Query tenant pool (capped at 5000 most recent)
  const snapshotTrackFilter = jobTrackToDbFilter(trackDecision?.track);
  const selectedSnapshotTrack = snapshotTrackFilter.length === 1
    ? snapshotTrackFilter[0]
    : 'tech'; // blended uses deterministic tech-first preference

  const poolRows = await prisma.candidate.findMany({
    where: { tenantId },
    select: {
      id: true,
      linkedinId: true,
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
    take: 5000,
    orderBy: { updatedAt: 'desc' },
  });

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

  // 2.5 ActiveGraph Home Pool Search
  const { generateTagsFromJD, searchHomePool, HOME_POOL_LIMIT } = await import(
    './activegraph-client'
  );
  const homeTags = generateTagsFromJD(requirements);
  let homeCandidates: any[] = [];
  try {
    // Search ActiveGraph for candidates matching the JD tags
    homeCandidates = await searchHomePool(homeTags, tenantId, HOME_POOL_LIMIT, requestId);
    log.info({ requestId, tags: homeTags, found: homeCandidates.length }, 'ActiveGraph home pool searched');
  } catch (err) {
    log.error({ err }, 'Failed to search ActiveGraph home pool');
  }

  // Merge ActiveGraph candidates into the pool for ranking if they aren't already there
  let addedFromHome = 0;
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
  log.info({ requestId, addedFromHome, totalPool: poolForRanking.length }, 'Merged ActiveGraph candidates into ranking pool');

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
        !(sc.fitScore >= 0.60 && sc.fitBreakdown.roleScore >= 0.70)
      ) {
        sc.fitScore *= config.unknownLocationPenaltyMultiplier;
        unknownLocationPoolPenaltyApplied++;
      }
    }
    if (unknownLocationPoolPenaltyApplied > 0) {
      scoredPool.sort((a, b) => compareFitWithConfidence(a, b, config.fitScoreEpsilon));
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
      scoredPool.sort((a, b) => compareFitWithConfidence(a, b, config.fitScoreEpsilon));
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

  // Pre-assembly location coverage estimate from scored pool
  const poolWithLocation = scoredPool.filter((sc) => {
    const poolCandidate = poolForRankingById.get(sc.candidateId);
    return hasMeaningfulLocation(poolCandidate?.snapshot?.location) ||
      hasMeaningfulLocation(poolCandidate?.locationHint);
  }).length;
  const poolLocationCoverage = scoredPool.length > 0
    ? poolWithLocation / scoredPool.length
    : 0;
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

  const poolSize = scoredPool.length;
  const poolDeficit = Math.max(0, config.targetCount - poolSize);
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
      const existingLinkedinIds = new Set(poolRows.map((r) => r.linkedinId));
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

        try {
          console.log('\n' + '🔍'.repeat(20));
          console.log('🚀 [ORCHESTRATOR] INITIATING PRIMARY DISCOVERY (CRUSTDATA SCREENER)');
          console.log('📋 [ORCHESTRATOR] STRATEGY: Screener flat schema → 240 profiles with skills/emails → rank locally → top 100');
          await sendProgressCallback('crustdata_fetching');
          const { searchPeople } = await import('./crustdata-client');
          const crustProfiles = await searchPeople(requirements, 300);
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

              return {
                // ── CandidateForRanking fields ──────────────────────────
                id: url,
                headlineHint: headline,
                locationHint: location,
                searchTitle: (currentJob?.title || currentJob?.name) || headline,
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
              };
            }).filter((p: any) => p.linkedinUrl);


            // Combine ActiveGraph/Pool candidates with fresh Crustdata candidates
            // Filter out pool candidates that we just fetched from Crustdata to avoid duplicates
            const fetchedCrustdataIds = new Set(mappedForRanking.map(c => c.id));
            const activeGraphAndPool = poolForRanking.filter(c => !fetchedCrustdataIds.has(c.id));
            const combinedForRanking = [...activeGraphAndPool, ...mappedForRanking];

            // Local ranking against full JD
            const locationBoostWeight = getLocationBoostWeight(config, trackDecision?.track);
            const scored = rankCandidates(combinedForRanking, requirements, {
              fitScoreEpsilon: config.fitScoreEpsilon,
              track: trackDecision?.track,
            });

            console.log(`📊 [ORCHESTRATOR] LOCAL RANKING DONE — ${scored.length} candidates scored`);
            console.log(`🥇 [ORCHESTRATOR] TOP fit score: ${scored[0]?.fitScore?.toFixed(3) ?? 'N/A'}`);
            console.log(`📉 [ORCHESTRATOR] #100 fit score: ${scored[99]?.fitScore?.toFixed(3) ?? 'N/A'}`);

            // ── Rank first (CPU-only, ~1s), then upsert only top 100 ──────────
            // Previously all 300 were upserted BEFORE ranking: 20 sequential
            // batches × ~2s Railway RTT = ~40s wasted. Now we rank in-memory
            // first and only write the 100 we actually serve (7 batches ≈ 14s).
            const profileByUrl = new Map(mappedForRanking.map((p) => [p.id, p]));

            // ── Ingest all Crustdata profiles to ActiveGraph (Background) ──────────
            const { ingestCandidate, generateTagsFromCandidate } = await import('./activegraph-client');
            Promise.all(mappedForRanking.map(async (candidate) => {
              const tags = generateTagsFromCandidate(candidate);
              return ingestCandidate(tenantId, candidate, tags, requestId);
            })).then(results => {
              const successCount = results.filter(Boolean).length;
              console.log(`📡 [ORCHESTRATOR] INGESTED ${successCount}/${mappedForRanking.length} TO ACTIVEGRAPH (Async)`);
            }).catch(err => {
              console.error(`[activegraph-client] Batch ingest failed:`, err);
            });

            // Build top-100 profiles for DB write (ranked order already in `scored`)
            const top100Profiles = scored.slice(0, 100).map((sc) => {
              const p = profileByUrl.get(sc.candidateId);
              if (!p) return null; // Was from pool/ActiveGraph, already in DB
              return {
                title: p.searchTitle || '',
                snippet: p.searchSnippet || '',
                linkedinUrl: p.linkedinUrl,
                linkedinId: extractLinkedInIdFromUrl(p.linkedinUrl) || '',
                name: p.name,
                headline: p.headlineHint,
                location: p.locationHint || '',
                companyHint: (p as any).companyHint ?? undefined,
                profilePictureUrl: (p as any).profilePictureUrl ?? undefined,
                crustdata: (p as any).crustdata,
              };
            }).filter((p): p is NonNullable<typeof p> => p !== null && !!p.linkedinId);

            const { upsertDiscoveredCandidates } = await import('./upsert-candidates');
            const candidateMap = await upsertDiscoveredCandidates(tenantId, top100Profiles, 'crustdata_query', 'crustdata');

            console.log(`💾 [ORCHESTRATOR] UPSERTED ${candidateMap.size} CANDIDATES TO DB`);

            const allRankedWithIds = scored.slice(0, 100).map((sc) => {
              const profile = profileByUrl.get(sc.candidateId);
              const poolCandidate = poolForRankingById.get(sc.candidateId);
              
              const linkedinUrl = profile?.linkedinUrl || poolCandidate?.id || '';
              const linkedinId = extractLinkedInIdFromUrl(linkedinUrl);
              const dbId = profile && linkedinId ? candidateMap.get(linkedinId) : poolCandidate?.id;

              return {
                candidateId: dbId || '',
                linkedinUrl: linkedinUrl,
                name: profile?.name || '',
                headlineHint: profile?.headlineHint || poolCandidate?.headlineHint || '',
                locationHint: profile?.locationHint || poolCandidate?.locationHint || '',
                fitScore: sc.fitScore,
                matchTier: sc.matchTier,
                locationMatchType: sc.locationMatchType,
                fitBreakdown: sc.fitBreakdown,
              };
            }).filter((c) => c.candidateId);

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
            console.log('⚠️ [ORCHESTRATOR] CRUSTDATA RETURNED 0 RESULTS');
            discovery = { candidates: [], queriesExecuted: 1, queriesBuilt: 1, telemetry: { queryRuns: [] } };
          }
        } catch (err) {
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
          const finalAssembled: AssembledCandidate[] = crustdataPrimaryList.map((sc, index) => {
            return {
              candidateId: sc.candidateId,
              name: sc.name || '',
              headlineHint: sc.headlineHint || '',
              locationHint: sc.locationHint || '',
              sourceType: 'crustdata_query',
              matchTier: sc.matchTier,
              locationMatchType: sc.locationMatchType,
              fitScore: sc.fitScore,
              fitBreakdown: sc.fitBreakdown,
              rank: index + 1,
              enrichmentStatus: 'pending',
              dataConfidence: 'medium',
            };
          });

          await sendProgressCallback('pipeline_complete');

          // Delete any existing JobSourcingCandidate records for retry idempotency
          await prisma.$transaction([
            prisma.jobSourcingCandidate.deleteMany({
              where: { sourcingRequestId: requestId },
            }),
            prisma.jobSourcingCandidate.createMany({
              data: finalAssembled.map((a) => ({
                tenantId,
                sourcingRequestId: requestId,
                candidateId: a.candidateId,
                fitScore: a.fitScore,
                fitBreakdown: a.fitBreakdown
                  ? toJsonValue({ ...a.fitBreakdown, matchTier: a.matchTier, locationMatchType: a.locationMatchType, dataConfidence: a.dataConfidence })
                  : toJsonValue({ matchTier: a.matchTier, locationMatchType: a.locationMatchType, dataConfidence: a.dataConfidence }),
                sourceType: a.sourceType, enrichmentStatus: 'pending', rank: a.rank,
              })),
            }),
          ]);

          console.log(`💾 [ORCHESTRATOR] PERSISTED ${finalAssembled.length} ENRICHED CANDIDATES TO JOBSOURCINGCANDIDATES!`);

          const avgFitTopK = finalAssembled.length > 0
            ? finalAssembled.reduce((sum, c) => sum + (c.fitScore ?? 0), 0) / finalAssembled.length
            : 0;

          const result: OrchestratorResult = {
            discoveredCount: finalAssembled.length,
            discoveryShortfallRate: 0,
            candidateCount: finalAssembled.length,
            poolCount: 0,
            queriesExecuted: 1,
            qualityGateTriggered: false,
            avgFitTopK: Number(avgFitTopK.toFixed(4)),
            countAboveThreshold: finalAssembled.length,
            strictTopKCount: finalAssembled.length,
            strictCoverageRate: 1.0,
            effectiveStrategy: 'discovery_first',
            discoveryReason: 'strategy_discovery_first',
            discoverySkippedReason: null,
            discoveryTelemetry: { queryRuns: [] } as any,
            snapshotReuseCount: 0,
            snapshotStaleServedCount: 0,
            strictMatchedCount: finalAssembled.length,
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
            discoveredPromotedCount: finalAssembled.length,
            discoveredPromotedInTopCount: finalAssembled.length,
            unknownLocationPromotedCount: 0,
            discoveredPromotionRejections: { total: 0, locationGate: 0, fitGate: 0, roleGate: 0, confidence: 0, phase: 0, unknownCap: 0 },
            discoveredDeferredFromFrontLoad: 0,
            unknownLocationAssemblyCapRejected: 0,
            unknownLocationPoolCapRejected: 0,
            unknownLocationPoolAssembledCount: 0,
            unknownLocationDiscoveredAssembledCount: 0,
            unknownLocationPenaltyApplied: 0,
            unknownLocationPoolPenaltyApplied: 0,
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
          });

          // Penalize discovered unknown_location candidates that don't clear quality thresholds
          for (const sc of scoredDiscovered) {
            if (
              sc.locationMatchType === 'unknown_location' &&
              !(sc.fitScore >= 0.50 && sc.fitBreakdown.roleScore >= 0.7)
            ) {
              sc.fitScore *= config.unknownLocationPenaltyMultiplier;
              unknownLocationPenaltyApplied++;
            }
          }
          // Re-sort after penalty so promotion/front-load ordering reflects demotion.
          if (unknownLocationPenaltyApplied > 0) {
            scoredDiscovered.sort((a, b) => compareFitWithConfidence(a, b, config.fitScoreEpsilon));
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

            const roleGate = sc.fitBreakdown.roleScore >= 0.7;
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
    expandedPool.sort((a, b) => compareFitWithConfidence(a, b, config.fitScoreEpsilon));
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

  // 5. Persist: deleteMany + createMany for retry idempotency
  await prisma.$transaction([
    prisma.jobSourcingCandidate.deleteMany({
      where: { sourcingRequestId: requestId },
    }),
    prisma.jobSourcingCandidate.createMany({
      data: assembled.map((a) => ({
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
    }),
  ]);


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
  };

  log.info({ requestId, resolvedTrack: trackDecision?.track ?? null, ...result }, 'Orchestrator complete');
  return result;
}


