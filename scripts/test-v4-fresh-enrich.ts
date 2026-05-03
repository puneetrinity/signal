/**
 * V4 helper — confirm the recovered worker can enrich NEW jobs successfully.
 * This proves the worker is healthy after restart; the V3 failed sessions
 * staying failed is the missing-recovery signal (Phase 5.7-5.9 gap).
 */
import { prisma } from '@/lib/prisma';
import { createEnrichmentSession, getEnrichmentQueue } from '@/lib/enrichment/queue';

async function main() {
  const TENANT = 'dev-tenant';
  const candidate = await prisma.candidate.findFirst({
    where: {
      tenantId: TENANT,
      enrichmentStatus: 'pending',
      linkedinUrl: { not: '' },
      id: { not: 'cmoptdztr000j7qu7zptoeag3' }, // avoid the V3 failed-session candidate
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, nameHint: true },
  });
  if (!candidate) {
    console.log('no fresh candidate without sessions; skipping fresh-enrich check');
    process.exit(0);
  }
  console.log(`fresh candidate id=${candidate.id} name=${candidate.nameHint ?? '(none)'}`);

  const { sessionId } = await createEnrichmentSession(TENANT, candidate.id, { priority: 1 });
  console.log(`sessionId=${sessionId}`);

  const queue = getEnrichmentQueue();
  const start = Date.now();
  const TIMEOUT_MS = 60_000;
  let lastStatus = '';
  while (Date.now() - start < TIMEOUT_MS) {
    const sess = await prisma.enrichmentSession.findUnique({
      where: { id: sessionId },
      select: { status: true, errorMessage: true },
    });
    const job = await queue.getJob(sessionId);
    const jobState = job ? await job.getState() : null;
    if (sess?.status !== lastStatus) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[${elapsed}s] sessionStatus=${sess?.status} jobState=${jobState}`);
      lastStatus = sess?.status ?? '';
    }
    if (jobState === 'completed' || jobState === 'failed') {
      const ok = jobState === 'completed' && sess?.status !== 'failed';
      console.log(`\n=== ${ok ? 'PASS' : 'FAIL'} fresh-enrich ===`);
      console.log(`  jobState=${jobState} sessionStatus=${sess?.status} err=${sess?.errorMessage ?? '-'}`);
      await prisma.$disconnect();
      process.exit(ok ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  console.log('TIMED OUT');
  await prisma.$disconnect();
  process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
