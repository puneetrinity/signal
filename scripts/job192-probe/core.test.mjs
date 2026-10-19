import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TARGET,plan,approve,rollbackPrisma,privacyOnlyFetch} from './core.mjs';

function state(){return {identity:{system:'discover',environment:'production',target_id:'synthetic'},
  request:{id:TARGET.requestId,tenantId:TARGET.tenantId,externalJobId:TARGET.externalJobId,status:'processing',
    protocol_version:2,acquisition_generation:1,execution_attempt_id:'attempt',processing_lease_id:'lease',completedAt:null},
  purchase:{id:TARGET.purchaseId,tenantId:TARGET.tenantId,sourcingRequestId:TARGET.requestId,acquisitionGeneration:1,
    slot:'exact',status:'complete',memory_delivery_contract:2,memory_prepared_at:null,memory_ingested_at:null,
    memory_member_count:null,result:{profiles:Array.from({length:300},(_,i)=>({crustdata_person_id:i+1}))}},
  rc:{request_id:TARGET.requestId,state:'stalled',paid_lookups:0,rc_started_at:null,resume_token:null,resume_enqueued_at:null,
    execution_attempt_id:'attempt',processing_lease_id:'lease'},counts:{purchases:1,packets:0,lookups:0}};}
test('fresh exact plan approves; expired, changed, forged and wrong-code plans refuse',()=>{
  const s=state(),p=plan(s,'source',1000);
  approve(p,p.approvalHash,s,'source',2000);
  assert.throws(()=>approve(p,'0'.repeat(64),s,'source',2000));
  assert.throws(()=>approve(p,p.approvalHash,s,'source',p.expiresAt));
  assert.throws(()=>approve(p,p.approvalHash,s,'new-source',2000));
  assert.throws(()=>approve({...p,mode:'commit'},p.approvalHash,s,'source',2000));
  s.request.processing_lease_id='new-lease';
  assert.throws(()=>approve(p,p.approvalHash,s,'source',2000));
});
for(const [name,change] of [
  ['other job',s=>s.request.externalJobId='vanta:jobs:190'],
  ['wrong purchase',s=>s.purchase.id='other'],['old contract',s=>s.purchase.memory_delivery_contract=1],
  ['sealed',s=>s.purchase.memory_prepared_at='now'],['RC started',s=>s.rc.rc_started_at='now'],
  ['paid lookup',s=>s.rc.paid_lookups=1],['queued resume',s=>s.rc.resume_token='token'],
  ['packets exist',s=>s.counts.packets=1],['another purchase',s=>s.counts.purchases=2],
  ['lookup exists',s=>s.counts.lookups=1],['duplicate provider',s=>s.purchase.result.profiles[1]=s.purchase.result.profiles[0]],
])test('preview refuses '+name,()=>{const s=state();change(s);assert.throws(()=>plan(s,'source'));});
test('a successful callback still rolls back; second transaction refused',async()=>{
  let commits=0,rollbacks=0;
  const real={$transaction:async fn=>{try{await fn({});commits++;}catch(e){rollbacks++;throw e;}}};
  const wrapper=rollbackPrisma(real);
  await assert.rejects(wrapper.client.$transaction(async()=>{}, {maxWait:2000,timeout:5000}),e=>e===wrapper.sentinel);
  assert.equal(commits,0);assert.equal(rollbacks,1);assert.equal(wrapper.completed,true);
  await assert.rejects(wrapper.client.$transaction(async()=>{}, {maxWait:2000,timeout:5000}));
  assert.equal(rollbacks,1);
});
test('original failure propagates; callback is not retried',async()=>{
  const error=Error('private');let calls=0;
  const real={$transaction:async fn=>{calls++;return fn({});}};
  const wrapper=rollbackPrisma(real);
  await assert.rejects(wrapper.client.$transaction(async()=>{throw error;},{maxWait:2000,timeout:5000}),e=>e===error);
  assert.equal(calls,1);assert.equal(wrapper.completed,false);
});
test('SQL actions cannot drain/ack/complete or write outside transaction',async()=>{
  let calls=0;
  const fake={$queryRawUnsafe:()=>{calls++;return[];},$transaction:async fn=>fn(fake)};
  const w=rollbackPrisma(fake),owner={tenantId:TARGET.tenantId,sourcingRequestId:TARGET.requestId,
    acquisitionReceiptId:TARGET.purchaseId,acquisitionGeneration:1,acquisitionSlot:'exact'};
  const sql='SELECT public.signal_memory_ingest($1::jsonb,$2::jsonb) AS result';
  for(const action of ['append','seal','claim','ack','fail','complete','compact','suppress_member'])
    assert.throws(()=>w.client.$queryRawUnsafe(sql,JSON.stringify(owner),JSON.stringify({action})));
  assert.throws(()=>w.client.$queryRawUnsafe('DELETE FROM anything'));
  assert.throws(()=>w.client.$executeRawUnsafe('COMMIT'));
  await assert.rejects(w.client.$transaction(async tx=>tx.$queryRawUnsafe(sql,JSON.stringify(owner),JSON.stringify({action:'claim'})),{maxWait:2000,timeout:5000}));
  assert.equal(calls,0);
});
test('only fixed HTTPS read endpoints pass, redirect error forced, call cap enforced',async()=>{
  const calls=[];const fetch=privacyOnlyFetch('https://memory.example',async(u,i)=>{calls.push([u,i]);return {};},2);
  await fetch('https://memory.example/candidate-privacy/snapshot?limit=1');
  await fetch('https://memory.example/candidate-privacy/eligibility/batch',{method:'POST',redirect:'follow'});
  assert.equal(calls[1][1].redirect,'error');
  for(const url of ['https://crustdata.example/search','https://memory.example/sourced-candidates/ingest',
    'https://memory.example/candidate-privacy/snapshot?limit=100','http://memory.example/candidate-privacy/snapshot?limit=1'])
    await assert.rejects(fetch(url));
  await assert.rejects(fetch('https://memory.example/candidate-privacy/snapshot?limit=1'));
  assert.equal(calls.length,2);
});
