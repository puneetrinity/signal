import { randomUUID } from 'node:crypto';
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

export async function rebuildCandidatePrivacyProjection(
  client: CandidatePrivacyMemoryClient,
): Promise<CandidatePrivacyProcessorResult> {
  const config = loadCandidatePrivacyConfig(process.env, {
    requireProcessor: true,
  });
  // Commit the restrictive state before any network read or long-running
  // rebuild transaction. Keeping this update inside the rebuild transaction
  // would leave the previous healthy row visible to concurrent readers under
  // MVCC until the final commit.
  const claimed = await prisma.candidatePrivacySyncState.updateMany({
    where: {
      consumerName: 'discover',
      status: { not: 'rebuilding' },
    },
    data: {
      status: 'rebuilding',
      rebuildStartedAt: new Date(),
      lastErrorCode: null,
    },
  });
  if (claimed.count !== 1) return 'busy';

  try {
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
    const nextGeneration = current.activeGeneration + BigInt(1);
    if (current.status !== 'rebuilding') {
      throw new Error('candidate_privacy_rebuild_claim_lost');
    }

    const highWaterBefore = await client.readHighWater();
    if (BigInt(highWaterBefore) < current.cursor) {
      await tx.candidatePrivacySyncState.update({
        where: { consumerName: 'discover' },
        data: {
          status: 'needs_reconciliation',
          rebuildStartedAt: null,
          lastErrorCode: 'candidate_privacy_cursor_decreased',
        },
      });
      return 'needs_reconciliation';
    }
    const expectedCandidates = await tx.candidate.count();
    await tx.candidatePrivacyProjection.deleteMany({
      where: { generation: nextGeneration },
    });

    let afterId: string | undefined;
    let projectedCandidates = 0;
    for (;;) {
      const rows = await tx.candidate.findMany({
        where: afterId ? { id: { gt: afterId } } : undefined,
        orderBy: { id: 'asc' },
        take: config.eligibilityBatchSize,
        select: {
          id: true,
          tenantId: true,
          linkedinUrl: true,
          globalLink: { select: { globalCandidateId: true } },
        },
      });
      if (rows.length === 0) break;
      const refs = rows.map((row) => ({ row, requestRef: randomUUID() }));
      const decisions = await client.eligibilityBatch(
        refs.map(({ row, requestRef }) => anchorToEligibilitySubject({
          requestRef,
          linkedinUrl: row.linkedinUrl,
          signalCandidateId: row.id,
          globalCandidateId: row.globalLink?.globalCandidateId,
        })),
      );
      await tx.candidatePrivacyProjection.createMany({
        data: refs.map(({ row, requestRef }) => ({
          tenantId: row.tenantId,
          candidateId: row.id,
          generation: nextGeneration,
          decision: decisions.get(requestRef) ?? 'review',
          evaluatedCursor: BigInt(highWaterBefore),
        })),
      });
      projectedCandidates += rows.length;
      afterId = rows[rows.length - 1].id;
    }

    const highWaterAfter = await client.readHighWater();
    const finalCandidateCount = await tx.candidate.count();
    const finalProjectionCount = await tx.candidatePrivacyProjection.count({
      where: { generation: nextGeneration },
    });
    if (
      highWaterAfter !== highWaterBefore ||
      finalCandidateCount !== expectedCandidates ||
      projectedCandidates !== expectedCandidates ||
      finalProjectionCount !== expectedCandidates
    ) {
      await tx.candidatePrivacyProjection.deleteMany({
        where: { generation: nextGeneration },
      });
      await tx.candidatePrivacySyncState.update({
        where: { consumerName: 'discover' },
        data: {
          status: 'needs_reconciliation',
          rebuildStartedAt: null,
          lastErrorCode: 'candidate_privacy_reconciliation_changed',
          expectedCandidates,
          projectedCandidates: Math.min(
            projectedCandidates,
            expectedCandidates,
          ),
        },
      });
      return 'needs_reconciliation';
    }

    await tx.candidatePrivacySyncState.update({
      where: { consumerName: 'discover' },
      data: {
        cursor: BigInt(highWaterBefore),
        activeGeneration: nextGeneration,
        status: 'healthy',
        lastSuccessAt: new Date(),
        rebuildStartedAt: null,
        lastErrorCode: null,
        expectedCandidates,
        projectedCandidates,
      },
    });
      return 'rebuilt';
    });
  } catch (error) {
    await markProcessorFailure(error, { status: 'rebuilding' });
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
