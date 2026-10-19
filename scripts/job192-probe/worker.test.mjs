import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {approvalBundle,approvalHash,run,checkEnvironment,claimApproval,WINDOW_MS} from './worker.mjs';
const volume=()=>{const d=mkdtempSync(join(tmpdir(),'job192-vol-'));chmodSync(d,0o700);return d;};

const SVC='22cae129-4438-448e-b644-9e3604c4d766', OTHER='00000000-0000-4000-8000-000000000000';
const preview={valid:true,runHash:'a'.repeat(64)};
const base=b=>({NODE_ENV:'production',LOG_LEVEL:'silent',DATABASE_URL:'postgresql://u@127.0.0.1:1/x',
  ACTIVEGRAPH_URL:'https://memory.example',SIGNAL_SCHEMA_TARGET_ID:'t',RAILWAY_SERVICE_ID:SVC,RAILWAY_DEPLOYMENT_ID:'d1',
  JOB192_RUN_HASH:b.runHash,JOB192_APPROVAL_NONCE:b.nonce,JOB192_APPROVAL_CREATED_AT:String(b.createdAt),
  JOB192_APPROVAL_EXPIRES_AT:String(b.expiresAt),JOB192_APPROVED_HASH:b.approvalHash,RAILWAY_VOLUME_MOUNT_PATH:volume()});
const refusal=async env=>{try{await run(env);return 'NO_REFUSAL';}catch(e){return e.message;}};

test('bundle binds run hash, service, window and nonce; nonces differ',()=>{
  const a=approvalBundle(preview,SVC,1000),b=approvalBundle(preview,SVC,1000);
  assert.equal(a.expiresAt-a.createdAt,WINDOW_MS);assert.notEqual(a.nonce,b.nonce);assert.notEqual(a.approvalHash,b.approvalHash);
  assert.equal(approvalHash(a),a.approvalHash);
  assert.throws(()=>approvalBundle({valid:false,runHash:'a'.repeat(64)},SVC),/PREVIEW_REQUIRED/);
});
test('expired approval refuses before any database connection',async()=>{
  const b=approvalBundle(preview,SVC,Date.now()-WINDOW_MS-1);
  assert.equal(await refusal(base(b)),'APPROVAL_EXPIRED');
});
test('approval for another service refuses (copied variables)',async()=>{
  const b=approvalBundle(preview,OTHER);
  assert.equal(await refusal(base(b)),'APPROVAL_MISMATCH');
});
test('tampered run hash, nonce or window refuses',async()=>{
  const b=approvalBundle(preview,SVC);
  assert.equal(await refusal({...base(b),JOB192_RUN_HASH:'b'.repeat(64)}),'APPROVAL_MISMATCH');
  assert.equal(await refusal({...base(b),JOB192_APPROVAL_NONCE:'f'.repeat(32)}),'APPROVAL_MISMATCH');
  assert.equal(await refusal({...base(b),JOB192_APPROVAL_EXPIRES_AT:String(b.expiresAt+1)}),'APPROVAL_INVALID');
  assert.equal(await refusal({...base(b),JOB192_APPROVAL_CREATED_AT:String(Date.now()+120_000),
    JOB192_APPROVAL_EXPIRES_AT:String(Date.now()+120_000+WINDOW_MS)}),'APPROVAL_INVALID');
});
test('missing deployment/service identity or approval fields refuses',async()=>{
  const b=approvalBundle(preview,SVC);
  for(const k of ['RAILWAY_DEPLOYMENT_ID','RAILWAY_SERVICE_ID','JOB192_APPROVAL_NONCE','JOB192_RUN_HASH','JOB192_APPROVED_HASH']){
    const e=base(b);delete e[k];assert.equal(await refusal(e),'RUN_CONFIG_REQUIRED',k);
  }
});
test('valid approval passes the gate and reaches the database step',async()=>{
  const b=approvalBundle(preview,SVC);
  const r=await refusal(base(b));
  assert.ok(!['APPROVAL_EXPIRED','APPROVAL_MISMATCH','APPROVAL_INVALID','RUN_CONFIG_REQUIRED'].includes(r),r);
});
test('paid keys and Redis are refused',()=>{
  const e={NODE_ENV:'production',LOG_LEVEL:'silent'};
  for(const k of ['CRUSTDATA_API_KEY','REVERSECONTACT_API_KEY','GROQ_API_KEY','SERPER_API_KEY','FULLENRICH_API_KEY'])
    assert.throws(()=>checkEnvironment({...e,[k]:'x'}),/PAID_CREDENTIALS_REFUSED/);
  assert.throws(()=>checkEnvironment({...e,REDIS_URL:'redis://x'}),/PROBE_ENVIRONMENT_REFUSED/);
});

test('second run of the same approval on the same volume is refused (reaches no database)',async()=>{
  const b=approvalBundle(preview,SVC),env=base(b);
  const first=await refusal(env);
  assert.notEqual(first,'APPROVAL_ALREADY_USED');
  assert.ok(existsSync(join(env.RAILWAY_VOLUME_MOUNT_PATH,'job192-ledger',b.approvalHash+'.spent')));
  assert.equal(await refusal(env),'APPROVAL_ALREADY_USED');
});
test('concurrent runs of one approval: exactly one claims, the other is refused',async()=>{
  const b=approvalBundle(preview,SVC),env=base(b);
  const results=await Promise.all([refusal(env),refusal(env),refusal(env)]);
  assert.equal(results.filter(r=>r==='APPROVAL_ALREADY_USED').length,2,results.join(','));
});
test('restart-safe: a fresh process cannot reuse a claimed approval',async()=>{
  const b=approvalBundle(preview,SVC),env=base(b);
  await claimApproval(env,b.approvalHash);
  const code=`import {claimApproval} from './scripts/job192-probe/worker.mjs';
    try{await claimApproval(process.env,process.env.A);console.log('CLAIMED');}catch(e){console.log(e.message);}`;
  const r=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),encoding:'utf8',
    env:{...process.env,RAILWAY_VOLUME_MOUNT_PATH:env.RAILWAY_VOLUME_MOUNT_PATH,A:b.approvalHash,NODE_ENV:'production',LOG_LEVEL:'silent'}});
  assert.match(r.stdout,/APPROVAL_ALREADY_USED/,r.stderr);
});
test('no durable volume: refused before any database step',async()=>{
  const b=approvalBundle(preview,SVC),env=base(b);delete env.RAILWAY_VOLUME_MOUNT_PATH;
  assert.equal(await refusal(env),'DURABLE_VOLUME_REQUIRED');
  assert.equal(await refusal({...env,RAILWAY_VOLUME_MOUNT_PATH:'relative/path'}),'DURABLE_VOLUME_REQUIRED');
});
test('a different approval for the same service still claims independently',async()=>{
  const env=base(approvalBundle(preview,SVC)),b2=approvalBundle(preview,SVC);
  await claimApproval(env,b2.approvalHash);
  const b3=approvalBundle(preview,SVC);
  await assert.doesNotReject(claimApproval(env,b3.approvalHash));
});

