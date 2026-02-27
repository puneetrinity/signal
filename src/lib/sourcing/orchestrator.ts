import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { redis } from '@/lib/redis/client';
import { toJsonValue } from '@/lib/prisma/json';
import { createLogger } from '@/lib/logger';
import { buildJobRequirements, type SourcingJobContextInput } from './jd-digest';
import { rankCandidates } from './ranking';
import { discoverCandidates, type DiscoveryTelemetry } from './discovery';
import { getSourcingConfig } from './config';
import { createEnrichmentSession } from '@/lib/enrichment/queue';
import { isMeaningfulLocation, isNoisyLocationHint, canonicalizeLocation, extractPrimaryCity, compareFitWithConfidence } from './ranking';
import { getRecentlyExposedCandidateIds } from './novelty';
import type { CandidateForRanking, FitBreakdown, MatchTier, LocationMatchType, ScoredCandidate } from './ranking';
import type { TrackDecision } from './types';
import { jobTrackToDbFilter } from './types';
import {
  assessLocationCountryConsistency,
  computeSerpEvidence,
  deriveCountryCodeFromLocationText,
  extractSerpSignals,
} from '@/lib/search/serp-signals';

const log = createLogger('SourcingOrchestrator');

export interface OrchestratorResult {
  candidateCount: number;
  enrichedCount: number;
  poolCount: number;
  discoveredCount: number;
  discoveryShortfallRate: number; // 0.0 = no shortfall, 1.0 = total miss (0 when no discovery needed)
  autoEnrichQueued: number;
  staleRefreshQueued: number;
  queriesExecuted: number;
  qualityGateTriggered: boolean;
  avgFitTopK: number;
  countAboveThreshold: number;
  strictTopKCount: number;
  strictCoverageRate: number;
  discoveryReason: 'pool_deficit' | 'low_quality_pool' | 'deficit_and_low_quality' | 'minimum_discovery_floor' | null;
  discoverySkippedReason: 'daily_serp_cap_reached' | 'cap_guard_unavailable' | null;
  discoveryTelemetry: DiscoveryTelemetry | null;
  snapshotReuseCount: number;
  snapshotStaleServedCount: number;
  snapshotRefreshQueuedCount: number;
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
  locationMatchCounts: { city_exact: number; city_alias: number; country_only: number; none: number };
  demotedStrictWithCityMatch: number;
  strictBeforeDemotion: number;
  countryGuardFilteredCount: number;
  countryGuardSerpLocaleSkippedCount: number;
  selectedSnapshotTrack: string;
  locationCoverageTriggered: boolean;
  noveltySuppressedCount: number;
  noveltyWindowDays: number;
  noveltyKey: string | null;
  noveltyHint: string | null;
  discoveredEnrichedCount: number;
  discoveredOrphanCount: number;
  discoveredOrphanQueued: number;
  dynamicQueryBudgetUsed: boolean;
  minDiscoveryPerRunApplied: number;
  minDiscoveredInOutputApplied: number;
  discoveredPromotedCount: number;
  discoveredPromotedInTopCount: number;
}

interface AssembledCandidate {
  candidateId: string;
  fitScore: number | null;
  fitBreakdown: FitBreakdown | null;
  matchTier: MatchTier | null;
  locationMatchType: LocationMatchType | null;
  sourceType: string;
  enrichmentStatus: string;
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
      locationHint: row.locationHint,
      searchTitle: row.searchTitle,
      searchSnippet: row.searchSnippet,
      enrichmentStatus: row.enrichmentStatus,
      lastEnrichedAt: row.lastEnrichedAt,
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
  const hasLocationConstraint = Boolean(requirements.location?.trim());
  const poolForRankingById = new Map(poolForRanking.map((r) => [r.id, r]));
  const requestedCountryCode = config.countryGuardEnabled && hasLocationConstraint
    ? deriveCountryCodeFromLocationText(requirements.location)
    : null;

  const scoredPoolRaw = rankCandidates(poolForRanking, requirements, { fitScoreEpsilon: config.fitScoreEpsilon, locationBoostWeight: config.locationBoostWeight });
  const countryGuardFilteredCandidateIds = new Set<string>();
  let countryGuardSerpLocaleSkippedCount = 0;
  let scoredPool = scoredPoolRaw;
  if (requestedCountryCode) {
    scoredPool = scoredPoolRaw.filter((sc) => {
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

      return true;
    });
  }
  let countryGuardFilteredCount = countryGuardFilteredCandidateIds.size;
  if (countryGuardFilteredCount > 0) {
    log.info(
      {
        requestId,
        requestedCountryCode,
        countryGuardFilteredCount,
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
  const enrichedCandidates = scoredPool.filter((sc) => poolById.get(sc.candidateId)?.enrichmentStatus === 'completed');
  const enrichedCount = enrichedCandidates.length;

  let discoveredCount = 0;
  let discoveredCandidateIds: string[] = [];
  let discoveredReservedInOutput = 0;
  let discoveredPromotedCount = 0;
  let discoveredPromotedInTopCount = 0;
  const promotedDiscoveredById = new Map<string, ScoredCandidate>();
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
  // Elevated discovery share when quality gate triggers (configurable, default 40%)
  const qualityDrivenTarget = qualityGateTriggered
    ? Math.ceil(config.targetCount * config.minDiscoveryShareLowQuality)
    : 0;
  const maxDiscoveryTarget = Math.ceil(config.targetCount * config.maxDiscoveryShare);
  const minDiscoveryFloor = Math.min(config.minDiscoveryPerRun, maxDiscoveryTarget);
  const desiredDiscoveryTarget = Math.min(
    Math.max(poolDeficit, qualityDrivenTarget, strictCoverageDeficit, minDiscoveryFloor),
    maxDiscoveryTarget,
  );

  if (poolDeficit > 0 && qualityGateTriggered) discoveryReason = 'deficit_and_low_quality';
  else if (poolDeficit > 0) discoveryReason = 'pool_deficit';
  else if (qualityGateTriggered) discoveryReason = 'low_quality_pool';
  else if (minDiscoveryFloor > 0) discoveryReason = 'minimum_discovery_floor';

  const effectiveMaxQueries = qualityGateTriggered
    ? config.maxSerpQueries * config.dynamicQueryMultiplier
    : config.maxSerpQueries;
  let dynamicQueryBudgetUsed = false;

  if (desiredDiscoveryTarget > 0) {
    const aggressive = enrichedCount < config.minGoodEnough;
    discoveryTarget = aggressive ? Math.min(desiredDiscoveryTarget, config.jobMaxEnrich) : desiredDiscoveryTarget;
    dynamicQueryBudgetUsed = qualityGateTriggered && config.dynamicQueryMultiplier > 1;
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
          enrichedCount,
          poolDeficit,
          qualityGateTriggered,
          avgFitTopK: Number(avgFitTopK.toFixed(3)),
          countAboveThreshold,
          minCountAboveRequired,
          discoveryReason,
          discoveryTarget,
          maxQueries: budget.maxQueries,
          aggressive,
        },
        'Starting discovery',
      );

      let usedQueries = 0;
      try {
        const discovery = await discoverCandidates(
          tenantId,
          requirements,
          discoveryTarget,
          existingLinkedinIds,
          budget.maxQueries,
          { config, track: trackDecision?.track },
        );

        discoveredCount = discovery.candidates.length;
        discoveredCandidateIds = discovery.candidates.map((d) => d.candidateId);
        queriesExecuted = discovery.queriesExecuted;
        discoveryTelemetry = discovery.telemetry;
        usedQueries = queriesExecuted;

        if (discoveredCandidateIds.length > 0) {
          const discoveredRows = await prisma.candidate.findMany({
            where: { id: { in: discoveredCandidateIds } },
            select: {
              id: true,
              headlineHint: true,
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
          const scoredDiscovered = rankCandidates(discoveredForRanking, requirements, { fitScoreEpsilon: config.fitScoreEpsilon, locationBoostWeight: config.locationBoostWeight });
          for (const sc of scoredDiscovered) {
            scoredDiscoveredById.set(sc.candidateId, sc);
            const passesLocationGate = !hasLocationConstraint || sc.locationMatchType !== 'none';
            const passesFitGate = sc.fitScore >= config.discoveredPromotionMinFitScore;
            if (passesLocationGate && passesFitGate) {
              promotedDiscoveredById.set(sc.candidateId, sc);
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
  const enrichedIds = new Set(enrichedCandidates.map((row) => row.candidateId));
  let rank = 1;

  const computeDataConfidence = (candidate: Omit<AssembledCandidate, 'rank' | 'dataConfidence'>): 'high' | 'medium' | 'low' => {
    if (candidate.enrichmentStatus === 'completed' && candidate.fitBreakdown?.skillScoreMethod === 'snapshot') {
      return 'high';
    }
    if (candidate.fitScore !== null && (candidate.fitBreakdown?.skillScoreMethod === 'text_fallback' || (candidate.enrichmentStatus === 'completed' && candidate.fitBreakdown?.skillScoreMethod !== 'snapshot'))) {
      return 'medium';
    }
    return 'low';
  };

  const pushCandidate = (candidate: Omit<AssembledCandidate, 'rank' | 'dataConfidence'>): boolean => {
    if (assembled.length >= config.targetCount) return false;
    if (assembledIds.has(candidate.candidateId)) return false;
    const dataConfidence = computeDataConfidence(candidate);
    assembled.push({ ...candidate, dataConfidence, rank: rank++ });
    assembledIds.add(candidate.candidateId);
    return true;
  };

  // Partition pool into strict vs expanded tiers (sorted by fitScore within each)
  const strictPool = scoredPool.filter((sc) => sc.matchTier === 'strict_location');
  let expandedPool = scoredPool.filter((sc) => sc.matchTier === 'expanded_location');

  // Quality guard: demote strict candidates below fitScore floor to expanded pool
  let strictDemotedCount = 0;
  const qualifiedStrict: typeof strictPool = [];
  const strictBeforeDemotion = strictPool.length;
  const demotedStrictCandidates: typeof strictPool = [];
  let demotedStrictWithCityMatch = 0;
  let strictRescuedCount = 0;
  let strictRescueApplied = false;
  let strictRescueMinFitScoreUsed: number | null = null;
  for (const sc of strictPool) {
    if (sc.fitScore < config.bestMatchesMinFitScore) {
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
      .filter((sc) => sc.fitScore >= config.strictRescueMinFitScore)
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
      const isEnriched = enrichedIds.has(sc.candidateId);
      pushCandidate({
        candidateId: sc.candidateId,
        fitScore: sc.fitScore,
        fitBreakdown: sc.fitBreakdown,
        matchTier: sc.matchTier,
        locationMatchType: sc.locationMatchType,
        sourceType: isEnriched ? 'pool_enriched' : 'pool',
        enrichmentStatus: isEnriched ? 'completed' : (poolById.get(sc.candidateId)?.enrichmentStatus ?? 'pending'),
      });
    }
  };

  const promotedDiscoveredIdsOrdered = Array.from(promotedDiscoveredById.values()).map((sc) => sc.candidateId);
  discoveredReservedInOutput = Math.min(
    config.minDiscoveredInOutput,
    discoveredCandidateIds.length,
    config.targetCount,
  );
  const promotedDiscoveredTopIds = promotedDiscoveredIdsOrdered
    .filter((id) => promotedDiscoveredById.get(id)?.matchTier === 'strict_location')
    .slice(0, discoveredReservedInOutput);
  discoveredPromotedInTopCount = promotedDiscoveredTopIds.length;
  const discoveredReserveRemaining = Math.max(0, discoveredReservedInOutput - discoveredPromotedInTopCount);
  const poolFillLimit = Math.max(0, config.targetCount - discoveredReserveRemaining);

  const pushDiscoveredCandidate = (candidateId: string): void => {
    const promoted = promotedDiscoveredById.get(candidateId);
    const enrichmentStatus = discoveredRowsById.get(candidateId)?.enrichmentStatus ?? 'pending';
    if (promoted) {
      pushCandidate({
        candidateId,
        fitScore: promoted.fitScore,
        fitBreakdown: promoted.fitBreakdown,
        matchTier: promoted.matchTier,
        locationMatchType: promoted.locationMatchType,
        sourceType: 'discovered',
        enrichmentStatus,
      });
      return;
    }
    const scored = scoredDiscoveredById.get(candidateId);
    pushCandidate({
      candidateId,
      fitScore: scored?.fitScore ?? null,
      fitBreakdown: scored?.fitBreakdown ?? null,
      matchTier: scored?.matchTier ?? 'expanded_location',
      locationMatchType: scored?.locationMatchType ?? 'none',
      sourceType: 'discovered',
      enrichmentStatus,
    });
  };

  // Pass 1: place high-confidence discovered candidates at the top (bounded by reserve).
  for (const candidateId of promotedDiscoveredTopIds) {
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
  // Promotion-qualified discovered are consumed first, then broader discovered backfill.
  const promotedTopIdSet = new Set(promotedDiscoveredTopIds);
  const discoveredFillOrder = [
    ...promotedDiscoveredIdsOrdered.filter((candidateId) => !promotedTopIdSet.has(candidateId)),
    ...discoveredCandidateIds.filter((candidateId) => !promotedDiscoveredById.has(candidateId)),
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
            sourceType: enrichedIds.has(sc.candidateId) ? 'pool_enriched' : 'pool',
            enrichmentStatus: poolById.get(sc.candidateId)?.enrichmentStatus ?? 'pending',
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
        sourceType: a.sourceType,
        enrichmentStatus: a.enrichmentStatus,
        rank: a.rank,
      })),
    }),
  ]);

  // 6. Auto-enrich top N unenriched candidates (cross-run dedupe)
  const candidateIdsToEnqueue = assembled
    .filter((a) => a.enrichmentStatus !== 'completed')
    .slice(0, config.initialEnrichCount)
    .map((a) => a.candidateId);

  const now = new Date();
  const staleCandidateIds = poolForRanking
    .filter((r) => r.snapshot?.staleAfter && r.snapshot.staleAfter < now)
    .slice(0, config.staleRefreshMaxPerRun)
    .map((r) => r.id);

  const discoveredUnenriched = assembled
    .filter((a) => a.sourceType === 'discovered' && a.enrichmentStatus !== 'completed')
    .slice(0, config.discoveredEnrichReserve)
    .map((a) => a.candidateId);
  const discoveredOrphanCandidates = discoveredCandidateIds.filter((candidateId) => !assembledIds.has(candidateId));
  const discoveredOrphanCandidateIds = discoveredOrphanCandidates
    .slice(0, config.discoveredOrphanEnrichReserve);
  const allPotentialIds = [...new Set([
    ...candidateIdsToEnqueue,
    ...staleCandidateIds,
    ...discoveredUnenriched,
    ...discoveredOrphanCandidateIds,
  ])];
  const candidateSearchMetaById = new Map<string, unknown>(
    poolRows.map((row) => [row.id, row.searchMeta]),
  );
  if (candidateIdsToEnqueue.length > 0) {
    const missingSearchMetaIds = candidateIdsToEnqueue.filter((id) => !candidateSearchMetaById.has(id));
    if (missingSearchMetaIds.length > 0) {
      const missingCandidates = await prisma.candidate.findMany({
        where: { id: { in: missingSearchMetaIds } },
        select: { id: true, searchMeta: true },
      });
      for (const candidate of missingCandidates) {
        candidateSearchMetaById.set(candidate.id, candidate.searchMeta);
      }
    }
  }
  const activeSessions = allPotentialIds.length > 0
    ? await prisma.enrichmentSession.findMany({
        where: {
          candidateId: { in: allPotentialIds },
          tenantId,
          status: { in: ['queued', 'running'] },
        },
        select: { candidateId: true },
      })
    : [];
  const alreadyActiveIds = new Set(activeSessions.map((s) => s.candidateId));

  const computeAutoEnrichPriority = (candidate: AssembledCandidate): number => {
    const basePriority = 10 + (candidate.rank - 1); // rank 1 → 10
    const searchMeta = candidateSearchMetaById.get(candidate.candidateId);
    const evidence = computeSerpEvidence(searchMeta);
    let adjustment = 0;

    // Recency adjustment — maps evidence buckets to original adjustments:
    //   fresh (≤30d, confidence ≥ 0.7): -3
    //   recent (≤90d, confidence ≥ 0.55): -1
    //   stale (>365d, has date): +2
    if (evidence.hasResultDate) {
      if (evidence.resultDateDays !== null && evidence.resultDateDays <= 30) adjustment -= 3;
      else if (evidence.resultDateDays !== null && evidence.resultDateDays <= 90) adjustment -= 1;
      else if (evidence.resultDateDays !== null && evidence.resultDateDays > 365) adjustment += 2;
    }

    // Location consistency via SERP locale
    const locationConsistency = assessLocationCountryConsistency(
      requirements.location,
      evidence.localeCountryCode,
    );
    if (locationConsistency === 'match') adjustment -= 4;
    else if (locationConsistency === 'mismatch') adjustment += 4;

    return Math.max(1, Math.min(99, basePriority + adjustment));
  };

  const enqueuedIds = new Set<string>();
  let autoEnrichQueued = 0;
  for (const a of assembled.filter((a) => a.enrichmentStatus !== 'completed').slice(0, config.initialEnrichCount)) {
    if (alreadyActiveIds.has(a.candidateId) || enqueuedIds.has(a.candidateId)) continue;
    try {
      const priority = computeAutoEnrichPriority(a);
      await createEnrichmentSession(tenantId, a.candidateId, { priority });
      enqueuedIds.add(a.candidateId);
      autoEnrichQueued++;
    } catch (error) {
      log.warn({ error, candidateId: a.candidateId, requestId }, 'Auto-enrich enqueue failed');
    }
  }

  // 6b. Discovered enrichment reserve (additive, separate from top-N)
  let discoveredEnrichedCount = 0;
  for (const a of assembled.filter((a) => a.sourceType === 'discovered' && a.enrichmentStatus !== 'completed' && !enqueuedIds.has(a.candidateId))) {
    if (discoveredEnrichedCount >= config.discoveredEnrichReserve) break;
    if (alreadyActiveIds.has(a.candidateId)) continue;
    try {
      const priority = 30 + discoveredEnrichedCount; // lower priority than rank-based (10+), higher than stale (50)
      await createEnrichmentSession(tenantId, a.candidateId, { priority });
      enqueuedIds.add(a.candidateId);
      discoveredEnrichedCount++;
    } catch (error) {
      log.warn({ error, candidateId: a.candidateId, requestId }, 'Discovered enrich enqueue failed');
    }
  }

  // 6c. Discovered orphan reserve (discovered this run but not assembled)
  let discoveredOrphanQueued = 0;
  for (const candidateId of discoveredOrphanCandidateIds) {
    if (alreadyActiveIds.has(candidateId) || enqueuedIds.has(candidateId)) continue;
    try {
      const priority = 40 + discoveredOrphanQueued; // lower than in-output discovered reserve, above stale refresh
      await createEnrichmentSession(tenantId, candidateId, { priority });
      enqueuedIds.add(candidateId);
      discoveredOrphanQueued++;
    } catch (error) {
      log.warn({ error, candidateId, requestId }, 'Discovered orphan enrich enqueue failed');
    }
  }

  // 7. Stale-refresh queueing (separate budget)
  let staleRefreshQueued = 0;
  const staleFromPool = poolForRanking
    .filter((r) => r.snapshot?.staleAfter && r.snapshot.staleAfter < now && !enqueuedIds.has(r.id) && !alreadyActiveIds.has(r.id))
    .slice(0, config.staleRefreshMaxPerRun);

  for (const r of staleFromPool) {
    try {
      await createEnrichmentSession(tenantId, r.id, { priority: 50 });
      enqueuedIds.add(r.id);
      staleRefreshQueued++;
    } catch (error) {
      log.warn({ error, candidateId: r.id, requestId }, 'Stale-refresh enqueue failed');
    }
  }

  const discoveryShortfallRate = discoveryTarget > 0
    ? (discoveryTarget - discoveredCount) / discoveryTarget
    : 0;

  // Snapshot reuse stats: candidates in assembled list with fresh snapshots
  const snapshotReuseCount = assembled.filter((a) => {
    const row = poolById.get(a.candidateId);
    const snap = row?.intelligenceSnapshots?.[0];
    return snap && (!snap.staleAfter || snap.staleAfter >= now);
  }).length;
  const snapshotStaleServedCount = assembled.filter((a) => {
    const row = poolById.get(a.candidateId);
    const snap = row?.intelligenceSnapshots?.[0];
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
    none: scoredPool.filter(sc => sc.locationMatchType === 'none').length,
  };

  const result: OrchestratorResult = {
    candidateCount: assembled.length,
    enrichedCount: assembled.filter((a) => a.sourceType === 'pool_enriched').length,
    poolCount: assembled.filter((a) => a.sourceType === 'pool' || a.sourceType === 'pool_enriched').length,
    discoveredCount,
    discoveryShortfallRate,
    autoEnrichQueued,
    staleRefreshQueued,
    queriesExecuted,
    qualityGateTriggered,
    avgFitTopK: Number(avgFitTopK.toFixed(4)),
    countAboveThreshold,
    strictTopKCount,
    strictCoverageRate: Number(strictCoverageRate.toFixed(4)),
    discoveryReason,
    discoverySkippedReason,
    discoveryTelemetry,
    snapshotReuseCount,
    snapshotStaleServedCount,
    snapshotRefreshQueuedCount: staleRefreshQueued,
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
    selectedSnapshotTrack,
    locationCoverageTriggered,
    noveltySuppressedCount,
    noveltyWindowDays: config.noveltyWindowDays,
    noveltyKey,
    noveltyHint,
    discoveredEnrichedCount,
    discoveredOrphanCount: discoveredOrphanCandidates.length,
    discoveredOrphanQueued,
    dynamicQueryBudgetUsed,
    minDiscoveryPerRunApplied: Math.min(config.minDiscoveryPerRun, maxDiscoveryTarget),
    minDiscoveredInOutputApplied: discoveredReservedInOutput,
    discoveredPromotedCount,
    discoveredPromotedInTopCount,
  };

  log.info({ requestId, resolvedTrack: trackDecision?.track ?? null, ...result }, 'Orchestrator complete');
  return result;
}
