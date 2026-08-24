import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileSummary } from "@/types/linkedin";

const prismaMock = vi.hoisted(() => {
  const database = {
    candidate: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  database.$transaction.mockImplementation(
    async (callback: (transaction: typeof database) => unknown) =>
      callback(database),
  );
  return database;
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  providerObservationIsOlder,
  resolveProviderObservedAt,
  upsertDiscoveredCandidates,
} from "../upsert-candidates";

describe("candidate provider freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the original observation time on delayed receipt replay", () => {
    const acquiredAt = new Date("2026-07-01T00:00:00.000Z");
    const retriedAt = new Date("2026-07-27T00:00:00.000Z");

    expect(
      resolveProviderObservedAt(null, acquiredAt, retriedAt),
    ).toEqual(acquiredAt);
  });

  it("does not regress a newer observation already in storage", () => {
    const acquiredAt = new Date("2026-07-01T00:00:00.000Z");
    const newerStoredAt = new Date("2026-07-20T00:00:00.000Z");

    expect(
      resolveProviderObservedAt(newerStoredAt, acquiredAt),
    ).toEqual(newerStoredAt);
    expect(providerObservationIsOlder(newerStoredAt, acquiredAt)).toBe(true);
  });

  it("re-reads after a concurrent write and cannot overwrite newer evidence", async () => {
    const originalStoredAt = new Date("2026-06-01T00:00:00.000Z");
    const acquiredAt = new Date("2026-07-01T00:00:00.000Z");
    const concurrentStoredAt = new Date("2026-07-02T00:00:00.000Z");
    const storedCandidate = {
      id: "candidate-a",
      nameHint: null,
      headlineHint: null,
      locationHint: null,
      companyHint: null,
      profilePictureUrl: null,
    };

    prismaMock.candidate.findFirst
      .mockResolvedValueOnce({
        ...storedCandidate,
        updatedAt: originalStoredAt,
      })
      .mockResolvedValueOnce({
        ...storedCandidate,
        updatedAt: concurrentStoredAt,
      });
    prismaMock.candidate.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await upsertDiscoveredCandidates(
      "org_1",
      [
        {
          linkedinUrl: "https://www.linkedin.com/in/example-person",
          linkedinId: "example-person",
          canonicalLinkedinId: "example-person",
          name: "Example Person",
          title: "Backend Engineer",
          snippet: "Python",
        } as ProfileSummary,
      ],
      "backend python",
      "crustdata",
      { providerObservedAt: acquiredAt, failOnError: true },
    );

    expect(result.get("example-person")).toBe("candidate-a");
    expect(prismaMock.candidate.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.candidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "candidate-a",
          tenantId: "org_1",
          updatedAt: originalStoredAt,
        }),
      }),
    );
    expect(prismaMock.candidate.findFirst).toHaveBeenCalledTimes(2);
  });

  it("keeps tenant-private provenance while applying observation ordering", async () => {
    const storedAt = new Date("2026-06-01T00:00:00.000Z");
    const acquiredAt = new Date("2026-07-01T00:00:00.000Z");
    prismaMock.candidate.findFirst.mockResolvedValue({
      id: "candidate-a",
      nameHint: "Example Person",
      headlineHint: "Backend Engineer",
      locationHint: "Bengaluru",
      companyHint: "Example Co",
      profilePictureUrl: null,
      updatedAt: storedAt,
    });
    prismaMock.candidate.updateMany.mockResolvedValue({ count: 1 });

    await upsertDiscoveredCandidates(
      "org_1",
      [
        {
          linkedinUrl: "https://www.linkedin.com/in/example-person",
          linkedinId: "example-person",
          canonicalLinkedinId: "example-person",
          name: "Example Person",
          title: "Private Memory result",
          snippet: "must not replace stored provenance",
          providerMeta: { private: true },
        } as ProfileSummary,
      ],
      "private-memory",
      "activegraph_private",
      {
        captureSource: "activegraph_private",
        preserveExistingProvenance: true,
        providerObservedAt: acquiredAt,
        failOnError: true,
      },
    );

    const data = prismaMock.candidate.updateMany.mock.calls[0]?.[0]?.data;
    expect(data.updatedAt).toEqual(acquiredAt);
    expect(data).not.toHaveProperty("searchTitle");
    expect(data).not.toHaveProperty("searchSnippet");
    expect(data).not.toHaveProperty("searchMeta");
    expect(data).not.toHaveProperty("searchProvider");
    expect(data).not.toHaveProperty("captureSource");
  });

  it("adopts a case-variant identity instead of retrying a conflicting create", async () => {
    const storedAt = new Date("2026-07-01T00:00:00.000Z");
    prismaMock.candidate.findFirst.mockResolvedValue({
      id: "candidate-existing",
      nameHint: "Example Person",
      headlineHint: "Backend Engineer",
      locationHint: "Bengaluru",
      companyHint: null,
      profilePictureUrl: null,
      updatedAt: storedAt,
    });
    prismaMock.candidate.updateMany.mockResolvedValue({ count: 1 });

    const result = await upsertDiscoveredCandidates(
      "org_1",
      [
        {
          linkedinUrl: "https://www.linkedin.com/in/example-person",
          linkedinId: "example-person",
          canonicalLinkedinId: "example-person",
          title: "Backend Engineer",
          snippet: "Python",
        } as ProfileSummary,
      ],
      "public_memory_hydration",
      "activegraph_public",
      {
        failOnError: true,
        adoptCaseVariantIdentity: true,
      },
    );

    expect(result.get("example-person")).toBe("candidate-existing");
    expect(prismaMock.candidate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: "org_1",
          linkedinId: {
            equals: "example-person",
            mode: "insensitive",
          },
        },
      }),
    );
    expect(prismaMock.candidate.create).not.toHaveBeenCalled();
  });
});
