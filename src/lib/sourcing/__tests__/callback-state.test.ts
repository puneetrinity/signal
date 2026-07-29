import { describe, expect, it } from "vitest";
import {
  buildCallbackStateWhere,
  buildStaleCallbackWhere,
} from "../callback";

describe("callback delivery state fencing", () => {
  it("fences writes to one processor lease", () => {
    expect(
      buildCallbackStateWhere(
        "request-a",
        "tenant-a",
        {
          acquisitionGeneration: 3,
          executionAttemptId: "attempt-a",
          processingLeaseId: "lease-a",
        },
        false,
      ),
    ).toEqual({
      id: "request-a",
      tenantId: "tenant-a",
      acquisitionGeneration: 3,
      executionAttemptId: "attempt-a",
      processingLeaseId: "lease-a",
    });
  });

  it("makes callback failure writes conditional on not being delivered", () => {
    expect(
      buildCallbackStateWhere(
        "request-a",
        "tenant-a",
        {
          acquisitionGeneration: 3,
          executionAttemptId: "attempt-a",
          processingLeaseId: "lease-a",
        },
        true,
      ),
    ).toMatchObject({
      OR: [
        { callbackStatus: null },
        { callbackStatus: { not: "delivered" } },
      ],
    });
  });

  it("recovers both failed and stranded pending completion callbacks", () => {
    const cutoff = new Date("2026-07-27T00:00:00.000Z");

    expect(buildStaleCallbackWhere(cutoff, "tenant-a")).toEqual({
      callbackStatus: { in: ["failed", "pending"] },
      status: "complete",
      completedAt: { lt: cutoff },
      tenantId: "tenant-a",
    });
  });
});
