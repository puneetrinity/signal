import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { loadCandidatePrivacyConfig } from './config';
import {
  CandidatePrivacyMemoryError,
  HttpCandidatePrivacyMemoryClient,
  type CandidatePrivacyMemoryClient,
} from './memory-client';
import { anchorToEligibilitySubject } from './models';
import {
  CANDIDATE_PRIVACY_ADMISSION_LOCK,
  CANDIDATE_PRIVACY_PROCESSOR_LOCK,
  readCandidatePrivacySyncState,
  withCandidatePrivacyTransaction,
} from './repository';

export type CandidatePrivacyProcessorResult =
  | 'healthy_refreshed'
  | 'rebuilt'
  | 'busy'
  | 'needs_reconciliation';

const candidateSnapshotSelect = {
  id: true,
  tenantId: true,
  linkedinUrl: true,
  globalLink: { select: { globalCandidateId: true } },
} as const;

type CandidateSnapshotRow = Prisma.CandidateGetPayload<{
  select: typeof candidateSnapshotSelect;
}>;

type CandidateProjectionSeed = {
  tenantId: string;
  candidateId: string;
  generation: bigint;
  decision: string;
  evaluatedCursor: bigint;
};

const PROJECTION_INSERT_BATCH_SIZE = 1_000;
const CANDIDATE_SNAPSHOT_READ_BATCH_SIZE = 1_000;
const ELIGIBILITY_RECONCILIATION_BATCH_MAX = 100;
const REBUILD_CLAIM_LOST = 'candidate_privacy_rebuild_claim_lost';

type RebuildClaim = {
  token: string;
  activeGeneration: bigint;
  leaseMs: number;
};

async function loadCandidateSnapshot(
  db: typeof prisma | Prisma.TransactionClient,
): Promise<CandidateSnapshotRow[]> {
  const snapshot: CandidateSnapshotRow[] = [];
  let afterId: string | undefined;
  for (;;) {
    const rows = await db.candidate.findMany({
      where: afterId ? { id: { gt: afterId } } : undefined,
      orderBy: { id: 'asc' },
      take: CANDIDATE_SNAPSHOT_READ_BATCH_SIZE,
      select: candidateSnapshotSelect,
    });
    snapshot.push(...rows);
    if (rows.length < CANDIDATE_SNAPSHOT_READ_BATCH_SIZE) break;
    afterId = rows[rows.length - 1].id;
  }
  return snapshot;
}

function candidateSnapshotFingerprint(rows: CandidateSnapshotRow[]): Buffer {
  const hash = createHash('sha256');
  for (const row of rows) {
    for (const value of [
      row.id,
      row.tenantId,
      row.linkedinUrl,
      row.globalLink?.globalCandidateId,
    ]) {
      if (value === null || value === undefined) {
        hash.update('n:');
      } else {
        hash.update(`s${Buffer.byteLength(value, 'utf8')}:`);
        hash.update(value);
      }
      hash.update('|');
    }
    hash.update('\n');
  }
  return hash.digest();
}

async function evaluateCandidateSnapshot(
  client: CandidatePrivacyMemoryClient,
  rows: CandidateSnapshotRow[],
  batchSize: number,
  generation: bigint,
  evaluatedCursor: bigint,
  afterBatch: () => Promise<void>,
): Promise<CandidateProjectionSeed[]> {
  const projections: CandidateProjectionSeed[] = [];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const refs = batch.map((row) => ({ row, requestRef: randomUUID() }));
    const decisions = await client.eligibilityBatch(
      refs.map(({ row, requestRef }) => anchorToEligibilitySubject({
        requestRef,
        linkedinUrl: row.linkedinUrl,
        signalCandidateId: row.id,
        globalCandidateId: row.globalLink?.globalCandidateId,
      })),
    );
    await afterBatch();
    projections.push(...refs.map(({ row, requestRef }) => ({
      tenantId: row.tenantId,
      candidateId: row.id,
      generation,
      decision: decisions.get(requestRef) ?? 'review',
      evaluatedCursor,
    })));
  }
  return projections;
}

async function refreshHealthyState(
  client: CandidatePrivacyMemoryClient,
): Promise<CandidatePrivacyProcessorResult | null> {
  const state = await readCandidatePrivacySyncState();
  if (state.status !== 'healthy') return null;
  let page: Awaited<ReturnType<CandidatePrivacyMemoryClient['readChanges']>>;
  let highWater: number;
  try {
    page = await client.readChanges(Number(state.cursor));
    highWater = await client.readHighWater();
  } catch (error) {
    await markProcessorFailure(error, {
      status: 'healthy',
      cursor: state.cursor,
      activeGeneration: state.activeGeneration,
    });
    throw error;
  }
  if (page.events.length > 0) return null;
  if (BigInt(highWater) !== state.cursor) {
    await prisma.candidatePrivacySyncState.updateMany({
      where: {
        consumerName: 'discover',
        status: 'healthy',
        cursor: state.cursor,
        activeGeneration: state.activeGeneration,
      },
      data: {
        status: 'needs_reconciliation',
        lastErrorCode: 'candidate_privacy_cursor_gap',
      },
    });
    return 'needs_reconciliation';
  }
  const refreshed = await prisma.candidatePrivacySyncState.updateMany({
    where: {
      consumerName: 'discover',
      status: 'healthy',
      cursor: state.cursor,
      activeGeneration: state.activeGeneration,
      expectedCandidates: state.expectedCandidates,
      projectedCandidates: state.projectedCandidates,
    },
    data: {
      lastSuccessAt: new Date(),
      lastErrorCode: null,
      status: 'healthy',
    },
  });
  return refreshed.count === 1 ? 'healthy_refreshed' : 'busy';
}

function processorFailureState(error: unknown): {
  status: 'stale' | 'needs_reconciliation';
  lastErrorCode: string;
} {
  if (
    error instanceof CandidatePrivacyMemoryError &&
    (error.code === 'candidate_privacy_response_invalid' ||
      error.code === 'candidate_privacy_conflict')
  ) {
    return {
      status: 'needs_reconciliation',
      lastErrorCode: 'candidate_privacy_response_invalid',
    };
  }
  return {
    status: 'stale',
    lastErrorCode: 'candidate_privacy_sync_failed',
  };
}

async function markProcessorFailure(
  error: unknown,
  expectedState?: {
    status: 'healthy' | 'rebuilding';
    cursor?: bigint;
    activeGeneration?: bigint;
  },
): Promise<void> {
  await prisma.candidatePrivacySyncState.updateMany({
    where: {
      consumerName: 'discover',
      ...(expectedState ?? {}),
    },
    data: processorFailureState(error),
  });
}

function rebuildLeaseExpiry(leaseMs: number, now = new Date()): Date {
  return new Date(now.getTime() + leaseMs);
}

async function heartbeatRebuildClaim(claim: RebuildClaim): Promise<void> {
  const now = new Date();
  const heartbeat = await prisma.candidatePrivacySyncState.updateMany({
    where: {
      consumerName: 'discover',
      status: 'rebuilding',
      activeGeneration: claim.activeGeneration,
      rebuildClaimToken: claim.token,
      rebuildLeaseExpiresAt: { gt: now },
    },
    data: {
      rebuildLeaseExpiresAt: rebuildLeaseExpiry(claim.leaseMs, now),
    },
  });
  if (heartbeat.count !== 1) throw new Error(REBUILD_CLAIM_LOST);
}

async function markRebuildNeedsReconciliation(
  claim: RebuildClaim,
  lastErrorCode: string,
  counts?: { expectedCandidates: number; projectedCandidates: number },
): Promise<void> {
  const updated = await prisma.candidatePrivacySyncState.updateMany({
    where: {
      consumerName: 'discover',
      status: 'rebuilding',
      activeGeneration: claim.activeGeneration,
      rebuildClaimToken: claim.token,
    },
    data: {
      status: 'needs_reconciliation',
      rebuildStartedAt: null,
      rebuildClaimToken: null,
      rebuildLeaseExpiresAt: null,
      lastErrorCode,
      ...counts,
    },
  });
  if (updated.count !== 1) throw new Error(REBUILD_CLAIM_LOST);
}

async function markRebuildFailure(error: unknown, claim: RebuildClaim): Promise<void> {
  const updated = await prisma.candidatePrivacySyncState.updateMany({
    where: {
      consumerName: 'discover',
      status: 'rebuilding',
      activeGeneration: claim.activeGeneration,
      rebuildClaimToken: claim.token,
    },
    data: {
      ...processorFailureState(error),
      rebuildStartedAt: null,
      rebuildClaimToken: null,
      rebuildLeaseExpiresAt: null,
    },
  });
  if (updated.count !== 1) throw new Error(REBUILD_CLAIM_LOST);
}

export async function rebuildCandidatePrivacyProjection(
  client: CandidatePrivacyMemoryClient,
): Promise<CandidatePrivacyProcessorResult> {
  const config = loadCandidatePrivacyConfig(process.env, {
    requireProcessor: true,
  });
  // Commit the restrictive state before any network read. Remote eligibility
  // evaluation deliberately stays outside the short generation-swap
  // transaction; the swap re-fingerprints every candidate and rechecks the
  // Memory high-water mark before making the generation visible.
  const claimToken = randomUUID();
  const claimedAt = new Date();
  const claimed = await prisma.candidatePrivacySyncState.updateMany({
    where: {
      consumerName: 'discover',
      OR: [
        { status: { not: 'rebuilding' } },
        { rebuildClaimToken: null },
        { rebuildLeaseExpiresAt: null },
        { rebuildLeaseExpiresAt: { lte: claimedAt } },
      ],
    },
    data: {
      status: 'rebuilding',
      rebuildStartedAt: claimedAt,
      rebuildClaimToken: claimToken,
      rebuildLeaseExpiresAt: rebuildLeaseExpiry(config.rebuildLeaseMs, claimedAt),
      lastErrorCode: null,
    },
  });
  if (claimed.count !== 1) return 'busy';

  const claimedState = await prisma.candidatePrivacySyncState.findFirst({
    where: {
      consumerName: 'discover',
      status: 'rebuilding',
      rebuildClaimToken: claimToken,
    },
  });
  if (!claimedState) throw new Error(REBUILD_CLAIM_LOST);
  const claim: RebuildClaim = {
    token: claimToken,
    activeGeneration: claimedState.activeGeneration,
    leaseMs: config.rebuildLeaseMs,
  };

  try {
    const highWaterBefore = await client.readHighWater();
    if (BigInt(highWaterBefore) < claimedState.cursor) {
      await markRebuildNeedsReconciliation(
        claim,
        'candidate_privacy_cursor_decreased',
      );
      return 'needs_reconciliation';
    }
    const nextGeneration = claimedState.activeGeneration + BigInt(1);
    const candidateSnapshot = await loadCandidateSnapshot(prisma);
    const snapshotFingerprint = candidateSnapshotFingerprint(candidateSnapshot);
    const projections = await evaluateCandidateSnapshot(
      client,
      candidateSnapshot,
      Math.min(
        config.eligibilityBatchSize,
        ELIGIBILITY_RECONCILIATION_BATCH_MAX,
      ),
      nextGeneration,
      BigInt(highWaterBefore),
      () => heartbeatRebuildClaim(claim),
    );
    await heartbeatRebuildClaim(claim);
    const highWaterAfter = await client.readHighWater();
    if (highWaterAfter !== highWaterBefore) {
      await markRebuildNeedsReconciliation(
        claim,
        'candidate_privacy_reconciliation_changed',
        {
          expectedCandidates: candidateSnapshot.length,
          projectedCandidates: 0,
        },
      );
      return 'needs_reconciliation';
    }

    return await withCandidatePrivacyTransaction(async (tx) => {
      const lock = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended(${CANDIDATE_PRIVACY_PROCESSOR_LOCK}, 0)
        ) AS "acquired"
      `;
      if (lock.length !== 1 || !lock[0].acquired) {
        throw new Error('candidate_privacy_processor_lock_unavailable');
      }

      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${CANDIDATE_PRIVACY_ADMISSION_LOCK}, 0)
        )
      `;
      const current = await tx.candidatePrivacySyncState.findUniqueOrThrow({
        where: { consumerName: 'discover' },
      });
      if (
        current.status !== 'rebuilding' ||
        current.activeGeneration !== claim.activeGeneration ||
        current.activeGeneration + BigInt(1) !== nextGeneration ||
        current.rebuildClaimToken !== claim.token ||
        !current.rebuildLeaseExpiresAt ||
        current.rebuildLeaseExpiresAt <= new Date()
      ) {
        throw new Error(REBUILD_CLAIM_LOST);
      }

      const currentSnapshot = await loadCandidateSnapshot(tx);
      const highWaterAtCommit = await client.readHighWater();
      if (
        highWaterAtCommit !== highWaterBefore ||
        !candidateSnapshotFingerprint(currentSnapshot).equals(snapshotFingerprint) ||
        projections.length !== candidateSnapshot.length
      ) {
        const refused = await tx.candidatePrivacySyncState.updateMany({
          where: {
            consumerName: 'discover',
            status: 'rebuilding',
            activeGeneration: claim.activeGeneration,
            rebuildClaimToken: claim.token,
          },
          data: {
            status: 'needs_reconciliation',
            rebuildStartedAt: null,
            rebuildClaimToken: null,
            rebuildLeaseExpiresAt: null,
            lastErrorCode: 'candidate_privacy_reconciliation_changed',
            expectedCandidates: currentSnapshot.length,
            projectedCandidates: 0,
          },
        });
        if (refused.count !== 1) throw new Error(REBUILD_CLAIM_LOST);
        return 'needs_reconciliation';
      }

      await tx.candidatePrivacyProjection.deleteMany({
        where: { generation: nextGeneration },
      });
      for (let offset = 0; offset < projections.length; offset += PROJECTION_INSERT_BATCH_SIZE) {
        await tx.candidatePrivacyProjection.createMany({
          data: projections.slice(offset, offset + PROJECTION_INSERT_BATCH_SIZE),
        });
      }
      const finalCandidateCount = await tx.candidate.count();
      const finalProjectionCount = await tx.candidatePrivacyProjection.count({
        where: { generation: nextGeneration },
      });
      if (
        finalCandidateCount !== candidateSnapshot.length ||
        finalProjectionCount !== candidateSnapshot.length
      ) {
        throw new Error('candidate_privacy_reconciliation_changed');
      }

      const completed = await tx.candidatePrivacySyncState.updateMany({
        where: {
          consumerName: 'discover',
          status: 'rebuilding',
          activeGeneration: claim.activeGeneration,
          rebuildClaimToken: claim.token,
          rebuildLeaseExpiresAt: { gt: new Date() },
        },
        data: {
          cursor: BigInt(highWaterBefore),
          activeGeneration: nextGeneration,
          status: 'healthy',
          lastSuccessAt: new Date(),
          rebuildStartedAt: null,
          rebuildClaimToken: null,
          rebuildLeaseExpiresAt: null,
          lastErrorCode: null,
          expectedCandidates: candidateSnapshot.length,
          projectedCandidates: candidateSnapshot.length,
        },
      });
      if (completed.count !== 1) throw new Error(REBUILD_CLAIM_LOST);
      return 'rebuilt';
    });
  } catch (error) {
    await markRebuildFailure(error, claim);
    throw error;
  }
}

export async function runCandidatePrivacyProcessorOnce(
  client: CandidatePrivacyMemoryClient = new HttpCandidatePrivacyMemoryClient(),
): Promise<CandidatePrivacyProcessorResult> {
  const refreshed = await refreshHealthyState(client);
  if (refreshed) return refreshed;
  return rebuildCandidatePrivacyProjection(client);
}

let processorTimer: NodeJS.Timeout | null = null;
let processorRunning = false;

async function tick(): Promise<void> {
  if (processorRunning) return;
  processorRunning = true;
  try {
    await runCandidatePrivacyProcessorOnce();
  } catch (error) {
    console.error('[CandidatePrivacy] processor tick failed', {
      errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
    });
  } finally {
    processorRunning = false;
  }
}

export function startCandidatePrivacyProcessor(): void {
  if (processorTimer) return;
  const config = loadCandidatePrivacyConfig(process.env, {
    requireProcessor: true,
  });
  void tick();
  processorTimer = setInterval(() => void tick(), config.pollMs);
  processorTimer.unref?.();
}

export function stopCandidatePrivacyProcessor(): void {
  if (processorTimer) clearInterval(processorTimer);
  processorTimer = null;
}
