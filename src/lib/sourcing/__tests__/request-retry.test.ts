import { describe, expect, it } from "vitest";
import { decideSourcingRetry } from "../request-retry";

describe("sourcing request acquisition generations", () => {
  it("keeps the generation for a failed downstream retry", () => {
    expect(
      decideSourcingRetry({
        status: "failed",
        callbackStatus: null,
        refreshRequested: false,
        forceSourcingRequested: false,
      }),
    ).toEqual({ retryable: true, startsNewAcquisition: false });
  });

  it("keeps the generation when Flow force-retries a failed request", () => {
    expect(
      decideSourcingRetry({
        status: "failed",
        callbackStatus: null,
        refreshRequested: false,
        forceSourcingRequested: true,
      }),
    ).toEqual({ retryable: true, startsNewAcquisition: false });
  });

  it("keeps the generation when only downstream callback processing failed", () => {
    expect(
      decideSourcingRetry({
        status: "complete",
        callbackStatus: "failed",
        refreshRequested: false,
        forceSourcingRequested: true,
      }),
    ).toEqual({ retryable: true, startsNewAcquisition: false });
  });

  it("replays a callback-failed generation without requiring a force flag", () => {
    expect(
      decideSourcingRetry({
        status: "complete",
        callbackStatus: "failed",
        refreshRequested: false,
        forceSourcingRequested: false,
      }),
    ).toEqual({ retryable: true, startsNewAcquisition: false });
  });

  it("allows explicit refresh to recover an ambiguous failed generation", () => {
    expect(
      decideSourcingRetry({
        status: "failed",
        callbackStatus: null,
        refreshRequested: true,
        forceSourcingRequested: true,
      }),
    ).toEqual({ retryable: true, startsNewAcquisition: true });
  });

  it("allows explicit refresh after downstream callback processing failed", () => {
    expect(
      decideSourcingRetry({
        status: "complete",
        callbackStatus: "failed",
        refreshRequested: true,
        forceSourcingRequested: true,
      }),
    ).toEqual({ retryable: true, startsNewAcquisition: true });
  });

  it.each([
    { refreshRequested: true, forceSourcingRequested: false },
    { refreshRequested: false, forceSourcingRequested: true },
  ])("starts a new acquisition for an explicit terminal rerun", (flags) => {
    expect(
      decideSourcingRetry({
        status: "complete",
        callbackStatus: "delivered",
        ...flags,
      }),
    ).toEqual({ retryable: true, startsNewAcquisition: true });
  });

  it.each([
    { status: "queued", callbackStatus: null },
    { status: "processing", callbackStatus: null },
    { status: "complete", callbackStatus: "pending" },
  ])(
    "does not supersede an active execution or pending completion callback",
    ({ status, callbackStatus }) => {
      expect(
        decideSourcingRetry({
          status,
          callbackStatus,
          refreshRequested: true,
          forceSourcingRequested: true,
        }),
      ).toEqual({ retryable: false, startsNewAcquisition: false });
    },
  );
});
