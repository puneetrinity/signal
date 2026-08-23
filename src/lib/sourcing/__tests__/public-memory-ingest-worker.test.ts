import { describe, expect, it, vi } from 'vitest';
import type { CandidateIngestResult } from '../activegraph-client';
import {
  runPublicMemoryIngestCycle,
} from '../public-memory-ingest-worker';
import type {
  ClaimedPublicMemoryOutboxRow,
  PublicMemoryOutboxPayload,
  PublicMemoryOutboxStore,
} from '../public-memory-ingest-outbox';

const GLOBAL_ONE = '11111111-1111-4111-8111-111111111111';
const GLOBAL_TWO = '22222222-2222-4222-8222-222222222222';

function payload(
  expectedGlobalCandidateId: string | null = null,
): PublicMemoryOutboxPayload {
  return {
    expectedGlobalCandidateId,
    candidate: {
      id: 'https://www.linkedin.com/in/alice',
      linkedinUrl: 'https://www.linkedin.com/in/alice',
      headlineHint: 'Backend Engineer',
      locationHint: 'Bengaluru, India',
      searchTitle: 'Backend Engineer',
      searchSnippet: null,
      enrichmentStatus: 'complete',
      lastEnrichedAt: null,
      crustdata: null,
      snapshot: null,
    },
    options: {},
  };
}

function row(
  id: string,
  expectedGlobalCandidateId: string | null = null,
): ClaimedPublicMemoryOutboxRow {
  return {
    id,
    tenantId: 'org_1',
    signalCandidateId: `signal-${id}`,
    sourcingRequestId: 'request-1',
    localCandidateId: `signal-${id}`,
    payload: payload(expectedGlobalCandidateId),
    generation: 1,
    attempts: 1,
    leaseToken: `lease-${id}`,
  };
}

function ingestResult(
  globalCandidateId: string | null,
  success = true,
  signalCandidateId = 'signal',
): CandidateIngestResult {
  return {
    success,
    signalCandidateId,
    memoryCandidateId: success ? 'memory' : null,
    globalCandidateId,
    sourceRecordId: success ? signalCandidateId : null,
    resolutionStatus: success ? 'matched' : null,
    errorCode: success ? null : 'resolve_failed',
  };
}

class FakeStore implements PublicMemoryOutboxStore {
  private claimed = false;
  readonly acknowledged: string[] = [];
  readonly failures: Array<{
    id: string;
    errorCode: string;
    terminal: boolean;
  }> = [];

  constructor(private readonly rows: ClaimedPublicMemoryOutboxRow[]) {}

  async claim(): Promise<ClaimedPublicMemoryOutboxRow[]> {
    if (this.claimed) return [];
    this.claimed = true;
    return this.rows;
  }

  async acknowledge({
    row: claimedRow,
  }: {
    row: ClaimedPublicMemoryOutboxRow;
    result: CandidateIngestResult;
    now: Date;
  }): Promise<boolean> {
    this.acknowledged.push(claimedRow.id);
    return true;
  }

  async fail({
    row: failedRow,
    errorCode,
    terminal = false,
  }: {
    row: ClaimedPublicMemoryOutboxRow;
    errorCode: string;
    maxAttempts: number;
    terminal?: boolean;
    now: Date;
  }): Promise<boolean> {
    this.failures.push({ id: failedRow.id, errorCode, terminal });
    return true;
  }
}

describe('public Memory ingest worker', () => {
  it('claims a row once across concurrent worker cycles', async () => {
    const store = new FakeStore([row('one')]);
    const ingest = vi
      .fn()
      .mockResolvedValue(ingestResult(GLOBAL_ONE, true, 'signal-one'));

    const summaries = await Promise.all([
      runPublicMemoryIngestCycle({ store, ingest }),
      runPublicMemoryIngestCycle({ store, ingest }),
    ]);

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(summaries.reduce((sum, summary) => sum + summary.claimed, 0)).toBe(1);
    expect(store.acknowledged).toEqual(['one']);
  });

  it('processes a row reclaimed after an expired lease', async () => {
    const store = new FakeStore([
      { ...row('expired'), attempts: 4, leaseToken: 'replacement-lease' },
    ]);
    const ingest = vi
      .fn()
      .mockResolvedValue(ingestResult(GLOBAL_TWO, true, 'signal-expired'));

    const summary = await runPublicMemoryIngestCycle({ store, ingest });

    expect(summary).toEqual({ claimed: 1, confirmed: 1, failed: 0 });
    expect(store.acknowledged).toEqual(['expired']);
  });

  it('isolates one failed ingest from successful rows in the same batch', async () => {
    const store = new FakeStore([row('bad'), row('good')]);
    const ingest = vi
      .fn()
      .mockResolvedValueOnce(ingestResult(null, false, 'signal-bad'))
      .mockResolvedValueOnce(
        ingestResult(GLOBAL_ONE, true, 'signal-good'),
      );

    const summary = await runPublicMemoryIngestCycle({
      store,
      ingest,
      concurrency: 2,
    });

    expect(summary).toEqual({ claimed: 2, confirmed: 1, failed: 1 });
    expect(store.acknowledged).toEqual(['good']);
    expect(store.failures[0]?.id).toBe('bad');
  });

  it('counts confirmation only after an ACK with a canonical UUID', async () => {
    const store = new FakeStore([row('missing-global')]);

    const summary = await runPublicMemoryIngestCycle({
      store,
      ingest: vi
        .fn()
        .mockResolvedValue(
          ingestResult(null, true, 'signal-missing-global'),
        ),
    });

    expect(summary.confirmed).toBe(0);
    expect(store.acknowledged).toEqual([]);
    expect(store.failures[0]?.errorCode).toBe('missing_global_id');
  });

  it('dead-letters a resolve result that conflicts with the hydrated UUID', async () => {
    const store = new FakeStore([row('mismatch', GLOBAL_ONE)]);

    const summary = await runPublicMemoryIngestCycle({
      store,
      ingest: vi
        .fn()
        .mockResolvedValue(
          ingestResult(GLOBAL_TWO, true, 'signal-mismatch'),
        ),
    });

    expect(summary.confirmed).toBe(0);
    expect(store.acknowledged).toEqual([]);
    expect(store.failures).toEqual([
      {
        id: 'mismatch',
        errorCode: 'identity_mismatch',
        terminal: true,
      },
    ]);
  });

  it('does not ACK a result without a durable source record', async () => {
    const store = new FakeStore([row('missing-source')]);
    const result = {
      ...ingestResult(
        GLOBAL_ONE,
        true,
        'signal-missing-source',
      ),
      sourceRecordId: null,
    };

    const summary = await runPublicMemoryIngestCycle({
      store,
      ingest: vi.fn().mockResolvedValue(result),
    });

    expect(summary.confirmed).toBe(0);
    expect(store.acknowledged).toEqual([]);
    expect(store.failures[0]?.id).toBe('missing-source');
  });
});
