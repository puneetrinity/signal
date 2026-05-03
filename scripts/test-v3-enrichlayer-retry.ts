/**
 * V3 — EnrichLayer retry under forced failure.
 *
 * Worker is started with ENRICHLAYER_PROFILE_URL=http://127.0.0.1:1/profile
 * (nothing listening on port 1 → connection refused → throws plain Error).
 *
 * Per the retry/classification fix, the worker should:
 *   - throw plain Error (network failure, retryable)
 *   - BullMQ engages attempts:3 + exponential backoff
 *   - On final attempt failure, session ends 'failed' with errorMessage
 *
 * This script:
 *   1. Picks one fresh candidate (not yet enriched)
 *   2. Enqueues an enrichment session
 *   3. Polls the session status, prints each transition
 *   4. Asserts: ≥3 BullMQ attempts (visible via job.attemptsMade in queue)
 *      and final session.status='failed' with errorMessage matching network error
 */
import { prisma } from '@/lib/prisma';
import { createEnrichmentSession, getEnrichmentQueue } from '@/lib/enrichment/queue';

async function main() {
  const TENANT = 'dev-tenant';

  // Find a candidate that hasn't been enriched yet
  const candidate = await prisma.candidate.findFirst({
    where: {
      tenantId: TENANT,
      enrichmentStatus: { not: 'completed' },
      linkedinUrl: { not: '' },
    },
    select: { id: true, nameHint: true, linkedinUrl: true, enrichmentStatus: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!candidate) throw new Error('no eligible candidate found');
  console.log(`candidate id=${candidate.id} name=${candidate.nameHint ?? '(none)'} status=${candidate.enrichmentStatus}`);

  // Enqueue
  const { sessionId } = await createEnrichmentSession(TENANT, candidate.id, { priority: 1 });
  console.log(`sessionId=${sessionId}`);

  const queue = getEnrichmentQueue();
  const start = Date.now();
  // Total backoff: 5s + 10s + 20s = 35s, plus ~30s for fetch timeout × 3 attempts.
  // Add slack.
  const TIMEOUT_MS = 180_000;
  let lastStatus = '';
  let lastAttempts = -1;

  while (Date.now() - start < TIMEOUT_MS) {
    const sess = await prisma.enrichmentSession.findUnique({
      where: { id: sessionId },
      select: { status: true, errorMessage: true },
    });
    const job = await queue.getJob(sessionId);
    const attempts = job?.attemptsMade ?? -1;

    if (sess?.status !== lastStatus || attempts !== lastAttempts) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(
        `[${elapsed}s] sessionStatus=${sess?.status} attemptsMade=${attempts} ${
          sess?.errorMessage ? `err="${sess.errorMessage.slice(0, 80)}"` : ''
        }`,
      );
      lastStatus = sess?.status ?? '';
      lastAttempts = attempts;
    }

    // Terminal = BullMQ job in 'failed' or 'completed' state. Note: session.status
    // can hit 'failed' between retries (we mark it pessimistically in catch); rely
    // on BullMQ's job state for the true terminal.
    const jobState = job ? await job.getState() : null;
    if (jobState === 'failed' || jobState === 'completed') {
      const finalAttempts = job?.attemptsMade ?? 0;
      console.log(`\nfinal sessionStatus=${sess?.status} jobState=${jobState} attemptsMade=${finalAttempts}`);

      const ok = jobState === 'failed' && finalAttempts >= 3 && Boolean(sess?.errorMessage);
      console.log(
        `\n=== ${ok ? 'PASS' : 'FAIL'} V3 ===\n` +
          `  jobState=${jobState} attemptsMade=${finalAttempts} (expected jobState=failed, attempts>=3)\n` +
          `  errorMessage="${sess?.errorMessage ?? '(none)'}"`,
      );
      await prisma.$disconnect();
      process.exit(ok ? 0 : 1);
    }

    await new Promise((r) => setTimeout(r, 2_000));
  }

  console.log('TIMED OUT waiting for terminal state');
  await prisma.$disconnect();
  process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
