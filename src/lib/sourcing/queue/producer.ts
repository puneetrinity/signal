import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { SourcingJobData, SourcingJobResult } from '../types';

export const SOURCING_QUEUE_NAME = process.env.NODE_ENV === 'production' ? 'sourcing' : 'sourcing_dev';

let redisConnection: IORedis | null = null;

export function getRedisConnection(): IORedis {
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

export async function cleanupSourcingQueueClient(): Promise<void> {
  if (sourcingQueue) {
    await sourcingQueue.close();
    sourcingQueue = null;
  }
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
}
