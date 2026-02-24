import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { redis } from '@/lib/redis/client';
import { toJsonValue } from '@/lib/prisma/json';
import { createLogger } from '@/lib/logger';
import { buildJobRequirements, type SourcingJobContextInput } from './jd-digest';
import { rankCandidates } from './ranking';
import { discoverCandidates } from './discovery';
import { getSourcingConfig } from './config';
import { createEnrichmentSession } from '@/lib/enrichment/queue';
import { isMeaningfulLocation, isNoisyLocationHint } from './ranking';
import type { CandidateForRanking, FitBreakdown, MatchTier, LocationMatchType } from './ranking';
import type { TrackDecision } from './types';

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
      intelligenceSnapshots: {
        where: { track: 'tech' },
        take: 1,
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
    const snap = r.intelligenceSnapshots[0] ?? null;
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
            computedAt: snap.computedAt,
            staleAfter: snap.staleAfter,
          }
        : null,
    };
  });
  const scoredPool = rankCandidates(poolForRanking, requirements);
  const hasLocationConstraint = Boolean(requirements.location?.trim());

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
    strictCoverageTriggered;

  // 3. Discovery decision (deficit and/or low quality)
  const enrichedCandidates = scoredPool.filter((sc) => poolById.get(sc.candidateId)?.enrichmentStatus === 'completed');
  const enrichedCount = enrichedCandidates.length;

  let discoveredCount = 0;
  let discoveredCandidateIds: string[] = [];
  let discoveryTarget = 0;
  let queriesExecuted = 0;
  let discoveryReason: OrchestratorResult['discoveryReason'] = null;
  let discoverySkippedReason: OrchestratorResult['discoverySkippedReason'] = null;

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

  if (desiredDiscoveryTarget > 0) {
    const aggressive = enrichedCount < config.minGoodEnough;
    discoveryTarget = aggressive ? Math.min(desiredDiscoveryTarget, config.jobMaxEnrich) : desiredDiscoveryTarget;
    const budget = await getDiscoveryQueryBudget(
      tenantId,
      config.maxSerpQueries,
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
        );

        discoveredCount = discovery.candidates.length;
        discoveredCandidateIds = discovery.candidates.map((d) => d.candidateId);
        queriesExecuted = discovery.queriesExecuted;
        usedQueries = queriesExecuted;
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
  const expandedPool = scoredPool.filter((sc) => sc.matchTier === 'expanded_location');

  // Quality guard: demote strict candidates below fitScore floor to expanded pool
  let strictDemotedCount = 0;
  const qualifiedStrict: typeof strictPool = [];
  for (const sc of strictPool) {
    if (sc.fitScore < config.bestMatchesMinFitScore) {
      expandedPool.push(sc);
      strictDemotedCount++;
    } else {
      qualifiedStrict.push(sc);
    }
  }
  if (strictDemotedCount > 0) {
    expandedPool.sort((a, b) => b.fitScore - a.fitScore);
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

  const allPotentialIds = [...new Set([...candidateIdsToEnqueue, ...staleCandidateIds])];
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

  const enqueuedIds = new Set<string>();
  let autoEnrichQueued = 0;
  for (const a of assembled.filter((a) => a.enrichmentStatus !== 'completed').slice(0, config.initialEnrichCount)) {
    if (alreadyActiveIds.has(a.candidateId) || enqueuedIds.has(a.candidateId)) continue;
    try {
      const priority = 10 + (a.rank - 1); // rank 1 → priority 10
      await createEnrichmentSession(tenantId, a.candidateId, { priority });
      enqueuedIds.add(a.candidateId);
      autoEnrichQueued++;
    } catch (error) {
      log.warn({ error, candidateId: a.candidateId, requestId }, 'Auto-enrich enqueue failed');
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
  const poolForRankingById = new Map(poolForRanking.map((r) => [r.id, r]));
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
  function hasMeaningfulLocation(loc: string | null | undefined): boolean {
    if (!isMeaningfulLocation(loc)) return false;
    if (isNoisyLocationHint(loc!)) return false;
    return true;
  }
  const scoredAssembled = assembled.filter((a) => a.fitScore !== null);
  const candidatesWithLocation = scoredAssembled.filter((a) => {
    const poolCandidate = poolForRankingById.get(a.candidateId);
    return hasMeaningfulLocation(poolCandidate?.snapshot?.location) ||
           hasMeaningfulLocation(poolCandidate?.locationHint);
  }).length;
  const locationHintCoverage = scoredAssembled.length > 0
    ? Number((candidatesWithLocation / scoredAssembled.length).toFixed(4))
    : 0;

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
  };

  log.info({ requestId, resolvedTrack: trackDecision?.track ?? null, ...result }, 'Orchestrator complete');
  return result;
}
