import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import type { JobRequirements } from "../jd-digest";
import type { CrustdataSearchResult } from "../crustdata-client";
import {
  acquireCrustdataSearch,
  acquireCrustdataSearchForRequest,
  prismaCrustdataReceiptStore,
  buildCrustdataRequestFingerprint,
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
import {CrustdataNoDispatchError} from '../crustdata-rate-gate';
import * as rateGate from '../crustdata-rate-gate';
import * as authority from '../governed-authority';
import * as provider from '../crustdata-client';
import {artifactHash} from '../governed-contracts';

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
  async markNoDispatch(id:string):Promise<void>{
    const receipt=[...this.receipts.values()].find(row=>row.id===id);
    if(!receipt||receipt.status!=='started')throw Error('invalid no-dispatch');
    receipt.status='no_dispatch';
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
  vi.unstubAllEnvs();
});

describe('real governed acquisition branch with transport-only substitutes',()=>{
  function governedFixture(){
    vi.stubEnv('FLOW_SOURCING_V1_ENABLED','true');
    const id='10000000-0000-4000-8000-000000000001',hash='a'.repeat(64),events:string[]=[];
    const artifact={compilerVersion:'1',digestVersion:3,jobContext:{title:'Backend Engineer',location:'Bengaluru',jdDigest:'{}',skills:['Python'],goodToHaveSkills:[]},
      criterionMap:[{criterionId:id,use:'assessment',field:null}],briefVersionId:id,materialHash:hash,sourceHash:hash,digestBasisHash:hash,previewQueryHash:hash,queryHash:hash};
    artifact.queryHash=artifactHash(artifact as Parameters<typeof artifactHash>[0]);
    const binding={protocolVersion:1,flowRunId:id,organizationRef:'28',externalJobId:'vanta:jobs:147',briefVersionId:id,materialHash:hash,
      artifactHash:artifact.queryHash,compilerVersion:'1',queryArtifact:artifact,callbackUrl:'https://flow.example/api/webhooks/signal/callback'};
    let receipt:StoredReceipt|null=null;
    vi.spyOn(prisma.jobSourcingRequest,'findFirst').mockResolvedValue({jobContext:{}} as never);
    vi.spyOn(authority.GovernedRepository.prototype,'call').mockImplementation(async operation=>{
      if(operation==='execution')return binding;
      if(operation==='evidence')return receipt?.status==='complete'?{action:'receipt',state:'complete'}:null;
      if(operation==='grantTransition'){events.push('grant-check');return {};}
      throw Error('UNEXPECTED_QUERY');
    });
    const capacity=vi.spyOn(rateGate,'acquireCrustdataAccountCapacity').mockImplementation(async()=>{events.push('capacity');});
    vi.spyOn(prismaCrustdataReceiptStore,'find').mockImplementation(async()=>receipt);
    vi.spyOn(prismaCrustdataReceiptStore,'complete').mockImplementation(async(_id,result)=>{events.push('durable-complete');receipt!.status='complete';receipt!.result=result;});
    vi.spyOn(prisma,'$transaction').mockImplementation((async(fn:(transaction:unknown)=>Promise<unknown>)=>fn({
      crustdataAcquisitionReceipt:{create:async({data}:{data:Record<string,unknown>})=>{
        events.push('durable-start');receipt={id:'receipt-governed',status:'started',startedAt:new Date(),requestFingerprint:data.requestFingerprint as string,
          requestMetadata:data.requestMetadata,result:null,error:null,effectsAppliedAt:null,effectMetadata:null};return receipt;
      }},$queryRawUnsafe:async()=>{events.push('transaction-grant-start');return [];},
    })) as never);
    const send=vi.spyOn(authority,'sendFlowSourcingEvidence').mockImplementation(async(_binding,_identity,body)=>{
      if((body as {action:string}).action==='grant'){
        events.push('flow-grant');return {grantId:id,providerInputHash:buildCrustdataRequestFingerprint(input),expiresAt:new Date(Date.now()+60000).toISOString(),state:'issued'};
      }
      events.push('flow-receipt');return {};
    });
    const search=vi.spyOn(provider,'searchPeople').mockImplementation(async(_r,_l,options)=>{
      expect(options?.capacityAcquired).toBe(true);expect(options?.governed).toBe(true);
      await options?.beforeDispatch?.();events.push('http');return exactResult;
    });
    const input=acquisitionInput({executionFence:{acquisitionGeneration:1,executionAttemptId:id,processingLeaseId:id}});
    return{input,events,capacity,send,search};
  }
  it('obtains rate capacity before Flow grant, persists start before HTTP, then reports completion',async()=>{
    const f=governedFixture();await acquireCrustdataSearchForRequest(f.input);
    expect(f.events).toEqual(['capacity','flow-grant','grant-check','durable-start','transaction-grant-start','grant-check','http','durable-complete','flow-receipt']);
  });
  it('gate failure requests no grant and performs no purchase',async()=>{
    const f=governedFixture();f.capacity.mockRejectedValueOnce(new CrustdataNoDispatchError());
    await expect(acquireCrustdataSearchForRequest(f.input)).rejects.toBeInstanceOf(CrustdataNoDispatchError);
    expect(f.send).not.toHaveBeenCalled();expect(f.search).not.toHaveBeenCalled();
  });
  it('a lost accounting acknowledgement reuses the durable completed receipt, never purchasing again',async()=>{
    const f=governedFixture(),normal=f.send.getMockImplementation()!;
    let failed=false;
    f.send.mockImplementation(async(...args)=>{
      if((args[2] as {action:string}).action==='receipt'&&!failed){failed=true;throw Error('Flow unavailable');}
      return normal(...args);
    });
    await expect(acquireCrustdataSearchForRequest(f.input)).rejects.toMatchObject({code:'receipt_persistence_failed'});
    await acquireCrustdataSearchForRequest(f.input);
    expect(f.search).toHaveBeenCalledTimes(1);expect(f.capacity).toHaveBeenCalledTimes(1);
    expect(f.events.filter(e=>e==='durable-start')).toHaveLength(1);
  });
});

describe("request-scoped Crustdata acquisition receipts", () => {
  it('waits for rate capacity before reserving a receipt and never calls transport on gate failure',async()=>{
    const store=new InMemoryReceiptStore(),reserve=vi.spyOn(store,'reserve'),search=vi.fn();
    const beforeReserve=vi.fn(async()=>{expect(reserve).not.toHaveBeenCalled();throw new CrustdataNoDispatchError();});
    await expect(acquireCrustdataSearch(acquisitionInput(),{store,search,beforeReserve})).rejects.toBeInstanceOf(CrustdataNoDispatchError);
    expect(store.receipts.size).toBe(0);expect(search).not.toHaveBeenCalled();
  });
  it('retains a no-dispatch receipt without reporting uncertainty or retrying it as a purchase',async()=>{
    const store=new InMemoryReceiptStore(),search=vi.fn().mockRejectedValue(new CrustdataNoDispatchError()),uncertain=vi.spyOn(store,'markUncertain');
    await expect(acquireCrustdataSearch(acquisitionInput(),{store,search})).rejects.toMatchObject({code:'receipt_no_dispatch'});
    expect([...store.receipts.values()]).toMatchObject([{status:'no_dispatch'}]);
    expect(uncertain).not.toHaveBeenCalled();
    await expect(acquireCrustdataSearch(acquisitionInput(),{store,search})).rejects.toMatchObject({code:'receipt_no_dispatch'});
    expect(search).toHaveBeenCalledTimes(1);
  });
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
