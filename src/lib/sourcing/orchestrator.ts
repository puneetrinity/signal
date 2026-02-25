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
import { isMeaningfulLocation, isNoisyLocationHint, canonicalizeLocation, extractPrimaryCity } from './ranking';
import { getRecentlyExposedCandidateIds } from './novelty';
import type { CandidateForRanking, FitBreakdown, MatchTier, LocationMatchType } from './ranking';
import type { TrackDecision } from './types';
import { jobTrackToDbFilter } from './types';
import {
  assessLocationCountryConsistency,
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
  discoveryReason: 'pool_deficit' | 'low_quality_pool' | 'deficit_and_low_quality' | null;
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
  selectedSnapshotTrack: string;
  locationCoverageTriggered: boolean;
  noveltySuppressedCount: number;
  noveltyWindowDays: number;
  noveltyKey: string | null;
  noveltyHint: string | null;
  discoveredEnrichedCount: number;
  dynamicQueryBudgetUsed: boolean;
}

interface AssembledCandidate {
  candidateId: string;
  fitScore: number | null;
  fitBreakdown: FitBreakdown | null;
  matchTier: MatchTier | null;
  locationMatchType: LocationMatchType | null;
  sourceType: string;
  enrichmentStatus: string;
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

  // 2. Rank pool candidates
  const poolForRanking: CandidateForRanking[] = poolRows.map((r) => {
    // For blended, deterministically prefer latest tech snapshot when present.
    // We fetch all matched tracks sorted by computedAt so per-track fallback is stable.
    const latestTechSnap = r.intelligenceSnapshots.find((s) => s.track === 'tech') ?? null;
    const latestNonTechSnap = r.intelligenceSnapshots.find((s) => s.track === 'non-tech') ?? null;
    const snap = snapshotTrackFilter.length === 1
      ? (r.intelligenceSnapshots[0] ?? null)
      : (latestTechSnap ?? latestNonTechSnap);
    return {
      id: r.id,
      headlineHint: r.headlineHint,
      locationHint: r.locationHint,
      searchTitle: r.searchTitle,
      searchSnippet: r.searchSnippet,
      enrichmentStatus: r.enrichmentStatus,
      lastEnrichedAt: r.lastEnrichedAt,
      snapshot: snap
        ? {
            skillsNormalized: snap.skillsNormalized,
            roleType: snap.roleType,
            seniorityBand: snap.seniorityBand,
            location: snap.location,
            activityRecencyDays: snap.activityRecencyDays ?? null,
            computedAt: snap.computedAt,
            staleAfter: snap.staleAfter,
          }
        : null,
    };
  });
  const hasLocationConstraint = Boolean(requirements.location?.trim());
  const poolForRankingById = new Map(poolForRanking.map((r) => [r.id, r]));
  const requestedCountryCode = config.countryGuardEnabled && hasLocationConstraint
    ? deriveCountryCodeFromLocationText(requirements.location)
    : null;

  const scoredPoolRaw = rankCandidates(poolForRanking, requirements);
  const countryGuardFilteredCandidateIds = new Set<string>();
  let scoredPool = scoredPoolRaw;
  if (requestedCountryCode) {
    scoredPool = scoredPoolRaw.filter((sc) => {
      const poolCandidate = poolForRankingById.get(sc.candidateId);
      const poolRow = poolById.get(sc.candidateId);
      const candidateLocation = poolCandidate?.snapshot?.location ?? poolCandidate?.locationHint ?? null;
      const locationCountryCode = deriveCountryCodeFromLocationText(candidateLocation);
      const serpLocaleCountryCode = extractSerpSignals(poolRow?.searchMeta).localeCountryCode;

      if (locationCountryCode && locationCountryCode !== requestedCountryCode) {
        countryGuardFilteredCandidateIds.add(sc.candidateId);
        return false;
      }

      if (!locationCountryCode && serpLocaleCountryCode && serpLocaleCountryCode !== requestedCountryCode) {
        countryGuardFilteredCandidateIds.add(sc.candidateId);
        return false;
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
  const desiredDiscoveryTarget = Math.min(Math.max(poolDeficit, qualityDrivenTarget, strictCoverageDeficit), maxDiscoveryTarget);

  if (poolDeficit > 0 && qualityGateTriggered) discoveryReason = 'deficit_and_low_quality';
  else if (poolDeficit > 0) discoveryReason = 'pool_deficit';
  else if (qualityGateTriggered) discoveryReason = 'low_quality_pool';

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

        if (requestedCountryCode && discoveredCandidateIds.length > 0) {
          const discoveredRows = await prisma.candidate.findMany({
            where: { id: { in: discoveredCandidateIds } },
            select: { id: true, locationHint: true, searchMeta: true },
          });
          const discoveredById = new Map(discoveredRows.map((row) => [row.id, row]));
          const allowedDiscoveredIds: string[] = [];

          for (const candidateId of discoveredCandidateIds) {
            const row = discoveredById.get(candidateId);
            if (!row) {
              allowedDiscoveredIds.push(candidateId);
              continue;
            }

            const locationCountryCode = deriveCountryCodeFromLocationText(row.locationHint);
            const serpLocaleCountryCode = extractSerpSignals(row.searchMeta).localeCountryCode;
            const locationMismatch = Boolean(
              locationCountryCode && locationCountryCode !== requestedCountryCode,
            );
            const localeMismatch = Boolean(
              !locationCountryCode &&
              serpLocaleCountryCode &&
              serpLocaleCountryCode !== requestedCountryCode,
            );

            if (locationMismatch || localeMismatch) {
              countryGuardFilteredCandidateIds.add(candidateId);
              continue;
            }
            allowedDiscoveredIds.push(candidateId);
          }

          discoveredCandidateIds = allowedDiscoveredIds;
          discoveredCount = discoveredCandidateIds.length;
          countryGuardFilteredCount = countryGuardFilteredCandidateIds.size;
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

  const pushCandidate = (candidate: Omit<AssembledCandidate, 'rank'>): boolean => {
    if (assembled.length >= config.targetCount) return false;
    if (assembledIds.has(candidate.candidateId)) return false;
    assembled.push({ ...candidate, rank: rank++ });
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
    expandedPool.sort((a, b) => b.fitScore - a.fitScore);
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

  // Helper: push pool candidates (enriched first, then non-enriched, by fitScore)
  const pushPoolTier = (tier: typeof scoredPool, limit: number): void => {
    const enriched = tier.filter((sc) => enrichedIds.has(sc.candidateId));
    const nonEnriched = tier.filter((sc) => !enrichedIds.has(sc.candidateId));
    for (const sc of enriched) {
      if (assembled.length >= limit) return;
      pushCandidate({
        candidateId: sc.candidateId,
        fitScore: sc.fitScore,
        fitBreakdown: sc.fitBreakdown,
        matchTier: sc.matchTier,
        locationMatchType: sc.locationMatchType,
        sourceType: 'pool_enriched',
        enrichmentStatus: 'completed',
      });
    }
    for (const sc of nonEnriched) {
      if (assembled.length >= limit) return;
      pushCandidate({
        candidateId: sc.candidateId,
        fitScore: sc.fitScore,
        fitBreakdown: sc.fitBreakdown,
        matchTier: sc.matchTier,
        locationMatchType: sc.locationMatchType,
        sourceType: 'pool',
        enrichmentStatus: poolById.get(sc.candidateId)?.enrichmentStatus ?? 'pending',
      });
    }
  };

  // Pass 1: Fill from qualified strict pool (above fitScore floor)
  pushPoolTier(qualifiedStrict, config.targetCount);
  const strictMatchedCount = assembled.length;

  // Pass 2: Expand as needed to reach targetCount; annotate reason when strict
  // location matches are insufficient for a location-constrained job.
  const needsExpansion = assembled.length < config.targetCount;
  let expansionReason: OrchestratorResult['expansionReason'] = null;
  if (hasLocationConstraint && strictMatchedCount < config.targetCount) {
    expansionReason = strictDemotedCount > 0 ? 'strict_low_quality' : 'insufficient_strict_location_matches';
  }

  if (needsExpansion) {
    // Add expanded pool
    pushPoolTier(expandedPool, config.targetCount);

    // Add discovered candidates (no score yet → expanded tier) as final backfill.
    // Keep scored expanded-pool candidates ahead of unranked discoveries.
    for (const candidateId of discoveredCandidateIds) {
      if (assembled.length >= config.targetCount) break;
      pushCandidate({
        candidateId,
        fitScore: null,
        fitBreakdown: null,
        matchTier: 'expanded_location',
        locationMatchType: 'none',
        sourceType: 'discovered',
        enrichmentStatus: 'pending',
      });
    }
  }

  // Novelty guard: suppress recently-exposed broader-pool candidates
  let noveltySuppressedCount = 0;
  let noveltyKey: string | null = null;
  let noveltyHint: string | null = null;

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
          if (assembled.length >= config.targetCount) break;
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
        for (const candidateId of discoveredCandidateIds) {
          if (assembled.length >= config.targetCount) break;
          if (assembledIds.has(candidateId)) continue;
          if (shouldSuppressNovelty(candidateId, 'expanded_location', null)) continue;
          pushCandidate({
            candidateId,
            fitScore: null,
            fitBreakdown: null,
            matchTier: 'expanded_location',
            locationMatchType: 'none',
            sourceType: 'discovered',
            enrichmentStatus: 'pending',
          });
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
          ? toJsonValue({ ...a.fitBreakdown, matchTier: a.matchTier, locationMatchType: a.locationMatchType })
          : a.matchTier
            ? toJsonValue({ matchTier: a.matchTier, locationMatchType: a.locationMatchType })
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
  const allPotentialIds = [...new Set([...candidateIdsToEnqueue, ...staleCandidateIds, ...discoveredUnenriched])];
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
    const serpSignals = extractSerpSignals(candidateSearchMetaById.get(candidate.candidateId));
    let adjustment = 0;

    if (serpSignals.resultDateDays !== null) {
      if (serpSignals.resultDateDays <= 30) adjustment -= 3;
      else if (serpSignals.resultDateDays <= 90) adjustment -= 1;
      else if (serpSignals.resultDateDays > 365) adjustment += 2;
    }

    const locationConsistency = assessLocationCountryConsistency(
      requirements.location,
      serpSignals.localeCountryCode,
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
  // Only count scored candidates (exclude discovered — they have no fitScore/skillScore)
  let withSnapshotSkills = 0;
  let usingTextFallback = 0;
  const skillScoreSumBySource: Record<string, { sum: number; count: number }> = {};
  for (const a of assembled) {
    if (a.fitScore === null) continue; // discovered candidates — not scored
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

  // Location hint coverage: fraction of scored candidates with a meaningful, non-noisy location
  // Excludes discovered candidates (not in pool, no location data yet)
  const scoredAssembled = assembled.filter((a) => a.fitScore !== null);
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
    selectedSnapshotTrack,
    locationCoverageTriggered,
    noveltySuppressedCount,
    noveltyWindowDays: config.noveltyWindowDays,
    noveltyKey,
    noveltyHint,
    discoveredEnrichedCount,
    dynamicQueryBudgetUsed,
  };

  log.info({ requestId, resolvedTrack: trackDecision?.track ?? null, ...result }, 'Orchestrator complete');
  return result;
}
