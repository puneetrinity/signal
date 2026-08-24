import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import type { JobRequirements } from "../jd-digest";
import type { CrustdataSearchResult } from "../crustdata-client";
import {
  acquireCrustdataSearch,
  applyCrustdataReceiptEffectOnce,
  CrustdataAcquisitionSafetyError,
  markCrustdataReceiptMemoryIngested,
  releaseCrustdataReceiptPayloads,
  releaseDeliveredCrustdataReceiptPayloads,
  type AcquireCrustdataSearchInput,
  type CrustdataReceiptStore,
  type StoredReceipt,
} from "../crustdata-acquisition";
import { ladderObservationIsStale } from "../crustdata-ladder-effect";

const requirements: JobRequirements = {
  title: "Backend Engineer",
  topSkills: ["python", "django"],
  seniorityLevel: "senior",
  domain: "software",
  roleFamily: "backend",
  location: "Bengaluru, India",
  experienceYears: 5,
  experienceYearsMax: null,
  education: null,
  titleSearchTerms: ["backend engineer"],
  adjacentBuckets: [["django developer"]],
  adjacentLocations: [],
};

const exactResult: CrustdataSearchResult = {
  profiles: [{ crustdata_person_id: 101 }],
  providerTotal: 500,
  rawReturnedCount: 1,
  requestedLimit: 300,
};

const spillResult: CrustdataSearchResult = {
  profiles: [{ crustdata_person_id: 202 }],
  providerTotal: 25,
  rawReturnedCount: 1,
  requestedLimit: 25,
};

function receiptKey(
  tenantId: string,
  sourcingRequestId: string,
  acquisitionGeneration: number,
  slot: string,
): string {
  return `${tenantId}|${sourcingRequestId}|${acquisitionGeneration}|${slot}`;
}

class InMemoryReceiptStore implements CrustdataReceiptStore {
  readonly receipts = new Map<string, StoredReceipt>();
  private nextId = 1;

  async find(
    tenantId: string,
    sourcingRequestId: string,
    acquisitionGeneration: number,
    slot: "exact" | "spill",
  ): Promise<StoredReceipt | null> {
    return (
      this.receipts.get(
        receiptKey(tenantId, sourcingRequestId, acquisitionGeneration, slot),
      ) ?? null
    );
  }

  async reserve(
    input: Parameters<CrustdataReceiptStore["reserve"]>[0],
  ): Promise<StoredReceipt> {
    const key = receiptKey(
      input.tenantId,
      input.sourcingRequestId,
      input.acquisitionGeneration,
      input.slot,
    );
    if (this.receipts.has(key)) throw new Error("unique constraint");
    const receipt: StoredReceipt = {
      id: `receipt-${this.nextId++}`,
      status: "started",
      startedAt: new Date("2026-07-27T00:00:00.000Z"),
      requestFingerprint: input.requestFingerprint,
      requestMetadata: input.requestMetadata,
      result: null,
      error: null,
      effectsAppliedAt: null,
      effectMetadata: null,
    };
    this.receipts.set(key, receipt);
    return receipt;
  }

  async complete(id: string, result: CrustdataSearchResult): Promise<void> {
    const receipt = [...this.receipts.values()].find((row) => row.id === id);
    if (!receipt || receipt.status !== "started") {
      throw new Error("receipt cannot complete");
    }
    receipt.status = "complete";
    receipt.result = result;
  }

  async markUncertain(id: string, error: string): Promise<void> {
    const receipt = [...this.receipts.values()].find((row) => row.id === id);
    if (!receipt) return;
    receipt.status = "uncertain";
    receipt.error = error;
  }
}

function acquisitionInput(
  overrides: Partial<AcquireCrustdataSearchInput> = {},
): AcquireCrustdataSearchInput {
  return {
    tenantId: "tenant-a",
    sourcingRequestId: "request-a",
    acquisitionGeneration: 1,
    slot: "exact",
    requirements,
    limit: 300,
    excludePersonIds: [1, 2],
    metadata: {
      rungId: "exact",
      rungDescription: "exact job segment",
      submittedExclusionCount: 2,
    },
    ...overrides,
  };
}

beforeEach(() => {
  process.env.SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER =
    "disposable_passthrough";
});

afterEach(() => {
  delete process.env.SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER;
  vi.restoreAllMocks();
});

describe("request-scoped Crustdata acquisition receipts", () => {
  it("makes zero provider or receipt calls when privacy health is unavailable", async () => {
    delete process.env.SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER;
    const store = new InMemoryReceiptStore();
    const find = vi.spyOn(store, "find");
    const reserve = vi.spyOn(store, "reserve");
    const search = vi.fn().mockResolvedValue(exactResult);

    await expect(
      acquireCrustdataSearch(acquisitionInput(), {
        store,
        search,
        requirePrivacyHealth: vi
          .fn()
          .mockRejectedValue(new Error("candidate_privacy_unavailable")),
      }),
    ).rejects.toThrow("candidate_privacy_unavailable");

    expect(find).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(store.receipts.size).toBe(0);
  });

  it("reuses exact and spill batches independently on a downstream retry", async () => {
    const store = new InMemoryReceiptStore();
    const search = vi
      .fn()
      .mockResolvedValueOnce(exactResult)
      .mockResolvedValueOnce(spillResult);
    const exactInput = acquisitionInput();
    const spillInput = acquisitionInput({
      slot: "spill",
      limit: 25,
      metadata: {
        rungId: "adjacent_title:0",
        rungDescription: "adjacent titles: django developer",
        submittedExclusionCount: 3,
      },
    });

    const firstExact = await acquireCrustdataSearch(exactInput, {
      store,
      search,
    });
    const firstSpill = await acquireCrustdataSearch(spillInput, {
      store,
      search,
    });
    const retriedExact = await acquireCrustdataSearch(exactInput, {
      store,
      search,
    });
    const retriedSpill = await acquireCrustdataSearch(spillInput, {
      store,
      search,
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(firstExact.reused).toBe(false);
    expect(firstSpill.reused).toBe(false);
    expect(retriedExact).toMatchObject({
      reused: true,
      receiptId: firstExact.receiptId,
      result: exactResult,
      acquiredAt: firstExact.acquiredAt,
    });
    expect(retriedSpill).toMatchObject({
      reused: true,
      receiptId: firstSpill.receiptId,
      result: spillResult,
      metadata: { rungId: "adjacent_title:0" },
    });
  });

  it("buys again for a new explicit acquisition generation", async () => {
    const store = new InMemoryReceiptStore();
    const search = vi.fn().mockResolvedValue(exactResult);

    await acquireCrustdataSearch(acquisitionInput(), { store, search });
    await acquireCrustdataSearch(
      acquisitionInput({ acquisitionGeneration: 2 }),
      { store, search },
    );

    expect(search).toHaveBeenCalledTimes(2);
    expect(store.receipts).toHaveLength(2);
  });

  it("never shares a receipt across requests or tenants", async () => {
    const store = new InMemoryReceiptStore();
    const search = vi.fn().mockResolvedValue(exactResult);

    await acquireCrustdataSearch(acquisitionInput(), { store, search });
    await acquireCrustdataSearch(
      acquisitionInput({ sourcingRequestId: "request-b" }),
      { store, search },
    );
    await acquireCrustdataSearch(acquisitionInput({ tenantId: "tenant-b" }), {
      store,
      search,
    });

    expect(search).toHaveBeenCalledTimes(3);
  });

  it("makes concurrent workers converge on the first in-flight call", async () => {
    const store = new InMemoryReceiptStore();
    let resolveSearch!: (result: CrustdataSearchResult) => void;
    const search = vi.fn(
      () =>
        new Promise<CrustdataSearchResult>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const dependencies = {
      store,
      search,
      sleep: () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        }),
      waitAttempts: 100,
      waitIntervalMs: 0,
    };

    const first = acquireCrustdataSearch(acquisitionInput(), dependencies);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    const concurrent = acquireCrustdataSearch(acquisitionInput(), dependencies);
    resolveSearch(exactResult);

    const [firstResult, concurrentResult] = await Promise.all([
      first,
      concurrent,
    ]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(firstResult.reused).toBe(false);
    expect(concurrentResult).toMatchObject({
      reused: true,
      receiptId: firstResult.receiptId,
    });
  });

  it("fails closed after an ambiguous provider outcome", async () => {
    const store = new InMemoryReceiptStore();
    const search = vi.fn().mockRejectedValue(new Error("socket reset"));

    await expect(
      acquireCrustdataSearch(acquisitionInput(), { store, search }),
    ).rejects.toMatchObject({
      name: "CrustdataAcquisitionSafetyError",
      code: "receipt_uncertain",
    });
    await expect(
      acquireCrustdataSearch(acquisitionInput(), {
        store,
        search,
        waitAttempts: 0,
      }),
    ).rejects.toBeInstanceOf(CrustdataAcquisitionSafetyError);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a paid response cannot be persisted", async () => {
    const store = new InMemoryReceiptStore();
    const search = vi.fn().mockResolvedValue(exactResult);
    vi.spyOn(store, "complete").mockRejectedValue(
      new Error("database unavailable"),
    );

    await expect(
      acquireCrustdataSearch(acquisitionInput(), { store, search }),
    ).rejects.toMatchObject({
      name: "CrustdataAcquisitionSafetyError",
      code: "receipt_persistence_failed",
    });
    await expect(
      acquireCrustdataSearch(acquisitionInput(), {
        store,
        search,
        waitAttempts: 0,
      }),
    ).rejects.toMatchObject({ code: "receipt_in_progress" });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("fails closed before dispatch when receipt storage cannot be read", async () => {
    const store = new InMemoryReceiptStore();
    const search = vi.fn().mockResolvedValue(exactResult);
    vi.spyOn(store, "find").mockRejectedValue(new Error("database unavailable"));

    await expect(
      acquireCrustdataSearch(acquisitionInput(), { store, search }),
    ).rejects.toMatchObject({
      name: "CrustdataAcquisitionSafetyError",
      code: "receipt_persistence_failed",
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch when a receipt cannot be reserved", async () => {
    const store = new InMemoryReceiptStore();
    const search = vi.fn().mockResolvedValue(exactResult);
    vi.spyOn(store, "reserve").mockRejectedValue(
      new Error("database unavailable"),
    );

    await expect(
      acquireCrustdataSearch(acquisitionInput(), { store, search }),
    ).rejects.toMatchObject({
      name: "CrustdataAcquisitionSafetyError",
      code: "receipt_persistence_failed",
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("audits input drift but still reuses the generation receipt", async () => {
    const store = new InMemoryReceiptStore();
    const search = vi.fn().mockResolvedValue(exactResult);

    const first = await acquireCrustdataSearch(acquisitionInput(), {
      store,
      search,
    });
    const retry = await acquireCrustdataSearch(
      acquisitionInput({
        excludePersonIds: [9, 10],
        metadata: {
          rungId: "exact",
          rungDescription: "exact job segment",
          submittedExclusionCount: 2,
        },
      }),
      { store, search },
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(first.requestFingerprintMatched).toBe(true);
    expect(retry).toMatchObject({
      reused: true,
      requestFingerprintMatched: false,
      metadata: { submittedExclusionCount: 2 },
    });
  });
});

describe("Crustdata acquisition downstream effects", () => {
  it("applies a receipt effect once and reuses its persisted metadata", async () => {
    const effectMetadata = {
      activeRung: "adjacent_title:0",
      shortfallStreak: 1,
      appliedAt: "2026-07-27T00:00:00.000Z",
    };
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const transaction = {
      crustdataAcquisitionReceipt: {
        updateMany,
        update: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue({
          effectsAppliedAt: new Date("2026-07-27T00:00:00.000Z"),
          effectMetadata,
        }),
      },
    };
    vi.spyOn(prisma, "$transaction").mockImplementation((async (
      callback: (tx: typeof transaction) => Promise<unknown>,
    ) => callback(transaction)) as unknown as typeof prisma.$transaction);
    const effect = vi.fn().mockResolvedValue(effectMetadata);

    const first = await applyCrustdataReceiptEffectOnce(
      "tenant-a",
      "receipt-1",
      effect,
    );
    const replay = await applyCrustdataReceiptEffectOnce(
      "tenant-a",
      "receipt-1",
      effect,
    );

    expect(effect).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ applied: true, metadata: effectMetadata });
    expect(replay).toEqual({ applied: false, metadata: effectMetadata });
  });

  it("releases scoped payloads and sweeps delivered callback leftovers", async () => {
    const updateMany = vi
      .spyOn(prisma.crustdataAcquisitionReceipt, "updateMany")
      .mockResolvedValue({ count: 2 });

    await expect(
      releaseCrustdataReceiptPayloads("tenant-a", "request-a", 3),
    ).resolves.toBe(2);
    await expect(
      releaseDeliveredCrustdataReceiptPayloads("tenant-a"),
    ).resolves.toBe(2);

    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          tenantId: "tenant-a",
          sourcingRequestId: "request-a",
          acquisitionGeneration: 3,
          status: "complete",
          memoryIngestedAt: { not: null },
        },
        data: expect.objectContaining({ status: "released" }),
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          status: "complete",
          memoryIngestedAt: { not: null },
          tenantId: "tenant-a",
          sourcingRequest: {
            status: "complete",
            callbackStatus: "delivered",
          },
        },
        data: expect.objectContaining({ status: "released" }),
      }),
    );
  });

  it("records successful Memory ingestion before a receipt can be released", async () => {
    const updateMany = vi
      .spyOn(prisma.crustdataAcquisitionReceipt, "updateMany")
      .mockResolvedValue({ count: 1 });

    await expect(
      markCrustdataReceiptMemoryIngested("tenant-a", "receipt-1", {
        candidateCount: 300,
      }),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "receipt-1",
        tenantId: "tenant-a",
        status: "complete",
        memoryIngestedAt: null,
      },
      data: {
        memoryIngestedAt: expect.any(Date),
        memoryIngestMetadata: { candidateCount: 300 },
      },
    });
  });

  it("rejects an older ladder observation replayed after newer state", () => {
    expect(
      ladderObservationIsStale(
        new Date("2026-07-27T12:00:00.000Z"),
        new Date("2026-07-26T12:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      ladderObservationIsStale(
        new Date("2026-07-26T12:00:00.000Z"),
        new Date("2026-07-27T12:00:00.000Z"),
      ),
    ).toBe(false);
  });
});
