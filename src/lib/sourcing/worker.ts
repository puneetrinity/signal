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
import { createLogger } from '@/lib/logger';

const log = createLogger('SourcingWorker');

function parsePositiveInt(raw: string | undefined, fallback: number, envName: string): number {
  const parsed = Number.parseInt(raw || String(fallback), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  log.warn({ envName, raw, default: fallback }, 'Invalid env value, using default');
  return fallback;
}

const CONCURRENCY = parsePositiveInt(
  process.env.SOURCING_WORKER_CONCURRENCY,
  2,
  'SOURCING_WORKER_CONCURRENCY',
);
const HEALTH_PORT = parsePositiveInt(process.env.PORT, 8081, 'PORT');

log.info({ concurrency: CONCURRENCY, redisConfigured: !!process.env.REDIS_URL }, 'Starting sourcing worker');

const worker = startSourcingWorker({ concurrency: CONCURRENCY });

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
