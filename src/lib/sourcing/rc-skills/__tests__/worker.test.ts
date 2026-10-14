import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {adaptProfile} from '../../rubric/evidence';
import {rankingHash} from '../../rubric/contracts';
import {createObservation,rcValidUntil} from '../contracts';
import {rcPublicIdentities} from '../membership';
import {freezeRcBaseline,runRcTick,sealedRcEvidence} from '../worker';
import {rcSnapshotSchema,RcRepository,type RcBaseline,type RcSnapshot} from '../repository';
import {RcMemoryError} from '../memory';
import {RcProviderError} from '../provider';

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
describe('execution-local compact RC reads',()=>{
 it('reads and validates the full baseline once, keeps it immutable, and fences every status call',async()=>{
  const s=snapshot(),query=vi.fn(async(sql:string,args:unknown[])=>{
   if((args[2] as any).action==='baseline')return [{result:s}];
   expect(args[2]).toEqual({version:1,action:'status',executionAttemptId:'execution',processingLeaseId:'lease',baselineHash:s.baselineHash});
   return [{result:{...s,baseline:null}}];
  }),repo=new RcRepository(query);
  const first=await repo.readWork(identity),second=await repo.readWork(identity);
  expect(query.mock.calls.filter(([,args])=>(args[2] as any).action==='baseline')).toHaveLength(1);
  expect(query.mock.calls.filter(([,args])=>(args[2] as any).action==='status')).toHaveLength(2);
  expect(first!.baseline).toBe(second!.baseline);
  expect(()=>first!.baseline!.identities.pop()).toThrow();
  expect(()=>{first!.revision='900';}).toThrow();
  await repo.readWork({...identity,processingLeaseId:'changed'}).catch(()=>{});
  expect(query.mock.calls.filter(([,args])=>(args[2] as any).action==='baseline')).toHaveLength(2);
 });
 it.each(['run','baseline','revision','full_payload'] as const)('rejects changed %s in compact status',async change=>{
  const s={...snapshot(),revision:'5'},compact={...s,baseline:null} as RcSnapshot;
  if(change==='run')compact.runId=randomUUID();
  if(change==='baseline')compact.baselineHash='b'.repeat(64);
  if(change==='revision')compact.revision='4';
  if(change==='full_payload')compact.baseline=s.baseline;
  const repo=new RcRepository(async(_sql,args)=>[{result:(args[2] as any).action==='baseline'?s:compact}]);
  await expect(repo.readWork(identity)).rejects.toThrow('RC_WORK_CONFLICT');
 });
 it('fetches each committed observation once and checks its identity and hash binding',async()=>{
  const s=snapshot(),obs=observation(),attemptId=randomUUID(),outcomeHash='a'.repeat(64);
  const outcome={kind:'cached',upstreamAt:obs.upstreamAt,retryableFree:false,safeCode:'ok',
   quota:{minuteLimit:null,minuteLeft:null,resetAt:null,retryAfterMs:null,dailyLeft:null},observation:obs};
  const status={...s,baseline:null,attempts:[{id:attemptId,identityHash:s.members[0].identityHash,operation:'FETCH',ordinal:1,
   state:'no_dispatch',dispatchAt:null,outcomeHash,outcome:null,possibleCredits:0}]};
  const query=vi.fn(async(sql:string,args:unknown[])=>[{result:(args[2] as any).action==='baseline'?s:
   (args[2] as any).action==='status'?status:{version:1,observations:[{attemptId,outcomeHash,outcome}]}}]);
  const repo=new RcRepository(query),first=await repo.readWork(identity),second=await repo.readWork(identity);
  expect(first!.attempts[0].outcome).toEqual(outcome);expect(first!.attempts[0].outcome).toBe(second!.attempts[0].outcome);
  expect(query.mock.calls.filter(([,args])=>(args[2] as any)?.action==='observations')).toHaveLength(1);
  status.attempts[0].outcomeHash='b'.repeat(64);
  await expect(repo.readWork(identity)).rejects.toThrow('RC_OUTCOME_CONFLICT');
 });
 it.each(['missing','duplicate','wrong_id','wrong_hash','wrong_identity'] as const)('refuses %s observation replies',async variant=>{
  const s=snapshot(),obs=observation(),attemptId=randomUUID(),outcomeHash='a'.repeat(64);
  const outcome={kind:'cached',upstreamAt:obs.upstreamAt,retryableFree:false,safeCode:'ok',
   quota:{minuteLimit:null,minuteLeft:null,resetAt:null,retryAfterMs:null,dailyLeft:null},observation:obs};
  if(variant==='wrong_identity'){
   const {contentHash:_,...body}=obs;outcome.observation=createObservation({...body,identityHash:'b'.repeat(64)});
  }
  const item={attemptId:variant==='wrong_id'?randomUUID():attemptId,outcomeHash:variant==='wrong_hash'?'b'.repeat(64):outcomeHash,outcome};
  const status={...s,baseline:null,attempts:[{id:attemptId,identityHash:s.members[0].identityHash,operation:'FETCH',ordinal:1,
   state:'no_dispatch',dispatchAt:null,outcomeHash,outcome:null,possibleCredits:0}]};
  const repo=new RcRepository(async(sql,args)=>[{result:(args[2] as any).action==='baseline'?s:
   (args[2] as any).action==='status'?status:{version:1,observations:variant==='missing'?[]:variant==='duplicate'?[item,item]:[item]}}]);
  await expect(repo.readWork(identity)).rejects.toThrow();
 });
});
describe('RC bounded worker recovery',()=>{
 it('refills direct-fetch slots without waiting for the slowest call and caps active calls at twenty',async()=>{
  const repo=mocks(),s={...snapshot(),protocolMode:2 as const};
  s.baseline!.identities=Array.from({length:21},(_,i)=>({candidateId:String(i),globalCandidateId:randomUUID(),
   url:`https://linkedin.com/in/p${i}`,identityHash:String(i).padStart(64,'0')}));
  s.members=s.baseline!.identities.map(p=>({candidateId:p.candidateId,identityHash:p.identityHash,receiptId:'r',state:'pending'}));
  repo.read.mockResolvedValue(s);repo.claim.mockImplementation(async(_id,hash)=>({state:'reserved',attemptId:hash,attemptState:'reserved'}));
  repo.dispatch.mockImplementation(async(_id,attemptId)=>({state:'granted',attemptId,deadlineAt:s.deadlineAt,maximumCredits:1}));
  let release!:()=>void,started21!:()=>void,active=0,peak=0,count=0,slowFinished=false;
  const slow=new Promise<void>(resolve=>{release=resolve;}),refilled=new Promise<void>(resolve=>{started21=resolve;});
  const client={check:vi.fn(),fetchSkills:vi.fn(async(url:string)=>{
   active++;peak=Math.max(peak,active);if(++count===21)started21();
   if(url.endsWith('/p0')){await slow;slowFinished=true;}else await Promise.resolve();active--;
   return {outcome:'not_found',upstreamAt:null,skills:[],quota:{creditsConsumed:0,minuteLimit:500,minuteLeft:499,resetAt:null,dailyLeft:null}};
  })};
  const tick=runRcTick({identity,repository:repo,provider:()=>client as any,privacyCursor:async()=>0,now:()=>now});
  try{await refilled;expect(count).toBe(21);expect(slowFinished).toBe(false);expect(peak).toBeLessThanOrEqual(20);}
  finally{release();await tick;}
  expect(repo.finish).toHaveBeenCalledTimes(21);expect(client.check).not.toHaveBeenCalled();
 });
 it.each(['success','no_skills','not_found','unusable_age'] as const)('direct fetch records %s without a check',async outcome=>{
  const repo=mocks(),s={...snapshot(),protocolMode:2 as const},attemptId=randomUUID();
  repo.read.mockResolvedValue(s);repo.claim.mockResolvedValue({state:'reserved',attemptId,attemptState:'reserved'});
  repo.dispatch.mockResolvedValue({state:'granted',attemptId,deadlineAt:s.deadlineAt,maximumCredits:1});
  const upstreamAt=outcome==='not_found'?null:'2026-01-01T00:00:00Z';
  const client={check:vi.fn(),fetchSkills:vi.fn().mockResolvedValue({outcome,upstreamAt,skills:outcome==='success'?['Rust']:[],
   quota:{minuteLimit:500,minuteLeft:499,resetAt:null,dailyLeft:null,creditsConsumed:outcome==='not_found'?0:1}})};
  await runRcTick({identity,repository:repo,provider:()=>client as any,privacyCursor:async()=>0,now:()=>now});
  expect(repo.claim).toHaveBeenCalledWith(identity,s.members[0].identityHash,'FETCH');
  expect(client.check).not.toHaveBeenCalled();expect(client.fetchSkills).toHaveBeenCalledExactlyOnceWith(s.baseline!.identities[0].url,Date.parse(s.deadlineAt!),1,'direct');
  expect(repo.finish).toHaveBeenCalledWith(identity,attemptId,expect.objectContaining({observation:expect.objectContaining({outcome,timestampSource:'fetch_updated_at'})}));
 });
 it('direct mode finishes cached observations without dispatching or constructing a provider',async()=>{
  const base=baseline(),cached=observation();base.cache=[{identityHash:cached.identityHash,observation:cached}];
  const repo=mocks(),s={...snapshot(base),protocolMode:2 as const},attemptId=randomUUID(),provider=vi.fn();
  repo.read.mockResolvedValue(s);repo.claim.mockResolvedValue({state:'reserved',attemptId,attemptState:'reserved'});
  await runRcTick({identity,repository:repo,provider,privacyCursor:vi.fn(),now:()=>now});
  expect(repo.finish).toHaveBeenCalledWith(identity,attemptId,expect.objectContaining({observation:cached,observedCredits:0,outcome:expect.objectContaining({kind:'cached'})}));
  expect(repo.dispatch).not.toHaveBeenCalled();expect(provider).not.toHaveBeenCalled();
 });
 it.each([false,true])('keeps unproven rate-limit rejection uncertain, including self-asserted proof=%s',assertedProof=>{
  return (async()=>{
  const repo=mocks(),s={...snapshot(),protocolMode:2 as const},attemptId=randomUUID();
  repo.read.mockResolvedValue(s);repo.claim.mockResolvedValue({state:'reserved',attemptId,attemptState:'reserved'});
  repo.dispatch.mockResolvedValue({state:'granted',attemptId,deadlineAt:s.deadlineAt,maximumCredits:1});
  const proof=assertedProof?{version:1 as const,kind:'rc_429_uncharged' as const,httpStatus:429 as const,
   providerCode:'synthetic-unpaid-429',policyVersion:'fixture-only-v1',creditsConsumed:0 as const,
   requestIdHash:'c'.repeat(64),retryAfterAt:new Date(now+1000).toISOString()}:null;
  const client={check:vi.fn(),fetchSkills:vi.fn().mockRejectedValue(new RcProviderError('rate_limited',true,1000,0,proof))};
  await runRcTick({identity,repository:repo,provider:()=>client as any,privacyCursor:async()=>0,now:()=>now});
  expect(client.fetchSkills).toHaveBeenCalledTimes(1);
  expect(repo.finish).toHaveBeenCalledWith(identity,attemptId,expect.objectContaining({observation:null,outcome:expect.objectContaining({kind:'uncertain',retryableFree:false})}));
  })();
 });
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
