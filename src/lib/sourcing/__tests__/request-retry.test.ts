import { describe, expect, it } from "vitest";
import { decideSourcingRetry,canResumeGovernedPurchase } from "../request-retry";

describe('bounded completed-purchase recovery',()=>{
  it('allows at most two redrives and preserves only completed purchase state',()=>{
    const exact={slot:'exact',status:'complete'};
    for(const receipts of [[exact],[exact,{slot:'spill',status:'complete'}]]){
      expect(canResumeGovernedPurchase(0,3,receipts)).toBe(true);
      expect(canResumeGovernedPurchase(1,3,receipts)).toBe(true);
      expect(canResumeGovernedPurchase(2,3,receipts)).toBe(false);
      expect(canResumeGovernedPurchase(2,100,receipts)).toBe(false);
    }
  });
  it.each(['started','uncertain','no_dispatch','released'])('never redrives an ambiguous or cancelled %s slot',status=>{
    expect(canResumeGovernedPurchase(0,3,[{slot:'exact',status}])).toBe(false);
    expect(canResumeGovernedPurchase(0,3,[{slot:'exact',status:'complete'},{slot:'spill',status}])).toBe(false);
    expect(canResumeGovernedPurchase(0,3,[])).toBe(false);
  });
});

describe("sourcing request acquisition generations", () => {
  it('never requeues a governed request through legacy refresh or force',()=>{
    for(const status of ['queued','processing','complete','failed']){
      for(const callbackStatus of [null,'pending','failed','delivered']){
        expect(decideSourcingRetry({status,callbackStatus,governed:true,refreshRequested:true,forceSourcingRequested:true}))
          .toEqual({retryable:false,startsNewAcquisition:false});
      }
    }
  });
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
