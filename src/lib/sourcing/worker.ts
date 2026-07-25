/**
 * Sourcing Worker Entry Point
 *
 * Standalone script to start the BullMQ worker for processing sourcing jobs.
 * Run as a separate service:
 *
 *   npx tsx src/lib/sourcing/worker.ts
 *
 * Or via npm script:
 *   npm run worker:sourcing
 */

import http from 'http';
import { startSourcingWorker, cleanupSourcingQueue, getSourcingQueueStats } from './queue';
import { redeliverStaleCallbacks } from './callback';
import { createLogger } from '@/lib/logger';
import {
  startPublicMemoryIngestWorker,
  stopPublicMemoryIngestWorker,
} from './public-memory-ingest-worker';
import {
  startContactEnrichmentWorker,
  stopContactEnrichmentWorker,
} from '@/lib/contact-enrichment/worker';

const log = createLogger('SourcingWorker');

function parsePositiveInt(raw: string | undefined, fallback: number, envName: string): number {
  const parsed = Number.parseInt(raw || String(fallback), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  log.warn({ envName, raw, default: fallback }, 'Invalid env value, using default');
  return fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return fallback;
}

const CONCURRENCY = parsePositiveInt(
  process.env.SOURCING_WORKER_CONCURRENCY,
  2,
  'SOURCING_WORKER_CONCURRENCY',
);
const HEALTH_PORT = parsePositiveInt(process.env.PORT, 8081, 'PORT');
const CALLBACK_REDELIVERY_ENABLED = parseBoolean(
  process.env.SOURCING_CALLBACK_REDELIVERY_ENABLED,
  true,
);
const CALLBACK_REDELIVERY_INTERVAL_MINUTES = parsePositiveInt(
  process.env.SOURCING_CALLBACK_REDELIVERY_INTERVAL_MINUTES,
  10,
  'SOURCING_CALLBACK_REDELIVERY_INTERVAL_MINUTES',
);
const CALLBACK_REDELIVERY_MAX_AGE_MINUTES = parsePositiveInt(
  process.env.SOURCING_CALLBACK_REDELIVERY_MAX_AGE_MINUTES,
  30,
  'SOURCING_CALLBACK_REDELIVERY_MAX_AGE_MINUTES',
);
const CALLBACK_REDELIVERY_BATCH_SIZE = parsePositiveInt(
  process.env.SOURCING_CALLBACK_REDELIVERY_BATCH_SIZE,
  50,
  'SOURCING_CALLBACK_REDELIVERY_BATCH_SIZE',
);

log.info({ concurrency: CONCURRENCY, redisConfigured: !!process.env.REDIS_URL }, 'Starting sourcing worker');

const worker = startSourcingWorker({ concurrency: CONCURRENCY });
const PUBLIC_MEMORY_INGEST_ENABLED =
  process.env.SOURCE_PUBLIC_MEMORY_INGEST_WORKER_ENABLED !== 'false';
if (PUBLIC_MEMORY_INGEST_ENABLED) {
  startPublicMemoryIngestWorker({
    intervalMs: parsePositiveInt(
      process.env.SOURCE_PUBLIC_MEMORY_INGEST_INTERVAL_MS,
      2_000,
      'SOURCE_PUBLIC_MEMORY_INGEST_INTERVAL_MS',
    ),
    options: {
      batchSize: parsePositiveInt(
        process.env.SOURCE_PUBLIC_MEMORY_INGEST_BATCH_SIZE,
        20,
        'SOURCE_PUBLIC_MEMORY_INGEST_BATCH_SIZE',
      ),
      concurrency: parsePositiveInt(
        process.env.SOURCE_PUBLIC_MEMORY_INGEST_CONCURRENCY,
        5,
        'SOURCE_PUBLIC_MEMORY_INGEST_CONCURRENCY',
      ),
    },
  });
}
const CONTACT_ENRICHMENT_ENABLED =
  process.env.CONTACT_ENRICHMENT_WORKER_ENABLED === 'true';
if (CONTACT_ENRICHMENT_ENABLED) {
  startContactEnrichmentWorker({
    intervalMs: parsePositiveInt(
      process.env.CONTACT_ENRICHMENT_INTERVAL_MS,
      5_000,
      'CONTACT_ENRICHMENT_INTERVAL_MS',
    ),
    options: {
      batchSize: parsePositiveInt(
        process.env.CONTACT_ENRICHMENT_BATCH_SIZE,
        20,
        'CONTACT_ENRICHMENT_BATCH_SIZE',
      ),
      concurrency: parsePositiveInt(
        process.env.CONTACT_ENRICHMENT_CONCURRENCY,
        5,
        'CONTACT_ENRICHMENT_CONCURRENCY',
      ),
      leaseMs: parsePositiveInt(
        process.env.CONTACT_ENRICHMENT_LEASE_MS,
        60_000,
        'CONTACT_ENRICHMENT_LEASE_MS',
      ),
      fullEnrichPollMs: parsePositiveInt(
        process.env.CONTACT_FULLENRICH_POLL_MS,
        5 * 60_000,
        'CONTACT_FULLENRICH_POLL_MS',
      ),
    },
  });
}
let callbackRedeliveryTimer: NodeJS.Timeout | null = null;
let callbackRedeliveryRunning = false;

async function runCallbackRedeliveryCycle(): Promise<void> {
  if (callbackRedeliveryRunning) {
    log.warn('Skipping callback redelivery cycle: previous cycle still running');
    return;
  }

  callbackRedeliveryRunning = true;
  try {
    const summary = await redeliverStaleCallbacks({
      maxAgeMinutes: CALLBACK_REDELIVERY_MAX_AGE_MINUTES,
      limit: CALLBACK_REDELIVERY_BATCH_SIZE,
    });
    if (summary.attempted > 0) {
      log.info({ ...summary }, 'Callback redelivery cycle completed');
    }
  } catch (error) {
    log.error({ err: error }, 'Callback redelivery cycle failed');
  } finally {
    callbackRedeliveryRunning = false;
  }
}

if (CALLBACK_REDELIVERY_ENABLED) {
  const intervalMs = CALLBACK_REDELIVERY_INTERVAL_MINUTES * 60 * 1000;
  callbackRedeliveryTimer = setInterval(() => {
    void runCallbackRedeliveryCycle();
  }, intervalMs);
  log.info(
    {
      intervalMinutes: CALLBACK_REDELIVERY_INTERVAL_MINUTES,
      maxAgeMinutes: CALLBACK_REDELIVERY_MAX_AGE_MINUTES,
      batchSize: CALLBACK_REDELIVERY_BATCH_SIZE,
    },
    'Callback redelivery scheduler enabled',
  );
  void runCallbackRedeliveryCycle();
} else {
  log.info('Callback redelivery scheduler disabled');
}

const healthServer = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/health') {
    try {
      const stats = await getSourcingQueueStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        worker: 'sourcing',
        concurrency: CONCURRENCY,
        queue: stats,
      }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', worker: 'sourcing' }));
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

healthServer.listen(HEALTH_PORT, () => {
  log.info({ port: HEALTH_PORT }, 'Health server listening');
});

const shutdown = async (signal: string) => {
  log.info({ signal }, 'Received signal, shutting down gracefully');
  try {
    healthServer.close();
    if (callbackRedeliveryTimer) {
      clearInterval(callbackRedeliveryTimer);
      callbackRedeliveryTimer = null;
    }
    stopPublicMemoryIngestWorker();
    stopContactEnrichmentWorker();
    await cleanupSourcingQueue();
    log.info('Cleanup complete, exiting');
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log.info('Sourcing worker started and listening for jobs');
