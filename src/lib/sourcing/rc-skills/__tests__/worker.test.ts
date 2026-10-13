import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {adaptProfile} from '../../rubric/evidence';
import {rankingHash} from '../../rubric/contracts';
import {createObservation,rcValidUntil} from '../contracts';
import {rcPublicIdentities} from '../membership';
import {freezeRcBaseline,runRcTick,sealedRcEvidence} from '../worker';
import {rcSnapshotSchema,type RcBaseline,type RcRepository,type RcSnapshot} from '../repository';
import {RcMemoryError} from '../memory';

const now=Date.parse('2026-10-08T00:00:00Z'),flow=randomUUID(),run=randomUUID(),globalId=randomUUID();
const identity={tenantId:'org_1',flowRunId:flow,executionAttemptId:'execution',processingLeaseId:'lease'};
function baseline():RcBaseline{
 const identities=rcPublicIdentities([{candidateId:'a',globalCandidateId:globalId,url:'https://linkedin.com/in/a'}]);
 return {version:1,asOf:new Date(now).toISOString(),identities,cache:[],withheld:[],
  evidence:[adaptProfile({candidateId:'a',organizationRef:'1',profile:{skills:['Java']},sourceVersion:'fixture',observedAt:'2020-01-01T00:00:00.000Z'})]};
}
function observation(){
 return createObservation({version:1,outcome:'success',identityHash:baseline().identities[0].identityHash,skills:['AWS'],
  upstreamAt:'2026-01-01T00:00:00Z',observedAt:new Date(now-1000).toISOString(),validUntil:rcValidUntil('2026-01-01T00:00:00Z'),timestampSource:'check_last_update'});
}
function snapshot(base:RcBaseline|null=baseline()):RcSnapshot{
 return rcSnapshotSchema.parse({version:1,runId:run,revision:'0',state:base?'prepared':'admitted',baseline:base,baselineHash:base?rankingHash(base):null,
  deadlineAt:new Date(now+300000).toISOString(),sealedAt:null,outcomeSetHash:null,rcAvailable:true,
  members:base?[{candidateId:'a',identityHash:base.identities[0].identityHash,receiptId:'r',state:'pending'}]:[],attempts:[],
  progress:{version:1,state:'enriching_skills',processed:0,total:base?1:0,updatedAt:new Date(now).toISOString(),notificationDelivered:false,safeReason:'working'}});
}
function mocks(){return {read:vi.fn(),prepare:vi.fn(),claim:vi.fn(),dispatch:vi.fn(),finish:vi.fn(),seal:vi.fn(),skipCache:vi.fn()};}
describe('RC bounded worker recovery',()=>{
 it('does not advance to provider work when baseline preparation times out',async()=>{
  const repo=mocks();repo.read.mockResolvedValue(snapshot(null));repo.prepare.mockRejectedValue(Error('canceling statement due to statement timeout'));
  const memory={read:vi.fn().mockResolvedValue([{globalCandidateId:globalId,state:'missing',observation:null}])};
  await expect(freezeRcBaseline({identity,baseline:baseline(),receiptIds:['receipt'],repository:repo as any,memory:memory as any,now:()=>now})).rejects.toThrow('statement timeout');
  expect(repo.claim).not.toHaveBeenCalled();expect(repo.dispatch).not.toHaveBeenCalled();expect(repo.finish).not.toHaveBeenCalled();
 });
 it('drops a Memory-restricted person before any lookup even if local privacy is stale',async()=>{
  const b=baseline(),repo=mocks(),frozen={...b,identities:[],evidence:[]};
  repo.read.mockResolvedValueOnce(snapshot(null)).mockResolvedValueOnce({ ...snapshot(),baseline:frozen,baselineHash:rankingHash(frozen),members:[] });
  const memory={read:vi.fn(async()=>[{globalCandidateId:globalId,state:'restricted' as const,observation:null}]),finish:vi.fn()};
  await freezeRcBaseline({identity,repository:repo,baseline:b,receiptIds:['r'],memory,now:()=>now});
  expect(repo.prepare).toHaveBeenCalledWith(identity,['r'],frozen);
  expect(repo.dispatch).not.toHaveBeenCalled();expect(repo.skipCache).not.toHaveBeenCalled();
 });
 it('freezes Memory skills for both new and Memory-only public identities without a provider',async()=>{
  const b=baseline(),repo=mocks(),cached=observation(),frozen={...b,cache:[{identityHash:cached.identityHash,observation:cached}]};
  repo.read.mockResolvedValueOnce(snapshot(null)).mockResolvedValueOnce(snapshot(frozen));
  const memory={read:vi.fn(async()=>[{globalCandidateId:globalId,state:'available' as const,observation:cached}]),finish:vi.fn()};
  const result=await freezeRcBaseline({identity,repository:repo as unknown as RcRepository,baseline:b,receiptIds:['r'],memory,now:()=>now});
  expect(result.baseline?.cache).toEqual(frozen.cache);expect(memory.finish).not.toHaveBeenCalled();
  expect(repo.prepare).toHaveBeenCalledWith(identity,['r'],frozen);
 });
 it('resumes the frozen snapshot without re-reading Memory',async()=>{
  const repo=mocks(),frozen=snapshot();repo.read.mockResolvedValue(frozen);
  const memory={read:vi.fn(),finish:vi.fn()};
  expect(await freezeRcBaseline({identity,repository:repo as unknown as RcRepository,baseline:baseline(),receiptIds:['r'],memory})).toBe(frozen);
  expect(memory.read).not.toHaveBeenCalled();expect(repo.prepare).not.toHaveBeenCalled();
 });
 it('does not convert a failed Memory read into paid work',async()=>{
  const repo=mocks();repo.read.mockResolvedValue(snapshot(null));
  const memory={read:vi.fn(async()=>{throw Error('RC_MEMORY_UNAVAILABLE');}),finish:vi.fn()};
  await expect(freezeRcBaseline({identity,repository:repo as unknown as RcRepository,baseline:baseline(),receiptIds:['r'],memory})).rejects.toThrow('RC_MEMORY_UNAVAILABLE');
  expect(repo.prepare).not.toHaveBeenCalled();expect(repo.claim).not.toHaveBeenCalled();
 });
 it('never touches the provider on a sealed replay',async()=>{
  const repo=mocks(),sealed={...snapshot(),sealedAt:new Date(now).toISOString(),outcomeSetHash:'a'.repeat(64)};
  repo.read.mockResolvedValue(sealed);const provider=vi.fn(),privacyCursor=vi.fn();
  expect(await runRcTick({identity,repository:repo as unknown as RcRepository,provider,privacyCursor,now:()=>now})).toEqual({state:'sealed',snapshot:sealed});
  expect(provider).not.toHaveBeenCalled();expect(privacyCursor).not.toHaveBeenCalled();expect(repo.claim).not.toHaveBeenCalled();
 });
 it('a cache outage skips RC without treating unknown cache state as paid misses',async()=>{
  const repo=mocks(),b=baseline();
  repo.read.mockResolvedValueOnce(snapshot(null)).mockResolvedValueOnce({...snapshot(b),rcAvailable:false});
  const memory={read:vi.fn(async()=>{throw new RcMemoryError('unavailable',true);}),finish:vi.fn()};
  const result=await freezeRcBaseline({identity,repository:repo,baseline:b,receiptIds:['r'],memory});
  expect(repo.skipCache).toHaveBeenCalledWith(identity);expect(result.rcAvailable).toBe(false);
  expect(repo.prepare).toHaveBeenCalledWith(identity,['r'],{...b,cache:[]});
  expect(repo.dispatch).not.toHaveBeenCalled();
 });
 it('never dispatches a recorded in-flight attempt again on restart',async()=>{
  const repo=mocks(),s=snapshot(),attemptId=randomUUID();
  s.attempts=[{id:attemptId,identityHash:s.members[0].identityHash,operation:'CHECK',ordinal:1,state:'dispatched',dispatchAt:new Date(now-1000).toISOString(),outcomeHash:null,outcome:null,possibleCredits:0}];
  repo.read.mockResolvedValue(s);repo.claim.mockResolvedValue({version:1,state:'existing',attemptId,attemptState:'dispatched'});
  const provider=vi.fn();expect((await runRcTick({identity,repository:repo as unknown as RcRepository,provider,privacyCursor:vi.fn(),now:()=>now})).state).toBe('waiting');
  expect(provider).not.toHaveBeenCalled();expect(repo.dispatch).not.toHaveBeenCalled();
 });
 it('records missing provider configuration without creating a paid dispatch',async()=>{
  const repo=mocks(),s=snapshot(),attemptId=randomUUID();
  repo.read.mockResolvedValue(s);
  repo.claim.mockResolvedValue({version:1,state:'new',attemptId,attemptState:'reserved'});
  const provider=vi.fn(()=>{throw Error('RC_CONFIGURATION_INVALID');});
  await runRcTick({identity,repository:repo,provider,privacyCursor:vi.fn(),now:()=>now});
  expect(repo.dispatch).not.toHaveBeenCalled();
  expect(repo.finish).toHaveBeenCalledWith(identity,attemptId,expect.objectContaining({
   observedCredits:0,observation:null,outcome:expect.objectContaining({kind:'failed',safeCode:'unauthorized',retryableFree:false}),
  }));
 });
 it('keeps missing skills unknown and adds cached skill evidence without replacing candidate facts',()=>{
  const b=baseline(),obs=observation();b.cache=[{identityHash:obs.identityHash,observation:obs}];
  const s={...snapshot(b),sealedAt:new Date(now).toISOString(),outcomeSetHash:'a'.repeat(64)};
  expect(sealedRcEvidence(s).evidence[0].facts.map(f=>f.value).sort()).toEqual(['aws','java']);
  const bare={...snapshot(),sealedAt:new Date(now).toISOString(),outcomeSetHash:'a'.repeat(64)};
  expect(sealedRcEvidence(bare).evidence[0].facts.map(f=>f.value)).toEqual(['java']);
 });
});
