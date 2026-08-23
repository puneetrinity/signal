import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicMemoryOutboxEnqueueInput } from "../public-memory-ingest-outbox";

const executeRaw = vi.fn();
const queryRaw = vi.fn();
const findMany = vi.fn();
const updateMany = vi.fn();
const ensureCandidateGlobalLink = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback({ $executeRaw: executeRaw }),
    ),
    publicMemoryIngestOutbox: {
      findMany,
      updateMany,
    },
    publicMemoryIngestReceipt: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

vi.mock("../public-memory-materialization", () => ({
  ensureCandidateGlobalLink,
}));

function input(
  id: string,
  expectedGlobalCandidateId: string | null = null,
): PublicMemoryOutboxEnqueueInput {
  return {
    candidate: {
      id,
      linkedinUrl: `https://www.linkedin.com/in/${id}`,
      headlineHint: "Backend Engineer",
      locationHint: "Bengaluru, India",
      searchTitle: "Backend Engineer",
      searchSnippet: null,
      enrichmentStatus: "complete",
      lastEnrichedAt: null,
      crustdata: { crustdata_person_id: 123 },
      snapshot: null,
    },
    options: {},
    expectedGlobalCandidateId,
  };
}

describe("public Memory ingest outbox enqueue", () => {
  beforeEach(() => {
    executeRaw.mockReset();
    executeRaw.mockResolvedValue(1);
    queryRaw.mockReset();
    findMany.mockReset();
    updateMany.mockReset();
    ensureCandidateGlobalLink.mockReset();
  });

  it("deduplicates one identity before the single upsert statement", async () => {
    const { enqueuePublicMemoryIngestOutbox } = await import(
      "../public-memory-ingest-outbox"
    );
    await expect(
      enqueuePublicMemoryIngestOutbox({
        tenantId: "org_1",
        sourcingRequestId: "request-1",
        candidates: [input("alice"), input("alice")],
      }),
    ).resolves.toBe(1);

    const serializedRows = executeRaw.mock.calls[0]?.[1];
    expect(JSON.parse(serializedRows)).toHaveLength(1);
  });

  it("stores only the public Crustdata projection in the durable outbox", async () => {
    const unsafe = input("alice");
    unsafe.candidate.name = "Alice nested-name@example.com";
    unsafe.candidate.headlineHint =
      "Backend Engineer; email headline@example.com or call +1-415-555-0123";
    unsafe.candidate.locationHint = "Bengaluru 9876543210";
    unsafe.candidate.searchTitle = "Engineer search-title@example.com";
    unsafe.candidate.searchSnippet =
      "Contact search-snippet@example.com or 98765-43210";
    unsafe.candidate.crustdata = {
      crustdata_person_id: 123,
      basic_profile: {
        name: "Alice Example",
        headline: "Backend Engineer",
        email: "nested@example.com",
      },
      contact: {
        has_personal_email: true,
        personal_email: "top@example.com",
      },
    } as typeof unsafe.candidate.crustdata;
    const { enqueuePublicMemoryIngestOutbox } = await import(
      "../public-memory-ingest-outbox"
    );

    await enqueuePublicMemoryIngestOutbox({
      tenantId: "org_1",
      sourcingRequestId: "request-1",
      candidates: [unsafe],
    });

    const rows = JSON.parse(String(executeRaw.mock.calls[0]?.[1]));
    const serialized = JSON.stringify(rows[0]?.payload);
    expect(serialized).toContain("Backend Engineer");
    expect(serialized).not.toContain("nested@example.com");
    expect(serialized).not.toContain("top@example.com");
    expect(serialized).not.toContain("nested-name@example.com");
    expect(serialized).not.toContain("headline@example.com");
    expect(serialized).not.toContain("+1-415-555-0123");
    expect(serialized).not.toContain("9876543210");
    expect(serialized).not.toContain("search-title@example.com");
    expect(serialized).not.toContain("search-snippet@example.com");
    expect(serialized).not.toContain("98765-43210");
    expect(serialized).toContain("[redacted]");
    expect(rows[0]?.payload.candidate.crustdata.contact).toBeUndefined();
  });

  it("round-trips the paid observation time and acquisition generation", async () => {
    const observedAt = new Date("2026-07-27T01:02:03.000Z");
    const timed = input("alice");
    timed.options = {
      profileObservedAt: observedAt,
      acquisitionGeneration: 4,
    };
    const {
      enqueuePublicMemoryIngestOutbox,
      hydrateOutboxIngestOptions,
    } = await import("../public-memory-ingest-outbox");

    await enqueuePublicMemoryIngestOutbox({
      tenantId: "org_1",
      sourcingRequestId: "request-1",
      candidates: [timed],
    });

    const rows = JSON.parse(String(executeRaw.mock.calls[0]?.[1]));
    expect(rows[0]?.payload.options).toEqual({
      profileObservedAt: observedAt.toISOString(),
      acquisitionGeneration: 4,
    });
    expect(
      hydrateOutboxIngestOptions(rows[0].payload.options),
    ).toEqual({
      profileObservedAt: observedAt,
      acquisitionGeneration: 4,
    });
  });

  it("refuses contradictory canonical receipts for one identity", async () => {
    const { dedupePublicMemoryOutboxInputs } = await import(
      "../public-memory-ingest-outbox"
    );
    expect(() =>
      dedupePublicMemoryOutboxInputs([
        input("alice", "11111111-1111-4111-8111-111111111111"),
        input("alice", "22222222-2222-4222-8222-222222222222"),
      ]),
    ).toThrow(/Conflicting Memory identity receipts/);
  });

  it("resets a prior dead receipt when the same request is retried", async () => {
    const { enqueuePublicMemoryIngestOutbox } = await import(
      "../public-memory-ingest-outbox"
    );
    await enqueuePublicMemoryIngestOutbox({
      tenantId: "org_1",
      sourcingRequestId: "request-1",
      candidates: [input("alice")],
    });

    const receiptSql = (
      executeRaw.mock.calls[1]?.[0] as TemplateStringsArray
    ).join(" ");
    expect(receiptSql).toContain(
      'ON CONFLICT ("sourcingRequestId", "signalCandidateId") DO UPDATE',
    );
    expect(receiptSql).toContain("\"status\" = 'pending'");
    expect(receiptSql).toContain('"terminalAt" = NULL');
    expect(receiptSql).toContain('"diagnosticsRecordedAt" = NULL');
  });

  it("fences link reconciliation to the selected generation and identity", async () => {
    const globalCandidateId = "11111111-1111-4111-8111-111111111111";
    queryRaw.mockResolvedValue([
      {
        id: "outbox-1",
        tenantId: "org_1",
        localCandidateId: "candidate-1",
        globalCandidateId,
        generation: 3,
        status: "succeeded",
        linkAttempts: 0,
      },
    ]);
    ensureCandidateGlobalLink.mockResolvedValue({
      candidateId: "candidate-1",
      created: true,
      raceResolved: false,
    });
    updateMany.mockResolvedValue({ count: 1 });
    const { reconcilePublicMemoryOutboxLinks } = await import(
      "../public-memory-ingest-outbox"
    );

    await reconcilePublicMemoryOutboxLinks();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "outbox-1",
          generation: 3,
          status: "succeeded",
          linkedAt: null,
          globalCandidateId,
          localCandidateId: "candidate-1",
        },
      }),
    );
  });

  it("fences a failed link retry from a re-enqueued generation", async () => {
    const globalCandidateId = "11111111-1111-4111-8111-111111111111";
    queryRaw.mockResolvedValue([
      {
        id: "outbox-1",
        tenantId: "org_1",
        localCandidateId: "candidate-1",
        globalCandidateId,
        generation: 4,
        status: "succeeded",
        linkAttempts: 2,
      },
    ]);
    ensureCandidateGlobalLink.mockRejectedValue(new Error("link failed"));
    updateMany.mockResolvedValue({ count: 1 });
    const { reconcilePublicMemoryOutboxLinks } = await import(
      "../public-memory-ingest-outbox"
    );

    await reconcilePublicMemoryOutboxLinks();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "outbox-1",
          generation: 4,
          status: "succeeded",
          linkedAt: null,
          globalCandidateId,
          localCandidateId: "candidate-1",
          linkAttempts: 2,
        },
      }),
    );
  });

  it("retains nonprivate market evidence in a compacted payload", async () => {
    const { compactPublicMemoryOutboxPayloads } = await import(
      "../public-memory-ingest-outbox"
    );
    await compactPublicMemoryOutboxPayloads();

    const sql = (executeRaw.mock.calls[0]?.[0] as TemplateStringsArray).join(
      " ",
    );
    expect(sql).toContain("'deliveryLag'");
    expect(sql).toContain("'coarseMarketKey'");
    expect(sql).toContain("'crustdataPersonId'");
  });
});
