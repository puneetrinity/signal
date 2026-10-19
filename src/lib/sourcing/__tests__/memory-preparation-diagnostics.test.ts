import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryPreparationFailure, memoryPreparationStage } from '../memory-preparation-diagnostics';
import { ImmutableMemoryRepository, prepareMemoryPacket } from '../immutable-memory-ingest';
import type { CandidateForRanking } from '../ranking-new';

const mocks = vi.hoisted(() => ({query:vi.fn(), execute:vi.fn(), transaction:vi.fn(), context:vi.fn(), proofs:vi.fn(), current:vi.fn()}));
vi.mock('@/lib/prisma', () => ({prisma:{$transaction:mocks.transaction,$queryRawUnsafe:mocks.query}}));
vi.mock('@/lib/candidate-privacy/decision', () => ({createCandidateAdmissionProofs:mocks.proofs}));
vi.mock('@/lib/candidate-privacy/repository', () => ({requireHealthyCandidatePrivacyContext:mocks.context,
  assertAdmissionProofCurrent:mocks.current,CANDIDATE_PRIVACY_ADMISSION_LOCK:'synthetic-lock'}));

const owner={tenantId:'org_32',sourcingRequestId:'synthetic-request',acquisitionReceiptId:'synthetic-purchase',
  acquisitionGeneration:1,acquisitionSlot:'exact' as const};
const fence={executionAttemptId:'synthetic-attempt',processingLeaseId:'synthetic-lease'};
const at=new Date('2026-10-19T00:00:00Z');
function packet(index:number, summary='Built software. '.repeat(200)) {
  return prepareMemoryPacket(owner, {id:`https://linkedin.com/in/synthetic-${index}`,searchSnippet:'Synthetic',
    crustdata:{crustdata_person_id:index+1,basic_profile:{name:'Synthetic Person',summary}}} as CandidateForRanking,
  {...owner,acquiredAt:at,profileObservedAt:at});
}

describe('safe Memory preparation diagnostics', () => {
  it.each([
    ['memory_packet_integrity','packet_integrity'],
    ['candidate_privacy_conflict','privacy_conflict'],
    ['candidate_privacy_unavailable','privacy_unavailable'],
    ['MEMORY_EXECUTION_STALE','execution_stale'],
    ['sourced_candidate_profile_field_too_large','profile_field_too_large'],
    ['sourced_candidate_private_value_refused','private_value_refused'],
  ])('classifies %s without raw error content', (message, reason) => {
    expect(memoryPreparationFailure(new Error(message))).toEqual({stage:'enqueue_input',reason});
  });
  it('keeps the deepest stage and rethrows the identical error', async () => {
    const error = Object.assign(new Error('sensitive SQL / candidate text'), {code:'P2028'});
    await expect(memoryPreparationStage('transaction', () => memoryPreparationStage('append', () => {
      throw error;
    }))).rejects.toBe(error);
    expect(memoryPreparationFailure(error)).toEqual({stage:'append',reason:'transaction_api_error',elapsedMs:expect.any(Number)});
  });
  it('reports transaction-level failure without claiming it proves a timeout', async () => {
    const error = Object.assign(new Error('private detail'), {code:'P2028'});
    await expect(memoryPreparationStage('transaction', () => {throw error;})).rejects.toBe(error);
    expect(memoryPreparationFailure(error).stage).toBe('transaction');
    expect(memoryPreparationFailure(error).reason).toBe('transaction_api_error');
  });
  it('reports a known SQLSTATE without exposing SQL or metadata', () => {
    const error = {code:'P2010',message:'secret',meta:{code:'42501',message:'candidate@example.test'}};
    expect(memoryPreparationFailure(error)).toEqual({stage:'enqueue_input',reason:'database_permission_denied'});
  });
  it.each([null, undefined, 'candidate@example.test', new Error('password=secret'),
    {code:'secret',message:'private',meta:{code:'private'},cause:new Error('secret')},
    new Error('constructor'), new Error('toString')])('does not serialize unknown errors %#', error => {
    expect(memoryPreparationFailure(error)).toEqual({stage:'enqueue_input',reason:'unexpected'});
  });
  it('does not alter successful results', async () => {
    const result={sealed:true};
    expect(await memoryPreparationStage('seal', () => result)).toBe(result);
  });
});

describe('actual preparation path with synthetic profiles and injected failures', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.context.mockResolvedValue({generation:BigInt(1),cursor:BigInt(0)});
    mocks.proofs.mockImplementation(async (anchors:Array<{key:string}>) =>
      new Map(anchors.map(a=>[a.key,{generation:BigInt(1),cursor:BigInt(0)}])));
    mocks.current.mockResolvedValue(undefined);
    mocks.execute.mockResolvedValue(1);
    mocks.query.mockImplementation(async (_sql:string,_owner:string,value:string) => {
      const command=JSON.parse(value);
      return [{result:command.action==='anchors'?[]:command.action==='read'?
        {sealed:true,members:[],manifestSha256:null,deadlineAt:null,memberCount:0}:null}];
    });
    mocks.transaction.mockImplementation(async fn => fn({$executeRawUnsafe:mocks.execute,$queryRawUnsafe:mocks.query}));
  });
  it('still uses 12 append batches and one seal for 300 profiles with unchanged transaction bounds', async () => {
    await new ImmutableMemoryRepository().prepare(owner,Array.from({length:300},(_,i)=>packet(i)),fence);
    const commands=mocks.query.mock.calls.map(call=>JSON.parse(call[2]));
    const appends=commands.filter(c=>c.action==='append');
    expect(appends).toHaveLength(12);
    expect(appends.every(c=>c.packets.length===25)).toBe(true);
    expect(commands.filter(c=>c.action==='seal')).toHaveLength(1);
    expect(mocks.transaction.mock.calls[0][1]).toEqual({maxWait:2000,timeout:5000});
  });
  it('labels a transaction failure during append, without continuing to seal or retrying', async () => {
    const error=Object.assign(new Error('sensitive SQL'),{code:'P2028'});
    mocks.query.mockRejectedValue(error);
    await expect(new ImmutableMemoryRepository().prepare(owner,[packet(0)],fence)).rejects.toBe(error);
    expect(memoryPreparationFailure(error)).toMatchObject({stage:'append',reason:'transaction_api_error'});
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
  it('labels a privacy refusal before starting a transaction', async () => {
    const error=new Error('candidate_privacy_conflict');
    mocks.proofs.mockRejectedValue(error);
    await expect(new ImmutableMemoryRepository().prepare(owner,[packet(0)],fence)).rejects.toBe(error);
    expect(memoryPreparationFailure(error)).toMatchObject({stage:'privacy_proofs',reason:'privacy_conflict'});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('keeps the in-transaction privacy generation fence', async () => {
    mocks.context.mockResolvedValueOnce({generation:BigInt(1),cursor:BigInt(0)}).mockResolvedValue({generation:BigInt(2),cursor:BigInt(0)});
    let failure:unknown;
    try {await new ImmutableMemoryRepository().prepare(owner,[packet(0)],fence);} catch(error){failure=error;}
    expect(memoryPreparationFailure(failure)).toMatchObject({stage:'privacy_recheck',reason:'privacy_conflict'});
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('a profile below 19 KB can still fail the real adapter field limit before any SQL', async () => {
    const summary='x'.repeat(8001);
    expect(Buffer.byteLength(JSON.stringify({basic_profile:{summary}}))).toBeLessThan(19000);
    let failure:unknown;
    try {await memoryPreparationStage('packet_build',()=>packet(0,summary));} catch(error){failure=error;}
    expect(memoryPreparationFailure(failure)).toMatchObject({stage:'packet_build',reason:'profile_field_too_large'});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
