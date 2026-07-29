import { createLogger } from '@/lib/logger';
import {
  generateTagsFromCandidate,
  ingestCandidateWithResult,
  isConfirmedCandidateIngestResult,
  type CandidateIngestResult,
} from './activegraph-client';
import {
  hydrateOutboxCandidate,
  hydrateOutboxIngestOptions,
  compactPublicMemoryOutboxPayloads,
  PrismaPublicMemoryOutboxStore,
  reconcilePublicMemoryOutboxDiagnostics,
  reconcilePublicMemoryOutboxLinks,
  type ClaimedPublicMemoryOutboxRow,
  type PublicMemoryOutboxStore,
} from './public-memory-ingest-outbox';

const log = createLogger('PublicMemoryIngestWorker');

export interface PublicMemoryIngestCycleSummary {
  claimed: number;
  confirmed: number;
  failed: number;
}

export interface PublicMemoryIngestWorkerOptions {
  store?: PublicMemoryOutboxStore;
  batchSize?: number;
  concurrency?: number;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  ingest?: (
    row: ClaimedPublicMemoryOutboxRow,
  ) => Promise<CandidateIngestResult>;
}

function sanitizeFailureCode(result: CandidateIngestResult): string {
  const code = result.errorCode?.toLowerCase();
  if (code && /^[a-z0-9_]{1,80}$/.test(code)) return code;
  if (result.success && !result.globalCandidateId) return 'missing_global_id';
  return 'resolve_failed';
}

async function processRow({
  row,
  store,
  maxAttempts,
  now,
  ingest,
}: {
  row: ClaimedPublicMemoryOutboxRow;
  store: PublicMemoryOutboxStore;
  maxAttempts: number;
  now: () => Date;
  ingest: (
    row: ClaimedPublicMemoryOutboxRow,
  ) => Promise<CandidateIngestResult>;
}): Promise<boolean> {
  try {
    const result = await ingest(row);
    const expectedGlobalCandidateId =
      row.payload.expectedGlobalCandidateId;
    if (
      isConfirmedCandidateIngestResult(result) &&
      expectedGlobalCandidateId &&
      result.globalCandidateId !== expectedGlobalCandidateId
    ) {
      await store.fail({
        row,
        errorCode: 'identity_mismatch',
        maxAttempts,
        terminal: true,
        now: now(),
      });
      return false;
    }
    if (
      isConfirmedCandidateIngestResult(
        result,
        expectedGlobalCandidateId,
        row.signalCandidateId,
      )
    ) {
      return store.acknowledge({ row, result, now: now() });
    }
    await store.fail({
      row,
      errorCode: sanitizeFailureCode(result),
      maxAttempts,
      now: now(),
    });
    return false;
  } catch {
    await store.fail({
      row,
      errorCode: 'unexpected',
      maxAttempts,
      now: now(),
    });
    return false;
  }
}

export async function runPublicMemoryIngestCycle(
  options: PublicMemoryIngestWorkerOptions = {},
): Promise<PublicMemoryIngestCycleSummary> {
  const store = options.store ?? new PrismaPublicMemoryOutboxStore();
  const batchSize = options.batchSize ?? 20;
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const leaseMs = options.leaseMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 8;
  const now = options.now ?? (() => new Date());
  const rows = await store.claim({
    // Claim at most one execution wave. A shared lease on multiple sequential
    // waves can expire before tail rows start, allowing another replica to
    // redeliver them despite lease-token fencing on the eventual ACK.
    limit: Math.min(batchSize, concurrency),
    leaseMs,
    now: now(),
  });
  const defaultIngest = async (
    row: ClaimedPublicMemoryOutboxRow,
  ): Promise<CandidateIngestResult> => {
    const candidate = hydrateOutboxCandidate(row.payload);
    return ingestCandidateWithResult(
      row.tenantId,
      candidate,
      generateTagsFromCandidate(candidate),
      row.sourcingRequestId ?? undefined,
      hydrateOutboxIngestOptions(row.payload.options),
    );
  };
  const ingest = options.ingest ?? defaultIngest;

  let confirmed = 0;
  for (let index = 0; index < rows.length; index += concurrency) {
    const chunk = rows.slice(index, index + concurrency);
    const outcomes = await Promise.all(
      chunk.map((row) =>
        processRow({ row, store, maxAttempts, now, ingest }),
      ),
    );
    confirmed += outcomes.filter(Boolean).length;
  }
  return {
    claimed: rows.length,
    confirmed,
    failed: rows.length - confirmed,
  };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startPublicMemoryIngestWorker({
  intervalMs = 2_000,
  options = {},
}: {
  intervalMs?: number;
  options?: PublicMemoryIngestWorkerOptions;
} = {}): void {
  if (timer) return;

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const summary = await runPublicMemoryIngestCycle(options);
      await reconcilePublicMemoryOutboxLinks();
      await reconcilePublicMemoryOutboxDiagnostics();
      await compactPublicMemoryOutboxPayloads();
      if (summary.claimed > 0) {
        log.info(summary, 'Public Memory outbox cycle completed');
      }
    } catch {
      log.error(
        { errorCode: 'outbox_cycle_failed' },
        'Public Memory outbox cycle failed',
      );
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    void run();
  }, intervalMs);
  void run();
}

export function stopPublicMemoryIngestWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
