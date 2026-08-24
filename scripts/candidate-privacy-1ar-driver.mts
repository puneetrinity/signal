import { readFileSync } from 'node:fs';

const databaseUrl = process.env.DATABASE_URL ?? '';
const memoryUrl = process.env.ACTIVEGRAPH_URL ?? '';
const tenantId = 'candidate-privacy-test-tenant';
const candidateIds = {
  control: 'candidate-privacy-1ar-control',
  erasure: 'candidate-privacy-1ar-erasure',
  global: 'candidate-privacy-1ar-global',
};

function refuse(): never {
  throw new Error('DISCOVER_1AR_DRIVER_REFUSED');
}

function assertLoopback(raw: string, requireTestIdentity: boolean): void {
  const parsed = new URL(raw);
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname)) refuse();
  if (requireTestIdentity && (
    !decodeURIComponent(parsed.pathname).includes('test') ||
    !decodeURIComponent(parsed.username).includes('test')
  )) refuse();
}

assertLoopback(databaseUrl, true);
assertLoopback(memoryUrl, false);
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER ||
  process.env.SIGNAL_CANDIDATE_PRIVACY_ACTOR_ID !== 'signal-service'
) refuse();

const scenarioPath = process.argv[2];
if (!scenarioPath) refuse();
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as Record<string, unknown>;
if (
  JSON.stringify(Object.keys(scenario).sort()) !== JSON.stringify(['command']) ||
  !['baseline', 'restricted', 'transition'].includes(String(scenario.command))
) refuse();

async function run() {
  const { prisma } = await import('../src/lib/prisma');
  const { runCandidatePrivacyProcessorOnce } = await import('../src/lib/candidate-privacy/processor');
  try {
    if (scenario.command === 'baseline') {
      await prisma.candidatePrivacyProjection.deleteMany();
      await prisma.candidateGlobalLink.deleteMany();
      await prisma.candidate.deleteMany({ where: { tenantId } });
      await prisma.candidatePrivacySyncState.update({
        where: { consumerName: 'discover' },
        data: {
          cursor: BigInt(0), activeGeneration: BigInt(0), status: 'uninitialized',
          lastSuccessAt: null, rebuildStartedAt: null, rebuildClaimToken: null,
          rebuildLeaseExpiresAt: null, lastErrorCode: null,
          expectedCandidates: 0, projectedCandidates: 0,
        },
      });
      await prisma.candidate.createMany({
        data: Object.values(candidateIds).map((id) => ({
          id, tenantId, linkedinId: id,
          linkedinUrl: `https://www.linkedin.com/in/${id}`,
        })),
      });
    }

    const outcome = await runCandidatePrivacyProcessorOnce();
    if (outcome !== 'rebuilt') refuse();
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    const decisions = await prisma.candidatePrivacyProjection.groupBy({
      by: ['decision'],
      where: { generation: state.activeGeneration },
      _count: { _all: true },
      orderBy: { decision: 'asc' },
    });
    const counts = new Map(decisions.map((row) => [row.decision, row._count._all]));
    if (
      state.status !== 'healthy' || state.expectedCandidates !== 3 ||
      state.projectedCandidates !== 3 ||
      (scenario.command === 'baseline' && (
        state.cursor !== BigInt(0) || counts.get('allow') !== 3
      )) ||
      (scenario.command === 'restricted' && (
        state.cursor !== BigInt(6) || counts.get('allow') !== 1 ||
        counts.get('block_all') !== 1 || counts.get('block_global') !== 1
      )) ||
      (scenario.command === 'transition' && (
        state.cursor !== BigInt(8) || counts.get('allow') !== 2 || counts.get('review') !== 1
      ))
    ) refuse();
    return {
      allow: counts.get('allow') ?? 0,
      block_all: counts.get('block_all') ?? 0,
      block_global: counts.get('block_global') ?? 0,
      cursor: Number(state.cursor),
      generation: Number(state.activeGeneration),
      projected: state.projectedCandidates,
      review: counts.get('review') ?? 0,
    };
  } finally {
    await prisma.$disconnect();
  }
}

try {
  process.stdout.write(JSON.stringify(await run()));
} catch {
  process.stderr.write('DISCOVER_1AR_DRIVER_REFUSED\n');
  process.exitCode = 1;
}
