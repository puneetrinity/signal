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
import type { CandidateForRanking, FitBreakdown } from './ranking';
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
  discoveryReason: 'pool_deficit' | 'low_quality_pool' | 'deficit_and_low_quality' | null;
  discoverySkippedReason: 'daily_serp_cap_reached' | 'cap_guard_unavailable' | null;
  snapshotReuseCount: number;
  snapshotStaleServedCount: number;
  snapshotRefreshQueuedCount: number;
}

interface AssembledCandidate {
  candidateId: string;
  fitScore: number | null;
  fitBreakdown: FitBreakdown | null;
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

  const topK = scoredPool.slice(0, Math.min(scoredPool.length, config.qualityTopK));
  const avgFitTopK = topK.length > 0
    ? topK.reduce((sum, row) => sum + row.fitScore, 0) / topK.length
    : 0;
  const countAboveThreshold = topK.filter((row) => row.fitScore >= config.qualityThreshold).length;
  const minCountAboveRequired = Math.min(config.qualityMinCountAbove, topK.length);
  const qualityGateTriggered =
    topK.length === 0 ||
    avgFitTopK < config.qualityMinAvgFit ||
    countAboveThreshold < minCountAboveRequired;

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
  const qualityDrivenTarget = qualityGateTriggered ? Math.ceil(config.targetCount * 0.2) : 0;
  const desiredDiscoveryTarget = Math.max(poolDeficit, qualityDrivenTarget);

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

  // 4. Assemble final list with controlled mix in low-quality scenarios
  const assembled: AssembledCandidate[] = [];
  const assembledIds = new Set<string>();
  const enrichedIds = new Set(enrichedCandidates.map((row) => row.candidateId));
  const nonEnrichedPool = scoredPool.filter((sc) => !enrichedIds.has(sc.candidateId));
  let rank = 1;

  const pushCandidate = (candidate: Omit<AssembledCandidate, 'rank'>): void => {
    if (assembled.length >= config.targetCount) return;
    if (assembledIds.has(candidate.candidateId)) return;
    assembled.push({ ...candidate, rank: rank++ });
    assembledIds.add(candidate.candidateId);
  };

  const discoveredSlotTarget = qualityGateTriggered
    ? Math.min(discoveredCandidateIds.length, Math.ceil(config.targetCount * 0.2))
    : 0;
  const poolSlotTarget = config.targetCount - discoveredSlotTarget;
  const enrichedCap = qualityGateTriggered ? Math.min(50, poolSlotTarget) : poolSlotTarget;

  for (const sc of enrichedCandidates) {
    if (assembled.length >= enrichedCap) break;
    pushCandidate({
      candidateId: sc.candidateId,
      fitScore: sc.fitScore,
      fitBreakdown: sc.fitBreakdown,
      sourceType: 'pool_enriched',
      enrichmentStatus: 'completed',
    });
  }

  for (const sc of nonEnrichedPool) {
    if (assembled.length >= poolSlotTarget) break;
    pushCandidate({
      candidateId: sc.candidateId,
      fitScore: sc.fitScore,
      fitBreakdown: sc.fitBreakdown,
      sourceType: 'pool',
      enrichmentStatus: poolById.get(sc.candidateId)?.enrichmentStatus ?? 'pending',
    });
  }

  for (const candidateId of discoveredCandidateIds) {
    pushCandidate({
      candidateId,
      fitScore: null,
      fitBreakdown: null,
      sourceType: 'discovered',
      enrichmentStatus: 'pending',
    });
  }

  // Backfill in case discovery under-delivers reserved slots.
  for (const sc of nonEnrichedPool) {
    if (assembled.length >= config.targetCount) break;
    pushCandidate({
      candidateId: sc.candidateId,
      fitScore: sc.fitScore,
      fitBreakdown: sc.fitBreakdown,
      sourceType: 'pool',
      enrichmentStatus: poolById.get(sc.candidateId)?.enrichmentStatus ?? 'pending',
    });
  }

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
        fitBreakdown: a.fitBreakdown ? toJsonValue(a.fitBreakdown) : Prisma.JsonNull,
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
    discoveryReason,
    discoverySkippedReason,
    snapshotReuseCount,
    snapshotStaleServedCount,
    snapshotRefreshQueuedCount: staleRefreshQueued,
  };

  log.info({ requestId, resolvedTrack: trackDecision?.track ?? null, ...result }, 'Orchestrator complete');
  return result;
}
