import {createRcFinish,createObservation,observationSchema,rcValidUntil,approvedRcFreeRejection,type SkillObservation,type RcFinish} from './contracts';
import {RC_LIMITS} from './config';
import { timedSourcingFunction, measureSourcingStage } from '../stage-timings';
import {RcProviderError,type createRcProvider,type CheckResult,type FetchResult} from './provider';
import {rcBaselineSchema,type RcBaseline,type RcRepository,type RcSnapshot,type RcWorkerIdentity} from './repository';
import type {RcWorkSnapshot} from './rc-compute-worker';
import {RcMemoryError,type RcMemoryClient} from './memory';
export {mergeSealedRcEvidence as sealedRcEvidence} from './evidence';
import type {RankingContract} from '../rubric/contracts';
import type {RankingRead} from '../rubric/repository';

type Repository=Pick<RcRepository,'read'|'claim'|'dispatch'|'finish'|'seal'|'prepare'|'skipCache'>&Partial<Pick<RcRepository,'readWork'|'beginPreparation'|'finishPreparation'>>;
type Provider=ReturnType<typeof createRcProvider>;
const emptyQuota={minuteLimit:null,minuteLeft:null,resetAt:null,retryAfterMs:null,dailyLeft:null};
type OutcomeKind=RcFinish['outcome']['kind'];
type SafeCode=RcFinish['outcome']['safeCode'];
function finish(kind:OutcomeKind,upstreamAt:string|null,observation:SkillObservation|null,credits:number|null,
 code:SafeCode='ok',quota:RcFinish['outcome']['quota']=emptyQuota,retryableFree=false):RcFinish {
 return createRcFinish({version:1,outcome:{kind,upstreamAt,retryableFree,safeCode:code,quota},observation,observedCredits:credits});
}
function providerQuota(result:CheckResult|FetchResult):RcFinish['outcome']['quota'] {
 return {minuteLimit:result.quota.minuteLimit,minuteLeft:result.quota.minuteLeft,resetAt:result.quota.resetAt,
  retryAfterMs:null,dailyLeft:result.quota.dailyLeft};
}

/** Read reusable observations before freezing the first RC stage snapshot. No
 * provider call occurs here. Once prepare commits, retries use only that frozen
 * cache view: late cache writes never reshuffle the published list. */
export const freezeRcBaseline = timedSourcingFunction('rc_preparation', freezeRcBaselineMeasured);
async function freezeRcBaselineMeasured(input:{identity:RcWorkerIdentity;baseline:RcBaseline;receiptIds:string[];
 repository:Repository;memory:RcMemoryClient;now?:()=>number}):Promise<RcWorkSnapshot> {
 const read=()=>input.repository.readWork?input.repository.readWork(input.identity):input.repository.read(input.identity.tenantId,input.identity.flowRunId);
 const resumed=await read();
 if(!resumed)throw Error('RC_ADMISSION_REQUIRED');
 if(resumed.baseline)return resumed;
 const ownedPreparation=!!input.repository.beginPreparation&&!!input.repository.finishPreparation;
 const baseline=ownedPreparation?await input.repository.beginPreparation!(input.baseline):rcBaselineSchema.parse(input.baseline);
 if(baseline.cache.length)throw Error('RC_UNVERIFIED_CACHE_INPUT');
 const cache:RcBaseline['cache']=[],now=(input.now??Date.now)();
 const restricted=new Set<string>();
 try{for(let offset=0;offset<baseline.identities.length;offset+=100){
  const chunk=baseline.identities.slice(offset,offset+100);
  // A cache health failure is not evidence of absent skills and must not trigger
  // another paid lookup. A recognized transport/config failure skips RC below.
  const items=await input.memory.read(input.identity.tenantId,chunk.map(i=>i.globalCandidateId));
  const expected=new Map(chunk.map(i=>[i.globalCandidateId,i]));
  if(items.length!==chunk.length||new Set(items.map(i=>i.globalCandidateId)).size!==chunk.length)throw Error('RC_CACHE_CONFLICT');
  for(const item of items){
   const identity=expected.get(item.globalCandidateId);if(!identity)throw Error('RC_CACHE_CONFLICT');
   if(item.state==='restricted'){restricted.add(identity.candidateId);continue;}
   if(!item.observation)continue;
   const observation=observationSchema.parse(item.observation);
   if(observation.identityHash!==identity.identityHash)throw Error('RC_CACHE_CONFLICT');
   if(observation.outcome==='success'&&(observation.validUntil===null||Date.parse(observation.validUntil)<now||Date.parse(observation.observedAt)>now))continue;
   cache.push({identityHash:identity.identityHash,observation});
  }
 }}catch(error){
  if(!(error instanceof RcMemoryError)||['conflict','invalid_response'].includes(error.code))throw error;
  // Do not use a partially read cache subset. Existing baseline facts remain;
  // this is an infrastructure fallback, not provider all-or-nothing enrichment.
  cache.length=0;
  await input.repository.skipCache(input.identity);
 }
 // A direct Memory refusal is authoritative even if Discover's projection
 // has not caught up. Exclude that person from dispatch AND ranking evidence;
 // do not turn a privacy restriction into a cache miss or fail the whole run.
 if(ownedPreparation)await input.repository.finishPreparation!(input.identity,input.receiptIds,cache,[...restricted]);
 else await input.repository.prepare(input.identity,input.receiptIds,{...baseline as RcBaseline,cache,
  identities:baseline.identities.filter(person=>!restricted.has(person.candidateId)),
  evidence:(baseline as RcBaseline).evidence.filter(person=>!restricted.has(person.candidateId)),
  withheld:(baseline as RcBaseline).withheld.filter(person=>!restricted.has(person.candidateId))});
 const prepared=await read();
 if(!prepared?.baseline)throw Error('RC_BASELINE_REQUIRED');return prepared;
}

export type RcTick={state:'waiting';nextWorkAt:number}|{state:'needs_attention'}|{state:'sealed';snapshot:RcWorkSnapshot};

/** One bounded quantum of work, not a thirteen-minute request handler. The
 * existing sourcing worker persists/schedules waits and renews its own lease.
 * Every dispatch is granted once by SQL; replay never invokes a paid fetch.
 */
export const runRcTick = timedSourcingFunction('rc_tick', runRcTickMeasured);
async function runRcTickMeasured(input:{identity:RcWorkerIdentity;repository:Repository;
 provider:()=>Provider;privacyCursor:()=>Promise<number>;now?:()=>number}):Promise<RcTick> {
 const now=input.now??Date.now,{identity,repository}=input;
 const read=()=>repository.readWork?repository.readWork(identity):repository.read(identity.tenantId,identity.flowRunId);
 let snapshot=await read();
 if(!snapshot?.baseline||!snapshot.deadlineAt)throw Error('RC_BASELINE_REQUIRED');
 if(snapshot.sealedAt)return {state:'sealed',snapshot};
 if(snapshot.state==='stalled'||snapshot.state==='closed_unrecoverable')return {state:'needs_attention'};
 const original=snapshot,baseline=snapshot.baseline,deadline=Date.parse(snapshot.deadlineAt),direct=snapshot.protocolMode===2;
 const candidates=new Map(baseline.identities.map(i=>[i.identityHash,i]));
 const cache=new Map(baseline.cache.map(i=>[i.identityHash,i.observation]));
 let nextWorkAt=Math.min(deadline,now()+(direct?0:1000));
 const pending=snapshot.members.filter(m=>['pending','checking','fetching'].includes(m.state));
 async function processMember(member:RcSnapshot['members'][number]):Promise<void>{
  const person=candidates.get(member.identityHash);if(!person)throw Error('RC_IDENTITY_CONFLICT');
  const previous=original.attempts.filter(a=>a.identityHash===member.identityHash).sort((a,b)=>b.ordinal-a.ordinal);
  const checked=previous.find(a=>a.operation==='CHECK'&&a.state==='success'&&a.outcome?.kind==='eligible');
  const operation=direct||checked?'FETCH':'CHECK';
  const claimed=await repository.claim(identity,member.identityHash,operation);
  if(claimed.state==='done'||claimed.state==='unavailable')return;
  const old=previous.find(a=>a.id===claimed.attemptId);
  if(claimed.attemptState!=='reserved'){
   if(claimed.attemptState==='dispatched'&&old?.dispatchAt&&now()-Date.parse(old.dispatchAt)>=RC_LIMITS.timeoutMs){
    // Paid ambiguity is terminal. CHECK may have one proven-free retry; never
    // overwrite a recorded outcome or restart the stage deadline.
    await repository.finish(identity,claimed.attemptId,finish(operation==='FETCH'?'uncertain':'failed',null,null,
     operation==='CHECK'?0:null,'transport',emptyQuota,operation==='CHECK'));
   }
   return;
  }
  const cached=cache.get(member.identityHash);
  if(cached&&(direct||operation==='CHECK')){
   await repository.finish(identity,claimed.attemptId,finish('cached',cached.upstreamAt,cached,0));return;
  }
  if(!original.rcAvailable||now()>=deadline)return;
  let provider:Provider;
  try{provider=input.provider();}
  catch{
   // Constructing the client performs no I/O. A missing/invalid key is known
   // not to have dispatched; record the refusal without a possible paid call.
   await repository.finish(identity,claimed.attemptId,finish('failed',null,null,0,'unauthorized'));
   return;
  }
  const granted=await repository.dispatch(identity,claimed.attemptId,await input.privacyCursor());
  if(granted.state==='wait'){nextWorkAt=Math.max(nextWorkAt,Date.parse(granted.nextWorkAt));return;}
  if(granted.state!=='granted')return;
  let result:RcFinish;
  try{
   if(operation==='CHECK'){
    const check=await measureSourcingStage('rc_provider_check',()=>provider.check(person.url,Date.parse(granted.deadlineAt)));
    const observation=check.outcome==='eligible'?null:createObservation({version:1,outcome:check.outcome,
     identityHash:person.identityHash,skills:[],upstreamAt:check.upstreamAt,observedAt:new Date(now()).toISOString(),
     validUntil:null,timestampSource:'check_last_update'});
    result=finish(check.outcome,check.upstreamAt,observation,check.quota.creditsConsumed,'ok',providerQuota(check));
   }else{
    const checkedAt=checked?.outcome?.upstreamAt;
    if(!direct&&typeof checkedAt!=='string')throw Error('RC_CHECK_SNAPSHOT_CONFLICT');
    const fetched=await measureSourcingStage('rc_provider_fetch',()=>provider.fetchSkills(person.url,Date.parse(granted.deadlineAt),granted.maximumCredits,direct?'direct':'legacy'));
    if(direct&&(fetched.outcome===undefined||fetched.upstreamAt===undefined))throw Error('RC_FETCH_SNAPSHOT_CONFLICT');
    const upstreamAt=direct?fetched.upstreamAt!:checkedAt as string;
    const outcome=direct?fetched.outcome!:(fetched.skills.length?'success':'no_skills');
    const observation=createObservation({version:1,outcome,identityHash:person.identityHash,skills:fetched.skills,upstreamAt,
     observedAt:new Date(now()).toISOString(),validUntil:outcome==='success'?rcValidUntil(upstreamAt!):null,timestampSource:direct?'fetch_updated_at':'check_last_update'});
    result=finish(outcome,upstreamAt,observation,fetched.quota.creditsConsumed,'ok',providerQuota(fetched));
   }
  }catch(error){
   // Any unexpected failure after durable dispatch remains potentially paid.
   // Never put repository.finish in this try: an acknowledgement failure must
   // not replace a successful provider outcome with a conflicting second one.
   const known=error instanceof RcProviderError?error:null;
   const code=known?.code??'invalid_response';
   const retryFree=operation==='CHECK'&&['transport','rate_limited'].includes(code)&&!known?.possiblePaid;
   const proof=direct&&operation==='FETCH'&&code==='rate_limited'?approvedRcFreeRejection(known?.rejectionProof):null;
   if(proof){
    result=createRcFinish({version:1,outcome:{kind:'rejected_free',upstreamAt:null,retryableFree:true,safeCode:'rate_limited',
     quota:{...emptyQuota,retryAfterMs:Math.max(0,Math.min(86_400_000,Date.parse(proof.retryAfterAt)-now()))},rejectionProof:proof},
     observation:null,observedCredits:0});
   }else result=finish(code==='restricted'?'restricted':operation==='FETCH'?'uncertain':'failed',null,null,
    known?.observedCredits??(operation==='CHECK'?0:null),code,
    {...emptyQuota,retryAfterMs:known?.retryAfterMs??null},retryFree);
  }
  await repository.finish(identity,claimed.attemptId,result);
 }
 if(now()<deadline&&snapshot.state!=='needs_attention'){
  // Persisted protocol, not a process toggle, determines concurrency on recovery.
  // SQL independently enforces the same cap and the shared account limiter.
  const work=pending.filter(m=>original.rcAvailable||cache.has(m.identityHash)).slice(0,direct?RC_LIMITS.newlyPurchased:RC_LIMITS.concurrencyPerRun);
  const concurrency=direct?RC_LIMITS.directConcurrencyPerRun:RC_LIMITS.concurrencyPerRun;
  let cursor=0,failure:unknown,failed=false;
  // Refill a free slot immediately, without a slow-call barrier every 10/20
  // people. An acknowledgement error stops new assignments; drain all started
  // work before returning so recovery cannot race orphaned provider calls.
  await Promise.all(Array.from({length:Math.min(concurrency,work.length)},async()=>{
   while(!failed&&cursor<work.length&&now()<deadline){
    const member=work[cursor++];
    try{await processMember(member);}catch(error){failed=true;failure=error;}
   }
  }));
  if(failed)throw failure;
 }
 snapshot=await read();
 if(!snapshot)throw Error('RC_ADMISSION_REQUIRED');
 const inflight=snapshot.attempts.filter(a=>a.state==='dispatched'&&a.dispatchAt&&now()-Date.parse(a.dispatchAt)<RC_LIMITS.timeoutMs);
 const unfinished=snapshot.members.some(m=>['pending','checking','fetching'].includes(m.state));
 const unfinishedCached=snapshot.members.some(m=>['pending','checking','fetching'].includes(m.state)&&cache.has(m.identityHash));
 if(inflight.length)return {state:'waiting',nextWorkAt:now()+1000};
 if(unfinished&&now()<deadline&&(snapshot.rcAvailable||unfinishedCached)&&snapshot.state!=='needs_attention')
  return {state:'waiting',nextWorkAt:Math.min(nextWorkAt,deadline)};
 for(let attempt=0;;attempt++){
  const result=await repository.seal(identity,snapshot);
  if(result?.state!=='reread')break;
  if(attempt>=2)throw Error('RC_SEAL_CONTENTION');
  const latest=await read();if(!latest)throw Error('RC_ADMISSION_REQUIRED');snapshot=latest;
 }
 const sealed=await read();
 if(!sealed?.sealedAt)throw Error('RC_SEAL_REQUIRED');return {state:'sealed',snapshot:sealed};
}

/** Apply only committed observations to a sealed baseline. This never invokes
 * Memory/RC and cannot promote a cached update arriving after publication. */

/** Shared by first execution and the queue's early snapshot-recovery branch.
 * Called only after the outer feature gate, governed authority and admission.
 * No fresh pool/model/Crustdata work is needed to finish an existing snapshot.
 */
export async function completeRcRanking(identity:RcWorkerIdentity,contract:RankingContract,ownedRepository?:RcRepository,providerFactory?:()=>Provider):Promise<RankingRead>{
 const {RcRepository}=await import('./repository');
 const {createRcProvider}=await import('./provider');
 const {RankingRepository}=await import('../rubric/repository');
 const {requireHealthyCandidatePrivacyContext,filterCandidateIdsBeforeLimit}=await import('@/lib/candidate-privacy/repository');
 const repository=ownedRepository??new RcRepository();let provider:Provider|undefined,heartbeatFailure=false,beating=false;
 await repository.heartbeat(identity);
 const timer=setInterval(()=>{
  if(beating)return;beating=true;
  void repository.heartbeat(identity).catch(()=>{heartbeatFailure=true;}).finally(()=>{beating=false;});
 },15000);timer.unref();
 try{
  let sealed:RcWorkSnapshot;
  for(;;){
   if(heartbeatFailure)throw Error('RC_HEARTBEAT_UNAVAILABLE');
   const tick=await runRcTick({identity,repository,provider:()=>{
    provider??=providerFactory?providerFactory():createRcProvider({apiKey:process.env.REVERSECONTACT_API_KEY??''});return provider;
   },privacyCursor:async()=>{
    const context=await requireHealthyCandidatePrivacyContext();
    const cursor=Number(context.cursor);if(!Number.isSafeInteger(cursor))throw Error('RC_PRIVACY_CURSOR_INVALID');return cursor;
   }});
   if(tick.state==='needs_attention')throw Error('RC_RECOVERY_PENDING');
   if(tick.state==='sealed'){sealed=tick.snapshot;break;}
   // Short waits keep worker cancellation/health observable; the original DB
   // deadline and account next-work marker survive a killed process.
   await measureSourcingStage('rc_wait',()=>new Promise(resolve=>setTimeout(resolve,Math.max(25,Math.min(1000,tick.nextWorkAt-Date.now())))));
  }
  const frozen=await measureSourcingStage('rc_merge',()=>repository.mergedEvidence(sealed));
   // Admission here only prepares the input. Claim rechecks it atomically and
   // requests bounded re-preparation if it changed; finish suppresses withdrawal.
   // No outer transaction: scoring must not hold the system-wide privacy lock.
   await requireHealthyCandidatePrivacyContext();
   const allowed=new Set(await filterCandidateIdsBeforeLimit(identity.tenantId,[...frozen.evidence,...frozen.withheld].map(e=>e.candidateId)));
   const evidence=frozen.evidence.filter(e=>allowed.has(e.candidateId)),withheld=frozen.withheld.filter(e=>allowed.has(e.candidateId));
   const sourceTypes=new Map(evidence.map(e=>{
    if(!e.presentationSource)throw Error('RANKING_SOURCE_METADATA_MISSING');return [e.candidateId,e.presentationSource] as const;
   }));
   const result=await new RankingRepository().publish({...identity,contract,evidence,withheld,sourceTypes});
  // SQL finish has already persisted minimal observations in the durable outbox.
  // Existing maintenance discovers and drains them independently; no provider
  // data upload or fire-and-forget promise delays the recruiter response.
  return result;
 }finally{clearInterval(timer);await repository.dispose();}
}
