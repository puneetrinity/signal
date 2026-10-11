// Owner-only, explicit operator tool. Never loads dotenv or provider credentials.
// Default is a counts-only status read. Mutations require a reviewed command file.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';

export function parseRecoveryArgs(args){
 const options={};
 for(let i=0;i<args.length;i++){
  const key=args[i];
  if(!['--tenant','--run','--command-file','--approve-recovery'].includes(key)||key in options)throw Error('RC_ARGUMENTS');
  if(key==='--approve-recovery')options[key]=true;
  else {const value=args[++i];if(!value||value.startsWith('--'))throw Error('RC_ARGUMENTS');options[key]=value;}
 }
 if(!/^org_[1-9][0-9]*$/.test(options['--tenant']??'')||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options['--run']??''))throw Error('RC_ARGUMENTS');
 if(Boolean(options['--command-file'])!==Boolean(options['--approve-recovery']))throw Error('RC_EXPLICIT_RECOVERY_REQUIRED');
 return options;
}

export async function main(args=process.argv.slice(2)){
 const options=parseRecoveryArgs(args);
 const dsn=process.env.RC_SKILLS_OWNER_DATABASE_URL;
 if(!dsn)throw Error('RC_EXPLICIT_OWNER_CONNECTION_REQUIRED');
 let command;
 if(options['--command-file']){
  const bytes=readFileSync(resolve(options['--command-file']));
  if(bytes.length>4096)throw Error('RC_INVALID_COMMAND');
  command=JSON.parse(bytes.toString('utf8'));
  if(!command||command.version!==1||!['resume','close','ack','hold'].includes(command.action)||
   typeof command.expectedRevision!=='string'||!/^\d+$/.test(command.expectedRevision)||
   typeof command.reason!=='string'||command.reason.trim().length<1||command.reason.length>160||
   typeof command.requestId!=='string')throw Error('RC_INVALID_COMMAND');
 }
 const client=new pg.Client({connectionString:dsn,connectionTimeoutMillis:5000,query_timeout:15000});
 await client.connect();
 try{
  await client.query('BEGIN');
  if(!command)await client.query('SET TRANSACTION READ ONLY');
  const role=await client.query("SELECT current_user=(SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='rc_sourcing_runs') AS owner");
  if(role.rows[0]?.owner!==true)throw Error('RC_OWNER_REQUIRED');
  if(command){
   const result=await client.query('SELECT public.signal_rc_recover($1,$2::uuid,$3::jsonb) result',
    [options['--tenant'],options['--run'],JSON.stringify(command)]);
   await client.query('COMMIT');
   const receipt=result.rows[0]?.result;
   console.log(JSON.stringify({version:1,action:receipt.action,state:receipt.state,revision:receipt.revision,
    requestId:receipt.requestId,receiptHash:receipt.receiptHash}));
  }else{
   // Explicit projection: never print baseline, skills, candidate IDs or emails.
   const result=await client.query(`SELECT r.id,r.state,r.revision::text,r.deadline_at,r.retention_hold,r.cleaned_at,
    r.rc_available,r.paid_lookups,(r.resume_token IS NOT NULL AND r.resume_enqueued_at IS NULL) AS enqueue_pending,
    (SELECT count(*)::int FROM public.rc_operations_events e WHERE e.run_id=r.id AND e.delivered_at IS NULL) AS undelivered_alerts,
    (SELECT count(*)::int FROM public.rc_skill_outbox o JOIN public.rc_lookup_attempts a ON a.id=o.attempt_id WHERE a.run_id=r.id AND o.state='pending') AS pending_skill_deliveries,
    (SELECT count(*)::int FROM public.crustdata_acquisition_receipts c WHERE c."tenantId"=r.tenant_id AND c."sourcingRequestId"=r.request_id
     AND c."acquisitionGeneration"=r.generation AND c.status='complete' AND c.memory_ingested_at IS NULL) AS pending_purchase_deliveries
    FROM public.rc_sourcing_runs r WHERE r.tenant_id=$1 AND r.flow_run_id=$2::uuid`,[options['--tenant'],options['--run']]);
   await client.query('ROLLBACK');
   console.log(JSON.stringify({version:1,runs:result.rows}));
  }
 }catch{await client.query('ROLLBACK').catch(()=>{});throw Error('RC_OPERATOR_ACTION_REFUSED');}
 finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(()=>{console.error('RC recovery command failed; no raw connection or database details emitted.');process.exitCode=1;});
}
