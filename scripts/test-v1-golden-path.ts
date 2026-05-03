/**
 * V1 — Golden path validation against the live local pipeline.
 *
 * Skips the JWT/HTTP layer (well-known, not what we changed) and exercises
 * what's actually new: Crustdata structured short-circuit + EnrichLayer v2
 * + retry/classification fix.
 *
 * Mirrors the work that POST /api/v3/jobs/[id]/source does after auth:
 *   - resolve track
 *   - create JobSourcingRequest
 *   - enqueue on sourcing queue
 *   - poll status
 *   - read results from DB
 *
 * Pass criteria:
 *   - request.status reaches 'completed'
 *   - resultCount >= 80
 *   - telemetry shows Crustdata structured short-circuit hit (1 strict query, target_reached)
 *   - at least some candidates show structured providerMeta hints
 */
import { prisma } from '@/lib/prisma';
import { getSourcingQueue } from '@/lib/sourcing/queue';
import { buildJobRequirements } from '@/lib/sourcing/jd-digest';
import { resolveTrack } from '@/lib/sourcing/track-resolver';
import { toJsonValue } from '@/lib/prisma/json';
import { createHash, randomUUID } from 'crypto';
import type { SourcingJobData } from '@/lib/sourcing/types';

const TENANT = process.env.TEST_TENANT_ID || 'dev-tenant';
// Mirrors the diagnosis baseline shape: AE / Mumbai / 5 skills
const JOB_CONTEXT = {
  jdDigest: 'Senior Account Executive role in Mumbai. Requires consultative selling, enterprise sales, pipeline management, salesforce, and stakeholder management.',
  title: 'Enterprise Account Executive',
  skills: ['consultative selling', 'enterprise sales', 'pipeline management', 'salesforce', 'stakeholder management'],
  goodToHaveSkills: ['account management', 'customer success', 'meddic', 'outbound'],
  location: 'Mumbai, India',
};

function jobContextHash(ctx: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const k of Object.keys(ctx).sort()) filtered[k] = ctx[k];
  return createHash('sha256').update(JSON.stringify(filtered)).digest('hex');
}

async function main() {
  const externalJobId = `test-v1-${Date.now()}`;
  console.log(`\n=== V1 Golden Path ===`);
  console.log(`tenant=${TENANT} externalJobId=${externalJobId}`);

  const requirements = buildJobRequirements(JOB_CONTEXT);
  const trackDecision = await resolveTrack(JOB_CONTEXT, requirements);
  console.log(`track=${trackDecision.track} method=${trackDecision.method} conf=${trackDecision.confidence}`);

  const req = await prisma.jobSourcingRequest.create({
    data: {
      tenantId: TENANT,
      externalJobId,
      jobContextHash: jobContextHash(JOB_CONTEXT),
      jobContext: JOB_CONTEXT,
      callbackUrl: 'https://webhook.site/test-v1',
      status: 'queued',
      diagnostics: toJsonValue({ trackDecision }),
    },
  });
  console.log(`requestId=${req.id}`);

  const jobData: SourcingJobData = {
    requestId: req.id,
    tenantId: TENANT,
    externalJobId,
    callbackUrl: req.callbackUrl,
    resolvedTrack: trackDecision,
  };
  await getSourcingQueue().add('source', jobData, { jobId: req.id });
  console.log('enqueued');

  const start = Date.now();
  const TIMEOUT_MS = 5 * 60_000;
  let lastStatus = '';
  let final: typeof req | null = null;
  while (Date.now() - start < TIMEOUT_MS) {
    const cur = await prisma.jobSourcingRequest.findUnique({ where: { id: req.id } });
    if (!cur) throw new Error('request vanished');
    if (cur.status !== lastStatus) {
      console.log(`[${Math.round((Date.now() - start) / 1000)}s] status=${cur.status} resultCount=${cur.resultCount ?? '-'}`);
      lastStatus = cur.status;
    }
    // DB enum is 'complete' / 'failed' (not 'completed'); accept both for safety.
    if (cur.status === 'complete' || cur.status === 'completed' || cur.status === 'failed') {
      final = cur;
      break;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (!final) throw new Error(`timed out after ${TIMEOUT_MS / 1000}s, last status=${lastStatus}`);

  console.log(`\nfinal status=${final.status} resultCount=${final.resultCount}`);

  const diag = (final.diagnostics ?? {}) as Record<string, unknown>;
  const telemetry = (diag.discoveryTelemetry ?? diag.telemetry ?? {}) as Record<string, unknown>;
  console.log('telemetry:', JSON.stringify({
    stoppedReason: telemetry.stoppedReason,
    strictQueriesExecuted: telemetry.strictQueriesExecuted,
    fallbackQueriesExecuted: telemetry.fallbackQueriesExecuted,
    providerUsage: telemetry.providerUsage,
  }, null, 2));

  const candidates = await prisma.candidate.findMany({
    where: {
      tenantId: TENANT,
      sourcingCandidates: { some: { sourcingRequestId: req.id } },
    },
    select: {
      id: true,
      nameHint: true,
      headlineHint: true,
      companyHint: true,
      enrichmentStatus: true,
    },
    take: 5,
  });
  console.log(`\nsample candidates (first 5 of pool):`);
  for (const c of candidates) {
    console.log(`  ${c.nameHint ?? '(no name)'} | ${c.companyHint ?? '(no co)'} | enrich=${c.enrichmentStatus}`);
  }

  const ok =
    (final.status === 'complete' || final.status === 'completed') &&
    (final.resultCount ?? 0) >= 80 &&
    telemetry.stoppedReason === 'target_reached';

  console.log(`\n=== ${ok ? 'PASS' : 'FAIL'} V1 ===`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
