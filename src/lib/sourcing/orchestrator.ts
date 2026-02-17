import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { toJsonValue } from '@/lib/prisma/json';
import { createLogger } from '@/lib/logger';
import { buildJobRequirements } from './jd-digest';
import { rankCandidates } from './ranking';
import { discoverCandidates } from './discovery';
import { getSourcingConfig } from './config';
import { createEnrichmentSession } from '@/lib/enrichment/queue';
import type { CandidateForRanking, FitBreakdown } from './ranking';

const log = createLogger('SourcingOrchestrator');

export interface OrchestratorResult {
  candidateCount: number;
  enrichedCount: number;
  poolCount: number;
  discoveredCount: number;
  discoveryShortfallRate: number; // 0.0 = no shortfall, 1.0 = total miss (0 when no discovery needed)
  autoEnrichQueued: number;
  staleRefreshQueued: number;
}

export async function runSourcingOrchestrator(
  requestId: string,
  tenantId: string,
  jobContext: { jdDigest: string; location?: string; experienceYears?: number; education?: string },
): Promise<OrchestratorResult> {
  const config = getSourcingConfig();
  const requirements = buildJobRequirements(jobContext);

  log.info({ requestId, tenantId, topSkills: requirements.topSkills, roleFamily: requirements.roleFamily }, 'Starting orchestrator');

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

  log.info({ requestId, poolSize: poolRows.length }, 'Pool queried');

  // Build ID→row lookup (avoids O(n) find() in hot loops over up to 5000 rows)
  const poolById = new Map(poolRows.map((r) => [r.id, r]));

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

  // 3. Assess deficit
  const enrichedCandidates = scoredPool.filter((sc) => {
    return poolById.get(sc.candidateId)?.enrichmentStatus === 'completed';
  });
  const enrichedCount = enrichedCandidates.length;

  let discoveredCount = 0;
  let discoveredCandidateIds: string[] = [];
  let discoveryTarget = 0;

  // Top-off: discover when pool can't fill targetCount on its own
  const poolSize = scoredPool.length;
  const poolDeficit = config.targetCount - poolSize;

  if (poolDeficit > 0) {
    // Weak pool (enriched < minGoodEnough): cap at jobMaxEnrich to guard SERP cost.
    // Decent pool: full top-off (discover exact deficit).
    const aggressive = enrichedCount < config.minGoodEnough;
    discoveryTarget = aggressive
      ? Math.min(poolDeficit, config.jobMaxEnrich)
      : poolDeficit;
    const existingLinkedinIds = new Set(poolRows.map((r) => r.linkedinId));

    log.info({
      requestId,
      discoveryTarget,
      poolSize,
      enrichedCount,
      poolDeficit,
      aggressive,
    }, 'Starting discovery');

    const discovered = await discoverCandidates(
      tenantId,
      requirements,
      discoveryTarget,
      existingLinkedinIds,
      config.maxSerpQueries,
    );
    discoveredCount = discovered.length;
    discoveredCandidateIds = discovered.map((d) => d.candidateId);

    if (discoveredCount < discoveryTarget) {
      log.warn({
        requestId,
        discoveredCount,
        discoveryTarget,
        shortfall: discoveryTarget - discoveredCount,
      }, 'Discovery under-delivered — deterministic queries yielded insufficient results');
    }

    log.info({ requestId, discoveredCount }, 'Discovery complete');
  }

  // 4. Assemble final list: enriched by fitScore → non-enriched pool by fitScore → discovered by discovery order
  const enrichedSet = new Set(enrichedCandidates.map((c) => c.candidateId));
  const nonEnrichedPool = scoredPool.filter((sc) => !enrichedSet.has(sc.candidateId));

  interface AssembledCandidate {
    candidateId: string;
    fitScore: number | null;
    fitBreakdown: FitBreakdown | null;
    sourceType: string;
    enrichmentStatus: string;
    rank: number;
  }

  const assembled: AssembledCandidate[] = [];
  let rank = 1;

  // Enriched candidates first (sorted by fitScore desc)
  for (const sc of enrichedCandidates) {
    if (assembled.length >= config.targetCount) break;
    assembled.push({
      candidateId: sc.candidateId,
      fitScore: sc.fitScore,
      fitBreakdown: sc.fitBreakdown,
      sourceType: 'pool_enriched',
      enrichmentStatus: 'completed',
      rank: rank++,
    });
  }

  // Non-enriched pool (sorted by fitScore desc)
  for (const sc of nonEnrichedPool) {
    if (assembled.length >= config.targetCount) break;
    assembled.push({
      candidateId: sc.candidateId,
      fitScore: sc.fitScore,
      fitBreakdown: sc.fitBreakdown,
      sourceType: 'pool',
      enrichmentStatus: poolById.get(sc.candidateId)?.enrichmentStatus ?? 'pending',
      rank: rank++,
    });
  }

  // Discovered (in discovery order)
  for (const candidateId of discoveredCandidateIds) {
    if (assembled.length >= config.targetCount) break;
    assembled.push({
      candidateId,
      fitScore: null,
      fitBreakdown: null,
      sourceType: 'discovered',
      enrichmentStatus: 'pending',
      rank: rank++,
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
        fitBreakdown: a.fitBreakdown
          ? toJsonValue(a.fitBreakdown)
          : Prisma.JsonNull,
        sourceType: a.sourceType,
        enrichmentStatus: a.enrichmentStatus,
        rank: a.rank,
      })),
    }),
  ]);

  // 6. Auto-enrich top N unenriched candidates
  //    Cross-run dedupe: skip candidates with an already queued/running session.
  const candidateIdsToEnqueue = [
    ...assembled.filter((a) => a.enrichmentStatus !== 'completed').slice(0, config.initialEnrichCount).map((a) => a.candidateId),
  ];
  const now = new Date();
  const staleCandidateIds = poolForRanking
    .filter((r) => r.snapshot?.staleAfter && r.snapshot.staleAfter < now)
    .slice(0, config.staleRefreshMaxPerRun)
    .map((r) => r.id);
  const allPotentialIds = [...new Set([...candidateIdsToEnqueue, ...staleCandidateIds])];

  // Batch query for active sessions to avoid duplicate enqueues across runs
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
      const priority = 10 + (a.rank - 1); // rank 1 → priority 10, rank 20 → priority 29
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

  const result: OrchestratorResult = {
    candidateCount: assembled.length,
    enrichedCount: assembled.filter((a) => a.sourceType === 'pool_enriched').length,
    poolCount: assembled.filter((a) => a.sourceType === 'pool' || a.sourceType === 'pool_enriched').length,
    discoveredCount,
    discoveryShortfallRate,
    autoEnrichQueued,
    staleRefreshQueued,
  };

  log.info({ requestId, ...result }, 'Orchestrator complete');
  return result;
}
