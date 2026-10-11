import {z} from 'zod';
import {rcAlertSchema,deliverRcAlert,type RcAlert} from './alerts';
import type {RcRepository} from './repository';

const deliveries=z.object({version:z.literal(1),runs:z.array(z.object({
 tenantId:z.string().regex(/^org_[1-9][0-9]*$/),flowRunId:z.string().uuid(),requestId:z.string().min(1).max(200),
}).strict()).max(25)}).strict();
export type RcDeliveryRun=z.infer<typeof deliveries>['runs'][number];
const resumeSchema=z.object({tenantId:z.string().regex(/^org_[1-9][0-9]*$/),flowRunId:z.string().uuid(),token:z.string().uuid(),
 requestId:z.string().min(1).max(200),externalJobId:z.string().min(1).max(200),callbackUrl:z.string().url(),
 acquisitionGeneration:z.literal(1),executionAttemptId:z.string().uuid()}).strict();
export type RcResume=z.infer<typeof resumeSchema>;

/** Only database-recorded operator approvals are queued. A lost Redis reply
 * leaves the intent pending; stable job identity makes the next cycle safe. */
export async function enqueueRcResumes(repository:Pick<RcRepository,'maintenance'>,enqueue?:(run:RcResume)=>Promise<void>){
 const pending=z.object({version:z.literal(1),runs:z.array(resumeSchema).max(25)}).strict()
  .parse(await repository.maintenance({version:1,action:'resumes'}));
 let enqueued=0,failed=0;
 for(const run of pending.runs){
  try{
   if(enqueue)await enqueue(run);
   else{
    const {Queue}=await import('bullmq'),{default:Redis}=await import('ioredis');
    // Unlike the long-lived worker, an operations cycle must not wait forever
    // for Redis. A lost add response leaves the same durable token pending.
    const connection=new Redis(process.env.REDIS_URL??'redis://localhost:6379',{
     lazyConnect:true,enableOfflineQueue:false,maxRetriesPerRequest:1,retryStrategy:()=>null,
     connectTimeout:5000,commandTimeout:5000});
    connection.on('error',()=>{});
    let queue:InstanceType<typeof Queue>|undefined;
    try{
     await connection.connect();
     queue=new Queue(process.env.NODE_ENV==='production'?'sourcing':'sourcing_dev',{connection});
     await queue.add(`rc-resume-${run.token}`,{kind:'source',requestId:run.requestId,tenantId:run.tenantId,
      externalJobId:run.externalJobId,callbackUrl:run.callbackUrl,acquisitionGeneration:run.acquisitionGeneration,
      executionAttemptId:run.executionAttemptId},{jobId:`${run.requestId}-${run.executionAttemptId}-rc-${run.token}`,
       attempts:3,backoff:{type:'exponential',delay:5000},removeOnComplete:{count:500,age:86400},removeOnFail:{count:2000,age:604800}});
    }finally{connection.disconnect();await queue?.close();}
   }
   z.object({version:z.literal(1),state:z.literal('recorded')}).strict().parse(await repository.maintenance(
    {version:1,action:'resume_ack',tenantId:run.tenantId,flowRunId:run.flowRunId,token:run.token}));
   enqueued++;
  }catch{failed++;}
 }
 return {enqueued,failed};
}
export type RcMaintenanceSummary={enabled:boolean;stalled:number;alertsDelivered:number;alertsPending:number;
 deliveriesAttempted:number;deliveriesPending:number;cleaned:number;ready:number};

/** Independent watchdog cycle. No provider import/call and no implicit resume.
 * DB owns clock/claim/backoff/cleanup predicates. Each operation is bounded;
 * failures retain data and are visible to the scheduler's liveness monitor. */
export async function runRcMaintenanceCycle(input:{repository:Pick<RcRepository,'maintenance'>;
 enabled:boolean;cleanupDue:boolean;alertsOnly?:boolean;deliver:(run:RcDeliveryRun)=>Promise<boolean>;
 notify?:(event:RcAlert)=>Promise<boolean>}):Promise<RcMaintenanceSummary>{
 const summary:RcMaintenanceSummary={enabled:input.enabled,stalled:0,alertsDelivered:0,alertsPending:0,
  deliveriesAttempted:0,deliveriesPending:0,cleaned:0,ready:0};
 if(!input.enabled)return summary;
 const call=(action:string)=>input.repository.maintenance({version:1,action});
 const watchdog=z.object({version:z.literal(1),stalled:z.number().int().min(0).max(25)}).strict().parse(await call('tick'));
 summary.stalled=watchdog.stalled;
 const events=z.object({version:z.literal(1),events:z.array(rcAlertSchema).max(25)}).strict().parse(await call('alerts'));
 // Bounded concurrency, separate from the provider rate budget. One failed
 // destination cannot cancel successful sends or erase their acknowledgements.
 for(let i=0;i<events.events.length;i+=5){
  await Promise.all(events.events.slice(i,i+5).map(async event=>{
   let delivered=false;
   try{delivered=await (input.notify??deliverRcAlert)(event);}catch{delivered=false;}
   z.object({version:z.literal(1),state:z.literal('recorded')}).strict().parse(
    await input.repository.maintenance({version:1,action:'alert_result',id:event.id,delivered}));
   if(delivered)summary.alertsDelivered++;else summary.alertsPending++;
  }));
 }
 if(input.alertsOnly)return summary;
 const work=deliveries.parse(await call('deliveries'));
 for(const run of work.runs){
  summary.deliveriesAttempted++;
  let pending=true;
  try{pending=!await input.deliver(run);}catch{pending=true;}
  if(pending)summary.deliveriesPending++;
  z.object({version:z.literal(1),state:z.literal('recorded')}).strict().parse(
   await input.repository.maintenance({version:1,action:'delivery_result',tenantId:run.tenantId,flowRunId:run.flowRunId,pending}));
 }
 if(input.cleanupDue){
  const cleaned=z.object({version:z.literal(1),ready:z.number().int().min(0).max(25),cleaned:z.number().int().min(0).max(25)})
   .strict().parse(await call('cleanup'));
  summary.ready=cleaned.ready;summary.cleaned=cleaned.cleaned;
 }
 return summary;
}
