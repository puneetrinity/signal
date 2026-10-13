import {describe,it,expect,vi} from 'vitest';
import {retryRankingBusy,RANKING_RETRY,type RetryClock} from '../contention';
import {RankingRepository} from '../repository';
import {adaptProfile} from '../evidence';
import {createRankingContract} from '../contracts';
const mocks=vi.hoisted(()=>({calls:[] as string[],allowed:vi.fn(async(_tenant:string,ids:string[])=>ids)}));
vi.mock('@/lib/candidate-privacy/repository',()=>({filterCandidateIdsBeforeLimit:mocks.allowed}));
vi.mock('@/lib/candidate-privacy/config',()=>({loadCandidatePrivacyConfig:()=>({staleMs:60000})}));
vi.mock('@/lib/prisma',()=>({prisma:{$transaction:async(fn:(tx:unknown)=>Promise<unknown>,options:unknown)=>{
 mocks.calls.push('begin:'+JSON.stringify(options));
 try{return await fn({$executeRawUnsafe:async(sql:string,...args:unknown[])=>{mocks.calls.push(sql+JSON.stringify(args));},
  $queryRawUnsafe:async(sql:string)=>{mocks.calls.push(sql);return[{result:{state:'ready'}}];}});}
 finally{mocks.calls.push('end');}
}}}));
function fake(){let now=0;const sleeps:number[]=[];const clock:RetryClock={now:()=>now,sleep:async ms=>{now+=ms;sleeps.push(ms);},random:()=>0};return{clock,sleeps,advance:(ms:number)=>{now+=ms;}};}
describe('bounded ranking contention, no durable takeover',()=>{
 it('backs off only on exact busy then returns the original successful value',async()=>{
  const f=fake();let calls=0;const ready={state:'ready'};
  expect(await retryRankingBusy('claim',async()=>++calls<5?{state:'busy',phase:'claim'}:ready,f.clock)).toBe(ready);
  expect(f.sleeps).toEqual([250,500,1000,2000]);expect(calls).toBe(5);
 });
 it('does not retry a lost response, statement timeout, stale lease or any exception',async()=>{
  for(const message of ['network','statement timeout','RANKING_LEASE_STALE']){
   const f=fake();let calls=0;
   await expect(retryRankingBusy('finish',async()=>{calls++;throw Error(message);},f.clock)).rejects.toThrow(message);
   expect(calls).toBe(1);expect(f.sleeps).toEqual([]);
  }
 });
 it('does not confuse reprepare or null with a lock collision',async()=>{
  for(const value of [null,{state:'reprepare',phase:'claim'}]){
   const f=fake();expect(await retryRankingBusy('claim',async()=>value,f.clock)).toBe(value);expect(f.sleeps).toEqual([]);
  }
 });
 it('refuses incorrect phases and extra data in a busy response',async()=>{
  for(const value of [{state:'busy',phase:'finish'},{state:'busy',phase:'claim',written:true}])
   await expect(retryRankingBusy('claim',async()=>value,fake().clock)).rejects.toThrow('RANKING_INVALID_BUSY');
 });
 it('bounds collision count without modifying paid-run attempts',async()=>{
  let calls=0;const f=fake();
  await expect(retryRankingBusy('finish',async()=>{calls++;return{state:'busy',phase:'finish'};},f.clock)).rejects.toThrow('RANKING_CONTENTION_EXHAUSTED');
  expect(calls).toBe(RANKING_RETRY.maxBusy);expect(f.sleeps.length).toBe(calls-1);
 });
 it('counts SQL time as well as sleep time against the elapsed retry budget',async()=>{
  const f=fake();let calls=0;
  await expect(retryRankingBusy('claim',async()=>{calls++;f.advance(20_000);return{state:'busy',phase:'claim'};},f.clock)).rejects.toThrow('RANKING_CONTENTION_EXHAUSTED');
  expect(calls).toBe(1);expect(f.sleeps).toEqual([]);
 });
 it('sets real timeouts and configured privacy age before the routine, without an outer lock',async()=>{
  mocks.calls.length=0;
  const repo=new RankingRepository() as unknown as {call:(operation:'claim',args:unknown[])=>Promise<unknown>};
  await repo.call('claim',['org_1','10000000-0000-4000-8000-000000000001',{}]);
  expect(mocks.calls[0]).toBe('begin:{"maxWait":2000,"timeout":35000}');
  expect(mocks.calls[1]).toContain("SET LOCAL statement_timeout='30s'");
  expect(mocks.calls[2]).toContain("SET LOCAL lock_timeout='2s'");
  expect(mocks.calls[3]).toContain('signal.ranking_privacy_max_age_ms');expect(mocks.calls[3]).toContain('60000');
  expect(mocks.calls[4]).toContain('signal_ranking_claim');expect(mocks.calls.at(-1)).toBe('end');
  expect(mocks.calls.join('\n')).not.toContain('pg_advisory');
 });
 it('bounds privacy re-preparation rather than searching or enriching again',async()=>{
  const id='10000000-0000-4000-8000-000000000001';
  const contract=createRankingContract(id,'a'.repeat(64),{schemaVersion:2,compilerVersion:2,taxonomyVersion:2,criteria:[{
   id,label:'Role',class:'preferred',subject:'title',requirement:{kind:'accepted_titles',values:['Engineer']},
   use:'assessment',evidenceKinds:['profile_evidence'],provenance:{kind:'recruiter_edit'}}]});
  const evidence=adaptProfile({candidateId:'candidate-a',organizationRef:'1',profile:{},sourceVersion:'fixture',observedAt:'2020-01-01T00:00:00.000Z'});
  let calls=0;
  const repo=new RankingRepository(async()=>{calls++;return[{result:{state:'reprepare',phase:'claim'}}];});
  await expect(repo.publish({tenantId:'org_1',flowRunId:id,contract,executionAttemptId:id,processingLeaseId:id,
   evidence:[evidence],sourceTypes:new Map([['candidate-a','pool']])})).rejects.toThrow('RANKING_PRIVACY_REPREPARE_EXHAUSTED');
  expect(calls).toBe(3);expect(mocks.allowed).toHaveBeenCalledTimes(2);
 });
});
