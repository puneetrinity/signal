// One-shot, rollback-only job-192 preparation probe for a temporary Railway service on the worker's network.
// Reuses the reviewed probe() and rollback wrapper unchanged. Two modes:
//   preview (operator, owner read-only): full validate() incl. RC/packets/lookups → prints the run fingerprint.
//   run     (temporary service, runtime role): refuses unless request+purchase+identity still match
//           JOB192_APPROVED_HASH and Memory shows no prepared packets; runs probe() once; re-checks; prints a
//           fixed-shape JSON result. Never prints rows, profiles, URLs, credentials or raw errors.
import pg from 'pg';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TARGET,validate,digest,requireThat} from './core.mjs';
import {probe} from './production.mjs';

const OWNER={tenantId:TARGET.tenantId,sourcingRequestId:TARGET.requestId,acquisitionReceiptId:TARGET.purchaseId,
  acquisitionGeneration:1,acquisitionSlot:'exact'};
const PAID=/^(CRUSTDATA|GROQ|REVERSECONTACT|REVERSE_CONTACT|FULLENRICH|FULL_ENRICH|ENRICHLAYER|SERPER|BRAVE|RC_API)_.*(KEY|TOKEN|SECRET)$/;

export function checkEnvironment(env){
  requireThat(env.NODE_ENV==='production'&&env.LOG_LEVEL==='silent'&&!env.SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER&&
    !env.REDIS_URL&&!env.REDIS_HOST&&!env.REDIS_PORT,'PROBE_ENVIRONMENT_REFUSED');
  requireThat(env.NODE_TLS_REJECT_UNAUTHORIZED!=='0','TLS_BYPASS_REFUSED');
  requireThat(!Object.keys(env).some(k=>PAID.test(k)&&env[k]),'PAID_CREDENTIALS_REFUSED');
}

async function readCore(db){
  // Rows the restricted runtime role may read; fingerprinted, never emitted.
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    const one=async(sql,args=[])=>{const r=await db.query(sql,args);requireThat(r.rowCount===1,'EXACT_ROW_REQUIRED');return r.rows[0].row;};
    const identity=await one('SELECT to_jsonb(i) row FROM signal_schema_control.target_identity i');
    const request=await one('SELECT to_jsonb(j) row FROM job_sourcing_requests j WHERE id=$1 AND "tenantId"=$2',[TARGET.requestId,TARGET.tenantId]);
    const purchase=await one('SELECT to_jsonb(a) row FROM crustdata_acquisition_receipts a WHERE id=$1 AND "tenantId"=$2',[TARGET.purchaseId,TARGET.tenantId]);
    await db.query('COMMIT');return {identity,request,purchase};
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
}
export const coreHash=c=>digest({identity:c.identity,request:c.request,purchase:c.purchase});

async function memorySnapshot(db){
  const r=await db.query('SELECT public.signal_memory_ingest($1::jsonb,$2::jsonb) AS result',[JSON.stringify(OWNER),JSON.stringify({action:'read'})]);
  requireThat(r.rowCount===1&&r.rows[0].result&&typeof r.rows[0].result.sealed==='boolean'&&Array.isArray(r.rows[0].result.members),'MEMORY_READ_REFUSED');
  return {sealed:r.rows[0].result.sealed,members:r.rows[0].result.members.length};
}

/** Operator preview over a read-only owner connection: Codex's full validate() plus the run fingerprint. */
export async function preview(db){
  const c=await readCore(db);
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let rc,counts;
  try{
    rc=(await db.query('SELECT to_jsonb(r) row FROM rc_sourcing_runs r WHERE request_id=$1',[TARGET.requestId])).rows[0]?.row;
    requireThat(rc,'EXACT_ROW_REQUIRED');
    counts=(await db.query(`SELECT
      (SELECT count(*)::int FROM crustdata_acquisition_receipts WHERE "sourcingRequestId"=$1) purchases,
      (SELECT count(*)::int FROM public_memory_ingest_requests WHERE request_id=$1) packets,
      (SELECT count(*)::int FROM rc_lookup_attempts WHERE run_id=$2::uuid) lookups`,[TARGET.requestId,rc.id])).rows[0];
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
  validate({...c,rc,counts});
  return {mode:'preview',valid:true,profiles:c.purchase.result.profiles.length,packets:counts.packets,
    rcLookups:counts.lookups,rcState:rc.state,runHash:coreHash(c),fullStateHash:digest({...c,rc,counts})};
}

export async function run(env){
  checkEnvironment(env);
  requireThat(/^[a-f0-9]{64}$/.test(env.JOB192_APPROVED_HASH??'')&&env.DATABASE_URL&&env.ACTIVEGRAPH_URL&&env.SIGNAL_SCHEMA_TARGET_ID,'RUN_CONFIG_REQUIRED');
  const db=new pg.Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:5000,
    options:'-c statement_timeout=10000 -c lock_timeout=1000'});
  await db.connect();
  try{
    const role=(await db.query(`SELECT rolsuper,rolbypassrls,
      has_table_privilege(current_user,'public.public_memory_ingest_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') direct_access,
      has_function_privilege(current_user,'public.signal_memory_ingest(jsonb,jsonb)','EXECUTE') entry_access
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    requireThat(role&&!role.rolsuper&&!role.rolbypassrls&&!role.direct_access&&role.entry_access,'RUNTIME_ROLE_REFUSED');
    const before=await readCore(db);
    requireThat(before.identity.target_id===env.SIGNAL_SCHEMA_TARGET_ID,'DATABASE_IDENTITY');
    requireThat(coreHash(before)===env.JOB192_APPROVED_HASH,'STATE_CHANGED_SINCE_PREVIEW');
    const mem0=await memorySnapshot(db);
    requireThat(!mem0.sealed&&mem0.members===0,'WORK_ALREADY_STARTED');
    const result=await probe(before,{prisma:env.DATABASE_URL},env.ACTIVEGRAPH_URL,async tx=>{
      const rows=await tx.$queryRawUnsafe(`SELECT id FROM job_sourcing_requests WHERE id=$1 AND "tenantId"=$2
        AND status='processing' AND execution_attempt_id=$3 AND processing_lease_id=$4`,
        TARGET.requestId,TARGET.tenantId,before.request.execution_attempt_id,before.request.processing_lease_id);
      requireThat(rows.length===1,'EXECUTION_CHANGED');
    });
    const after=await readCore(db),mem1=await memorySnapshot(db);
    const unchanged=coreHash(after)===coreHash(before)&&!mem1.sealed&&mem1.members===0;
    return {mode:'run',...result,unchanged,committedWrites:unchanged?0:'MANUAL_REVIEW',newPurchases:0,rcLookups:0};
  }finally{await db.end().catch(()=>{});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  run(process.env).then(r=>process.stdout.write('JOB192_PROBE_RESULT '+JSON.stringify(r)+'\n')).catch(e=>{
    const code=typeof e?.message==='string'&&/^[A-Z][A-Z0-9_]{2,63}$/.test(e.message)?e.message:'UNCLASSIFIED';
    process.stdout.write('JOB192_PROBE_REFUSED '+JSON.stringify({code})+'\n');process.exitCode=1;
  }).finally(()=>setTimeout(()=>process.exit(process.exitCode??0),500));
}
