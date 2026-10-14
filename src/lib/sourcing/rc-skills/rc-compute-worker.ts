/** Pure, execution-local RC computation. No DB/provider calls or credentials. */
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {resolve} from 'node:path';
import {z} from 'zod';
import {rcBaselineSchema,rcSnapshotSchema,type RcBaseline,type RcSnapshot} from './repository';
import {rcHashSchema,rcOutcomeSchema,observationSchema} from './contracts';
import {encodeRcPreparation} from './canonical-transport';
import {mergeSealedRcEvidence} from './evidence';

export type RcBaselinePlan=Pick<RcBaseline,'version'|'asOf'|'identities'|'cache'>;
export type RcWorkSnapshot=Omit<RcSnapshot,'baseline'>&{baseline:RcBaselinePlan|null};
const outcomeSchema=z.union([z.object({kind:z.literal('restricted')}).strict(),
 rcOutcomeSchema.extend({observation:observationSchema.nullable()}).strict()]);
const recordSchema=z.object({attemptId:z.string().uuid(),identityHash:rcHashSchema,outcomeHash:rcHashSchema,outcome:outcomeSchema}).strict();
const messages=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('begin'),baseline:z.unknown()}).strict(),
 z.object({kind:z.literal('prepare'),baseline:z.unknown(),receiptIds:z.array(z.string().min(1).max(200)).max(2)}).strict(),
 z.object({kind:z.literal('finishPreparation'),cache:z.unknown(),restrictedIds:z.array(z.string().min(1).max(200)).max(2000),receiptIds:z.array(z.string().min(1).max(200)).max(2)}).strict(),
 z.object({kind:z.literal('load'),snapshot:z.unknown()}).strict(),
 z.object({kind:z.literal('observations'),runId:z.string().uuid(),baselineHash:rcHashSchema,records:z.array(recordSchema).max(25)}).strict(),
 z.object({kind:z.literal('merge'),snapshot:z.unknown()}).strict(),
]);
export type RcComputeMessage=z.input<typeof messages>;
function header(raw:unknown):Omit<RcSnapshot,'baseline'>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||'baseline' in raw)throw Error('RC_COMPUTE_INVALID');
 const parsed=rcSnapshotSchema.parse({...raw,baseline:null});
 if(parsed.attempts.some(a=>a.outcome!==null))throw Error('RC_COMPUTE_INVALID');
 const {baseline:_,...result}=parsed;return result;
}
function plan(baseline:RcBaseline,members?:Set<string>):RcBaselinePlan{
 return {version:1,asOf:baseline.asOf,identities:baseline.identities,
  cache:members?baseline.cache.filter(c=>members.has(c.identityHash)):baseline.cache};
}

/** Also exercised directly by pure tests; runtime never falls back to inline. */
export class RcComputeState {
 private baseline:RcBaseline|undefined;
 private loaded:{runId:string;baselineHash:string;revision:bigint}|undefined;
 private readonly outcomes=new Map<string,z.infer<typeof recordSchema>>();
 handle(raw:unknown):unknown{
  const message=messages.parse(raw);
  if(message.kind==='begin'||message.kind==='prepare'){
   if(this.loaded||this.baseline)throw Error('RC_COMPUTE_ALREADY_INITIALIZED');
   const baseline=rcBaselineSchema.parse(message.baseline);
   if(message.kind==='begin'){this.baseline=baseline;return {kind:'begun',plan:plan(baseline)};}
   const command=encodeRcPreparation(baseline,message.receiptIds);
   return {kind:'prepared',baselineHash:command.baselineHash,wire:JSON.stringify(command)};
  }
  if(message.kind==='finishPreparation'){
   if(!this.baseline||this.loaded)throw Error('RC_COMPUTE_NOT_PREPARING');
   const restricted=new Set(message.restrictedIds),ids=new Set(this.baseline.identities.map(i=>i.candidateId));
   if(restricted.size!==message.restrictedIds.length||message.restrictedIds.some(id=>!ids.has(id)))throw Error('RC_COMPUTE_IDENTITY_CONFLICT');
   const baseline=rcBaselineSchema.parse({...this.baseline,cache:message.cache,
    identities:this.baseline.identities.filter(i=>!restricted.has(i.candidateId)),
    evidence:this.baseline.evidence.filter(e=>!restricted.has(e.candidateId)),
    withheld:this.baseline.withheld.filter(e=>!restricted.has(e.candidateId))});
   const command=encodeRcPreparation(baseline,message.receiptIds);
   this.baseline=undefined;
   return {kind:'prepared',baselineHash:command.baselineHash,wire:JSON.stringify(command)};
  }
  if(message.kind==='load'){
   if(this.loaded)throw Error('RC_COMPUTE_ALREADY_INITIALIZED');
   const snapshot=rcSnapshotSchema.parse(message.snapshot);
   if(!snapshot.baseline||!snapshot.baselineHash)throw Error('RC_BASELINE_REQUIRED');
   this.baseline=snapshot.baseline;
   this.loaded={runId:snapshot.runId,baselineHash:snapshot.baselineHash,revision:BigInt(snapshot.revision)};
   // Outcome bodies are fetched through the privacy-fenced observation action,
   // not trusted from the legacy/full baseline projection.
   const {baseline:_,...small}=snapshot;
   return {kind:'loaded',snapshot:{...small,attempts:small.attempts.map(a=>({...a,outcome:null})),
    baseline:plan(this.baseline,new Set(snapshot.members.map(m=>m.identityHash)))}};
  }
  if(!this.loaded||!this.baseline)throw Error('RC_COMPUTE_NOT_LOADED');
  if(message.kind==='observations'){
   if(message.runId!==this.loaded.runId||message.baselineHash!==this.loaded.baselineHash)throw Error('RC_COMPUTE_IDENTITY_CONFLICT');
   const identities=new Set(this.baseline.identities.map(i=>i.identityHash));
   if(new Set(message.records.map(r=>r.attemptId)).size!==message.records.length)throw Error('RC_OUTCOME_CONFLICT');
   for(const record of message.records){
    if(!identities.has(record.identityHash)||('observation' in record.outcome&&record.outcome.observation&&
     record.outcome.observation.identityHash!==record.identityHash))throw Error('RC_COMPUTE_IDENTITY_CONFLICT');
    const previous=this.outcomes.get(record.attemptId);
    if(previous&&(previous.outcomeHash!==record.outcomeHash||previous.identityHash!==record.identityHash))throw Error('RC_OUTCOME_CONFLICT');
    this.outcomes.set(record.attemptId,record);
   }
   return {kind:'observations',count:message.records.length};
  }
  const snapshot=header(message.snapshot);
  if(snapshot.runId!==this.loaded.runId||snapshot.baselineHash!==this.loaded.baselineHash||
   !snapshot.sealedAt||!snapshot.outcomeSetHash||BigInt(snapshot.revision)<this.loaded.revision)throw Error('RC_COMPUTE_SEAL_CONFLICT');
  const restricted=new Set(snapshot.members.filter(m=>m.state==='restricted').map(m=>m.identityHash));
  const attempts=snapshot.attempts.map(a=>{
   if(!a.outcomeHash)return a;
   const saved=this.outcomes.get(a.id);
   if(!saved||saved.identityHash!==a.identityHash||saved.outcomeHash!==a.outcomeHash)throw Error('RC_OUTCOME_CONFLICT');
   return {...a,outcome:restricted.has(a.identityHash)?{kind:'restricted'}:saved.outcome};
  });
  this.loaded.revision=BigInt(snapshot.revision);
  return {kind:'merged',...mergeSealedRcEvidence({...snapshot,baseline:this.baseline,attempts})};
 }
}

/** One persistent helper per executing run, never a shared candidate cache. */
export class RcComputeClient {
 private worker:Worker|undefined;
 private sequence=0;
 private closed=false;
 private pending:{id:number;resolve:(value:any)=>void;reject:(error:Error)=>void}|undefined;
 async call(message:RcComputeMessage):Promise<any>{
  if(this.closed)throw Error('RC_COMPUTE_CLOSED');
  if(this.pending)throw Error('RC_COMPUTE_BUSY');
  if(!this.worker){
   this.worker=new Worker("require('tsx/cjs'); require(require('node:worker_threads').workerData.entry);",{
    eval:true,execArgv:[],workerData:{kind:'rc-compute-v1',entry:resolve(process.cwd(),'src/lib/sourcing/rc-skills/rc-compute-worker.ts')},
    env:{PATH:process.env.PATH??'/usr/bin:/bin',NODE_ENV:'production',TZ:'UTC'},resourceLimits:{maxOldGenerationSizeMb:512},
   });
   this.worker.on('message',reply=>{
    const pending=this.pending;
    if(!pending||reply?.id!==pending.id){this.fail('RC_COMPUTE_REPLY_INVALID');return;}
    this.pending=undefined;
    if(reply.ok===true)pending.resolve(reply.value);
    else{this.closed=true;pending.reject(Error(typeof reply.code==='string'&&/^RC_[A-Z_]+$/.test(reply.code)?reply.code:'RC_COMPUTE_INVALID'));void this.worker?.terminate();}
   });
   this.worker.on('error',()=>this.fail('RC_COMPUTE_FAILED'));
   this.worker.on('exit',()=>this.fail('RC_COMPUTE_EXITED'));
  }
  const id=++this.sequence;
  return new Promise((resolve,reject)=>{
   this.pending={id,resolve,reject};
   try{this.worker!.postMessage({id,message});}catch{this.fail('RC_COMPUTE_SEND_FAILED');}
  });
 }
 private fail(code:string){
  this.closed=true;const pending=this.pending;this.pending=undefined;pending?.reject(Error(code));
  void this.worker?.terminate();
 }
 async dispose(){
  this.closed=true;this.pending?.reject(Error('RC_COMPUTE_CLOSED'));this.pending=undefined;
  if(this.worker)await this.worker.terminate();this.worker=undefined;
 }
}

if(!isMainThread&&workerData?.kind==='rc-compute-v1'){
 const state=new RcComputeState();let sequence=0;
 parentPort!.on('message',envelope=>{
  const id=envelope?.id;
  try{
   if(!envelope||Object.keys(envelope).sort().join(',')!=='id,message'||!Number.isSafeInteger(id)||id!==sequence+1)throw Error('RC_COMPUTE_MESSAGE_INVALID');
   sequence=id;parentPort!.postMessage({id,ok:true,value:state.handle(envelope.message)});
  }catch(error){const code=error instanceof Error&&/^RC_[A-Z_]+$/.test(error.message)?error.message:'RC_COMPUTE_INVALID';parentPort!.postMessage({id,ok:false,code});}
 });
}
