import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createCandidateAdmissionProofs } from '../decision';
import type { CandidatePrivacyMemoryClient } from '../memory-client';
import type {
  CandidatePrivacyDecision,
  CandidatePrivacyEligibilitySubject,
} from '../models';
import {
  rebuildCandidatePrivacyProjection,
  runCandidatePrivacyProcessorOnce,
} from '../processor';
import {
  CandidatePrivacyRestrictedError,
  CandidatePrivacyUnavailableError,
  candidatePrivacyAllowedRelationWhere,
  persistAdmissionProjection,
  requireCandidatePrivacyAllowed,
  requireHealthyCandidatePrivacyContext,
} from '../repository';

const enabled = process.env.RUN_SIGNAL_CANDIDATE_PRIVACY_POSTGRES === '1';
const describePostgres = enabled ? describe.sequential : describe.skip;

class SyntheticMemoryClient implements CandidatePrivacyMemoryClient {
  public maxEligibilityBatchSize = 0;

  constructor(
    public highWater: number,
    private readonly decisions: Map<string, CandidatePrivacyDecision>,
    private readonly options: {
      highWaterSequence?: number[];
      delayMs?: number;
      events?: Array<{ cursor: number }>;
    } = {},
  ) {}

  async eligibilityBatch(
    subjects: CandidatePrivacyEligibilitySubject[],
  ): Promise<Map<string, CandidatePrivacyDecision>> {
    this.maxEligibilityBatchSize = Math.max(
      this.maxEligibilityBatchSize,
      subjects.length,
    );
    if (this.options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    return new Map(subjects.map((subject) => {
      const candidateId = subject.identifiers.find(
        (identifier) => identifier.identifier_type === 'signal_candidate_id',
      )?.value;
      return [subject.request_ref, this.decisions.get(candidateId ?? '') ?? 'review'];
    }));
  }

  async readChanges(): Promise<{ events: Array<{ cursor: number }>; count: number }> {
    const events = this.options.events ?? [];
    return { events, count: events.length };
  }

  async readHighWater(): Promise<number> {
    const next = this.options.highWaterSequence?.shift();
    if (next !== undefined) return next;
    return this.highWater;
  }
}

const tenantId = 'candidate-privacy-test-tenant';
const candidateIds = {
  allow: 'candidate-privacy-allow',
  blockGlobal: 'candidate-privacy-block-global',
  blockAll: 'candidate-privacy-block-all',
  review: 'candidate-privacy-review',
};

function stableClient(highWater = 7, delayMs?: number) {
  return new SyntheticMemoryClient(highWater, new Map([
    [candidateIds.allow, 'allow'],
    [candidateIds.blockGlobal, 'block_global'],
    [candidateIds.blockAll, 'block_all'],
    [candidateIds.review, 'review'],
    ['candidate-privacy-admitted', 'allow'],
    ['candidate-privacy-stale-proof', 'allow'],
  ]), { delayMs });
}

async function resetFixture(): Promise<void> {
  await prisma.candidatePrivacyProjection.deleteMany();
  await prisma.candidateGlobalLink.deleteMany();
  await prisma.candidate.deleteMany({ where: { tenantId } });
  await prisma.candidatePrivacySyncState.update({
    where: { consumerName: 'discover' },
    data: {
      cursor: BigInt(0),
      activeGeneration: BigInt(0),
      status: 'uninitialized',
      lastSuccessAt: null,
      rebuildStartedAt: null,
      rebuildClaimToken: null,
      rebuildLeaseExpiresAt: null,
      lastErrorCode: null,
      expectedCandidates: 0,
      projectedCandidates: 0,
    },
  });
}

describePostgres('candidate privacy disposable PostgreSQL matrix', () => {
  beforeAll(async () => {
    process.env.ACTIVEGRAPH_URL = 'http://127.0.0.1:18000';
    process.env.SIGNAL_JWT_PRIVATE_KEY = 'disposable-test-marker';
    process.env.SIGNAL_CANDIDATE_PRIVACY_STALE_MS = '120000';
    process.env.SIGNAL_CANDIDATE_PRIVACY_REBUILD_LEASE_MS = '60000';
    const rows = await prisma.$queryRaw<Array<{
      database_name: string;
      role_name: string;
      server_addr: string | null;
      server_version_num: number;
      projection: string | null;
      sync: string | null;
    }>>`
      SELECT current_database() AS "database_name",
             current_user AS "role_name",
             host(inet_server_addr()) AS "server_addr",
             current_setting('server_version_num')::INTEGER AS "server_version_num",
             to_regclass('public.candidate_privacy_projection')::TEXT AS "projection",
             to_regclass('public.candidate_privacy_sync_state')::TEXT AS "sync"
    `;
    const row = rows[0];
    if (
      !row ||
      !/(?:^|[_-])candidate_privacy_test(?:[_-]|$)/i.test(row.database_name) ||
      !/(?:^|[_-])candidate_privacy_test(?:[_-]|$)/i.test(row.role_name) ||
      ![null, '127.0.0.1', '::1'].includes(row.server_addr) ||
      Math.floor(row.server_version_num / 10000) !== 16 ||
      !row.projection ||
      !row.sync
    ) {
      throw new Error('Refusing candidate privacy integration: disposable loopback PostgreSQL 16 proof failed');
    }
    await resetFixture();
    await prisma.candidate.createMany({
      data: Object.entries(candidateIds).map(([label, id]) => ({
        id,
        tenantId,
        linkedinId: `synthetic-${label.toLowerCase()}`,
        linkedinUrl: `https://www.linkedin.com/in/synthetic-${label.toLowerCase()}`,
      })),
    });
  });

  it('privacy-postgres-matrix: initial state is restrictive', async () => {
    await expect(requireHealthyCandidatePrivacyContext()).rejects.toBeInstanceOf(
      CandidatePrivacyUnavailableError,
    );
    await expect(
      requireCandidatePrivacyAllowed(tenantId, candidateIds.allow),
    ).rejects.toBeInstanceOf(CandidatePrivacyUnavailableError);
  });

  it('privacy-postgres-matrix: rebuilds all four decisions and swaps only a complete generation', async () => {
    await expect(rebuildCandidatePrivacyProjection(stableClient())).resolves.toBe('rebuilt');
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(state).toMatchObject({
      cursor: BigInt(7),
      activeGeneration: BigInt(1),
      status: 'healthy',
      expectedCandidates: 4,
      projectedCandidates: 4,
    });
    const decisions = await prisma.candidatePrivacyProjection.findMany({
      where: { generation: BigInt(1) },
      orderBy: { candidateId: 'asc' },
      select: { candidateId: true, decision: true },
    });
    expect(new Map(decisions.map((row) => [row.candidateId, row.decision]))).toEqual(
      new Map([
        [candidateIds.allow, 'allow'],
        [candidateIds.blockAll, 'block_all'],
        [candidateIds.blockGlobal, 'block_global'],
        [candidateIds.review, 'review'],
      ]),
    );
    await expect(requireCandidatePrivacyAllowed(tenantId, candidateIds.allow)).resolves.toBeDefined();
    await expect(
      requireCandidatePrivacyAllowed(tenantId, candidateIds.blockGlobal),
    ).rejects.toBeInstanceOf(CandidatePrivacyRestrictedError);
    await expect(
      requireCandidatePrivacyAllowed(tenantId, candidateIds.review),
    ).rejects.toBeInstanceOf(CandidatePrivacyRestrictedError);
  });

  it('route-results-prelimit: a restricted top row does not under-fill a limited query', async () => {
    const context = await requireHealthyCandidatePrivacyContext();
    const rows = await prisma.candidate.findMany({
      where: {
        tenantId,
        ...candidatePrivacyAllowedRelationWhere(context),
      },
      orderBy: { id: 'asc' },
      take: 1,
      select: { id: true },
    });
    expect(rows).toEqual([{ id: candidateIds.allow }]);
  });

  it('privacy-postgres-matrix: authenticated cursor continuity refreshes healthy state', async () => {
    await expect(runCandidatePrivacyProcessorOnce(stableClient())).resolves.toBe(
      'healthy_refreshed',
    );
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(state.status).toBe('healthy');
    expect(state.lastErrorCode).toBeNull();
  });

  it('privacy-postgres-matrix: an empty-page cursor gap becomes restrictive', async () => {
    await expect(
      runCandidatePrivacyProcessorOnce(new SyntheticMemoryClient(8, new Map())),
    ).resolves.toBe('needs_reconciliation');
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(state).toMatchObject({
      status: 'needs_reconciliation',
      lastErrorCode: 'candidate_privacy_cursor_gap',
    });
  });

  it('privacy-postgres-matrix: a live lease excludes a competing processor', async () => {
    await prisma.candidatePrivacySyncState.update({
      where: { consumerName: 'discover' },
      data: { status: 'stale' },
    });
    let releaseBatch!: () => void;
    let signalBatchStarted!: () => void;
    const batchStarted = new Promise<void>((resolve) => { signalBatchStarted = resolve; });
    const batchRelease = new Promise<void>((resolve) => { releaseBatch = resolve; });
    const client = stableClient();
    const evaluate = client.eligibilityBatch.bind(client);
    client.eligibilityBatch = async (subjects) => {
      signalBatchStarted();
      await batchRelease;
      return evaluate(subjects);
    };

    const first = rebuildCandidatePrivacyProjection(client);
    await batchStarted;
    const liveClaim = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(liveClaim).toMatchObject({ status: 'rebuilding' });
    expect(liveClaim.rebuildClaimToken).toEqual(expect.any(String));
    expect(liveClaim.rebuildLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    await expect(rebuildCandidatePrivacyProjection(stableClient())).resolves.toBe('busy');
    releaseBatch();
    await expect(first).resolves.toBe('rebuilt');
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(state.status).toBe('healthy');
    expect(state.activeGeneration).toBe(BigInt(2));
    expect(state.rebuildClaimToken).toBeNull();
    expect(state.rebuildLeaseExpiresAt).toBeNull();
    expect(await prisma.candidatePrivacyProjection.count({
      where: { generation: BigInt(2) },
    })).toBe(4);
  });

  it('privacy-postgres-matrix: a stalled owner past its lease is fenced by one successor', async () => {
    const before = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    await prisma.candidatePrivacySyncState.update({
      where: { consumerName: 'discover' },
      data: { status: 'stale' },
    });
    let releaseBatch!: () => void;
    let signalBatchStarted!: () => void;
    const batchStarted = new Promise<void>((resolve) => { signalBatchStarted = resolve; });
    const batchRelease = new Promise<void>((resolve) => { releaseBatch = resolve; });
    const stalledClient = stableClient();
    const evaluate = stalledClient.eligibilityBatch.bind(stalledClient);
    stalledClient.eligibilityBatch = async (subjects) => {
      signalBatchStarted();
      await batchRelease;
      return evaluate(subjects);
    };

    const staleOwner = rebuildCandidatePrivacyProjection(stalledClient);
    await batchStarted;
    const staleClaim = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    await prisma.candidatePrivacySyncState.updateMany({
      where: {
        consumerName: 'discover',
        rebuildClaimToken: staleClaim.rebuildClaimToken,
      },
      data: { rebuildLeaseExpiresAt: new Date(Date.now() - 1) },
    });

    await expect(rebuildCandidatePrivacyProjection(stableClient())).resolves.toBe('rebuilt');
    releaseBatch();
    await expect(staleOwner).rejects.toThrow('candidate_privacy_rebuild_claim_lost');
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(state).toMatchObject({
      status: 'healthy',
      activeGeneration: before.activeGeneration + BigInt(1),
      rebuildClaimToken: null,
      rebuildLeaseExpiresAt: null,
    });
    expect(await prisma.candidatePrivacyProjection.count({
      where: { generation: state.activeGeneration },
    })).toBe(4);
  });

  it('privacy-postgres-matrix: a stale owner failure cannot overwrite its successor', async () => {
    const before = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    await prisma.candidatePrivacySyncState.update({
      where: { consumerName: 'discover' },
      data: { status: 'stale' },
    });
    let releaseBatch!: () => void;
    let signalBatchStarted!: () => void;
    const batchStarted = new Promise<void>((resolve) => { signalBatchStarted = resolve; });
    const batchRelease = new Promise<void>((resolve) => { releaseBatch = resolve; });
    const stalledClient = stableClient();
    stalledClient.eligibilityBatch = async () => {
      signalBatchStarted();
      await batchRelease;
      throw new Error('candidate_privacy_invalid_response');
    };

    const staleOwner = rebuildCandidatePrivacyProjection(stalledClient);
    await batchStarted;
    const staleClaim = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    await prisma.candidatePrivacySyncState.updateMany({
      where: {
        consumerName: 'discover',
        rebuildClaimToken: staleClaim.rebuildClaimToken,
      },
      data: { rebuildLeaseExpiresAt: new Date(Date.now() - 1) },
    });

    await expect(rebuildCandidatePrivacyProjection(stableClient())).resolves.toBe('rebuilt');
    releaseBatch();
    await expect(staleOwner).rejects.toThrow('candidate_privacy_rebuild_claim_lost');
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(state).toMatchObject({
      status: 'healthy',
      activeGeneration: before.activeGeneration + BigInt(1),
      rebuildClaimToken: null,
      rebuildLeaseExpiresAt: null,
    });
    expect(await prisma.candidatePrivacyProjection.count({
      where: { generation: state.activeGeneration },
    })).toBe(4);
  });

  it('privacy-postgres-matrix: a legacy tokenless rebuilding claim is recoverable', async () => {
    const before = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    await prisma.candidatePrivacySyncState.update({
      where: { consumerName: 'discover' },
      data: {
        status: 'rebuilding',
        rebuildStartedAt: new Date(Date.now() - 600_000),
        rebuildClaimToken: null,
        rebuildLeaseExpiresAt: null,
      },
    });
    await expect(rebuildCandidatePrivacyProjection(stableClient())).resolves.toBe('rebuilt');
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(state).toMatchObject({
      status: 'healthy',
      activeGeneration: before.activeGeneration + BigInt(1),
      rebuildClaimToken: null,
      rebuildLeaseExpiresAt: null,
    });
  });

  it('privacy-postgres-matrix: production-scale reconciliation bounds remote batches', async () => {
    await prisma.candidatePrivacySyncState.update({
      where: { consumerName: 'discover' },
      data: { status: 'stale' },
    });
    const scaleCandidateIds = Array.from(
      { length: 205 },
      (_, index) => `candidate-privacy-scale-${index.toString().padStart(3, '0')}`,
    );
    await prisma.candidate.createMany({
      data: scaleCandidateIds.map((id) => ({
        id,
        tenantId,
        linkedinId: id,
        linkedinUrl: `https://www.linkedin.com/in/${id}`,
      })),
    });
    const client = stableClient();
    await expect(rebuildCandidatePrivacyProjection(client)).resolves.toBe('rebuilt');
    expect(client.maxEligibilityBatchSize).toBe(100);
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(state.expectedCandidates).toBe(209);
    expect(state.projectedCandidates).toBe(209);

    await prisma.candidatePrivacyProjection.deleteMany();
    await prisma.candidate.deleteMany({ where: { id: { in: scaleCandidateIds } } });
    await prisma.candidatePrivacySyncState.update({
      where: { consumerName: 'discover' },
      data: { status: 'stale' },
    });
  });

  it('privacy-postgres-matrix: candidate drift during remote evaluation refuses the swap', async () => {
    const stateBefore = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    const client = stableClient();
    const eligibilityBatch = client.eligibilityBatch.bind(client);
    let inserted = false;
    client.eligibilityBatch = async (subjects) => {
      if (!inserted) {
        inserted = true;
        await prisma.candidate.create({
          data: {
            id: 'candidate-privacy-concurrent-change',
            tenantId,
            linkedinId: 'candidate-privacy-concurrent-change',
            linkedinUrl: 'https://www.linkedin.com/in/candidate-privacy-concurrent-change',
          },
        });
      }
      return eligibilityBatch(subjects);
    };

    await expect(rebuildCandidatePrivacyProjection(client)).resolves.toBe(
      'needs_reconciliation',
    );
    const stateAfter = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(stateAfter).toMatchObject({
      activeGeneration: stateBefore.activeGeneration,
      status: 'needs_reconciliation',
      lastErrorCode: 'candidate_privacy_reconciliation_changed',
      projectedCandidates: 0,
    });
    expect(await prisma.candidatePrivacyProjection.count({
      where: { generation: stateBefore.activeGeneration + BigInt(1) },
    })).toBe(0);
    await prisma.candidate.delete({
      where: { id: 'candidate-privacy-concurrent-change' },
    });
  });

  it('privacy-postgres-matrix: changing high-water refuses the new generation', async () => {
    const stateBefore = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    await prisma.candidatePrivacySyncState.update({
      where: { consumerName: 'discover' },
      data: { status: 'stale' },
    });
    const client = new SyntheticMemoryClient(8, new Map(), {
      highWaterSequence: [7, 8],
    });
    await expect(rebuildCandidatePrivacyProjection(client)).resolves.toBe(
      'needs_reconciliation',
    );
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(state.status).toBe('needs_reconciliation');
    expect(state.activeGeneration).toBe(stateBefore.activeGeneration);
    expect(await prisma.candidatePrivacyProjection.count({
      where: { generation: stateBefore.activeGeneration + BigInt(1) },
    })).toBe(0);
  });

  it('privacy-postgres-matrix: a decreasing high-water cannot replace the active cursor', async () => {
    await prisma.candidatePrivacySyncState.update({
      where: { consumerName: 'discover' },
      data: { status: 'stale' },
    });
    await expect(
      rebuildCandidatePrivacyProjection(new SyntheticMemoryClient(6, new Map())),
    ).resolves.toBe('needs_reconciliation');
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(state.cursor).toBe(BigInt(7));
    expect(state.status).toBe('needs_reconciliation');
  });

  it('admission-atomic: inserts a candidate and active projection in one locked transaction', async () => {
    await expect(rebuildCandidatePrivacyProjection(stableClient())).resolves.toBe('rebuilt');
    const proofs = await createCandidateAdmissionProofs([{
      key: 'new',
      signalCandidateId: 'candidate-privacy-admitted',
      linkedinUrl: 'https://www.linkedin.com/in/synthetic-admitted',
    }], stableClient());
    const proof = proofs.get('new');
    expect(proof).toBeDefined();
    await prisma.$transaction(async (tx) => {
      await tx.candidate.create({
        data: {
          id: 'candidate-privacy-admitted',
          tenantId,
          linkedinId: 'synthetic-admitted',
          linkedinUrl: 'https://www.linkedin.com/in/synthetic-admitted',
        },
      });
      await persistAdmissionProjection(tx, {
        tenantId,
        candidateId: 'candidate-privacy-admitted',
        proof: proof!,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const state = await prisma.candidatePrivacySyncState.findUniqueOrThrow({
      where: { consumerName: 'discover' },
    });
    expect(state.expectedCandidates).toBe(5);
    expect(state.projectedCandidates).toBe(5);
    await expect(
      requireCandidatePrivacyAllowed(tenantId, 'candidate-privacy-admitted'),
    ).resolves.toBeDefined();
  });

  it('admission-atomic: a stale proof rolls back the candidate write', async () => {
    const proofs = await createCandidateAdmissionProofs([{
      key: 'stale',
      signalCandidateId: 'candidate-privacy-stale-proof',
      linkedinUrl: 'https://www.linkedin.com/in/synthetic-stale-proof',
    }], stableClient());
    await prisma.candidatePrivacySyncState.update({
      where: { consumerName: 'discover' },
      data: { cursor: { increment: BigInt(1) } },
    });
    await expect(prisma.$transaction(async (tx) => {
      await tx.candidate.create({
        data: {
          id: 'candidate-privacy-stale-proof',
          tenantId,
          linkedinId: 'synthetic-stale-proof',
          linkedinUrl: 'https://www.linkedin.com/in/synthetic-stale-proof',
        },
      });
      await persistAdmissionProjection(tx, {
        tenantId,
        candidateId: 'candidate-privacy-stale-proof',
        proof: proofs.get('stale')!,
      });
    })).rejects.toBeInstanceOf(CandidatePrivacyUnavailableError);
    expect(await prisma.candidate.count({
      where: { id: 'candidate-privacy-stale-proof' },
    })).toBe(0);
  });

  it('privacy-postgres-matrix: an active projection prevents candidate deletion', async () => {
    await expect(prisma.candidate.delete({
      where: { id: candidateIds.allow },
    })).rejects.toBeDefined();
    expect(await prisma.candidate.count({ where: { id: candidateIds.allow } })).toBe(1);
  });
});
