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
import { getSourcingConfig } from './config';
import { buildJobRequirements, type SourcingJobContextInput } from './jd-digest';
import { rankCandidates, compareFitWithConfidence } from './ranking';
import { toRankingCandidate, readTrackFromDiagnostics, isValidJobContext } from './rescore';
import { jobTrackToDbFilter } from './types';

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
    const jobId = `rerank:${row.sourcingRequestId}`;

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
      id: true, headlineHint: true, locationHint: true,
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
  const scored = rankCandidates(rankingCandidates, requirements, {
    fitScoreEpsilon: config.fitScoreEpsilon,
    locationBoostWeight: config.locationBoostWeight,
  });

  // 6. Sort: strict first, then expanded. Within each: epsilon comparator.
  const epsilon = config.fitScoreEpsilon;
  const strict = scored
    .filter(c => c.matchTier === 'strict_location')
    .sort((a, b) => compareFitWithConfidence(a, b, epsilon));
  const expanded = scored
    .filter(c => c.matchTier !== 'strict_location')
    .sort((a, b) => compareFitWithConfidence(a, b, epsilon));
  const sorted = [...strict, ...expanded];

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

  // 9. Mark rerank timestamp
  await prisma.jobSourcingRequest.update({
    where: { id: requestId },
    data: { lastRerankedAt: new Date() },
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
