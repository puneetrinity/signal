/** Pure CPU lane. No database, provider, credentials or publication authority. */
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {resolve} from 'node:path';
import {z} from 'zod';
import {canonical,byteCompare,rankingContractSchema,rankingHash,type RankingContract} from './contracts';
import {evidenceSchema,evidenceBytes,EVIDENCE_POOL_MAX_BYTES,withheldProfileSchema,type CanonicalEvidence,type WithheldProfile} from './evidence';
import {rankEvidence} from './score';

type Source='pool'|'pool_enriched'|'discovered';
type Prepare={contract:RankingContract;executionAttemptId:string;processingLeaseId:string;
 evidence:readonly CanonicalEvidence[];withheld?:readonly WithheldProfile[];sourceTypes:readonly (readonly [string,Source])[]};
type Claim={contract:RankingContract;claim:unknown;expected?:{evidence:readonly CanonicalEvidence[];withheld:readonly WithheldProfile[]}};
export type ComputeInput={kind:'prepare';input:Prepare}|{kind:'claim';input:Claim};
const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
const claimSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('ready'),revisionId:uuid,outputHash:hash}).strict(),
 z.object({state:z.literal('reserved_compact'),revisionId:uuid,lease:uuid,inputHash:hash,asOf:z.string().datetime(),contractHash:hash}).strict(),
 z.object({state:z.literal('reserved'),revisionId:uuid,lease:uuid,inputHash:hash,asOf:z.string().datetime(),
  contract:rankingContractSchema,evidence:z.array(evidenceSchema).max(2000),withheld:z.array(withheldProfileSchema).max(2000).default([])}).strict(),
]);
export function computeRankingMessage(message:ComputeInput){
 if(message.kind==='prepare'){
  const input=message.input,contract=rankingContractSchema.parse(input.contract),sources=new Map(input.sourceTypes);
  if(input.evidence.length+(input.withheld?.length??0)>2000)throw Error('RANKING_INPUT_CONFLICT');
  const evidence=input.evidence.map(e=>{const presentationSource=sources.get(e.candidateId);
   if(!presentationSource)throw Error('RANKING_SOURCE_METADATA_MISSING');
   return evidenceSchema.parse({...e,presentationSource});}).sort((a,b)=>byteCompare(a.candidateId,b.candidateId));
  const withheld=(input.withheld??[]).map(e=>withheldProfileSchema.parse(e)).sort((a,b)=>byteCompare(a.candidateId,b.candidateId));
  const ids=[...evidence,...withheld].map(e=>e.candidateId);
  if(new Set(ids).size!==ids.length)throw Error('RANKING_INPUT_CONFLICT');
  const logical={contractHash:contract.contractHash,responseMode:'compact' as const,executionAttemptId:input.executionAttemptId,processingLeaseId:input.processingLeaseId,evidence,withheld};
  if(evidenceBytes(logical)>EVIDENCE_POOL_MAX_BYTES)throw Error('RANKING_POOL_TOO_LARGE');
  const {evidence:unusedEvidence,withheld:unusedWithheld,...metadata}=logical;
  void unusedEvidence;void unusedWithheld;
  const command={...metadata,transportVersion:1 as const,evidenceCanonical:evidence.map(canonical),withheldCanonical:withheld.map(canonical)};
  if(evidenceBytes(command)>2*EVIDENCE_POOL_MAX_BYTES+65_536)throw Error('RANKING_POOL_TOO_LARGE');
  return{kind:'prepared' as const,contract,evidence,withheld,command};
 }
 const {input}=message,contract=rankingContractSchema.parse(input.contract),receipt=claimSchema.parse(input.claim);
 if(receipt.state==='reserved_compact'&&(!input.expected||receipt.contractHash!==contract.contractHash))throw Error('RANKING_INPUT_CONFLICT');
 const claim=receipt.state==='reserved_compact'?{state:'reserved' as const,revisionId:receipt.revisionId,lease:receipt.lease,inputHash:receipt.inputHash,asOf:receipt.asOf,
  contract,evidence:z.array(evidenceSchema).max(2000).parse(input.expected!.evidence),withheld:z.array(withheldProfileSchema).max(2000).parse(input.expected!.withheld)}:receipt;
 if(claim.state==='ready')return{kind:'computed' as const,state:'ready' as const,revisionId:claim.revisionId,outputHash:claim.outputHash};
 if(receipt.state!=='reserved_compact'&&input.expected&&(rankingHash(claim.evidence)!==rankingHash(input.expected.evidence)||rankingHash(claim.withheld)!==rankingHash(input.expected.withheld)))throw Error('RANKING_INPUT_CONFLICT');
 if(claim.contract.contractHash!==contract.contractHash||claim.inputHash!==rankingHash({contractHash:contract.contractHash,asOf:claim.asOf,evidence:claim.evidence,
  ...(claim.withheld.length?{withheld:claim.withheld}:{})}))throw Error('RANKING_INPUT_CONFLICT');
 const ranked=rankEvidence(contract,claim.evidence,claim.asOf),selected=new Map(ranked.selected.map(i=>[i.candidateId,i.selectedOrdinal]));
 const sourceTypes=new Map(claim.evidence.map(e=>[e.candidateId,e.presentationSource]));
 const items=ranked.items.map((item,index)=>{const sourceType=sourceTypes.get(item.candidateId);
  if(!sourceType)throw Error('RANKING_SOURCE_METADATA_MISSING');
  return{...item,ordinal:index+1,selectedOrdinal:selected.get(item.candidateId)??null,sourceType};});
 const result={inputHash:claim.inputHash,items},outputHash=rankingHash(result);
 if(evidenceBytes({...result,outputHash})>67_108_864)throw Error('RANKING_POOL_TOO_LARGE');
 const command={transportVersion:1 as const,inputHash:claim.inputHash,outputHash,itemsCanonical:items.map(canonical)};
 if(evidenceBytes(command)>2*67_108_864+65_536)throw Error('RANKING_POOL_TOO_LARGE');
 return{kind:'computed' as const,state:'reserved' as const,revisionId:claim.revisionId,lease:claim.lease,outputHash,command};
}

// Bound additional heaps to the production worker's two active searches.
// Queued callers retain existing heartbeat/recovery/lease behavior; no DB lock
// is held while waiting for this CPU lane, and no new retry is introduced.
let active=0;const waiting:(()=>void)[]=[];
async function acquire(){if(active<2){active++;return;}await new Promise<void>(resolve=>waiting.push(resolve));}
function release(){const next=waiting.shift();if(next)next();else active--;}
export async function runRankingComputation(message:ComputeInput):Promise<ReturnType<typeof computeRankingMessage>>{
 await acquire();let worker:Worker|undefined;
 try{
  worker=new Worker("require('tsx/cjs'); require(require('node:worker_threads').workerData.entry);",{
   eval:true,execArgv:[],workerData:{kind:'ranking-compute-v1',entry:resolve(process.cwd(),'src/lib/sourcing/rubric/ranking-compute-worker.ts')},
   env:{PATH:process.env.PATH??'/usr/bin:/bin',NODE_ENV:'production',TZ:'UTC'},
   resourceLimits:{maxOldGenerationSizeMb:512},
  });
  return await new Promise((yes,no)=>{
   worker!.once('message',(reply)=>reply?.ok===true?yes(reply.value):no(Error(typeof reply?.code==='string'&&/^RANKING_[A-Z_]+$/.test(reply.code)?reply.code:'RANKING_COMPUTE_FAILED')));
   worker!.once('error',()=>no(Error('RANKING_COMPUTE_FAILED')));
   worker!.once('exit',()=>no(Error('RANKING_COMPUTE_EXITED')));
   worker!.postMessage(message);
  });
 }finally{try{if(worker)await worker.terminate();}finally{release();}}
}
if(!isMainThread&&workerData?.kind==='ranking-compute-v1'){
 parentPort!.once('message',(message:ComputeInput)=>{
  try{parentPort!.postMessage({ok:true,value:computeRankingMessage(message)});}
  catch(error){const code=error instanceof Error&&/^RANKING_[A-Z_]+$/.test(error.message)?error.message:'RANKING_COMPUTE_INVALID';parentPort!.postMessage({ok:false,code});}
 });
}
