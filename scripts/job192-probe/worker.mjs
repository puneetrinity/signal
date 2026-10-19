// One-shot, rollback-only job-192 preparation probe for a temporary Railway service on the worker's network.
// Reuses the reviewed probe() and rollback wrapper unchanged. Two modes:
//   preview (operator, owner read-only): full validate() incl. RC/packets/lookups → prints the run fingerprint.
//   run     (temporary service, runtime role): refuses unless request+purchase+identity still match
//           JOB192_APPROVED_HASH and Memory shows no prepared packets; runs probe() once; re-checks; prints a
//           fixed-shape JSON result. Never prints rows, profiles, URLs, credentials or raw errors.
import pg from 'pg';
import {resolve,join,isAbsolute} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {TARGET,validate,digest,requireThat} from './core.mjs';
import {probe} from './production.mjs';
import {consumeApproval} from './cli.mjs';

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
export const WINDOW_MS=15*60*1000;
/** Approval binds the exact core state, the one temporary service, a 15-minute window and a random nonce. */
export function approvalHash({runHash,serviceId,createdAt,expiresAt,nonce}){
  return digest({version:1,mode:'rollback-only',target:TARGET,runHash,serviceId,createdAt,expiresAt,nonce});
}

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
    rcLookups:counts.lookups,rcState:rc.state,runHash:coreHash(c),fullStateHash:fullHash(c,rc,counts)};
}
const fullHash=(c,rc,counts)=>digest({...c,rc,counts});

/** Operator approval bundle for the single temporary service (values go into its variables). */
export function approvalBundle(previewResult,serviceId,now=Date.now()){
  requireThat(previewResult.valid===true&&/^[0-9a-f-]{36}$/.test(serviceId),'PREVIEW_REQUIRED');
  const b={runHash:previewResult.runHash,serviceId,createdAt:now,expiresAt:now+WINDOW_MS,nonce:randomBytes(16).toString('hex')};
  return {...b,approvalHash:approvalHash(b)};
}

/** Operator postcheck over the read-only owner connection: full state incl. RC run and lookups must equal preview. */
export async function postcheck(db,previewResult){
  const p=await preview(db);
  return {mode:'postcheck',fullStateUnchanged:p.fullStateHash===previewResult.fullStateHash,
    packets:p.packets,rcLookups:p.rcLookups,rcState:p.rcState};
}

/** One-use, restart-safe claim on the temporary service's Railway volume (no database write). Reuses the reviewed
 * ledger: exclusive create of <approval>.spent, fsync file and directory. A restart, redeploy or concurrent run of the
 * same approval finds the file and refuses. Claimed before any database or Memory access; never cleared. */
export async function claimApproval(env,approval){
  const volume=env.RAILWAY_VOLUME_MOUNT_PATH;
  requireThat(typeof volume==='string'&&isAbsolute(volume),'DURABLE_VOLUME_REQUIRED');
  const directory=join(volume,'job192-ledger');
  await mkdir(directory,{recursive:true,mode:0o700});
  try{await consumeApproval(directory,approval);}
  catch(error){if(error?.code==='EEXIST')throw Error('APPROVAL_ALREADY_USED');throw error;}
}

export async function run(env){
  checkEnvironment(env);
  requireThat(/^[a-f0-9]{64}$/.test(env.JOB192_APPROVED_HASH??'')&&/^[a-f0-9]{64}$/.test(env.JOB192_RUN_HASH??'')&&
    /^[a-f0-9]{32}$/.test(env.JOB192_APPROVAL_NONCE??'')&&env.JOB192_APPROVAL_CREATED_AT&&env.JOB192_APPROVAL_EXPIRES_AT&&
    env.DATABASE_URL&&env.ACTIVEGRAPH_URL&&env.SIGNAL_SCHEMA_TARGET_ID&&env.RAILWAY_SERVICE_ID&&env.RAILWAY_DEPLOYMENT_ID,'RUN_CONFIG_REQUIRED');
  const createdAt=Number(env.JOB192_APPROVAL_CREATED_AT),expiresAt=Number(env.JOB192_APPROVAL_EXPIRES_AT),now=Date.now();
  requireThat(Number.isSafeInteger(createdAt)&&expiresAt===createdAt+WINDOW_MS&&createdAt<=now+60_000,'APPROVAL_INVALID');
  requireThat(now<expiresAt,'APPROVAL_EXPIRED');
  requireThat(approvalHash({runHash:env.JOB192_RUN_HASH,serviceId:env.RAILWAY_SERVICE_ID,createdAt,expiresAt,
    nonce:env.JOB192_APPROVAL_NONCE})===env.JOB192_APPROVED_HASH,'APPROVAL_MISMATCH');
  await claimApproval(env,env.JOB192_APPROVED_HASH); // consumed even if a later step refuses: no automatic retry
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
    requireThat(coreHash(before)===env.JOB192_RUN_HASH,'STATE_CHANGED_SINCE_PREVIEW');
    const mem0=await memorySnapshot(db);
    requireThat(!mem0.sealed&&mem0.members===0,'WORK_ALREADY_STARTED');
    const result=await probe(before,{prisma:env.DATABASE_URL},env.ACTIVEGRAPH_URL,async tx=>{
      const rows=await tx.$queryRawUnsafe(`SELECT id FROM job_sourcing_requests WHERE id=$1 AND "tenantId"=$2
        AND status='processing' AND execution_attempt_id=$3 AND processing_lease_id=$4`,
        TARGET.requestId,TARGET.tenantId,before.request.execution_attempt_id,before.request.processing_lease_id);
      requireThat(rows.length===1,'EXECUTION_CHANGED');
    });
    const after=await readCore(db),mem1=await memorySnapshot(db);
    // Only what this role actually verified. RC run/lookups are verified by the operator postcheck (owner read).
    return {mode:'run',...result,deploymentId:env.RAILWAY_DEPLOYMENT_ID,
      requestPurchaseUnchanged:coreHash(after)===coreHash(before),packetsAfter:mem1.members,sealedAfter:mem1.sealed,
      rcVerification:'operator_postcheck_required'};
  }finally{await db.end().catch(()=>{});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  run(process.env).then(r=>process.stdout.write('JOB192_PROBE_RESULT '+JSON.stringify(r)+'\n')).catch(e=>{
    const code=typeof e?.message==='string'&&/^[A-Z][A-Z0-9_]{2,63}$/.test(e.message)?e.message:'UNCLASSIFIED';
    process.stdout.write('JOB192_PROBE_REFUSED '+JSON.stringify({code})+'\n');
  // Always exit 0: the outcome is in the line above. A non-zero exit would trigger the shared railway.toml
  // ON_FAILURE restart policy and break the one-shot guarantee.
  }).finally(()=>setTimeout(()=>process.exit(0),500));
}
