import { describe, expect, it, vi } from "vitest";
import {
  MemoryContactUnavailableError,
  type ContactMemoryClient,
  type MemoryContactLookupResult,
} from "../memory-client";
import type {
  ContactProviderClient,
  EnrichLayerResult,
  FullEnrichPollResult,
  FullEnrichStartResult,
} from "../providers";
import type {
  ContactOperationStore,
  ContactOperationTransition,
} from "../store";
import type {
  ClaimedContactOperation,
  ContactOperationState,
  StagedContactEvidence,
} from "../types";
import { runContactEnrichmentCycle } from "../worker";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const GLOBAL_ID = "11111111-1111-4111-8111-111111111111";

function operation(
  state: ContactOperationState = "queued",
  overrides: Partial<ClaimedContactOperation> = {},
): ClaimedContactOperation {
  return {
    id: "operation-1",
    tenantId: "org_1",
    candidateId: "candidate-1",
    globalCandidateId: GLOBAL_ID,
    state,
    generation: 1,
    provider: null,
    providerRequestKey: null,
    providerRecordId: null,
    stagedEvidence: null,
    stagedAt: null,
    attempts: 1,
    nextAttemptAt: NOW,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    lastErrorCode: null,
    providerStartedAt: null,
    selectedEmail: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    linkedinUrl: "https://www.linkedin.com/in/alice",
    nameHint: "Alice Example",
    companyHint: "Acme",
    linkedGlobalCandidateId: GLOBAL_ID,
    ...overrides,
  };
}

class FakeStore implements ContactOperationStore {
  readonly transitions: Array<{
    from: ContactOperationState;
    transition: ContactOperationTransition;
    releaseLease: boolean;
  }> = [];
  private claimed = false;

  constructor(readonly row: ClaimedContactOperation) {}

  async claim(): Promise<ClaimedContactOperation[]> {
    if (
      this.claimed ||
      this.row.leaseToken === "" ||
      [
        "found",
        "suppressed",
        "not_found",
        "failed",
        "fullenrich_ambiguous",
        "enrichlayer_ambiguous",
      ].includes(this.row.state)
    ) {
      return [];
    }
    this.claimed = true;
    this.row.leaseToken = `lease-${this.row.attempts + 1}`;
    this.row.attempts += 1;
    return [{ ...this.row }];
  }

  allowNextCycle(): void {
    this.claimed = false;
    if (this.row.leaseToken === "") {
      this.row.leaseToken = "claimable";
    }
  }

  async transition({
    row,
    expectedStates,
    transition,
    releaseLease,
  }: {
    row: ClaimedContactOperation;
    expectedStates: ContactOperationState[];
    transition: ContactOperationTransition;
    releaseLease: boolean;
    now: Date;
  }): Promise<boolean> {
    if (
      row.generation !== this.row.generation ||
      row.leaseToken !== this.row.leaseToken ||
      !expectedStates.includes(this.row.state)
    ) {
      return false;
    }
    this.transitions.push({
      from: this.row.state,
      transition,
      releaseLease,
    });
    Object.assign(this.row, transition);
    if (releaseLease) {
      this.row.leaseToken = "";
      this.row.leaseExpiresAt = NOW;
    }
    return true;
  }
}

function memoryClient(
  lookupResult: "found" | "suppressed" | "miss" | "unavailable" = "miss",
): ContactMemoryClient & {
  lookup: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
} {
  return {
    lookup: vi.fn(async (): Promise<MemoryContactLookupResult> => {
      if (lookupResult === "unavailable") {
        throw new MemoryContactUnavailableError("memory_unavailable");
      }
      if (lookupResult === "found") {
        return { state: "found", email: "alice@example.com" };
      }
      return { state: lookupResult };
    }),
    record: vi.fn(
      async (): Promise<MemoryContactLookupResult> => ({
        state: "found",
        email: "alice@example.com",
      }),
    ),
  };
}

function providerClient({
  start = { kind: "started", providerRecordId: "fe-1" },
  poll = { kind: "pending" },
  enrichLayer = { kind: "not_found" },
}: {
  start?: FullEnrichStartResult;
  poll?: FullEnrichPollResult;
  enrichLayer?: EnrichLayerResult;
} = {}): ContactProviderClient & {
  startFullEnrich: ReturnType<typeof vi.fn>;
  pollFullEnrich: ReturnType<typeof vi.fn>;
  callEnrichLayer: ReturnType<typeof vi.fn>;
} {
  return {
    startFullEnrich: vi.fn(async () => start),
    pollFullEnrich: vi.fn(async () => poll),
    callEnrichLayer: vi.fn(async () => enrichLayer),
  };
}

function foundEvidence(): StagedContactEvidence["items"] {
  return [
    {
      email: "alice@example.com",
      provider: "fullenrich",
      providerRecordId: "fe-1",
      confidence: 0.95,
      observedAt: NOW.toISOString(),
      validatedAt: NOW.toISOString(),
      status: "verified",
    },
  ];
}

const cycleOptions = {
  now: () => NOW,
  retryMs: 0,
  linkRetryMs: 0,
  fullEnrichPollMs: 300_000,
};

describe("durable contact enrichment worker", () => {
  it("waits for a canonical Memory id without provider spend", async () => {
    const store = new FakeStore(
      operation("queued", {
        globalCandidateId: null,
        linkedGlobalCandidateId: null,
      }),
    );
    const memory = memoryClient("miss");
    const providers = providerClient();

    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory,
      providers,
    });

    expect(store.row.state).toBe("awaiting_global_id");
    expect(memory.lookup).not.toHaveBeenCalled();
    expect(providers.startFullEnrich).not.toHaveBeenCalled();
    expect(providers.callEnrichLayer).not.toHaveBeenCalled();
  });

  it("does not call a provider while Memory is unavailable", async () => {
    const store = new FakeStore(operation());
    const memory = memoryClient("unavailable");
    const providers = providerClient();

    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory,
      providers,
    });

    expect(providers.startFullEnrich).not.toHaveBeenCalled();
    expect(providers.callEnrichLayer).not.toHaveBeenCalled();
    expect(store.row.state).toBe("memory_lookup");
  });

  it.each(["found", "suppressed"] as const)(
    "uses a Memory %s without provider spend",
    async (memoryState) => {
      const store = new FakeStore(operation());
      const memory = memoryClient(memoryState);
      const providers = providerClient();

      await runContactEnrichmentCycle({
        ...cycleOptions,
        store,
        memory,
        providers,
      });

      expect(providers.startFullEnrich).not.toHaveBeenCalled();
      expect(store.row.state).toBe(memoryState);
      expect(store.row.selectedEmail).toBe(
        memoryState === "found" ? "alice@example.com" : null,
      );
    },
  );

  it("allows only one provider start across concurrent claims", async () => {
    const store = new FakeStore(operation());
    const memory = memoryClient("miss");
    const providers = providerClient();

    await Promise.all([
      runContactEnrichmentCycle({
        ...cycleOptions,
        store,
        memory,
        providers,
      }),
      runContactEnrichmentCycle({
        ...cycleOptions,
        store,
        memory,
        providers,
      }),
    ]);

    expect(providers.startFullEnrich).toHaveBeenCalledTimes(1);
  });

  it("commits fullenrich_starting before the provider POST", async () => {
    const store = new FakeStore(operation());
    const memory = memoryClient("miss");
    const providers = providerClient();
    providers.startFullEnrich.mockImplementationOnce(async () => {
      expect(store.row.state).toBe("fullenrich_starting");
      expect(store.row.providerRequestKey).toBe("fullenrich:operation-1:1");
      return { kind: "started", providerRecordId: "fe-1" };
    });

    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory,
      providers,
    });

    expect(store.row.state).toBe("fullenrich_polling");
    expect(store.row.providerRecordId).toBe("fe-1");
  });

  it("never reposts an ambiguous FullEnrich start or falls back", async () => {
    const store = new FakeStore(operation());
    const providers = providerClient({
      start: {
        kind: "ambiguous",
        code: "fullenrich_start_ambiguous",
      },
    });

    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory: memoryClient("miss"),
      providers,
    });
    store.allowNextCycle();
    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory: memoryClient("miss"),
      providers,
    });

    expect(store.row.state).toBe("fullenrich_ambiguous");
    expect(store.row.completedAt).toBeNull();
    expect(providers.startFullEnrich).toHaveBeenCalledTimes(1);
    expect(providers.callEnrichLayer).not.toHaveBeenCalled();
  });

  it("never claims a terminal operation for provider restart", async () => {
    const store = new FakeStore(
      operation("fullenrich_ambiguous", {
        lastErrorCode: "fullenrich_start_ambiguous",
      }),
    );
    const providers = providerClient();

    const result = await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory: memoryClient("miss"),
      providers,
    });

    expect(result.claimed).toBe(0);
    expect(providers.startFullEnrich).not.toHaveBeenCalled();
    expect(providers.callEnrichLayer).not.toHaveBeenCalled();
  });

  it("polls only the saved FullEnrich request id", async () => {
    const store = new FakeStore(
      operation("fullenrich_polling", {
        provider: "fullenrich",
        providerRecordId: "saved-fe-id",
      }),
    );
    const providers = providerClient();

    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory: memoryClient(),
      providers,
    });

    expect(providers.pollFullEnrich).toHaveBeenCalledWith({
      providerRecordId: "saved-fe-id",
    });
    expect(providers.startFullEnrich).not.toHaveBeenCalled();
  });

  it("falls back to EnrichLayer only after definitive FullEnrich miss", async () => {
    const store = new FakeStore(
      operation("fullenrich_polling", {
        provider: "fullenrich",
        providerRecordId: "fe-1",
      }),
    );
    const providers = providerClient({
      poll: { kind: "not_found" },
      enrichLayer: { kind: "not_found" },
    });
    const memory = memoryClient();

    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory,
      providers,
    });

    expect(providers.callEnrichLayer).toHaveBeenCalledTimes(1);
    expect(memory.lookup).toHaveBeenCalledTimes(1);
    expect(store.row.state).toBe("not_found");
  });

  it.each(["found", "suppressed"] as const)(
    "rechecks Memory and stops before EnrichLayer when it is %s",
    async (state) => {
      const store = new FakeStore(
        operation("fullenrich_polling", {
          provider: "fullenrich",
          providerRecordId: "fe-1",
        }),
      );
      const memory = memoryClient(state);
      const providers = providerClient({
        poll: { kind: "not_found" },
      });

      await runContactEnrichmentCycle({
        ...cycleOptions,
        store,
        memory,
        providers,
      });

      expect(memory.lookup).toHaveBeenCalledTimes(1);
      expect(providers.callEnrichLayer).not.toHaveBeenCalled();
      expect(store.row.state).toBe(state);
    },
  );

  it("retries the post-FullEnrich Memory check without EnrichLayer spend", async () => {
    const store = new FakeStore(
      operation("fullenrich_polling", {
        provider: "fullenrich",
        providerRecordId: "fe-1",
      }),
    );
    const memory = memoryClient("unavailable");
    const providers = providerClient({
      poll: { kind: "not_found" },
    });

    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory,
      providers,
    });

    expect(providers.callEnrichLayer).not.toHaveBeenCalled();
    expect(store.row.state).toBe("queued");
    expect(store.row.lastErrorCode).toBe("fullenrich_no_email");
  });

  it("rechecks Memory before webhook-driven EnrichLayer continuation", async () => {
    const store = new FakeStore(
      operation("queued", {
        provider: "fullenrich",
        providerRecordId: "fe-1",
        lastErrorCode: "fullenrich_no_email",
      }),
    );
    const memory = memoryClient("found");
    const providers = providerClient();

    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory,
      providers,
    });

    expect(memory.lookup).toHaveBeenCalledTimes(1);
    expect(providers.callEnrichLayer).not.toHaveBeenCalled();
    expect(store.row.state).toBe("found");
  });

  it("does not repeat an ambiguous EnrichLayer call", async () => {
    const store = new FakeStore(
      operation("queued", {
        provider: "fullenrich",
        lastErrorCode: "fullenrich_no_email",
      }),
    );
    const providers = providerClient({
      enrichLayer: {
        kind: "ambiguous",
        code: "enrichlayer_ambiguous",
      },
    });

    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory: memoryClient(),
      providers,
    });
    store.allowNextCycle();
    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory: memoryClient(),
      providers,
    });

    expect(providers.callEnrichLayer).toHaveBeenCalledTimes(1);
    expect(store.row.state).toBe("enrichlayer_ambiguous");
  });

  it("stages evidence before Memory and retries Memory without a provider", async () => {
    const store = new FakeStore(
      operation("fullenrich_polling", {
        provider: "fullenrich",
        providerRecordId: "fe-1",
      }),
    );
    const providers = providerClient({
      poll: { kind: "found", evidence: foundEvidence() },
    });
    const memory = memoryClient();
    memory.record
      .mockRejectedValueOnce(
        new MemoryContactUnavailableError("memory_unavailable"),
      )
      .mockResolvedValueOnce({
        state: "found",
        email: "alice@example.com",
      });

    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory,
      providers,
    });
    expect(store.row.state).toBe("evidence_pending");
    expect(store.row.stagedEvidence?.items).toEqual(foundEvidence());
    store.allowNextCycle();

    await runContactEnrichmentCycle({
      ...cycleOptions,
      store,
      memory,
      providers,
    });

    expect(store.row.state).toBe("found");
    expect(providers.pollFullEnrich).toHaveBeenCalledTimes(1);
    expect(providers.startFullEnrich).not.toHaveBeenCalled();
    expect(memory.record).toHaveBeenCalledTimes(2);
  });
});
