/**
 * Smoke trigger: enqueue a graph sync job for one known candidate.
 *
 * This only proves enqueue succeeded. To validate end-to-end, check:
 *   1. enrichment-worker logs (graph sync completed, globalCandidateId)
 *   2. Signal DB: candidate_global_links
 *   3. ActiveKG DB: global_candidates / candidate_provenance
 *
 * Required env:
 *   CANDIDATE_GRAPH_SYNC_ENABLED=true
 *   REDIS_URL              (BullMQ connection)
 *   ACTIVEKG_BASE_URL      (worker reads candidate and calls ActiveKG)
 *   SIGNAL_JWT_PRIVATE_KEY (RS256 key for ActiveKG auth)
 *   DATABASE_URL            (Prisma — worker reads candidate data)
 *
 * Usage:
 *   tsx scripts/trigger-graph-sync-test.ts [candidateId] [tenantId]
 */

import { enqueueGraphSync, getGraphSyncQueueStats } from '@/lib/integrations/candidate-graph-sync';

const CANDIDATE_ID = process.argv[2] || 'cmmkdqfol00hump0qps9q4mps'; // Julie Unsworth
const TENANT_ID = process.argv[3] || 'dev-tenant';

async function main() {
  console.log(`Enqueuing graph sync: candidate=${CANDIDATE_ID} tenant=${TENANT_ID}`);

  const jobId = await enqueueGraphSync({
    candidateId: CANDIDATE_ID,
    tenantId: TENANT_ID,
    trigger: 'enrichment',
  });

  if (!jobId) {
    console.error('enqueueGraphSync returned null — is CANDIDATE_GRAPH_SYNC_ENABLED=true?');
    process.exit(1);
  }

  console.log(`Job enqueued: ${jobId}`);

  const stats = await getGraphSyncQueueStats();
  console.log('Queue stats:', stats);

  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
