import { createLogger } from "@/lib/logger";
import {
  ActiveGraphContactMemoryClient,
  MemoryContactUnavailableError,
  type ContactMemoryClient,
  type MemoryContactLookupResult,
} from "./memory-client";
import {
  ExternalContactProviderClient,
  type ContactProviderClient,
  type FullEnrichPollResult,
} from "./providers";
import {
  PrismaContactOperationStore,
  type ContactOperationStore,
  type ContactOperationTransition,
} from "./store";
import {
  type ClaimedContactOperation,
  type ContactOperationState,
  type StagedContactEvidence,
} from "./types";

const log = createLogger("ContactEnrichmentWorker");
const DEFAULT_RETRY_MS = 60_000;
const DEFAULT_LINK_RETRY_MS = 60_000;
const DEFAULT_FULLENRICH_POLL_MS = 5 * 60_000;

export interface ContactEnrichmentCycleSummary {
  claimed: number;
  completed: number;
  pending: number;
  ambiguous: number;
}

export interface ContactEnrichmentWorkerOptions {
  store?: ContactOperationStore;
  memory?: ContactMemoryClient;
  providers?: ContactProviderClient;
  batchSize?: number;
  concurrency?: number;
  leaseMs?: number;
  retryMs?: number;
  linkRetryMs?: number;
  fullEnrichPollMs?: number;
  now?: () => Date;
}

function transitionedRow(
  row: ClaimedContactOperation,
  transition: ContactOperationTransition,
): ClaimedContactOperation {
  return {
    ...row,
    ...transition,
    globalCandidateId:
      transition.globalCandidateId !== undefined
        ? transition.globalCandidateId
        : row.globalCandidateId,
    provider:
      transition.provider !== undefined ? transition.provider : row.provider,
    providerRequestKey:
      transition.providerRequestKey !== undefined
        ? transition.providerRequestKey
        : row.providerRequestKey,
    providerRecordId:
      transition.providerRecordId !== undefined
        ? transition.providerRecordId
        : row.providerRecordId,
    stagedEvidence:
      transition.stagedEvidence !== undefined
        ? transition.stagedEvidence
        : row.stagedEvidence,
    stagedAt:
      transition.stagedAt !== undefined ? transition.stagedAt : row.stagedAt,
    lastErrorCode:
      transition.lastErrorCode !== undefined
        ? transition.lastErrorCode
        : row.lastErrorCode,
    providerStartedAt:
      transition.providerStartedAt !== undefined
        ? transition.providerStartedAt
        : row.providerStartedAt,
    selectedEmail:
      transition.selectedEmail !== undefined
        ? transition.selectedEmail
        : row.selectedEmail,
    completedAt:
      transition.completedAt !== undefined
        ? transition.completedAt
        : row.completedAt,
  };
}

async function transitionClaim(
  store: ContactOperationStore,
  row: ClaimedContactOperation,
  expectedStates: ContactOperationState[],
  transition: ContactOperationTransition,
  releaseLease: boolean,
  now: Date,
): Promise<ClaimedContactOperation | null> {
  const updated = await store.transition({
    row,
    expectedStates,
    transition,
    releaseLease,
    now,
  });
  return updated ? transitionedRow(row, transition) : null;
}

async function finishFromMemory(
  store: ContactOperationStore,
  row: ClaimedContactOperation,
  result: MemoryContactLookupResult,
  now: Date,
): Promise<"completed" | "pending"> {
  if (result.state === "found") {
    await transitionClaim(
      store,
      row,
      [row.state],
      {
        state: "found",
        selectedEmail: result.email,
        completedAt: now,
        lastErrorCode: null,
      },
      true,
      now,
    );
    return "completed";
  }
  if (result.state === "suppressed") {
    await transitionClaim(
      store,
      row,
      [row.state],
      {
        state: "suppressed",
        selectedEmail: null,
        completedAt: now,
        lastErrorCode: "contact_suppressed",
      },
      true,
      now,
    );
    return "completed";
  }
  return "pending";
}

async function persistStagedEvidence(
  store: ContactOperationStore,
  row: ClaimedContactOperation,
  expectedState: ContactOperationState,
  evidence: StagedContactEvidence["items"],
  now: Date,
): Promise<ClaimedContactOperation | null> {
  if (!row.globalCandidateId || evidence.length === 0) return null;
  const stagedEvidence: StagedContactEvidence = {
    version: 1,
    globalCandidateId: row.globalCandidateId,
    items: evidence,
  };
  return transitionClaim(
    store,
    row,
    [expectedState],
    {
      state: "evidence_pending",
      stagedEvidence,
      stagedAt: now,
      lastErrorCode: null,
      nextAttemptAt: now,
    },
    false,
    now,
  );
}

async function writeStagedEvidence({
  store,
  memory,
  row,
  now,
  retryMs,
}: {
  store: ContactOperationStore;
  memory: ContactMemoryClient;
  row: ClaimedContactOperation;
  now: Date;
  retryMs: number;
}): Promise<"completed" | "pending"> {
  const evidence = row.stagedEvidence;
  if (
    !evidence ||
    !row.globalCandidateId ||
    evidence.globalCandidateId !== row.globalCandidateId ||
    evidence.items.length === 0
  ) {
    await transitionClaim(
      store,
      row,
      ["evidence_pending"],
      {
        state: "failed",
        lastErrorCode: "staged_evidence_invalid",
        completedAt: now,
      },
      true,
      now,
    );
    return "completed";
  }

  try {
    const result = await memory.record({
      tenantId: row.tenantId,
      evidence,
    });
    const completed = await finishFromMemory(store, row, result, now);
    if (completed === "completed") return completed;
    await transitionClaim(
      store,
      row,
      ["evidence_pending"],
      {
        state: "evidence_pending",
        nextAttemptAt: new Date(now.getTime() + retryMs),
        lastErrorCode: "memory_evidence_not_selected",
      },
      true,
      now,
    );
    return "pending";
  } catch (error) {
    const code =
      error instanceof MemoryContactUnavailableError
        ? error.code
        : "memory_unavailable";
    await transitionClaim(
      store,
      row,
      ["evidence_pending"],
      {
        state: "evidence_pending",
        nextAttemptAt: new Date(now.getTime() + retryMs),
        lastErrorCode: code,
      },
      true,
      now,
    );
    return "pending";
  }
}

async function startEnrichLayer({
  store,
  memory,
  providers,
  row,
  expectedState,
  now,
  retryMs,
}: {
  store: ContactOperationStore;
  memory: ContactMemoryClient;
  providers: ContactProviderClient;
  row: ClaimedContactOperation;
  expectedState: ContactOperationState;
  now: Date;
  retryMs: number;
}): Promise<"completed" | "pending" | "ambiguous"> {
  const requestKey = `enrichlayer:${row.id}:${row.generation}`;
  const starting = await transitionClaim(
    store,
    row,
    [expectedState],
    {
      state: "enrichlayer_starting",
      provider: "enrichlayer",
      providerRequestKey: requestKey,
      providerRecordId: null,
      providerStartedAt: now,
      lastErrorCode: null,
    },
    false,
    now,
  );
  if (!starting) return "pending";

  const result = await providers.callEnrichLayer({
    requestKey,
    candidate: starting,
  });
  if (result.kind === "found") {
    const staged = await persistStagedEvidence(
      store,
      starting,
      "enrichlayer_starting",
      result.evidence,
      now,
    );
    return staged
      ? writeStagedEvidence({
          store,
          memory,
          row: staged,
          now,
          retryMs,
        })
      : "pending";
  }
  if (result.kind === "not_found") {
    await transitionClaim(
      store,
      starting,
      ["enrichlayer_starting"],
      {
        state: "not_found",
        selectedEmail: null,
        completedAt: now,
        lastErrorCode: null,
      },
      true,
      now,
    );
    return "completed";
  }
  if (result.kind === "ambiguous") {
    await transitionClaim(
      store,
      starting,
      ["enrichlayer_starting"],
      {
        state: "enrichlayer_ambiguous",
        completedAt: now,
        lastErrorCode: result.code,
      },
      true,
      now,
    );
    return "ambiguous";
  }
  await transitionClaim(
    store,
    starting,
    ["enrichlayer_starting"],
    {
      state: "failed",
      completedAt: now,
      lastErrorCode: result.code,
    },
    true,
    now,
  );
  return "completed";
}

async function continueToEnrichLayerAfterFreshMemoryLookup({
  store,
  memory,
  providers,
  row,
  markFullEnrichMiss,
  now,
  retryMs,
}: {
  store: ContactOperationStore;
  memory: ContactMemoryClient;
  providers: ContactProviderClient;
  row: ClaimedContactOperation;
  markFullEnrichMiss: boolean;
  now: Date;
  retryMs: number;
}): Promise<"completed" | "pending" | "ambiguous"> {
  let current = row;
  if (markFullEnrichMiss) {
    const marked = await transitionClaim(
      store,
      row,
      ["fullenrich_polling"],
      {
        state: "queued",
        nextAttemptAt: now,
        lastErrorCode: "fullenrich_no_email",
      },
      false,
      now,
    );
    if (!marked) return "pending";
    current = marked;
  }
  if (!current.globalCandidateId) return "pending";

  let memoryResult: MemoryContactLookupResult;
  try {
    memoryResult = await memory.lookup({
      tenantId: current.tenantId,
      globalCandidateId: current.globalCandidateId,
    });
  } catch {
    await transitionClaim(
      store,
      current,
      ["queued"],
      {
        state: "queued",
        nextAttemptAt: new Date(now.getTime() + retryMs),
        // Preserve the continuation marker so the next claim rechecks Memory
        // instead of restarting FullEnrich.
        lastErrorCode: "fullenrich_no_email",
      },
      true,
      now,
    );
    return "pending";
  }

  const completed = await finishFromMemory(store, current, memoryResult, now);
  if (completed === "completed") return completed;
  return startEnrichLayer({
    store,
    memory,
    providers,
    row: current,
    expectedState: "queued",
    now,
    retryMs,
  });
}

async function handleFullEnrichPoll({
  store,
  memory,
  providers,
  row,
  now,
  retryMs,
  pollMs,
}: {
  store: ContactOperationStore;
  memory: ContactMemoryClient;
  providers: ContactProviderClient;
  row: ClaimedContactOperation;
  now: Date;
  retryMs: number;
  pollMs: number;
}): Promise<"completed" | "pending" | "ambiguous"> {
  if (!row.providerRecordId) {
    await transitionClaim(
      store,
      row,
      ["fullenrich_polling"],
      {
        state: "failed",
        completedAt: now,
        lastErrorCode: "fullenrich_missing_request_id",
      },
      true,
      now,
    );
    return "completed";
  }
  const result: FullEnrichPollResult = await providers.pollFullEnrich({
    providerRecordId: row.providerRecordId,
  });
  if (result.kind === "pending") {
    await transitionClaim(
      store,
      row,
      ["fullenrich_polling"],
      {
        state: "fullenrich_polling",
        nextAttemptAt: new Date(now.getTime() + pollMs),
        lastErrorCode: result.code ?? null,
      },
      true,
      now,
    );
    return "pending";
  }
  if (result.kind === "found") {
    const staged = await persistStagedEvidence(
      store,
      row,
      "fullenrich_polling",
      result.evidence,
      now,
    );
    return staged
      ? writeStagedEvidence({
          store,
          memory,
          row: staged,
          now,
          retryMs,
        })
      : "pending";
  }
  if (result.kind === "not_found") {
    return continueToEnrichLayerAfterFreshMemoryLookup({
      store,
      memory,
      providers,
      row,
      markFullEnrichMiss: true,
      now,
      retryMs,
    });
  }
  await transitionClaim(
    store,
    row,
    ["fullenrich_polling"],
    {
      state: "failed",
      completedAt: now,
      lastErrorCode: result.code,
    },
    true,
    now,
  );
  return "completed";
}

async function startFullEnrich({
  store,
  providers,
  row,
  now,
  pollMs,
}: {
  store: ContactOperationStore;
  providers: ContactProviderClient;
  row: ClaimedContactOperation;
  now: Date;
  pollMs: number;
}): Promise<"completed" | "pending" | "ambiguous"> {
  const requestKey = `fullenrich:${row.id}:${row.generation}`;
  const starting = await transitionClaim(
    store,
    row,
    [row.state],
    {
      state: "fullenrich_starting",
      provider: "fullenrich",
      providerRequestKey: requestKey,
      providerRecordId: null,
      providerStartedAt: now,
      lastErrorCode: null,
    },
    false,
    now,
  );
  if (!starting) return "pending";

  const result = await providers.startFullEnrich({
    operationId: starting.id,
    generation: starting.generation,
    requestKey,
    candidate: starting,
  });
  if (result.kind === "started") {
    await transitionClaim(
      store,
      starting,
      ["fullenrich_starting"],
      {
        state: "fullenrich_polling",
        providerRecordId: result.providerRecordId,
        nextAttemptAt: new Date(now.getTime() + pollMs),
        lastErrorCode: null,
      },
      true,
      now,
    );
    return "pending";
  }
  if (result.kind === "ambiguous") {
    await transitionClaim(
      store,
      starting,
      ["fullenrich_starting"],
      {
        state: "fullenrich_ambiguous",
        completedAt: null,
        lastErrorCode: result.code,
      },
      true,
      now,
    );
    return "ambiguous";
  }
  await transitionClaim(
    store,
    starting,
    ["fullenrich_starting"],
    {
      state: "failed",
      completedAt: now,
      lastErrorCode: result.code,
    },
    true,
    now,
  );
  return "completed";
}

async function lookupMemoryFirst({
  store,
  memory,
  providers,
  row,
  now,
  retryMs,
  pollMs,
}: {
  store: ContactOperationStore;
  memory: ContactMemoryClient;
  providers: ContactProviderClient;
  row: ClaimedContactOperation;
  now: Date;
  retryMs: number;
  pollMs: number;
}): Promise<"completed" | "pending" | "ambiguous"> {
  if (!row.globalCandidateId) return "pending";
  let result: MemoryContactLookupResult;
  try {
    result = await memory.lookup({
      tenantId: row.tenantId,
      globalCandidateId: row.globalCandidateId,
    });
  } catch (error) {
    const code =
      error instanceof MemoryContactUnavailableError
        ? error.code
        : "memory_unavailable";
    await transitionClaim(
      store,
      row,
      [row.state],
      {
        state: "memory_lookup",
        nextAttemptAt: new Date(now.getTime() + retryMs),
        lastErrorCode: code,
      },
      true,
      now,
    );
    return "pending";
  }
  const completed = await finishFromMemory(store, row, result, now);
  if (completed === "completed") return completed;
  if (!row.linkedinUrl) {
    await transitionClaim(
      store,
      row,
      [row.state],
      {
        state: "failed",
        completedAt: now,
        lastErrorCode: "missing_linkedin_url",
      },
      true,
      now,
    );
    return "completed";
  }
  return startFullEnrich({
    store,
    providers,
    row,
    now,
    pollMs,
  });
}

async function processContactOperation({
  store,
  memory,
  providers,
  row,
  now,
  retryMs,
  linkRetryMs,
  pollMs,
}: {
  store: ContactOperationStore;
  memory: ContactMemoryClient;
  providers: ContactProviderClient;
  row: ClaimedContactOperation;
  now: Date;
  retryMs: number;
  linkRetryMs: number;
  pollMs: number;
}): Promise<"completed" | "pending" | "ambiguous"> {
  if (row.state === "evidence_pending") {
    return writeStagedEvidence({
      store,
      memory,
      row,
      now,
      retryMs,
    });
  }
  if (row.state === "fullenrich_polling") {
    return handleFullEnrichPoll({
      store,
      memory,
      providers,
      row,
      now,
      retryMs,
      pollMs,
    });
  }
  if (
    row.state === "queued" &&
    row.provider === "fullenrich" &&
    row.lastErrorCode === "fullenrich_no_email"
  ) {
    return continueToEnrichLayerAfterFreshMemoryLookup({
      store,
      memory,
      providers,
      row,
      markFullEnrichMiss: false,
      now,
      retryMs,
    });
  }

  let current = row;
  if (!current.globalCandidateId) {
    if (!current.linkedGlobalCandidateId) {
      await transitionClaim(
        store,
        current,
        [current.state],
        {
          state: "awaiting_global_id",
          nextAttemptAt: new Date(now.getTime() + linkRetryMs),
          lastErrorCode: "awaiting_global_id",
        },
        true,
        now,
      );
      return "pending";
    }
    const linked = await transitionClaim(
      store,
      current,
      [current.state],
      {
        state: "memory_lookup",
        globalCandidateId: current.linkedGlobalCandidateId,
        nextAttemptAt: now,
        lastErrorCode: null,
      },
      false,
      now,
    );
    if (!linked) return "pending";
    current = linked;
  }
  return lookupMemoryFirst({
    store,
    memory,
    providers,
    row: current,
    now,
    retryMs,
    pollMs,
  });
}

export async function runContactEnrichmentCycle(
  options: ContactEnrichmentWorkerOptions = {},
): Promise<ContactEnrichmentCycleSummary> {
  const store = options.store ?? new PrismaContactOperationStore();
  const memory = options.memory ?? new ActiveGraphContactMemoryClient();
  const providers = options.providers ?? new ExternalContactProviderClient();
  const now = options.now ?? (() => new Date());
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const batchSize = Math.max(1, options.batchSize ?? 20);
  const rows = await store.claim({
    limit: Math.min(batchSize, concurrency),
    leaseMs: options.leaseMs ?? 60_000,
    now: now(),
  });
  const outcomes = await Promise.all(
    rows.map((row) =>
      processContactOperation({
        store,
        memory,
        providers,
        row,
        now: now(),
        retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
        linkRetryMs: options.linkRetryMs ?? DEFAULT_LINK_RETRY_MS,
        pollMs: options.fullEnrichPollMs ?? DEFAULT_FULLENRICH_POLL_MS,
      }).catch(async () => {
        const failureNow = now();
        await transitionClaim(
          store,
          row,
          [row.state],
          {
            state: row.state,
            nextAttemptAt: new Date(
              failureNow.getTime() + (options.retryMs ?? DEFAULT_RETRY_MS),
            ),
            lastErrorCode: "contact_worker_unexpected",
          },
          true,
          failureNow,
        );
        return "pending" as const;
      }),
    ),
  );
  return {
    claimed: rows.length,
    completed: outcomes.filter((value) => value === "completed").length,
    pending: outcomes.filter((value) => value === "pending").length,
    ambiguous: outcomes.filter((value) => value === "ambiguous").length,
  };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startContactEnrichmentWorker({
  intervalMs = 5_000,
  options = {},
}: {
  intervalMs?: number;
  options?: ContactEnrichmentWorkerOptions;
} = {}): void {
  if (timer) return;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const summary = await runContactEnrichmentCycle(options);
      if (summary.claimed > 0) {
        log.info(summary, "Contact enrichment cycle completed");
      }
    } catch {
      log.error(
        { errorCode: "contact_cycle_failed" },
        "Contact enrichment cycle failed",
      );
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void run(), intervalMs);
  void run();
}

export function stopContactEnrichmentWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
