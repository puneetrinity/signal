import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileSummary } from "@/types/linkedin";

const prismaMock = vi.hoisted(() => ({
  candidate: {
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
}));

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

    prismaMock.candidate.findUnique
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
    expect(prismaMock.candidate.findUnique).toHaveBeenCalledTimes(2);
  });
});
