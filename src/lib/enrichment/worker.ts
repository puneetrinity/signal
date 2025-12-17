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

import { startEnrichmentWorker, cleanupQueue } from './queue';

const CONCURRENCY = parseInt(process.env.ENRICHMENT_WORKER_CONCURRENCY || '3', 10);

console.log('[EnrichmentWorker] Starting worker...');
console.log(`[EnrichmentWorker] Concurrency: ${CONCURRENCY}`);
console.log(`[EnrichmentWorker] Redis URL: ${process.env.REDIS_URL ? 'configured' : 'not configured (using localhost)'}`);

// Start the worker
const worker = startEnrichmentWorker({ concurrency: CONCURRENCY });

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`[EnrichmentWorker] Received ${signal}, shutting down gracefully...`);

  try {
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
