/**
 * Post-Enrichment Rerank Queue
 *
 * When enrichment completes for a candidate, enqueues a deduped, delayed
 * rerank job per sourcing request. Multiple enrichment completions within the
 * delay window coalesce into a single rerank. The rerank job recomputes
 * fitScore/matchTier/rank for ALL candidates in the request using latest
 * snapshot data.
 */

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@/lib/prisma';
import { toJsonValue } from '@/lib/prisma/json';
import { createLogger } from '@/lib/logger';
import { getLocationBoostWeight, getSourcingConfig } from './config';
import { guardedTopKSwap } from './top20-guards';
import { buildJobRequirements, type SourcingJobContextInput } from './jd-digest';
import { rankCandidates, compareFitWithConfidence } from './ranking';
import { toRankingCandidate, readTrackFromDiagnostics, isValidJobContext } from './rescore';
import { jobTrackToDbFilter } from './types';
import { resolveRolesBatch, type RoleBatchEntry, type RoleResolution } from '@/lib/taxonomy/role-service';
import { resolveLocationsBatch, type LocationBatchEntry, type LocationResolution } from '@/lib/taxonomy/location-service';

const log = createLogger('SourcingRerank');

const RERANK_QUEUE_NAME = 'sourcing-rerank';

// ---------------------------------------------------------------------------
// Redis connection singleton (own instance, not shared)
// ---------------------------------------------------------------------------

let redisConnection: IORedis | null = null;

function getRedisConnection(): IORedis {
  if (!redisConnection) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
  }
  return redisConnection;
}

// ---------------------------------------------------------------------------
// Queue singleton
// ---------------------------------------------------------------------------

interface RerankJobData {
  requestId: string;
  tenantId: string;
}

interface RerankJobResult {
  reranked?: number;
  skipped?: boolean;
  reason?: string;
}

let rerankQueue: Queue<RerankJobData, RerankJobResult> | null = null;

function getRerankQueue(): Queue<RerankJobData, RerankJobResult> {
  if (!rerankQueue) {
    rerankQueue = new Queue(RERANK_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { count: 500, age: 3600 },
        removeOnFail: { count: 1000, age: 86400 },
      },
    });
  }
  return rerankQueue;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Find all completed sourcing requests containing this candidate and enqueue
 * a deduped, delayed rerank job for each.
 */
export async function enqueueRerankForCandidate(
  tenantId: string,
  candidateId: string,
): Promise<string[]> {
  const config = getSourcingConfig();
  if (!config.rerankAfterEnrichment) return [];

  const rows = await prisma.jobSourcingCandidate.findMany({
    where: { tenantId, candidateId, sourcingRequest: { status: 'complete' } },
    select: { sourcingRequestId: true },
  });

  const queue = getRerankQueue();
  const enqueuedRequestIds: string[] = [];

  for (const row of rows) {
    // BullMQ custom job IDs cannot contain ":".
    const jobId = `rerank-${row.sourcingRequestId}`;

    // Safe dedup: check existing job state, skip if already pending.
    // getJob + add is not atomic — wrap add in try/catch to handle
    // race where another process adds the same jobId between check and add.
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'waiting' || state === 'delayed' || state === 'active') {
        continue;
      }
      // Completed or failed from previous run — remove to allow fresh enqueue
      await existing.remove().catch(() => {});
    }

    try {
      await queue.add(
        'rerank',
        { requestId: row.sourcingRequestId, tenantId },
        { jobId, delay: config.rerankDelayMs },
      );
      enqueuedRequestIds.push(row.sourcingRequestId);
    } catch (err: unknown) {
      // Duplicate jobId race — another enrichment completion won the race.
      const isDuplicate =
        (err instanceof Error && err.message.includes(jobId)) ||
        (typeof err === 'object' && err !== null && 'code' in err &&
          (err as { code: string }).code === 'ERR_JOB_DUPLICATE');
      if (isDuplicate) continue;
      throw err;
    }
  }

  return enqueuedRequestIds;
}

// ---------------------------------------------------------------------------
// Data confidence (mirrors orchestrator logic for rerank context)
// ---------------------------------------------------------------------------

function computeDataConfidence(
  candidate: { enrichmentStatus: string } | undefined,
  scored: { fitBreakdown: { skillScoreMethod: string } },
): 'high' | 'medium' | 'low' {
  const enrichmentStatus = candidate?.enrichmentStatus ?? '';
  if (enrichmentStatus === 'completed' && scored.fitBreakdown.skillScoreMethod === 'snapshot') {
    return 'high';
  }
  if (scored.fitBreakdown.skillScoreMethod === 'text_fallback' ||
      (enrichmentStatus === 'completed' && scored.fitBreakdown.skillScoreMethod !== 'snapshot')) {
    return 'medium';
  }
  return 'low';
}

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

async function processRerankJob(
  job: Job<RerankJobData, RerankJobResult>,
): Promise<RerankJobResult> {
  const { requestId, tenantId } = job.data;

  // 1. Load sourcing request + jobContext
  const request = await prisma.jobSourcingRequest.findUnique({
    where: { id: requestId },
    select: { id: true, jobContext: true, diagnostics: true, status: true },
  });
  if (!request || request.status !== 'complete') return { skipped: true, reason: 'not_complete' };
  if (!isValidJobContext(request.jobContext)) return { skipped: true, reason: 'invalid_context' };

  const requirements = buildJobRequirements(request.jobContext);
  const track = readTrackFromDiagnostics(request.diagnostics);
  const trackFilter = jobTrackToDbFilter(track);

  // 2. Load ALL sourcing candidate rows for this request
  const rows = await prisma.jobSourcingCandidate.findMany({
    where: { sourcingRequestId: requestId },
    select: { id: true, candidateId: true, sourceType: true, enrichmentStatus: true },
  });
  if (rows.length === 0) return { skipped: true, reason: 'no_candidates' };
  const candidateIds = rows.map(r => r.candidateId);

  // 3. Load ALL candidates with fresh snapshots
  const candidates = await prisma.candidate.findMany({
    where: { id: { in: candidateIds } },
    select: {
      id: true, headlineHint: true, seniorityHint: true, locationHint: true,
      searchTitle: true, searchSnippet: true,
      enrichmentStatus: true, lastEnrichedAt: true,
      intelligenceSnapshots: {
        where: { track: { in: trackFilter } },
        orderBy: { computedAt: 'desc' },
        select: {
          track: true, skillsNormalized: true, roleType: true,
          seniorityBand: true, location: true, activityRecencyDays: true,
          computedAt: true, staleAfter: true,
        },
      },
    },
  });

  // 4. Build CandidateForRanking[] using shared helper
  const rankingCandidates = candidates.map(c => toRankingCandidate(c, trackFilter));

  // 5. rankCandidates — recomputes fitScore, matchTier, locationMatchType
  const config = getSourcingConfig();
  let preResolvedRoles: Map<string, RoleResolution> | undefined;
  let preResolvedLocations: Map<string, LocationResolution> | undefined;

  if (config.roleGroqEnabled) {
    const roleEntries: RoleBatchEntry[] = rankingCandidates.map((c) => ({
      key: c.id,
      title: c.headlineHint ?? c.searchTitle ?? '',
      context: [c.headlineHint, c.searchTitle, c.searchSnippet].filter(Boolean).join(' '),
    }));
    const batchResult = await resolveRolesBatch(roleEntries);
    if (!config.roleGroqShadowMode) {
      preResolvedRoles = batchResult.resolutions;
    }
  }

  if (config.locationGroqEnabled) {
    const locationEntries: LocationBatchEntry[] = rankingCandidates.map((c) => ({
      key: c.id,
      location: c.snapshot?.location ?? c.locationHint,
      context: [c.headlineHint, c.searchTitle, c.searchSnippet, requirements.location].filter(Boolean).join(' '),
    }));
    const batchResult = await resolveLocationsBatch(locationEntries);
    if (!config.locationGroqShadowMode) {
      preResolvedLocations = batchResult.resolutions;
    }
  }

  const scored = rankCandidates(rankingCandidates, requirements, {
    fitScoreEpsilon: config.fitScoreEpsilon,
    locationBoostWeight: getLocationBoostWeight(config, track),
    track,
    preResolvedRoles,
    preResolvedLocations,
  });
  const hasLocationConstraint = Boolean(requirements.location?.trim());

  if (track !== 'non_tech') {
    let unknownPenaltyApplied = 0;
    for (const sc of scored) {
      if (
        sc.locationMatchType === 'unknown_location' &&
        !(sc.fitScore >= 0.60 && sc.fitBreakdown.roleScore >= 0.70)
      ) {
        sc.fitScore *= config.unknownLocationPenaltyMultiplier;
        unknownPenaltyApplied++;
      }
    }
    if (unknownPenaltyApplied > 0) {
      scored.sort((a, b) => compareFitWithConfidence(a, b, config.fitScoreEpsilon));
    }
  }
  if (track === 'non_tech' && hasLocationConstraint) {
    let locationMismatchPenaltyApplied = 0;
    for (const sc of scored) {
      if (sc.locationMatchType === 'none') {
        sc.fitScore *= config.nonTechLocationMismatchPenaltyMultiplier;
        locationMismatchPenaltyApplied++;
      }
    }
    if (locationMismatchPenaltyApplied > 0) {
      scored.sort((a, b) => compareFitWithConfidence(a, b, config.fitScoreEpsilon));
    }
  }

  // Mirror initial assembly admission logic: strict candidates must clear the
  // best-match floor, with tech also enforcing the skill floor. If all strict
  // candidates are demoted, apply the same role-aware strict rescue gate.
  const strictPool = scored.filter((c) => c.matchTier === 'strict_location');
  let expandedPool = scored.filter((c) => c.matchTier !== 'strict_location');
  const qualifiedStrict: typeof strictPool = [];
  const demotedStrictCandidates: typeof strictPool = [];
  const strictBeforeDemotion = strictPool.length;
  let strictDemotedCount = 0;
  let strictRescuedCount = 0;
  let strictRescueApplied = false;
  let strictRescueMinFitScoreUsed: number | null = null;

  for (const sc of strictPool) {
    const failsTechStrictSkillFloor =
      track === 'tech' &&
      sc.fitBreakdown.skillScore < config.techTop20SkillMin;
    if (sc.fitScore < config.bestMatchesMinFitScore || failsTechStrictSkillFloor) {
      sc.matchTier = 'expanded_location';
      expandedPool.push(sc);
      demotedStrictCandidates.push(sc);
      strictDemotedCount++;
    } else {
      qualifiedStrict.push(sc);
    }
  }

  if (strictDemotedCount > 0) {
    expandedPool.sort((a, b) => compareFitWithConfidence(a, b, config.fitScoreEpsilon));
  }

  if (
    qualifiedStrict.length === 0 &&
    demotedStrictCandidates.length > 0 &&
    config.strictRescueCount > 0
  ) {
    const rescuedStrict = demotedStrictCandidates
      .filter((sc) => {
        if (sc.fitScore < config.strictRescueMinFitScore) return false;
        if (track === 'tech' && sc.fitBreakdown.skillScore < config.techTop20SkillMin) return false;
        if (track === 'tech' && sc.fitBreakdown.roleScore < 0.7) return false;
        if (track !== 'tech' && sc.fitBreakdown.roleScore < 0.6) return false;
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

  // 6. Sort: strict first, then expanded. Within each: epsilon comparator.
  const epsilon = config.fitScoreEpsilon;
  const strict = qualifiedStrict
    .sort((a, b) => compareFitWithConfidence(a, b, epsilon));
  const expanded = expandedPool
    .sort((a, b) => compareFitWithConfidence(a, b, epsilon));
  const sorted = [...strict, ...expanded];

  // Post-sort top-K guards (order: unknown cap → role → skill → unknown re-assert)
  const topK = Math.min(20, sorted.length);
  const unknownCapRatio = track === 'tech' ? 0.1 : 0.15;
  const top20UnknownCap = Math.max(1, Math.ceil(topK * unknownCapRatio));
  const getFitScoreRerank = (c: typeof sorted[number]) => c.fitScore;

  // 1. Unknown-location cap (initial)
  guardedTopKSwap({
    items: sorted,
    topK,
    isViolation: (c) => c.locationMatchType === 'unknown_location',
    isEligibleReplacement: (c) => c.locationMatchType !== 'unknown_location',
    cap: top20UnknownCap,
    epsilon: config.fitScoreEpsilon,
    getFitScore: getFitScoreRerank,
  });

  // 2. Role guard (tech only)
  const rerankGuardsEnabled = config.techTop20GuardsEnabled && track === 'tech';
  let rerankRoleSwapped = false;
  let rerankSkillSwapped = false;
  if (rerankGuardsEnabled) {
    const roleResult = guardedTopKSwap({
      items: sorted,
      topK,
      isViolation: (c) => c.fitBreakdown.roleScore < config.techTop20RoleMin,
      isEligibleReplacement: (c) => c.fitBreakdown.roleScore >= config.techTop20RoleMin,
      cap: config.techTop20RoleCap,
      epsilon: config.fitScoreEpsilon,
      getFitScore: getFitScoreRerank,
      preferReplacement: (a, b) => {
        const aLocOk = a.locationMatchType !== 'unknown_location' ? 1 : 0;
        const bLocOk = b.locationMatchType !== 'unknown_location' ? 1 : 0;
        if (bLocOk !== aLocOk) return bLocOk - aLocOk;
        const aSkillOk = a.fitBreakdown.skillScore >= config.techTop20SkillMin ? 1 : 0;
        const bSkillOk = b.fitBreakdown.skillScore >= config.techTop20SkillMin ? 1 : 0;
        return bSkillOk - aSkillOk;
      },
    });
    rerankRoleSwapped = roleResult.demoted > 0;

    // 3. Skill floor (tech only)
    const skillResult = guardedTopKSwap({
      items: sorted,
      topK,
      isViolation: (c) => c.fitBreakdown.skillScore < config.techTop20SkillMin,
      isEligibleReplacement: (c) =>
        c.fitBreakdown.skillScore >= config.techTop20SkillMin &&
        c.fitBreakdown.roleScore >= config.techTop20RoleMin,
      cap: 0,
      epsilon: config.fitScoreEpsilon,
      getFitScore: getFitScoreRerank,
      preferReplacement: (a, b) => {
        const aLocOk = a.locationMatchType !== 'unknown_location' ? 1 : 0;
        const bLocOk = b.locationMatchType !== 'unknown_location' ? 1 : 0;
        return bLocOk - aLocOk;
      },
    });
    rerankSkillSwapped = skillResult.demoted > 0;

    // 4. Unknown cap re-assertion
    if (rerankRoleSwapped || rerankSkillSwapped) {
      guardedTopKSwap({
        items: sorted,
        topK,
        isViolation: (c) => c.locationMatchType === 'unknown_location',
        isEligibleReplacement: (c) => c.locationMatchType !== 'unknown_location',
        cap: top20UnknownCap,
        epsilon: config.fitScoreEpsilon,
        getFitScore: getFitScoreRerank,
      });
    }
  }

  // 7. Build lookups for DB updates
  const rowByCandidateId = new Map(rows.map(r => [r.candidateId, r]));
  const candidateById = new Map(candidates.map(c => [c.id, c]));

  // 8. Update all rows in transaction
  // GUARDRAIL: never mutate sourceType — only update fitScore, fitBreakdown,
  // enrichmentStatus, rank
  await prisma.$transaction(
    sorted.map((sc, i) => {
      const row = rowByCandidateId.get(sc.candidateId)!;
      const candidate = candidateById.get(sc.candidateId);
      const dataConfidence = computeDataConfidence(candidate, sc);
      return prisma.jobSourcingCandidate.update({
        where: { id: row.id },
        data: {
          fitScore: sc.fitScore,
          fitBreakdown: toJsonValue({
            ...sc.fitBreakdown,
            matchTier: sc.matchTier,
            locationMatchType: sc.locationMatchType,
            dataConfidence,
          }),
          enrichmentStatus: candidate?.enrichmentStatus ?? row.enrichmentStatus,
          rank: i + 1,
        },
      });
    }),
  );

  const strictMatchedCount = sorted.filter((c) => c.matchTier === 'strict_location').length;
  const expandedCount = sorted.length - strictMatchedCount;
  const expansionReason =
    hasLocationConstraint && strictMatchedCount < config.targetCount
      ? (strictDemotedCount > 0 ? 'strict_low_quality' : 'insufficient_strict_location_matches')
      : null;

  const diagnosticsObj =
    request.diagnostics && typeof request.diagnostics === 'object'
      ? request.diagnostics as Record<string, unknown>
      : {};

  // 9. Mark rerank timestamp and keep diagnostics aligned with the final rows.
  await prisma.jobSourcingRequest.update({
    where: { id: requestId },
    data: {
      lastRerankedAt: new Date(),
      diagnostics: toJsonValue({
        ...diagnosticsObj,
        strictMatchedCount,
        expandedCount,
        expansionReason,
        strictDemotedCount,
        strictRescuedCount,
        strictRescueApplied,
        strictRescueMinFitScoreUsed,
        strictBeforeDemotion,
      }),
    },
  });

  log.info({ requestId, reranked: sorted.length }, 'Rerank completed');
  return { reranked: sorted.length };
}

// ---------------------------------------------------------------------------
// Worker singleton
// ---------------------------------------------------------------------------

let rerankWorker: Worker<RerankJobData, RerankJobResult> | null = null;

export function startRerankWorker(options?: { concurrency?: number }): Worker<RerankJobData, RerankJobResult> {
  if (rerankWorker) return rerankWorker;

  rerankWorker = new Worker<RerankJobData, RerankJobResult>(
    RERANK_QUEUE_NAME,
    processRerankJob,
    {
      connection: getRedisConnection(),
      concurrency: options?.concurrency ?? 2,
    },
  );

  rerankWorker.on('completed', (job, result) => {
    log.info({ jobId: job.id, requestId: job.data.requestId, reranked: result.reranked }, 'Rerank job completed');
  });

  rerankWorker.on('failed', (job, error) => {
    log.error({ jobId: job?.id, error: error.message }, 'Rerank job failed');
  });

  rerankWorker.on('error', (error) => {
    log.error({ error }, 'Rerank worker error');
  });

  log.info('Rerank worker started');
  return rerankWorker;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function stopRerankWorker(): Promise<void> {
  if (rerankWorker) {
    await rerankWorker.close();
    rerankWorker = null;
    log.info('Rerank worker stopped');
  }
}

export async function cleanupRerankQueue(): Promise<void> {
  await stopRerankWorker();

  if (rerankQueue) {
    await rerankQueue.close();
    rerankQueue = null;
  }

  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }

  log.info('Rerank queue cleaned up');
}
