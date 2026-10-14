import {createHash} from 'node:crypto';
import {z} from 'zod';
import {retrievalConfiguration,type RetrievalConfiguration} from '../search-retrieval';
import {evidenceSchema,withheldProfileSchema,evidenceBytes,EVIDENCE_POOL_MAX_BYTES} from '../rubric/evidence';
import {byteCompare,rankingHash} from '../rubric/contracts';
import {rcHashSchema,rcTimeSchema,rcProgressSchema,rcFinishSchema,rcOutcomeSchema,observationSchema,type RcFinish} from './contracts';
import {rcIdentityHash} from './membership';
import type {RcComputeClient,RcComputeMessage,RcBaselinePlan,RcWorkSnapshot} from './rc-compute-worker';
import type {CanonicalEvidence,WithheldProfile} from '../rubric/evidence';

const uuid=z.string().uuid(),id=z.string().min(1).max(200),tenant=z.string().regex(/^org_[1-9][0-9]*$/);
const identity=z.object({candidateId:id,globalCandidateId:uuid,url:z.string().regex(/^https:\/\/linkedin\.com\/in\/[a-z0-9][a-z0-9._-]{0,199}$/),identityHash:rcHashSchema})
 .strict().refine(v=>rcIdentityHash(v.url)===v.identityHash,'Invalid public identity');
export const rcBaselineSchema=z.object({version:z.literal(1),asOf:rcTimeSchema,evidence:z.array(evidenceSchema).max(2000),
 withheld:z.array(withheldProfileSchema).max(2000),identities:z.array(identity).max(2000),
 cache:z.array(z.object({identityHash:rcHashSchema,observation:observationSchema}).strict()).max(2000)}).strict().superRefine((v,ctx)=>{
 const ids=[...v.evidence,...v.withheld].map(e=>e.candidateId),seen=new Set(ids);
 const identityHashes=new Set(v.identities.map(i=>i.identityHash));
 if(ids.length>2000||ids.length!==seen.size||v.identities.some(i=>!seen.has(i.candidateId))||
  ['candidateId','globalCandidateId','identityHash'].some(key=>new Set(v.identities.map(i=>i[key as keyof typeof i])).size!==v.identities.length)||
  new Set(v.cache.map(c=>c.identityHash)).size!==v.cache.length||v.cache.some(c=>c.identityHash!==c.observation.identityHash||
   !identityHashes.has(c.identityHash))||
  evidenceBytes(v)>EVIDENCE_POOL_MAX_BYTES)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid RC baseline'});
});
export type RcBaseline=z.infer<typeof rcBaselineSchema>;
export const rcMemberSchema=z.object({candidateId:id,identityHash:rcHashSchema,receiptId:id,
 state:z.enum(['pending','cached','no_data','checking','fetching','success','failed','uncertain','restricted','oversized'])}).strict();
const attemptSchema=z.object({id:uuid,identityHash:rcHashSchema,operation:z.enum(['CHECK','FETCH']),ordinal:z.number().int().min(1).max(3),
 state:z.enum(['reserved','dispatched','success','no_data','no_dispatch','uncertain','failed','rejected_free']),dispatchAt:rcTimeSchema.nullable(),
 outcomeHash:rcHashSchema.nullable(),outcome:z.record(z.unknown()).nullable(),possibleCredits:z.number().int().nonnegative()}).strict();
export const rcSnapshotSchema=z.object({version:z.literal(1),runId:uuid,revision:z.string().regex(/^[0-9]+$/),
 protocolMode:z.union([z.literal(1),z.literal(2)]).optional(),
 state:z.enum(['admitted','prepared','checking','fetching','complete','partial','baseline_only','needs_attention','stalled','closed_unrecoverable']),
 baselineHash:rcHashSchema.nullable(),baseline:rcBaselineSchema.nullable(),deadlineAt:rcTimeSchema.nullable(),sealedAt:rcTimeSchema.nullable(),
 outcomeSetHash:rcHashSchema.nullable(),rcAvailable:z.boolean(),members:z.array(rcMemberSchema).max(300),
 attempts:z.array(attemptSchema).max(900),progress:rcProgressSchema}).strict().superRefine((v,ctx)=>{
 if(v.baseline!==null&&rankingHash(v.baseline)!==v.baselineHash)ctx.addIssue({code:z.ZodIssueCode.custom,message:'RC baseline hash mismatch'});
 const members=new Set(v.members.map(m=>m.identityHash));
 if(new Set(v.attempts.map(a=>a.id)).size!==v.attempts.length||members.size!==v.members.length||
  v.attempts.some(a=>!members.has(a.identityHash)))ctx.addIssue({code:z.ZodIssueCode.custom,message:'RC identity mismatch'});
});
export type RcSnapshot=z.infer<typeof rcSnapshotSchema>;
export type RcWorkerIdentity={tenantId:string;flowRunId:string;executionAttemptId:string;processingLeaseId:string};
const worker=z.object({tenantId:tenant,flowRunId:uuid,executionAttemptId:id,processingLeaseId:id}).strict();
const statements={admit:'SELECT public.signal_rc_admit($1,$2::uuid,$3::jsonb) result',
 prepare:'SELECT public.signal_rc_prepare($1,$2::uuid,$3::jsonb) result',claim:'SELECT public.signal_rc_claim($1,$2::uuid,$3::jsonb) result',
 dispatch:'SELECT public.signal_rc_dispatch($1,$2::uuid,$3::uuid,$4::jsonb) result',finish:'SELECT public.signal_rc_finish($1,$2::uuid,$3::uuid,$4::jsonb) result',
 read:'SELECT public.signal_rc_read($1,$2::uuid) result',work:'SELECT public.signal_rc_work($1,$2::uuid,$3::jsonb) result',seal:'SELECT public.signal_rc_seal($1,$2::uuid,$3::jsonb) result',
 outbox:'SELECT public.signal_rc_outbox($1,$2::uuid,$3::jsonb) result',maintain:'SELECT public.signal_rc_maintain($1::jsonb) result'} as const;
type Query=(sql:string,args:unknown[])=>Promise<Array<Record<string,unknown>>>;
const claimResult=z.discriminatedUnion('state',[
 z.object({version:z.literal(1),state:z.literal('unavailable')}).strict(),z.object({version:z.literal(1),state:z.literal('done')}).strict(),
 z.object({version:z.literal(1),state:z.enum(['reserved','existing']),attemptId:uuid,attemptState:attemptSchema.shape.state}).strict(),
]);
const dispatchResult=z.discriminatedUnion('state',[
 z.object({version:z.literal(1),state:z.enum(['already_dispatched','unavailable','restricted'])}).strict(),
 z.object({version:z.literal(1),state:z.literal('wait'),nextWorkAt:rcTimeSchema}).strict(),
 z.object({version:z.literal(1),state:z.literal('granted'),attemptId:uuid,deadlineAt:rcTimeSchema,maximumCredits:z.number().int().positive()}).strict(),
]);
const storedOutcome=z.union([z.object({kind:z.literal('restricted')}).strict(),
 rcOutcomeSchema.extend({observation:observationSchema.nullable()}).strict()]);
const observationReply=z.object({version:z.literal(1),observations:z.array(z.object({attemptId:uuid,
 outcomeHash:rcHashSchema,outcome:storedOutcome}).strict()).max(25)}).strict();
function freezeOwned<T>(value:T):T {
 if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){
  for(const child of Object.values(value))freezeOwned(child);
  Object.freeze(value);
 }
 return value;
}

/** Digest of immutable attempt commitments in SQL COLLATE C order. It includes
 * failed/uncertain dispatches, not just successful skill observations. */
export function rcOutcomeSetHash(snapshot:Pick<RcSnapshot,'baselineHash'|'sealedAt'|'outcomeSetHash'|'attempts'>):string {
 if(!snapshot.baselineHash)throw Error('RC_BASELINE_REQUIRED');
 if(snapshot.sealedAt){if(!snapshot.outcomeSetHash)throw Error('RC_SEAL_INVALID');return snapshot.outcomeSetHash;}
 const sorted=[...snapshot.attempts].sort((a,b)=>byteCompare(a.identityHash,b.identityHash)||byteCompare(a.operation,b.operation)||a.ordinal-b.ordinal);
 const markers=sorted.map(a=>`${a.identityHash}:${a.operation}:${a.ordinal}:${a.state}:${a.outcomeHash??'-'}`).join('\n');
 return createHash('sha256').update(snapshot.baselineHash+'\n'+markers).digest('hex');
}

/** Fixed routine-only access; no table writes, provider calls or eager config.
 * Dispatch/finish/outbox additionally use the existing stricter configured
 * privacy-health check, then SQL repeats its own authority/withdrawal fence. */
export class RcRepository {
 private session:{key:string;runId:string;baselineHash:string;baseline:RcBaselinePlan;revision:bigint;
  outcomes:Map<string,{hash:string;value:Record<string,unknown>}>}|undefined;
 private readonly ownedSnapshots=new WeakSet<RcWorkSnapshot>();
 private compute:Pick<RcComputeClient,'call'|'dispose'>|undefined;
 constructor(private readonly suppliedQuery?:Query,isolatedCompute?:RcComputeClient){this.compute=isolatedCompute;}
 private async computeCall(message:RcComputeMessage){
  if(!this.compute){
   const {RcComputeClient,RcComputeState}=await import('./rc-compute-worker');
   if(this.suppliedQuery){
    // Explicit disposable query adapters use the same pure state machine.
    // Runtime has no suppliedQuery and never falls back after a helper failure.
    const state=new RcComputeState();this.compute={call:async message=>state.handle(message),dispose:async()=>{}};
   }else this.compute=new RcComputeClient();
  }
  return this.compute.call(message);
 }
 async dispose(){await this.compute?.dispose();this.compute=undefined;this.session=undefined;}
 private async call(operation:keyof typeof statements,args:unknown[]):Promise<unknown>{
  if(this.suppliedQuery)return (await this.suppliedQuery(statements[operation],args))[0]?.result??null;
  const {prisma}=await import('@/lib/prisma');
  const values=args.map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v);
  const compact=operation==='work'&&(args[2] as {action?:string})?.action!=='baseline';
  if(operation==='prepare'||operation==='read'||operation==='work'){
   return prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe(compact?"SET LOCAL statement_timeout='5s'":"SET LOCAL statement_timeout='30s'");
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='2s'");
    await tx.$executeRawUnsafe("SET LOCAL idle_in_transaction_session_timeout='35s'");
    if(operation==='work'&&(args[2] as {action?:string})?.action==='observations'){
     const {requireHealthyCandidatePrivacyContext}=await import('@/lib/candidate-privacy/repository');
     await requireHealthyCandidatePrivacyContext(tx);
    }
    return (await tx.$queryRawUnsafe<Array<Record<string,unknown>>>(statements[operation],...values))[0]?.result??null;
   },{maxWait:2000,timeout:compact?7000:35000});
  }
  if(['dispatch','finish','outbox'].includes(operation)){
   const {CANDIDATE_PRIVACY_ADMISSION_LOCK,requireHealthyCandidatePrivacyContext}=await import('@/lib/candidate-privacy/repository');
   return prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',CANDIDATE_PRIVACY_ADMISSION_LOCK);
    await requireHealthyCandidatePrivacyContext(tx);
    return (await tx.$queryRawUnsafe<Array<Record<string,unknown>>>(statements[operation],...values))[0]?.result??null;
   },{maxWait:2000,timeout:15000});
  }
  return (await prisma.$queryRawUnsafe<Array<Record<string,unknown>>>(statements[operation],...values))[0]?.result??null;
 }
 async admit(identity:RcWorkerIdentity,requestId:string,generation:number,contractHash:string,purchaseSlot?:'exact'|'spill'){
  worker.parse(identity);id.parse(requestId);z.number().int().positive().parse(generation);rcHashSchema.parse(contractHash);
  return z.discriminatedUnion('enabled',[
   z.object({version:z.literal(1),enabled:z.literal(false)}).strict(),
   z.object({version:z.literal(1),enabled:z.literal(true),runId:uuid,rcAvailable:z.boolean()}).strict(),
  ]).parse(await this.call('admit',[identity.tenantId,identity.flowRunId,{version:1,requestId,generation,contractHash,
   executionAttemptId:identity.executionAttemptId,processingLeaseId:identity.processingLeaseId,protocolMode:2,...(purchaseSlot?{purchaseSlot}:{})}]));
 }
 async retrievalConfiguration(identity:RcWorkerIdentity,configuration:Readonly<RetrievalConfiguration>){
  worker.parse(identity);
  const proposed=retrievalConfiguration(configuration.publicLimit,configuration.privateLimit,configuration.recentLimit);
  const saved=z.object({version:z.literal(1),publicLimit:z.number().int(),privateLimit:z.number().int(),
   recentLimit:z.number().int(),newLimit:z.literal(300)}).strict().parse(await this.call('work',[
    identity.tenantId,identity.flowRunId,{version:1,action:'retrieval_config',
     executionAttemptId:identity.executionAttemptId,processingLeaseId:identity.processingLeaseId,configuration:proposed}]));
  return retrievalConfiguration(saved.publicLimit,saved.privateLimit,saved.recentLimit);
 }
 async prepare(identity:RcWorkerIdentity,receiptIds:string[],raw:RcBaseline){
  worker.parse(identity);z.array(id).max(2).parse(receiptIds);
  const prepared=await this.computeCall({kind:'prepare',baseline:raw,receiptIds});
  return this.storePreparation(identity,prepared);
 }
 async beginPreparation(raw:RcBaseline):Promise<RcBaselinePlan>{
  const result=await this.computeCall({kind:'begin',baseline:raw});
  if(result.kind!=='begun')throw Error('RC_COMPUTE_REPLY_INVALID');return result.plan;
 }
 async finishPreparation(identity:RcWorkerIdentity,receiptIds:string[],cache:RcBaseline['cache'],restrictedIds:string[]){
  worker.parse(identity);
  const prepared=await this.computeCall({kind:'finishPreparation',receiptIds,cache,restrictedIds});
  return this.storePreparation(identity,prepared);
 }
 private async storePreparation(identity:RcWorkerIdentity,prepared:unknown){
  const {wire,baselineHash}=z.object({kind:z.literal('prepared'),wire:z.string(),baselineHash:rcHashSchema}).strict().parse(prepared);
  const result=z.object({version:z.literal(1),runId:uuid,baselineHash:rcHashSchema,replayed:z.boolean()}).strict().parse(
   await this.call('prepare',[identity.tenantId,identity.flowRunId,wire]));
  if(result.baselineHash!==baselineHash)throw Error('RC_BASELINE_CONFLICT');return result;
 }
 async read(tenantId:string,flowRunId:string):Promise<RcSnapshot|null>{
  tenant.parse(tenantId);uuid.parse(flowRunId);const raw=await this.call('read',[tenantId,flowRunId]);
  return raw===null?null:rcSnapshotSchema.parse(raw);
 }
 /** Execution-local immutable baseline, never a cross-run/global cache. Every
  * compact read is fenced by SQL against the current execution and lease. */
 async readWork(identity:RcWorkerIdentity):Promise<RcWorkSnapshot|null>{
  worker.parse(identity);const key=JSON.stringify(identity);
  if(this.session?.key!==key){
   if(this.session)await this.dispose();
   const raw=await this.call('work',[identity.tenantId,identity.flowRunId,{version:1,action:'baseline',baselineHash:null,
    executionAttemptId:identity.executionAttemptId,processingLeaseId:identity.processingLeaseId}]);
   if(raw===null||typeof raw==='object'&&(raw as {baseline?:unknown}).baseline===null)return raw===null?null:rcSnapshotSchema.parse(raw);
   const loaded=await this.computeCall({kind:'load',snapshot:raw});
   if(loaded.kind!=='loaded')throw Error('RC_COMPUTE_REPLY_INVALID');
   const initial=loaded.snapshot as RcWorkSnapshot;
   if(!initial.baseline||!initial.baselineHash)throw Error('RC_BASELINE_REQUIRED');
   this.session={key,runId:initial.runId,baselineHash:initial.baselineHash,baseline:freezeOwned(initial.baseline),
    revision:BigInt(initial.revision),outcomes:new Map()};
  }
  const session=this.session;
  const command={version:1,executionAttemptId:identity.executionAttemptId,processingLeaseId:identity.processingLeaseId,baselineHash:session.baselineHash};
  const raw=await this.call('work',[identity.tenantId,identity.flowRunId,{...command,action:'status'}]);
  if(Buffer.byteLength(JSON.stringify(raw))>1_048_576)throw Error('RC_RESPONSE_TOO_LARGE');
  const status=rcSnapshotSchema.parse(raw);
  if(status.baseline!==null||status.attempts.some(a=>a.outcome!==null)||status.runId!==session.runId||
   status.baselineHash!==session.baselineHash||BigInt(status.revision)<session.revision)throw Error('RC_WORK_CONFLICT');
  const terminals=status.attempts.filter(a=>a.outcomeHash!==null);
  for(const attempt of terminals){
   const cached=session.outcomes.get(attempt.id);
   if(cached&&cached.hash!==attempt.outcomeHash)throw Error('RC_OUTCOME_CONFLICT');
  }
  const missing=terminals.filter(a=>!session.outcomes.has(a.id));
  for(let offset=0;offset<missing.length;offset+=25){
   const expected=new Map(missing.slice(offset,offset+25).map(a=>[a.id,a]));
   const response=await this.call('work',[identity.tenantId,identity.flowRunId,{...command,action:'observations',attemptIds:[...expected.keys()]}]);
   if(Buffer.byteLength(JSON.stringify(response))>2_097_152)throw Error('RC_RESPONSE_TOO_LARGE');
   const items=observationReply.parse(response).observations;
   if(items.length!==expected.size||new Set(items.map(i=>i.attemptId)).size!==expected.size)throw Error('RC_OUTCOME_CONFLICT');
   for(const item of items){
    const attempt=expected.get(item.attemptId);
    if(!attempt||item.outcomeHash!==attempt.outcomeHash||('observation' in item.outcome&&item.outcome.observation!==null&&
     item.outcome.observation.identityHash!==attempt.identityHash))throw Error('RC_OUTCOME_CONFLICT');
    session.outcomes.set(item.attemptId,{hash:item.outcomeHash,value:freezeOwned(item.outcome)});
   }
   await this.computeCall({kind:'observations',runId:session.runId,baselineHash:session.baselineHash,
    records:items.map(item=>({...item,identityHash:expected.get(item.attemptId)!.identityHash}))});
  }
  const restricted=new Set(status.members.filter(m=>m.state==='restricted').map(m=>m.identityHash));
  const result=freezeOwned({...status,baseline:session.baseline,attempts:status.attempts.map(a=>({...a,
   outcome:a.outcomeHash?(restricted.has(a.identityHash)?{kind:'restricted'}:session.outcomes.get(a.id)!.value):null}))});
  session.revision=BigInt(status.revision);this.ownedSnapshots.add(result);return result;
 }
 async mergedEvidence(snapshot:RcWorkSnapshot):Promise<{evidence:CanonicalEvidence[];withheld:WithheldProfile[]}>{
  if(!this.ownedSnapshots.has(snapshot))throw Error('RC_COMPUTE_SNAPSHOT_REQUIRED');
  const {baseline:_,...header}=snapshot;
  const result=await this.computeCall({kind:'merge',snapshot:{...header,attempts:header.attempts.map(a=>({...a,outcome:null}))}});
  if(result.kind!=='merged')throw Error('RC_COMPUTE_REPLY_INVALID');
  return {evidence:result.evidence,withheld:result.withheld};
 }
 async progress(tenantId:string,flowRunId:string){
  tenant.parse(tenantId);uuid.parse(flowRunId);
  if(this.suppliedQuery){
   // Test adapters may provide a transaction; production always scopes the
   // custom setting to its own read-only transaction below.
   const raw=await this.call('read',[tenantId,flowRunId]);
   return raw===null?null:rcSnapshotSchema.parse(raw).progress;
  }
  const {prisma}=await import('@/lib/prisma');
  return prisma.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
   await tx.$queryRawUnsafe("SELECT set_config('signal.rc_progress_only','true',true)");
   const rows=await tx.$queryRawUnsafe<Array<{result:unknown}>>(statements.read,tenantId,flowRunId);
   const raw=rows[0]?.result??null;return raw===null?null:rcProgressSchema.parse(raw);
  },{maxWait:2000,timeout:10000});
 }
 async claim(identity:RcWorkerIdentity,identityHash:string,operation:'CHECK'|'FETCH'){
  worker.parse(identity);rcHashSchema.parse(identityHash);z.enum(['CHECK','FETCH']).parse(operation);
  return claimResult.parse(await this.call('claim',[identity.tenantId,identity.flowRunId,{version:1,operation,identityHash,
   executionAttemptId:identity.executionAttemptId,processingLeaseId:identity.processingLeaseId}]));
 }
 async dispatch(identity:RcWorkerIdentity,attemptId:string,privacyCursor:number){
  worker.parse(identity);uuid.parse(attemptId);z.number().int().nonnegative().safe().parse(privacyCursor);
  return dispatchResult.parse(await this.call('dispatch',[identity.tenantId,identity.flowRunId,attemptId,{version:1,privacyCursor,
   executionAttemptId:identity.executionAttemptId,processingLeaseId:identity.processingLeaseId}]));
 }
 async finish(identity:RcWorkerIdentity,attemptId:string,command:RcFinish){
  worker.parse(identity);uuid.parse(attemptId);rcFinishSchema.parse(command);
  const result=z.object({version:z.literal(1),attemptId:uuid,replayed:z.boolean()}).strict().parse(
   await this.call('finish',[identity.tenantId,identity.flowRunId,attemptId,command]));
  if(result.attemptId!==attemptId)throw Error('RC_OUTCOME_CONFLICT');return result;
 }
 async seal(identity:RcWorkerIdentity,snapshot:RcWorkSnapshot){
  worker.parse(identity);if(!this.ownedSnapshots.has(snapshot))rcSnapshotSchema.parse(snapshot);
  const outcomeSetHash=rcOutcomeSetHash(snapshot);
  const result=z.discriminatedUnion('state',[
   z.object({version:z.literal(1),state:z.literal('reread')}).strict(),
   z.object({version:z.literal(1),state:z.enum(['complete','partial','baseline_only']),outcomeSetHash:rcHashSchema,replayed:z.boolean()}).strict(),
  ]).parse(await this.call('seal',[identity.tenantId,identity.flowRunId,{version:1,baselineHash:snapshot.baselineHash,outcomeSetHash,
   ...(snapshot.protocolMode===2?{expectedRevision:snapshot.revision,executionAttemptId:identity.executionAttemptId,processingLeaseId:identity.processingLeaseId}:{})}]));
  if(result.state==='reread')return result;
  if(result.outcomeSetHash!==outcomeSetHash)throw Error('RC_OUTCOME_CONFLICT');return result;
 }
 async outbox(tenantId:string,flowRunId:string,command:{version:1;action:'claim'|'ack';id:string|null;receiptHash:string|null}):Promise<unknown>{
  tenant.parse(tenantId);uuid.parse(flowRunId);z.object({version:z.literal(1),action:z.enum(['claim','ack']),id:uuid.nullable(),receiptHash:rcHashSchema.nullable()}).strict().parse(command);
  return this.call('outbox',[tenantId,flowRunId,command]);
 }
 async heartbeat(identity:RcWorkerIdentity):Promise<void>{
  worker.parse(identity);
  z.object({version:z.literal(1),state:z.literal('alive')}).strict().parse(await this.call('maintain',[
   {version:1,action:'heartbeat',...identity}]));
 }
 async skipCache(identity:RcWorkerIdentity):Promise<void>{
  worker.parse(identity);
  z.object({version:z.literal(1),state:z.literal('skipped')}).strict().parse(await this.call('maintain',[
   {version:1,action:'skip_cache',...identity}]));
 }
 async stall(identity:RcWorkerIdentity):Promise<void>{
  worker.parse(identity);
  z.object({version:z.literal(1),state:z.literal('stalled')}).strict().parse(await this.call('maintain',[
   {version:1,action:'stall',...identity}]));
 }
 async failure(identity:RcWorkerIdentity,attemptsMade:number,maxAttempts:number){
  worker.parse(identity);z.number().int().nonnegative().parse(attemptsMade);z.number().int().positive().parse(maxAttempts);
  return z.object({version:z.literal(1),state:z.enum(['cancelled','retry','stalled'])}).strict().parse(
   await this.call('maintain',[{version:1,action:'failure',...identity,attemptsMade,maxAttempts}]));
 }
 async claimExecution(input:{tenantId:string;requestId:string;generation:number;executionAttemptId:string;processingLeaseId:string;resumeToken:string|null}){
  tenant.parse(input.tenantId);id.parse(input.requestId);z.number().int().nonnegative().parse(input.generation);
  id.parse(input.executionAttemptId);id.parse(input.processingLeaseId);uuid.nullable().parse(input.resumeToken);
  return z.object({version:z.literal(1),state:z.enum(['unmanaged','claimed','rejected'])}).strict().parse(
   await this.call('maintain',[{version:1,action:'execution_claim',...input}]));
 }
 async maintenance(command:Record<string,unknown>):Promise<unknown>{
  return this.call('maintain',[command]);
 }
}
