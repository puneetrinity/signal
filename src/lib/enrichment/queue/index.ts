/**
 * Async Enrichment Queue
 *
 * BullMQ-based job queue for background enrichment processing.
 * Supports:
 * - Async job creation with immediate response
 * - Progress tracking and status updates
 * - Retry and error handling
 * - Budget/rate limiting
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import type { RoleType } from '@/types/linkedin';
import type { EnrichmentBudget, EnrichmentGraphOutput } from '../graph/types';
import { runEnrichment } from '../graph/builder';

/**
 * Queue names
 */
export const QUEUE_NAMES = {
  ENRICHMENT: 'enrichment',
} as const;

/**
 * Job data for enrichment jobs
 */
export interface EnrichmentJobData {
  sessionId: string;
  candidateId: string;
  roleType?: RoleType;
  budget?: Partial<EnrichmentBudget>;
  priority?: number;
}

/**
 * Job result from enrichment
 */
export interface EnrichmentJobResult {
  sessionId: string;
  candidateId: string;
  status: EnrichmentGraphOutput['status'];
  identitiesFound: number;
  bestConfidence: number | null;
  durationMs: number;
  error?: string;
}

/**
 * Session status for tracking
 */
export type EnrichmentSessionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Session record in database (matches Prisma schema)
 */
export interface EnrichmentSession {
  id: string;
  candidateId: string;
  status: EnrichmentSessionStatus;
  roleType: RoleType | null;
  sourcesPlanned: string[] | null;
  sourcesExecuted: string[] | null;
  queriesPlanned: number | null;
  queriesExecuted: number | null;
  earlyStopReason: string | null;
  identitiesFound: number;
  identitiesConfirmed: number;
  finalConfidence: number | null;
  errorMessage: string | null;
  errorDetails: unknown | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;

  // Optional summary output (v2.1)
  summary?: string | null;
  summaryStructured?: unknown | null;
  summaryEvidence?: unknown | null;
  summaryModel?: string | null;
  summaryTokens?: number | null;
  summaryGeneratedAt?: string | null;

  createdAt: string;
  updatedAt: string;
}

/**
 * Redis connection singleton
 */
let redisConnection: IORedis | null = null;

function getRedisConnection(): IORedis {
  if (!redisConnection) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
    });
  }
  return redisConnection;
}

/**
 * Queue singleton
 */
let enrichmentQueue: Queue<EnrichmentJobData, EnrichmentJobResult> | null = null;

export function getEnrichmentQueue(): Queue<EnrichmentJobData, EnrichmentJobResult> {
  if (!enrichmentQueue) {
    enrichmentQueue = new Queue(QUEUE_NAMES.ENRICHMENT, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          count: 1000,
          age: 24 * 3600, // Keep completed jobs for 24 hours
        },
        removeOnFail: {
          count: 5000,
          age: 7 * 24 * 3600, // Keep failed jobs for 7 days
        },
      },
    });
  }
  return enrichmentQueue;
}

/**
 * Queue events for progress tracking
 */
let queueEvents: QueueEvents | null = null;

export function getQueueEvents(): QueueEvents {
  if (!queueEvents) {
    queueEvents = new QueueEvents(QUEUE_NAMES.ENRICHMENT, {
      connection: getRedisConnection(),
    });
  }
  return queueEvents;
}

/**
 * Create an enrichment session and enqueue the job
 */
export async function createEnrichmentSession(
  candidateId: string,
  options?: {
    roleType?: RoleType;
    budget?: Partial<EnrichmentBudget>;
    priority?: number;
  }
): Promise<{ sessionId: string; jobId: string }> {
  const sessionId = uuidv4();

  // Create session record using Prisma
  try {
    await prisma.enrichmentSession.create({
      data: {
        id: sessionId,
        candidateId,
        status: 'queued',
        roleType: options?.roleType ?? null,
        sourcesExecuted: [] as unknown as Prisma.InputJsonValue,
        queriesPlanned: options?.budget?.maxQueries || null,
        queriesExecuted: 0,
        identitiesFound: 0,
        identitiesConfirmed: 0,
        // Leave nullable fields unset (defaults to null)
      },
    });
  } catch (error) {
    console.error('[EnrichmentQueue] Failed to create session:', error);
    throw new Error(`Failed to create enrichment session: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Enqueue the job
  const queue = getEnrichmentQueue();
  const job = await queue.add(
    'enrich',
    {
      sessionId,
      candidateId,
      roleType: options?.roleType,
      budget: options?.budget,
      priority: options?.priority,
    },
    {
      priority: options?.priority || 0,
      jobId: sessionId, // Use sessionId as jobId for easy lookup
    }
  );

  console.log(
    `[EnrichmentQueue] Created session ${sessionId} for candidate ${candidateId}, job ${job.id}`
  );

  return { sessionId, jobId: job.id! };
}

/**
 * Get session status
 */
export async function getEnrichmentSession(
  sessionId: string
): Promise<EnrichmentSession | null> {
  const session = await prisma.enrichmentSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    return null;
  }

  // Convert Prisma dates to ISO strings
  // Prisma client types may be stale until `prisma generate` runs in the target environment.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionAny: any = session;
  return {
    ...sessionAny,
    sourcesPlanned: session.sourcesPlanned as string[] | null,
    sourcesExecuted: session.sourcesExecuted as string[] | null,
    startedAt: session.startedAt?.toISOString() || null,
    completedAt: session.completedAt?.toISOString() || null,
    summaryGeneratedAt: sessionAny.summaryGeneratedAt?.toISOString?.() || null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  } as EnrichmentSession;
}

/**
 * Get recent sessions for a candidate
 */
export async function getRecentSessions(
  candidateId: string,
  limit: number = 5
): Promise<EnrichmentSession[]> {
  const sessions = await prisma.enrichmentSession.findMany({
    where: { candidateId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  // Convert Prisma dates to ISO strings
  return sessions.map((session) => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(session as any),
    sourcesPlanned: session.sourcesPlanned as string[] | null,
    sourcesExecuted: session.sourcesExecuted as string[] | null,
    startedAt: session.startedAt?.toISOString() || null,
    completedAt: session.completedAt?.toISOString() || null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summaryGeneratedAt: (session as any).summaryGeneratedAt?.toISOString?.() || null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  })) as EnrichmentSession[];
}

/**
 * Update session status
 */
async function updateSessionStatus(
  sessionId: string,
  updates: Partial<{
    status: EnrichmentSessionStatus;
    sourcesPlanned: string[];
    sourcesExecuted: string[];
    queriesExecuted: number;
    identitiesFound: number;
    finalConfidence: number;
    earlyStopReason: string;
    errorMessage: string;
    errorDetails: unknown;
    startedAt: Date;
    completedAt: Date;
    durationMs: number;
  }>
): Promise<void> {
  try {
    const data: Prisma.EnrichmentSessionUpdateInput = {};

    if (updates.status !== undefined) data.status = updates.status;
    if (updates.queriesExecuted !== undefined) data.queriesExecuted = updates.queriesExecuted;
    if (updates.identitiesFound !== undefined) data.identitiesFound = updates.identitiesFound;
    if (updates.finalConfidence !== undefined) data.finalConfidence = updates.finalConfidence;
    if (updates.earlyStopReason !== undefined) data.earlyStopReason = updates.earlyStopReason;
    if (updates.errorMessage !== undefined) data.errorMessage = updates.errorMessage;
    if (updates.durationMs !== undefined) data.durationMs = updates.durationMs;
    if (updates.startedAt !== undefined) data.startedAt = updates.startedAt;
    if (updates.completedAt !== undefined) data.completedAt = updates.completedAt;

    if (updates.sourcesPlanned !== undefined) {
      data.sourcesPlanned = JSON.parse(JSON.stringify(updates.sourcesPlanned)) as Prisma.InputJsonValue;
    }
    if (updates.sourcesExecuted !== undefined) {
      data.sourcesExecuted = JSON.parse(JSON.stringify(updates.sourcesExecuted)) as Prisma.InputJsonValue;
    }
    if (updates.errorDetails !== undefined) {
      data.errorDetails = JSON.parse(JSON.stringify(updates.errorDetails)) as Prisma.InputJsonValue;
    }

    await prisma.enrichmentSession.update({
      where: { id: sessionId },
      data,
    });
  } catch (error) {
    console.error('[EnrichmentQueue] Failed to update session:', error);
  }
}

/**
 * Process enrichment job
 */
async function processEnrichmentJob(
  job: Job<EnrichmentJobData, EnrichmentJobResult>
): Promise<EnrichmentJobResult> {
  const { sessionId, candidateId, roleType, budget } = job.data;
  const startTime = Date.now();

  console.log(`[EnrichmentWorker] Processing job ${job.id} for candidate ${candidateId}`);

  // Update session to running
  await updateSessionStatus(sessionId, {
    status: 'running',
    startedAt: new Date(),
  });

  try {
    // Run the enrichment graph
    const result = await runEnrichment(
      { candidateId, sessionId, roleType, budget },
      {
        onProgress: async (event) => {
          // Update job progress
          await job.updateProgress({
            event: event.type,
            platform: event.platform,
            data: event.data,
            timestamp: event.timestamp,
          });
        },
      }
    );

    // Update session with results
    await updateSessionStatus(sessionId, {
      status: result.status === 'failed' ? 'failed' : 'completed',
      identitiesFound: result.identitiesFound.length,
      finalConfidence: result.bestConfidence || undefined,
      queriesExecuted: result.queriesExecuted,
      sourcesExecuted: result.sourcesExecuted,
      earlyStopReason: result.earlyStopReason || undefined,
      errorMessage: result.errors.length > 0 ? result.errors[0].message : undefined,
      completedAt: new Date(),
      durationMs: Date.now() - startTime,
    });

    console.log(
      `[EnrichmentWorker] Completed job ${job.id}: ${result.identitiesFound.length} identities found`
    );

    return {
      sessionId,
      candidateId,
      status: result.status,
      identitiesFound: result.identitiesFound.length,
      bestConfidence: result.bestConfidence,
      durationMs: result.durationMs,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Update session with error
    await updateSessionStatus(sessionId, {
      status: 'failed',
      errorMessage,
      completedAt: new Date(),
      durationMs: Date.now() - startTime,
    });

    console.error(`[EnrichmentWorker] Job ${job.id} failed:`, errorMessage);

    return {
      sessionId,
      candidateId,
      status: 'failed',
      identitiesFound: 0,
      bestConfidence: null,
      durationMs: 0,
      error: errorMessage,
    };
  }
}

/**
 * Worker singleton
 */
let enrichmentWorker: Worker<EnrichmentJobData, EnrichmentJobResult> | null = null;

/**
 * Start the enrichment worker
 */
export function startEnrichmentWorker(options?: {
  concurrency?: number;
}): Worker<EnrichmentJobData, EnrichmentJobResult> {
  if (enrichmentWorker) {
    return enrichmentWorker;
  }

  enrichmentWorker = new Worker<EnrichmentJobData, EnrichmentJobResult>(
    QUEUE_NAMES.ENRICHMENT,
    processEnrichmentJob,
    {
      connection: getRedisConnection(),
      concurrency: options?.concurrency || 3,
    }
  );

  enrichmentWorker.on('completed', (job, result) => {
    console.log(
      `[EnrichmentWorker] Job ${job.id} completed: ${result.identitiesFound} identities`
    );
  });

  enrichmentWorker.on('failed', (job, error) => {
    console.error(`[EnrichmentWorker] Job ${job?.id} failed:`, error.message);
  });

  enrichmentWorker.on('error', (error) => {
    console.error('[EnrichmentWorker] Worker error:', error);
  });

  console.log('[EnrichmentWorker] Worker started');

  return enrichmentWorker;
}

/**
 * Stop the enrichment worker
 */
export async function stopEnrichmentWorker(): Promise<void> {
  if (enrichmentWorker) {
    await enrichmentWorker.close();
    enrichmentWorker = null;
    console.log('[EnrichmentWorker] Worker stopped');
  }
}

/**
 * Get queue statistics
 */
export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getEnrichmentQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Cleanup on shutdown
 */
export async function cleanupQueue(): Promise<void> {
  await stopEnrichmentWorker();

  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }

  if (enrichmentQueue) {
    await enrichmentQueue.close();
    enrichmentQueue = null;
  }

  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }

  console.log('[EnrichmentQueue] Cleaned up');
}

export default {
  createEnrichmentSession,
  getEnrichmentSession,
  getRecentSessions,
  getEnrichmentQueue,
  getQueueEvents,
  getQueueStats,
  startEnrichmentWorker,
  stopEnrichmentWorker,
  cleanupQueue,
};
