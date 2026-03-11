/**
 * Candidate Graph Sync Queue (BullMQ)
 *
 * Async queue for syncing tenant-scoped candidates to the global ActiveKG
 * knowledge graph. Mirrors enrichment/sourcing queue patterns.
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { createLogger } from '@/lib/logger';

const log = createLogger('CandidateGraphSync');

export const GRAPH_SYNC_QUEUE_NAME = 'candidate-graph-sync';

// ---------------------------------------------------------------------------
// Job data
// ---------------------------------------------------------------------------

export interface CandidateGraphSyncJobData {
  candidateId: string;
  tenantId: string;
  trigger: 'discovery' | 'enrichment' | 're-enrichment';
  /** Optional metadata for diagnostics */
  sourcingRequestId?: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Redis connection singleton
// ---------------------------------------------------------------------------

let redisConnection: IORedis | null = null;

export function getRedisConnection(): IORedis {
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

let graphSyncQueue: Queue<CandidateGraphSyncJobData> | null = null;

export function getGraphSyncQueue(): Queue<CandidateGraphSyncJobData> {
  if (!graphSyncQueue) {
    graphSyncQueue = new Queue(GRAPH_SYNC_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 10_000,
        },
        removeOnComplete: {
          count: 1000,
          age: 24 * 3600, // 24h
        },
        removeOnFail: {
          count: 5000,
          age: 7 * 24 * 3600, // 7d
        },
      },
    });
  }
  return graphSyncQueue;
}

// ---------------------------------------------------------------------------
// Enqueue helper
// ---------------------------------------------------------------------------

/**
 * Enqueue a candidate graph sync job.
 * Returns the job ID, or null if the feature is disabled.
 */
export async function enqueueGraphSync(
  data: CandidateGraphSyncJobData,
): Promise<string | null> {
  if (process.env.CANDIDATE_GRAPH_SYNC_ENABLED !== 'true') {
    return null;
  }

  const queue = getGraphSyncQueue();
  const jobId = `cgraph-${data.tenantId}-${data.candidateId}-${data.trigger}`;

  const job = await queue.add('sync', data, { jobId });

  log.info(
    { jobId: job.id, candidateId: data.candidateId, tenantId: data.tenantId, trigger: data.trigger },
    'Enqueued graph sync job',
  );

  return job.id ?? null;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function getGraphSyncQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getGraphSyncQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function cleanupGraphSyncQueue(): Promise<void> {
  if (graphSyncQueue) {
    await graphSyncQueue.close();
    graphSyncQueue = null;
  }

  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }

  log.info('Graph sync queue cleaned up');
}
