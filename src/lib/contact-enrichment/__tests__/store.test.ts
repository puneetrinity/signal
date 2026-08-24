import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  candidateFindFirst,
  jobCandidateFindFirst,
  operationUpsert,
  operationUpdateMany,
  operationFindUnique,
  executeRaw,
  queryRaw,
} = vi.hoisted(() => ({
  candidateFindFirst: vi.fn(),
  jobCandidateFindFirst: vi.fn(),
  operationUpsert: vi.fn(),
  operationUpdateMany: vi.fn(),
  operationFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    candidate: { findFirst: candidateFindFirst },
    jobSourcingCandidate: { findFirst: jobCandidateFindFirst },
    contactEnrichmentOperation: {
      upsert: operationUpsert,
      updateMany: operationUpdateMany,
      update: vi.fn(),
      findUniqueOrThrow: operationFindUnique,
    },
    $transaction: vi.fn(
      async (
        callback: (tx: {
          $executeRaw: typeof executeRaw;
          $queryRaw: typeof queryRaw;
          candidate: { findFirst: typeof candidateFindFirst };
          contactEnrichmentOperation: { upsert: typeof operationUpsert };
        }) => unknown,
      ) => callback({
        $executeRaw: executeRaw,
        $queryRaw: queryRaw,
        candidate: { findFirst: candidateFindFirst },
        contactEnrichmentOperation: { upsert: operationUpsert },
      }),
    ),
  },
}));

import {
  applyContactMemoryRevalidation,
  candidateAppearedInSourcingJob,
  findOrCreateContactOperation,
  PrismaContactOperationStore,
} from "../store";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function persistedOperation() {
  return {
    id: "operation-1",
    tenantId: "org_1",
    candidateId: "candidate-1",
    globalCandidateId: "11111111-1111-4111-8111-111111111111",
    state: "queued",
    generation: 1,
    provider: null,
    providerRequestKey: null,
    providerRecordId: null,
    stagedEvidence: null,
    stagedAt: null,
    attempts: 0,
    nextAttemptAt: NOW,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    providerStartedAt: null,
    selectedEmail: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("contact operation store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    candidateFindFirst.mockResolvedValue({
      id: "candidate-1",
      globalLink: {
        globalCandidateId: "11111111-1111-4111-8111-111111111111",
      },
    });
    operationUpsert.mockResolvedValue(persistedOperation());
    operationUpdateMany.mockResolvedValue({ count: 0 });
    operationFindUnique.mockResolvedValue(persistedOperation());
    jobCandidateFindFirst.mockResolvedValue({ id: "appearance-1" });
    executeRaw.mockResolvedValue(0);
    queryRaw.mockResolvedValue([]);
  });

  it("idempotently keys an operation by tenant and local candidate", async () => {
    await findOrCreateContactOperation({
      tenantId: "org_1",
      candidateId: "candidate-1",
    });
    await findOrCreateContactOperation({
      tenantId: "org_1",
      candidateId: "candidate-1",
    });

    expect(candidateFindFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: "candidate-1", tenantId: "org_1" },
      }),
    );
    expect(operationUpsert).toHaveBeenCalledTimes(2);
    expect(operationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_candidateId: {
            tenantId: "org_1",
            candidateId: "candidate-1",
          },
        },
      }),
    );
  });

  it("does not create an operation across a tenant boundary", async () => {
    candidateFindFirst.mockResolvedValueOnce(null);
    await expect(
      findOrCreateContactOperation({
        tenantId: "org_2",
        candidateId: "candidate-1",
      }),
    ).resolves.toBeNull();
    expect(operationUpsert).not.toHaveBeenCalled();
  });

  it("validates the tenant, candidate and external job appearance together", async () => {
    await expect(
      candidateAppearedInSourcingJob({
        tenantId: "org_1",
        candidateId: "candidate-1",
        externalJobId: "vanta:jobs:42",
      }),
    ).resolves.toBe(true);
    expect(jobCandidateFindFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "org_1",
        candidateId: "candidate-1",
        candidate: {},
        sourcingRequest: {
          tenantId: "org_1",
          externalJobId: "vanta:jobs:42",
        },
      },
      select: { id: true },
    });
  });

  it("fences a changed canonical identity even after a terminal find", async () => {
    operationUpsert.mockResolvedValueOnce({
      ...persistedOperation(),
      globalCandidateId: "11111111-1111-4111-8111-111111111111",
      state: "found",
      selectedEmail: "wrong-person@example.com",
      completedAt: NOW,
    });
    candidateFindFirst.mockResolvedValueOnce({
      id: "candidate-1",
      globalLink: {
        globalCandidateId: "22222222-2222-4222-8222-222222222222",
      },
    });
    operationUpdateMany.mockResolvedValueOnce({ count: 1 });
    operationFindUnique.mockResolvedValueOnce({
      ...persistedOperation(),
      globalCandidateId: "11111111-1111-4111-8111-111111111111",
      state: "failed",
      generation: 2,
      selectedEmail: null,
      lastErrorCode: "global_identity_changed",
      completedAt: NOW,
    });

    const result = await findOrCreateContactOperation({
      tenantId: "org_1",
      candidateId: "candidate-1",
    });

    expect(result?.state).toBe("failed");
    expect(result?.selectedEmail).toBeNull();
    expect(operationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "failed",
          generation: { increment: 1 },
          selectedEmail: null,
          lastErrorCode: "global_identity_changed",
        }),
      }),
    );
  });

  it("revalidates a cached found email against Memory suppression", async () => {
    operationUpdateMany.mockResolvedValueOnce({ count: 1 });
    operationFindUnique.mockResolvedValueOnce({
      ...persistedOperation(),
      state: "suppressed",
      selectedEmail: null,
      lastErrorCode: "contact_suppressed",
      completedAt: NOW,
    });

    const result = await applyContactMemoryRevalidation({
      operation: {
        ...persistedOperation(),
        stagedEvidence: null,
        state: "found",
        selectedEmail: "stale@example.com",
      },
      result: { state: "suppressed" },
      now: NOW,
    });

    expect(result.state).toBe("suppressed");
    expect(result.selectedEmail).toBeNull();
    expect(operationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "found",
          generation: 1,
        }),
        data: expect.objectContaining({
          state: "suppressed",
          selectedEmail: null,
        }),
      }),
    );
  });

  it("does not reset a terminal operation on repeated requests", async () => {
    operationUpsert.mockResolvedValue({
      ...persistedOperation(),
      state: "fullenrich_ambiguous",
      lastErrorCode: "fullenrich_start_ambiguous",
      completedAt: NOW,
    });

    const first = await findOrCreateContactOperation({
      tenantId: "org_1",
      candidateId: "candidate-1",
    });
    const second = await findOrCreateContactOperation({
      tenantId: "org_1",
      candidateId: "candidate-1",
    });

    expect(first?.state).toBe("fullenrich_ambiguous");
    expect(second?.state).toBe("fullenrich_ambiguous");
    expect(operationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
  });

  it("recovers an expired provider-start lease as ambiguous before claiming", async () => {
    const store = new PrismaContactOperationStore();
    await store.claim({ limit: 5, leaseMs: 60_000, now: NOW });

    const recoverySql = (
      executeRaw.mock.calls[0]?.[0] as TemplateStringsArray
    ).join(" ");
    expect(recoverySql).toContain("'fullenrich_starting'");
    expect(recoverySql).toContain("'fullenrich_ambiguous'");
    expect(recoverySql).toContain("'enrichlayer_starting'");
    expect(recoverySql).toContain("'enrichlayer_ambiguous'");
    expect(recoverySql).toContain('"leaseExpiresAt" <=');
  });
});
