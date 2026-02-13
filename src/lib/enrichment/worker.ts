/**
 * Enrichment Worker Entry Point
 *
 * Standalone script to start the BullMQ worker for processing enrichment jobs.
 * Run as a separate service on Railway:
 *
 *   npx tsx src/lib/enrichment/worker.ts
 *
 * Or via npm script:
 *   npm run worker:enrichment
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import http from 'http';
import { startEnrichmentWorker, cleanupQueue, getQueueStats } from './queue';
import { createLogger } from '@/lib/logger';

const log = createLogger('EnrichmentWorker');

function parsePositiveInt(raw: string | undefined, fallback: number, envName: string): number {
  const parsed = Number.parseInt(raw || String(fallback), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  log.warn({ envName, raw, default: fallback }, 'Invalid env value, using default');
  return fallback;
}

const CONCURRENCY = parsePositiveInt(
  process.env.ENRICHMENT_WORKER_CONCURRENCY,
  3,
  'ENRICHMENT_WORKER_CONCURRENCY'
);
const HEALTH_PORT = parsePositiveInt(process.env.PORT, 8080, 'PORT');

log.info({ concurrency: CONCURRENCY, redisConfigured: !!process.env.REDIS_URL }, 'Starting worker');

// Start the worker
const worker = startEnrichmentWorker({ concurrency: CONCURRENCY });

// Simple health check server for Railway
const healthServer = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/health') {
    try {
      const stats = await getQueueStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        worker: 'enrichment',
        concurrency: CONCURRENCY,
        queue: stats,
      }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', worker: 'enrichment' }));
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

healthServer.listen(HEALTH_PORT, () => {
  log.info({ port: HEALTH_PORT }, 'Health server listening');
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  log.info({ signal }, 'Received signal, shutting down gracefully');

  try {
    healthServer.close();
    await cleanupQueue();
    log.info('Cleanup complete, exiting');
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Keep process alive
log.info('Worker started and listening for jobs');
