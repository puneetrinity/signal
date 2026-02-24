/**
 * Sourcing Queue (BullMQ)
 *
 * Dedicated queue for v3 sourcing jobs. Mirrors enrichment queue pattern.
 */

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { toJsonValue } from '@/lib/prisma/json';
import { deliverCallback } from '../callback';
import { runSourcingOrchestrator } from '../orchestrator';
import type { SourcingJobData, SourcingJobResult, SourcingCallbackPayload } from '../types';
import type { SourcingJobContextInput } from '../jd-digest';

const log = createLogger('SourcingQueue');

export const SOURCING_QUEUE_NAME = 'sourcing';

// ---------------------------------------------------------------------------
// Redis connection singleton (separate process from enrichment)
// ---------------------------------------------------------------------------

let redisConnection: IORedis | null = null;

function getRedisConnection(): IORedis {
  if (!redisConnection) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
      lazyConnect: true,
    });
  }
  return redisConnection;
}

// ---------------------------------------------------------------------------
// Queue singleton
// ---------------------------------------------------------------------------

let sourcingQueue: Queue<SourcingJobData, SourcingJobResult> | null = null;

export function getSourcingQueue(): Queue<SourcingJobData, SourcingJobResult> {
  if (!sourcingQueue) {
    sourcingQueue = new Queue(SOURCING_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 10_000,
        },
        removeOnComplete: {
          count: 500,
          age: 24 * 3600,
        },
        removeOnFail: {
          count: 2000,
          age: 7 * 24 * 3600,
        },
      },
    });
  }
  return sourcingQueue;
}

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

async function processSourcingJob(
  job: Job<SourcingJobData, SourcingJobResult>,
): Promise<SourcingJobResult> {
  const { requestId, tenantId, externalJobId, callbackUrl } = job.data;
  const startTime = Date.now();

  log.info({ jobId: job.id, requestId, tenantId, externalJobId }, 'Processing sourcing job');

  // Transition queued → processing
  await prisma.jobSourcingRequest.update({
    where: { id: requestId },
    data: { status: 'processing' },
  });

  try {
    const jobRequest = await prisma.jobSourcingRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const jobContext = jobRequest.jobContext as unknown as SourcingJobContextInput;
    const orchestratorResult = await runSourcingOrchestrator(requestId, tenantId, jobContext, job.data.resolvedTrack);
    const candidateCount = orchestratorResult.candidateCount;
    const enrichedCount = orchestratorResult.enrichedCount;

    // Transition processing → complete
    const durationMs = Date.now() - startTime;
    await prisma.jobSourcingRequest.update({
      where: { id: requestId },
      data: {
        status: 'complete',
        completedAt: new Date(),
        resultCount: candidateCount,
        qualityGateTriggered: orchestratorResult.qualityGateTriggered,
        queriesExecuted: orchestratorResult.queriesExecuted,
        diagnostics: toJsonValue({
          // Preserve trackDecision written at enqueue time
          ...(job.data.resolvedTrack ? { trackDecision: job.data.resolvedTrack } : {}),
          avgFitTopK: orchestratorResult.avgFitTopK,
          countAboveThreshold: orchestratorResult.countAboveThreshold,
          strictTopKCount: orchestratorResult.strictTopKCount,
          strictCoverageRate: orchestratorResult.strictCoverageRate,
          discoveryReason: orchestratorResult.discoveryReason,
          discoverySkippedReason: orchestratorResult.discoverySkippedReason,
          discoveryShortfallRate: orchestratorResult.discoveryShortfallRate,
          discoveredCount: orchestratorResult.discoveredCount,
          poolCount: orchestratorResult.poolCount,
          snapshotReuseCount: orchestratorResult.snapshotReuseCount,
          snapshotStaleServedCount: orchestratorResult.snapshotStaleServedCount,
          snapshotRefreshQueuedCount: orchestratorResult.snapshotRefreshQueuedCount,
          strictMatchedCount: orchestratorResult.strictMatchedCount,
          expandedCount: orchestratorResult.expandedCount,
          expansionReason: orchestratorResult.expansionReason,
          requestedLocation: orchestratorResult.requestedLocation,
          skillScoreDiagnostics: orchestratorResult.skillScoreDiagnostics,
          locationHintCoverage: orchestratorResult.locationHintCoverage,
          strictDemotedCount: orchestratorResult.strictDemotedCount,
        }),
      },
    });

    // Deliver callback
    const payload: SourcingCallbackPayload = {
      version: 1,
      requestId,
      externalJobId,
      status: 'complete',
      candidateCount,
      enrichedCount,
    };
    await deliverCallback(requestId, tenantId, callbackUrl, payload);

    const result: SourcingJobResult = {
      requestId,
      status: 'complete',
      candidateCount,
      enrichedCount,
      durationMs,
    };

    log.info({ jobId: job.id, requestId, durationMs }, 'Sourcing job completed');
    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    const durationMs = Date.now() - startTime;

    await prisma.jobSourcingRequest.update({
      where: { id: requestId },
      data: {
        status: 'failed',
        qualityGateTriggered: false,
        queriesExecuted: 0,
        // Preserve trackDecision written at enqueue time; only clear orchestrator fields
        diagnostics: job.data.resolvedTrack
          ? toJsonValue({ trackDecision: job.data.resolvedTrack })
          : Prisma.JsonNull,
      },
    });

    // Attempt failure callback
    const failPayload: SourcingCallbackPayload = {
      version: 1,
      requestId,
      externalJobId,
      status: 'failed',
      candidateCount: 0,
      enrichedCount: 0,
      error: errorMsg,
    };
    await deliverCallback(requestId, tenantId, callbackUrl, failPayload, false).catch((cbErr) => {
      log.error({ requestId, error: cbErr }, 'Failed to deliver failure callback');
    });

    log.error({ jobId: job.id, requestId, error: errorMsg }, 'Sourcing job failed');

    return {
      requestId,
      status: 'failed',
      candidateCount: 0,
      enrichedCount: 0,
      durationMs,
      error: errorMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Worker singleton
// ---------------------------------------------------------------------------

let sourcingWorker: Worker<SourcingJobData, SourcingJobResult> | null = null;

export function startSourcingWorker(options?: {
  concurrency?: number;
}): Worker<SourcingJobData, SourcingJobResult> {
  if (sourcingWorker) return sourcingWorker;

  sourcingWorker = new Worker<SourcingJobData, SourcingJobResult>(
    SOURCING_QUEUE_NAME,
    processSourcingJob,
    {
      connection: getRedisConnection(),
      concurrency: options?.concurrency || 2,
    },
  );

  sourcingWorker.on('completed', (job, result) => {
    log.info({ jobId: job.id, requestId: result.requestId }, 'Job completed');
  });

  sourcingWorker.on('failed', (job, error) => {
    log.error({ jobId: job?.id, error: error.message }, 'Job failed');
  });

  sourcingWorker.on('error', (error) => {
    log.error({ error }, 'Worker error');
  });

  log.info('Sourcing worker started');
  return sourcingWorker;
}

export async function stopSourcingWorker(): Promise<void> {
  if (sourcingWorker) {
    await sourcingWorker.close();
    sourcingWorker = null;
    log.info('Sourcing worker stopped');
  }
}

// ---------------------------------------------------------------------------
// Stats + cleanup
// ---------------------------------------------------------------------------

export async function getSourcingQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getSourcingQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

export async function cleanupSourcingQueue(): Promise<void> {
  await stopSourcingWorker();

  if (sourcingQueue) {
    await sourcingQueue.close();
    sourcingQueue = null;
  }

  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }

  log.info('Sourcing queue cleaned up');
}
