import {createHash} from 'node:crypto';
import {z} from 'zod';
import {rankingHash} from '../rubric/contracts';
import {cacheFinishSchema,rcHashSchema} from './contracts';
import {RcMemoryError,type RcMemoryClient} from './memory';
import type {RcRepository} from './repository';

const claimSchema=z.discriminatedUnion('state',[
 z.object({version:z.literal(1),state:z.literal('empty')}).strict(),
 z.object({version:z.literal(1),state:z.literal('suppressed'),id:z.string().uuid()}).strict(),
 z.object({version:z.literal(1),state:z.literal('claimed'),id:z.string().uuid(),payloadHash:rcHashSchema,payload:cacheFinishSchema}).strict(),
]);
const ackSchema=z.discriminatedUnion('state',[
 z.object({version:z.literal(1),state:z.literal('delivered'),id:z.string().uuid(),replayed:z.boolean()}).strict(),
 z.object({version:z.literal(1),state:z.literal('suppressed'),id:z.string().uuid()}).strict(),
]);
export function rcOutboxPayloadHash(payload:z.infer<typeof cacheFinishSchema>):string {
 return createHash('sha256').update(`${payload.originRun}:${payload.originAttempt}:${payload.globalCandidateId}:${payload.observation.contentHash}`).digest('hex');
}

/** Retry only idempotent Memory delivery, never an RC provider request. Each
 * claim rechecks privacy and has a durable retry delay; no hot retry loop and
 * no edits to a sealed ranking. The maintenance caller owns incident delivery.
 */
export async function drainRcOutbox(input:{tenantId:string;flowRunId:string;repository:Pick<RcRepository,'outbox'>;
 memory:RcMemoryClient;limit?:number}):Promise<{delivered:number;suppressed:number;pending:boolean;reason:'none'|'memory_unavailable'|'memory_refused'}> {
 const limit=input.limit??25;if(!Number.isSafeInteger(limit)||limit<1||limit>300)throw Error('RC_OUTBOX_LIMIT');
 let delivered=0,suppressed=0;
 for(let index=0;index<limit;index++){
  const entry=claimSchema.parse(await input.repository.outbox(input.tenantId,input.flowRunId,{version:1,action:'claim',id:null,receiptHash:null}));
  if(entry.state==='empty')return {delivered,suppressed,pending:false,reason:'none'};
  if(entry.state==='suppressed'){suppressed++;continue;}
  if(entry.payloadHash!==rcOutboxPayloadHash(entry.payload))throw Error('RC_OUTBOX_CONFLICT');
  try{
   const receipt=await input.memory.finish(input.tenantId,entry.payload);
   if(receipt.contentHash!==entry.payload.observation.contentHash)throw Error('RC_OUTBOX_CONFLICT');
   // Ignore stored/replayed transport status: the stable receipt is identical
   // when Memory succeeded but the local acknowledgement was lost.
   const receiptHash=rankingHash({version:1,receiptId:receipt.receiptId,contentHash:receipt.contentHash});
   const ack=ackSchema.parse(await input.repository.outbox(input.tenantId,input.flowRunId,{version:1,action:'ack',id:entry.id,receiptHash}));
   if(ack.id!==entry.id)throw Error('RC_OUTBOX_CONFLICT');
   if(ack.state==='suppressed')suppressed++;else delivered++;
  }catch(error){
   if(!(error instanceof RcMemoryError))throw error;
   return {delivered,suppressed,pending:true,reason:error.retryable?'memory_unavailable':'memory_refused'};
  }
 }
 return {delivered,suppressed,pending:true,reason:'none'};
}
