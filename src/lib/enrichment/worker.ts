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

const CONCURRENCY = parseInt(process.env.ENRICHMENT_WORKER_CONCURRENCY || '3', 10);
const HEALTH_PORT = parseInt(process.env.PORT || '8080', 10);

console.log('[EnrichmentWorker] Starting worker...');
console.log(`[EnrichmentWorker] Concurrency: ${CONCURRENCY}`);
console.log(`[EnrichmentWorker] Redis URL: ${process.env.REDIS_URL ? 'configured' : 'not configured (using localhost)'}`);

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
  console.log(`[EnrichmentWorker] Health server listening on port ${HEALTH_PORT}`);
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`[EnrichmentWorker] Received ${signal}, shutting down gracefully...`);

  try {
    healthServer.close();
    await cleanupQueue();
    console.log('[EnrichmentWorker] Cleanup complete, exiting');
    process.exit(0);
  } catch (error) {
    console.error('[EnrichmentWorker] Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Keep process alive
console.log('[EnrichmentWorker] Worker started and listening for jobs');
