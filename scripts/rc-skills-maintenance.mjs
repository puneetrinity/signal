// Independent scheduler entrypoint. No provider import, no implicit recovery.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function main(args=process.argv.slice(2)){
 if(args.some(arg=>!['--once','--cleanup'].includes(arg))||new Set(args).size!==args.length)throw Error('RC_ARGUMENTS');
 if(process.env.RC_SKILLS_ENABLED!=='true'){
  console.log(JSON.stringify({event:'rc_watchdog_disabled',version:1}));return;
 }
 // Install the existing loader once for both ESM and transitive CJS imports.
 // Per-import scoped loaders can disagree on nested TypeScript dependencies.
 await import('tsx');
 const load=async path=>{const module=await import(path);return {...module.default,...module};};
 const {RcRepository}=await load('../src/lib/sourcing/rc-skills/repository.ts');
 const {runRcMaintenanceCycle,enqueueRcResumes}=await load('../src/lib/sourcing/rc-skills/maintenance.ts');
 const {createRcMemoryClient}=await load('../src/lib/sourcing/rc-skills/memory.ts');
 const {drainRcOutbox}=await load('../src/lib/sourcing/rc-skills/outbox.ts');
 const {repairRcPurchaseIngestion}=await load('../src/lib/sourcing/public-memory-ingest-outbox.ts');
 const {runPublicMemoryIngestCycle}=await load('../src/lib/sourcing/public-memory-ingest-worker.ts');
 const {prisma}=await load('../src/lib/prisma.ts');
 const repository=new RcRepository(),memory=createRcMemoryClient();
 let stop=false,lastCleanup=0;
 let watchdogBusy=false;
 const heartbeat=async()=>{
  if(watchdogBusy||stop)return;
  watchdogBusy=true;
  try{
   await runRcMaintenanceCycle({repository,enabled:true,cleanupDue:false,alertsOnly:true,deliver:async()=>false});
   console.log(JSON.stringify({event:'rc_watchdog_heartbeat',version:1,at:new Date().toISOString()}));
  }catch{console.error(JSON.stringify({event:'rc_watchdog_tick_failed',version:1,at:new Date().toISOString()}));}
  finally{watchdogBusy=false;}
 };
 // Recovery delivery can be slow without preventing independent stale-worker
 // detection. Never overlap watchdog transactions or declare delivery success.
 const watchdog=args.includes('--once')?null:setInterval(()=>{void heartbeat();},30000);
 const halt=()=>{stop=true;};process.on('SIGTERM',halt);process.on('SIGINT',halt);
 try{
  do{
   const started=Date.now(),cleanupDue=args.includes('--cleanup')||started-lastCleanup>=3600000;
   try{
    const resumed=await enqueueRcResumes(repository);
    const result=await runRcMaintenanceCycle({repository,enabled:true,cleanupDue,deliver:async run=>{
     const purchased=await repairRcPurchaseIngestion(run.tenantId,run.requestId,run.flowRunId);
     const skills=await drainRcOutbox({tenantId:run.tenantId,flowRunId:run.flowRunId,repository,memory,limit:25});
     return purchased&&!skills.pending;
    }});
    // Existing idempotent Memory ingest transport only; never Crustdata/RC.
    if(result.deliveriesAttempted)await runPublicMemoryIngestCycle({batchSize:25,concurrency:2});
    if(cleanupDue)lastCleanup=started;
    console.log(JSON.stringify({event:'rc_maintenance_cycle',version:1,at:new Date().toISOString(),...result,resumed}));
    if(resumed.failed && args.includes('--once'))process.exitCode=1;
   }catch{
    console.error(JSON.stringify({event:'rc_watchdog_cycle_failed',version:1,at:new Date().toISOString()}));
    if(args.includes('--once'))process.exitCode=1;
   }
   if(args.includes('--once'))break;
   // No overlapping cycles; external monitor alarms if no healthy heartbeat
   // for120s. SIGTERM is observed at most30s later, not an abandoned DB write.
   if(!stop)await new Promise(resolve=>setTimeout(resolve,Math.max(0,30000-(Date.now()-started))));
  }while(!stop);
 }finally{
  if(watchdog)clearInterval(watchdog);
  while(watchdogBusy)await new Promise(resolve=>setTimeout(resolve,25));
  process.off('SIGTERM',halt);process.off('SIGINT',halt);await prisma.$disconnect();
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(()=>{console.error('RC maintenance failed; no raw connection or profile details emitted.');process.exitCode=1;});
}
