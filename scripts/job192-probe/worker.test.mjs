import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalBundle,approvalHash,run,checkEnvironment,WINDOW_MS} from './worker.mjs';

const SVC='22cae129-4438-448e-b644-9e3604c4d766', OTHER='00000000-0000-4000-8000-000000000000';
const preview={valid:true,runHash:'a'.repeat(64)};
const base=b=>({NODE_ENV:'production',LOG_LEVEL:'silent',DATABASE_URL:'postgresql://u@127.0.0.1:1/x',
  ACTIVEGRAPH_URL:'https://memory.example',SIGNAL_SCHEMA_TARGET_ID:'t',RAILWAY_SERVICE_ID:SVC,RAILWAY_DEPLOYMENT_ID:'d1',
  JOB192_RUN_HASH:b.runHash,JOB192_APPROVAL_NONCE:b.nonce,JOB192_APPROVAL_CREATED_AT:String(b.createdAt),
  JOB192_APPROVAL_EXPIRES_AT:String(b.expiresAt),JOB192_APPROVED_HASH:b.approvalHash});
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
