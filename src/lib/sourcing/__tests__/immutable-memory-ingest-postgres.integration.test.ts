import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ImmutableMemoryRepository, awaitMemoryAcquisition, runImmutableMemoryCycle, prepareMemoryPacket, type FrozenMemoryPacket, type MemoryAcquisitionOwner } from '../immutable-memory-ingest';
import { repairRcPurchaseIngestion } from '../public-memory-ingest-outbox';
import { memoryPreparationFailure } from '../memory-preparation-diagnostics';
import type { CandidateForRanking } from '../ranking-new';

const enabled=process.env.RUN_SIGNAL_IMMUTABLE_POSTGRES==='1';
const bridge=vi.hoisted(()=>({db:null as import('@prisma/client').PrismaClient|null}));
vi.mock('@/lib/prisma',()=>({prisma:new Proxy({},{get(_target,key){const db=bridge.db!;const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}})}));
vi.mock('@/lib/candidate-privacy/decision',()=>({
 createCandidateAdmissionProofs:async(anchors:Array<{key:string}>)=>{
  if(new Set(anchors.map(a=>a.key)).size!==anchors.length)throw Error('duplicate privacy anchor key');
  return new Map(anchors.map(a=>[a.key,{generation:BigInt(1),cursor:BigInt(0)}]));
 },
 requireNewCandidateAllowed:async()=>({generation:BigInt(1),cursor:BigInt(0)}),
}));
vi.mock('@/lib/candidate-privacy/repository',async(importOriginal)=>({
 ...await importOriginal<typeof import('@/lib/candidate-privacy/repository')>(),
 requireHealthyCandidatePrivacyContext:async()=>({generation:BigInt(1),cursor:BigInt(0)}),assertAdmissionProofCurrent:async()=>{},
}));
vi.mock('../activegraph-auth',()=>({signSourcedCandidateIngestJWT:async()=>'synthetic-test-token',signActiveGraphJWT:vi.fn()}));
vi.mock('../rc-skills/repository',()=>({RcRepository:class {async progress(){return {state:'partial'};}}}));
describe.skipIf(!enabled)('immutable purchased-profile queue: real migrations and restricted runtime',()=>{
 let admin:Client,owner:Client,runtime:Client;
 const database=`signal_immutable_ingest_test_${process.pid}`;
 const ownerRole=`immutable_owner_test_${process.pid}`,runtimeRole=`immutable_runtime_test_${process.pid}`;
 let created=false;
 const fence={executionAttemptId:'execution-test',processingLeaseId:'processing-test'};
 const at=new Date('2026-10-19T00:00:00.000Z');
 const globalId='11111111-1111-4111-8111-111111111111';
 const call=async(db:Client,o:MemoryAcquisitionOwner,c:unknown)=>(await db.query(
  'SELECT public.signal_memory_ingest($1::jsonb,$2::jsonb) result',[JSON.stringify(o),JSON.stringify(c)])).rows[0].result;
 async function fixture(count=1,contract=2){
  const id=randomUUID();
  const o:MemoryAcquisitionOwner={tenantId:'org_32',sourcingRequestId:id,acquisitionReceiptId:`receipt-${id}`,acquisitionGeneration:1,acquisitionSlot:'exact'};
  await owner.query(`INSERT INTO job_sourcing_requests(id,"tenantId","externalJobId","jobContextHash","jobContext","callbackUrl",status,protocol_version,execution_attempt_id,processing_lease_id,flow_run_id,artifact_hash)
    VALUES($1::text,'org_32',$1::text,$1::text,'{}','https://example.invalid/callback','processing',2,$2,$3,$1::text::uuid,repeat('a',64))`,[id,fence.executionAttemptId,fence.processingLeaseId]);
  await owner.query(`INSERT INTO crustdata_acquisition_receipts(id,"tenantId","sourcingRequestId","acquisitionGeneration",slot,status,"requestFingerprint","requestInput","requestMetadata",result,"updatedAt",memory_delivery_contract)
    VALUES($1,'org_32',$2,1,'exact','complete',$3,'{}','{}',$4::jsonb,clock_timestamp(),$5)`,
   [o.acquisitionReceiptId,id,'a'.repeat(64),JSON.stringify({profiles:Array.from({length:count},(_,i)=>({crustdata_person_id:i+1}))}),contract]);
  const packets=Array.from({length:count},(_,i)=>prepareMemoryPacket(o,{
   id:`https://linkedin.com/in/synthetic-${i}`,headlineHint:'Engineer',searchTitle:'Engineer',locationHint:'Bengaluru, India',searchSnippet:'Synthetic profile',
   snapshot:null,lastEnrichedAt:null,enrichmentStatus:'pending',
   crustdata:{crustdata_person_id:i+1,basic_profile:{name:'Synthetic Person',summary:'Built distributed services. '.repeat(100)},
    skills:{professional_network_skills:Array.from({length:50},(_,j)=>`Skill ${j}`)}},
  } as CandidateForRanking,{...o,acquiredAt:at,profileObservedAt:at,expectedGlobalCandidateId:globalId}));
  return {o,packets};
 }
 async function seal(o:MemoryAcquisitionOwner,packets:FrozenMemoryPacket[]){
  await runtime.query('BEGIN');
  try{
   for(let i=0;i<packets.length;i+=25)await call(runtime,o,{action:'append',...fence,packets:packets.slice(i,i+25)});
   const result=await call(runtime,o,{action:'seal',...fence});await runtime.query('COMMIT');return result;
  }catch(e){await runtime.query('ROLLBACK');throw e;}
 }
 function result(p:FrozenMemoryPacket,conflict=false){return {success:true,signalCandidateId:p.signalCandidateId,memoryCandidateId:null,
  globalCandidateId:conflict?null:globalId,sourceRecordId:p.idempotencyKey,ingestReceiptId:p.idempotencyKey,
  resolutionStatus:conflict?'conflict_review_required':'refreshed',deliveryStatus:'recorded',sourceIdentityId:conflict?null:globalId,sourceObservationId:globalId,errorCode:null};}
 beforeAll(async()=>{
  const raw=process.env.SIGNAL_IMMUTABLE_TEST_ADMIN_URL;
  if(!raw)throw Error('disposable admin URL required');
  const url=new URL(raw);
  if(!['127.0.0.1','localhost'].includes(url.hostname)||!/(postgres|test)/.test(url.pathname))throw Error('local disposable database required');
  admin=new Client({connectionString:raw});await admin.connect();
  await admin.query(`CREATE ROLE ${ownerRole} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'local-test-only'`);
  await admin.query(`CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'local-test-only'`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${ownerRole}`);created=true;
  url.pathname=`/${database}`;url.username=ownerRole;url.password='local-test-only';owner=new Client({connectionString:url.toString()});await owner.connect();
  const root=process.cwd();const baseline=JSON.parse(await readFile(resolve(root,'prisma/baseline/manifest.json'),'utf8'));
  await owner.query(await readFile(resolve(root,baseline.baselinePath),'utf8'));
  const migrations=(await readdir(resolve(root,'prisma/migrations'))).filter(n=>/^\d{14}_/.test(n)&&n>baseline.baselineMigrationThrough).sort();
  for(const name of migrations){
   if(name==='20261020010000_memory_wait_progress')console.info('PROGRESS_PREDECESSORS',(await owner.query(
    "SELECT oid::regprocedure::text signature,md5(prosrc) digest FROM pg_proc WHERE oid IN ('signal_rc_maintain(jsonb)'::regprocedure,'signal_rc_read(text,uuid)'::regprocedure,'signal_memory_ingest(jsonb,jsonb)'::regprocedure) ORDER BY 1")).rows);
   await owner.query('BEGIN');try{await owner.query(await readFile(resolve(root,'prisma/migrations',name,'migration.sql'),'utf8'));await owner.query('COMMIT');}catch(e){await owner.query('ROLLBACK');throw e;}}
  const {MEMORY_CATALOG_SQL,MEMORY_CATALOG_SHA256}=await import('../../../../scripts/check-immutable-memory-ingest.mjs');
  const catalog=(await owner.query(MEMORY_CATALOG_SQL)).rows[0].digest;
  expect(catalog).toBe(MEMORY_CATALOG_SHA256);console.info('MEMORY_CATALOG',catalog);
  const {RC_CATALOG_SQL,RC_CATALOG_SHA256}=await import('../../../../scripts/check-rc-skills.mjs');
  expect((await owner.query(RC_CATALOG_SQL)).rows[0].digest).toBe(RC_CATALOG_SHA256);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
  await owner.query(`GRANT SELECT ON job_sourcing_requests,crustdata_acquisition_receipts TO ${runtimeRole}`);
  await owner.query(`GRANT EXECUTE ON FUNCTION signal_memory_ingest(jsonb,jsonb) TO ${runtimeRole}`);
  await owner.query(`GRANT EXECUTE ON FUNCTION signal_memory_ingest_lag_ids(text[],timestamptz,integer) TO ${runtimeRole}`);
  await owner.query(`GRANT EXECUTE ON FUNCTION signal_memory_ingest_work(text,text,integer) TO ${runtimeRole}`);
  url.username=runtimeRole;runtime=new Client({connectionString:url.toString()});await runtime.connect();
  bridge.db=new PrismaClient({datasources:{db:{url:url.toString()}}});
 },120000);
 afterAll(async()=>{vi.unstubAllGlobals();await bridge.db?.$disconnect();await runtime?.end();await owner?.end();if(created)await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
  if(admin){await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`);await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);await admin.end();}},30000);
 const exclusion=(providerRecordId:string)=>({index:Number(providerRecordId)-1,providerRecordId,
  candidateFingerprint:'e'.repeat(64),reason:'linkedin_invalid'});
 it('keeps 300 slow acknowledgements alive across watchdog ticks and restart, but not heartbeat-only hangs',async()=>{
  const {o,packets}=await fixture(300), policy=randomUUID(), runId=randomUUID();
  await owner.query(`INSERT INTO governed_sourcing_tenants(tenant_id,enabled_at,policy_hash,organization_ref,callback_url)
   VALUES('org_32',clock_timestamp(),repeat('a',64),'32','https://example.invalid/callback') ON CONFLICT DO NOTHING`);
  await owner.query(`INSERT INTO governed_sourcing_bindings(tenant_id,flow_run_id,request_id,artifact_hash,organization_ref,external_job_id,command)
   VALUES('org_32',$1::text::uuid,$1::text,repeat('a',64),'32','synthetic','{}')`,[o.sourcingRequestId]);
  await owner.query(`INSERT INTO rc_rate_policies(id,policy_hash,enabled) VALUES($1,$2,false)`,[policy,policy.replaceAll('-','').repeat(2)]);
  await owner.query(`INSERT INTO rc_sourcing_runs(id,tenant_id,flow_run_id,request_id,generation,policy_id,brief_hash,state,
   execution_attempt_id,processing_lease_id,rc_available,protocol_mode)
   VALUES($1,'org_32',$2::text::uuid,$2::text,1,$3,repeat('a',64),'admitted',$4,$5,false,2)`,
   [runId,o.sourcingRequestId,policy,fence.executionAttemptId,fence.processingLeaseId]);
  const signatures=['signal_memory_ingest(jsonb,jsonb)','signal_rc_maintain(jsonb)','signal_rc_read(text,uuid)'];
  const definitions=await Promise.all(signatures.map(async s=>(await owner.query('SELECT pg_get_functiondef($1::regprocedure) d',[s])).rows[0].d as string));
  // Virtual database clock, not a replacement watchdog or sender. Every production
  // routine and row/lease check still runs; 10 minutes need not cost 10 wall minutes.
  await owner.query(`CREATE FUNCTION lifecycle_test_clock() RETURNS timestamptz LANGUAGE sql STABLE AS
   $$ SELECT current_setting('test.lifecycle_at')::timestamptz $$`);
  const start=Date.now();
  let seconds=0;
  async function clock(seconds:number){
   for(const db of [owner,runtime])await db.query("SELECT set_config('test.lifecycle_at',$1,false)",[new Date(start+seconds*1000).toISOString()]);
  }
  async function tick(){
   await owner.query("SELECT signal_rc_maintain('{\"version\":1,\"action\":\"tick\"}')");
   return (await owner.query('SELECT state FROM rc_sourcing_runs WHERE id=$1',[runId])).rows[0].state;
  }
  async function heartbeat(){
   await runtime.query(`SELECT signal_rc_maintain($1::jsonb)`,[JSON.stringify({version:1,action:'heartbeat',
    tenantId:'org_32',flowRunId:o.sourcingRequestId,...fence})]);
  }
  await owner.query(`GRANT EXECUTE ON FUNCTION signal_rc_maintain(jsonb),signal_rc_read(text,uuid),lifecycle_test_clock() TO ${runtimeRole}`);
  try{
   for(const d of definitions)await owner.query(d.replaceAll('clock_timestamp()','public.lifecycle_test_clock()'));
   await clock(0);
   const sealed=await seal(o,packets);
   expect(Date.parse(sealed.deadlineAt)-start).toBe(900000);
   seconds=1;await clock(seconds);
   let batches=0;
   const members=await awaitMemoryAcquisition(o,{
    read:async()=>call(runtime,o,{action:'read'}),
    drain:async()=>{
     if(batches===10){
      // Mutation witness: the old watchdog stalls the same progressing run.
      await owner.query('BEGIN');
      try{
       await owner.query(definitions[1].replaceAll('clock_timestamp()','public.lifecycle_test_clock()')
        .replace('public.signal_memory_rc_progress(rc_sourcing_runs)','last_progress_at'));
       expect(await tick()).toBe('stalled');
      }finally{await owner.query('ROLLBACK');}
     }
     const claimed=await call(runtime,o,{action:'claim',limit:10});
     expect(claimed).toHaveLength(10);
     for(const row of claimed)await call(runtime,o,{action:'ack',id:row.id,leaseToken:row.leaseToken,result:result(row.packet)});
     // Duplicate acknowledgement is not new progress.
     expect(await call(runtime,o,{action:'ack',id:claimed[0].id,leaseToken:claimed[0].leaseToken,result:result(claimed[0].packet)})).toBe(false);
     const progress=(await runtime.query('SELECT signal_rc_read($1,$2) result',['org_32',o.sourcingRequestId])).rows[0].result;
     expect(progress.progress.state).not.toBe('stalled');
     batches++;
    },
   },Date.parse(sealed.deadlineAt),{
    now:()=>start+seconds*1000,
    sleep:async()=>{seconds+=20;await clock(seconds);},
    assertExecution:async()=>{await heartbeat();expect(await tick()).toBe('admitted');},
   });
   expect(batches).toBe(30);expect(members).toHaveLength(300);expect(seconds).toBe(601);
   expect((await new ImmutableMemoryRepository().read(o)).members.every(m=>m.state==='succeeded')).toBe(true);
   expect(await call(runtime,o,{action:'complete'})).toBe(true);
   expect((await owner.query('SELECT paid_lookups FROM rc_sourcing_runs WHERE id=$1',[runId])).rows[0].paid_lookups).toBe(0);
   expect((await owner.query('SELECT count(*)::int n FROM crustdata_acquisition_receipts WHERE "sourcingRequestId"=$1',[o.sourcingRequestId])).rows[0].n).toBe(1);
   expect((await call(runtime,o,{action:'seal',...fence})).deadlineAt).toBe(sealed.deadlineAt);
   // No acknowledgement from a foreign/stale execution, generation or phase can
   // keep this run alive. Exercise the private helper without giving runtime access.
   for(const patch of [
    {tenant_id:'org_99'},{request_id:randomUUID()},{generation:2},
    {execution_attempt_id:'old'},{processing_lease_id:'old'},{baseline:{}},
    {state:'prepared'},{protocol_mode:1},
   ]){
    const row=(await owner.query(`SELECT public.signal_memory_rc_progress(
     jsonb_populate_record(NULL::rc_sourcing_runs,to_jsonb(r)||$2::jsonb))=r.last_progress_at AS ignored
     FROM rc_sourcing_runs r WHERE id=$1`,[runId,JSON.stringify(patch)])).rows[0];
    expect(row.ignored).toBe(true);
   }
   await expect(runtime.query('SELECT public.signal_memory_rc_progress(NULL::rc_sourcing_runs)')).rejects.toThrow(/permission denied/);
   await owner.query('BEGIN');
   try{
    await owner.query("UPDATE governed_sourcing_bindings SET cancellation='{}' WHERE request_id=$1",[o.sourcingRequestId]);
    expect((await owner.query('SELECT signal_memory_rc_progress(r)=last_progress_at AS ignored FROM rc_sourcing_runs r WHERE id=$1',[runId])).rows[0].ignored).toBe(true);
   }finally{await owner.query('ROLLBACK');}
   // A live but idle worker cannot keep a run alive after real progress stops.
   await clock(710);await heartbeat();expect(await tick()).toBe('stalled');
   // Heartbeat expiry wins even when progress is recent.
   await owner.query(`UPDATE rc_sourcing_runs SET state='admitted',stalled_at=NULL,
    last_progress_at=public.lifecycle_test_clock(),heartbeat_at=public.lifecycle_test_clock()-interval '91 seconds' WHERE id=$1`,[runId]);
   expect(await tick()).toBe('stalled');
  }finally{
   for(const d of definitions)await owner.query(d);
   await owner.query("UPDATE public_memory_ingest_requests SET state='blocked',failure_code='unexpected' WHERE acquisition_id=$1 AND state IN ('pending','leased','retry_wait')",[o.acquisitionReceiptId]);
   await owner.query('DROP FUNCTION lifecycle_test_clock()');
  }
 },30000);
 it('seals 299 packets plus one recorded exclusion, survives restart, and never sends the excluded member',async()=>{
  const {o,packets}=await fixture(300);
  const repository=new ImmutableMemoryRepository();
  const snapshot=await repository.prepare(o,packets.slice(0,299),fence,[exclusion('300')]);
  expect(snapshot.members).toHaveLength(299);
  expect(snapshot.sealed).toBe(true);
  const saved=(await owner.query('SELECT memory_exclusions FROM crustdata_acquisition_receipts WHERE id=$1',[o.acquisitionReceiptId])).rows[0];
  expect(saved.memory_exclusions).toEqual([exclusion('300')]);
  const restart=await new ImmutableMemoryRepository().read(o);
  expect(restart.members.some(m=>m.packet.providerRecordId==='300')).toBe(false);
  expect(await call(runtime,o,{action:'seal',...fence,exclusions:[exclusion('300')]})).toMatchObject({sealed:true});
  await expect(call(runtime,o,{action:'seal',...fence,exclusions:[]})).rejects.toThrow('MEMORY_EXCLUSIONS_CONFLICT');
  await expect(owner.query("UPDATE crustdata_acquisition_receipts SET memory_exclusions='[]' WHERE id=$1",[o.acquisitionReceiptId]))
   .rejects.toThrow('MEMORY_EXCLUSIONS_IMMUTABLE');
  // Do not leave this synthetic purchase in the global work selector used by later tests.
  await owner.query("UPDATE public_memory_ingest_requests SET state='blocked',failure_code='unexpected' WHERE acquisition_id=$1 AND state='pending'",[o.acquisitionReceiptId]);
 },30000);
 it('refuses missing, foreign, duplicate and overlapping exclusion records',async()=>{
  const {o,packets}=await fixture(2);
  await call(runtime,o,{action:'append',...fence,packets:[packets[0]]});
  await expect(call(runtime,o,{action:'seal',...fence})).rejects.toThrow('MEMORY_MEMBERS_INCOMPLETE');
  for(const exclusions of [[exclusion('3')],[exclusion('2'),exclusion('2')],[exclusion('1')],
   [{...exclusion('2'),reason:'privacy_unavailable'}]]) {
   await expect(call(runtime,o,{action:'seal',...fence,exclusions})).rejects.toThrow('MEMORY_EXCLUSIONS_INVALID');
  }
  const saved=(await owner.query('SELECT memory_exclusions,memory_prepared_at FROM crustdata_acquisition_receipts WHERE id=$1',[o.acquisitionReceiptId])).rows[0];
  expect(saved).toEqual({memory_exclusions:[],memory_prepared_at:null});
  await owner.query("UPDATE public_memory_ingest_requests SET state='blocked',failure_code='unexpected' WHERE acquisition_id=$1 AND state='pending'",[o.acquisitionReceiptId]);
 });
 it('accounts for an all-excluded purchase without fabricating a Memory success',async()=>{
  const {o}=await fixture(2);
  const snapshot=await new ImmutableMemoryRepository().prepare(o,[],fence,[exclusion('1'),exclusion('2')]);
  expect(snapshot.sealed).toBe(true);expect(snapshot.members).toEqual([]);
  expect(await call(runtime,o,{action:'complete'})).toBe(true);
  expect((await owner.query('SELECT memory_exclusions FROM crustdata_acquisition_receipts WHERE id=$1',[o.acquisitionReceiptId])).rows[0].memory_exclusions).toHaveLength(2);
 });
 it('fingerprints only migration-34-owned objects: older receipts-table drift is tolerated, owned changes are not',async()=>{
  const {MEMORY_CATALOG_SQL,MEMORY_CATALOG_SHA256}=await import('../../../../scripts/check-immutable-memory-ingest.mjs');
  const digest=async()=>(await owner.query(MEMORY_CATALOG_SQL)).rows[0].digest;
  // Production carries these two CHECKs from migration 20260727; the fresh baseline does not.
  await owner.query('BEGIN');
  try{
   await owner.query(`ALTER TABLE crustdata_acquisition_receipts
    ADD CONSTRAINT "crustdata_acquisition_receipts_generation_check" CHECK ("acquisitionGeneration" > 0),
    ADD CONSTRAINT "crustdata_acquisition_receipts_slot_check" CHECK (slot IN ('exact','spill'))`);
   expect(await digest()).toBe(MEMORY_CATALOG_SHA256);
  }finally{await owner.query('ROLLBACK');}
  // A changed memory-owned constraint on the receipts table must still fail verification.
  await owner.query('BEGIN');
  try{
   await owner.query('ALTER TABLE crustdata_acquisition_receipts DROP CONSTRAINT memory_preparation_shape');
   expect(await digest()).not.toBe(MEMORY_CATALOG_SHA256);
  }finally{await owner.query('ROLLBACK');}
  // So must a changed constraint on the new table.
  await owner.query('BEGIN');
  try{
   await owner.query('ALTER TABLE public_memory_ingest_requests DROP CONSTRAINT public_memory_ingest_requests_attempts_check');
   await owner.query('ALTER TABLE public_memory_ingest_requests ADD CONSTRAINT public_memory_ingest_requests_attempts_check CHECK (attempts >= 0 AND attempts <= 9)');
   expect(await digest()).not.toBe(MEMORY_CATALOG_SHA256);
  }finally{await owner.query('ROLLBACK');}
  expect(await digest()).toBe(MEMORY_CATALOG_SHA256);
 });
 it('denies direct runtime access and private trigger execution',async()=>{
  for(const sql of ['SELECT * FROM public_memory_ingest_requests','DELETE FROM public_memory_ingest_requests','TRUNCATE public_memory_ingest_requests'])
   await expect(runtime.query(sql)).rejects.toMatchObject({code:'42501'});
  expect((await runtime.query("SELECT has_function_privilege(current_user,'signal_memory_packet_guard()','EXECUTE') allowed")).rows[0].allowed).toBe(false);
 });
 it('seals an empty acquisition before acknowledging it',async()=>{
  const {o,packets}=await fixture(0);await seal(o,packets);expect(await call(runtime,o,{action:'complete'})).toBe(true);
  expect((await call(runtime,o,{action:'read'})).memberCount).toBe(0);
 });
 it('reports and rolls back a 300-profile preparation with injected append latency (not production proof)',async()=>{
  const {o,packets}=await fixture(300);
  const original=bridge.db!;
  bridge.db=new Proxy(original,{get(target,key){
   if(key==='$transaction')return (fn:(tx:unknown)=>Promise<unknown>,options:{maxWait:number;timeout:number})=>
    target.$transaction(tx=>fn(new Proxy(tx,{get(client,method){
     if(method==='$queryRawUnsafe')return async(query:string,...values:unknown[])=>{
      if(typeof values[1]==='string'&&JSON.parse(values[1]).action==='append')await new Promise(resolve=>setTimeout(resolve,450));
      return client.$queryRawUnsafe(query,...values);
     };
     const value=Reflect.get(client,method);return typeof value==='function'?value.bind(client):value;
    }})),options);
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  let failure:unknown;
  try{await new ImmutableMemoryRepository().prepare(o,packets,fence);}catch(error){failure=error;}finally{bridge.db=original;}
  expect(failure).toMatchObject({code:'P2028'});
  expect(memoryPreparationFailure(failure)).toMatchObject({stage:'append',reason:'transaction_api_error'});
  expect((await call(runtime,o,{action:'read'})).members).toEqual([]);
  expect((await owner.query('SELECT memory_prepared_at FROM crustdata_acquisition_receipts WHERE id=$1',[o.acquisitionReceiptId])).rows[0].memory_prepared_at).toBeNull();
 },20000);
 it('shares stored bytes across queue executor, maintenance repair and restarted inline readback',async()=>{
  const {o,packets}=await fixture();const repository=new ImmutableMemoryRepository();
  await repository.prepare(o,packets,fence);
  const bodies:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url,init:RequestInit)=>{
   bodies.push(String(init.body));if(bodies.length===1)throw Error('synthetic lost HTTP acknowledgement');
   const p=packets[0];return Response.json({delivery_status:'replayed',resolution:'refreshed',provider_namespace:'crustdata',record_type:'person',
    provider_record_id:p.providerRecordId,acquisition_receipt_id:o.acquisitionReceiptId,acquisition_generation:1,acquisition_slot:'exact',
    idempotency_key:p.idempotencyKey,ingest_receipt_id:p.idempotencyKey,source_observation_id:globalId,source_identity_id:globalId,global_candidate_id:globalId});
  }));
  await runImmutableMemoryCycle();expect((await repository.read(o)).members[0].state).toBe('retry_wait');
  await owner.query("UPDATE public_memory_ingest_requests SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[packets[0].idempotencyKey]);
  await bridge.db!.$disconnect(); // New connections/repository read the committed packet, not an in-memory cache.
  vi.stubEnv('RC_SKILLS_ENABLED','true');
  expect(await repairRcPurchaseIngestion(o.tenantId,o.sourcingRequestId,o.sourcingRequestId)).toBe(true);
  vi.unstubAllEnvs();
  const restarted=new ImmutableMemoryRepository();
  const members=await awaitMemoryAcquisition(o,restarted,Date.now()+5000,{assertExecution:async()=>{}});
  expect(members[0].result?.globalCandidateId).toBe(globalId);expect(await restarted.finish(o)).toBe(true);
  expect(bodies).toEqual([packets[0].requestBody,packets[0].requestBody]);vi.unstubAllGlobals();
 });
 it('keeps historical contract-1 purchases unchanged and refuses automated preparation',async()=>{
  const {o,packets}=await fixture(1,1);await expect(seal(o,packets)).rejects.toThrow('MEMORY_ACQUISITION_REFUSED');
  expect((await owner.query('SELECT memory_prepared_at FROM crustdata_acquisition_receipts WHERE id=$1',[o.acquisitionReceiptId])).rows[0].memory_prepared_at).toBeNull();
 });
 it('keeps distinct provider members when two records share a display identity',async()=>{
  const {o,packets}=await fixture(2);
  packets[1]={...packets[1],signalCandidateId:packets[0].signalCandidateId};
  const snapshot=await new ImmutableMemoryRepository().prepare(o,packets,fence);
  expect(snapshot.memberCount).toBe(2);expect(snapshot.members[0].packet.providerRecordId).not.toBe(snapshot.members[1].packet.providerRecordId);
 });
 it('does not make unsealed packets claimable; rollback removes partial preparation',async()=>{
  const {o,packets}=await fixture();await runtime.query('BEGIN');
  await call(runtime,o,{action:'append',...fence,packets});expect(await call(runtime,o,{action:'claim',limit:1})).toEqual([]);
  await runtime.query('ROLLBACK');expect((await call(runtime,o,{action:'read'})).members).toEqual([]);
  expect((await runtime.query('SELECT signal_memory_ingest_work($1,$2,10) result',[o.tenantId,o.sourcingRequestId])).rows[0].result).toEqual([]);
 });
 it('refuses incomplete membership and mismatched tenant/execution',async()=>{
  const {o,packets}=await fixture(2);await expect(seal(o,packets.slice(0,1))).rejects.toThrow('MEMORY_MEMBERS_INCOMPLETE');
  await expect(call(runtime,{...o,tenantId:'org_5'},{action:'read'})).rejects.toThrow('MEMORY_ACQUISITION_REFUSED');
  await expect(call(runtime,o,{action:'append',...fence,processingLeaseId:'other',packets})).rejects.toThrow('MEMORY_EXECUTION_STALE');
 });
 it('freezes exact bytes and seals once, preserving the same deadline on replay',async()=>{
  const {o,packets}=await fixture();const first=await seal(o,packets);const second=await seal(o,packets);
  expect(second.deadlineAt).toBe(first.deadlineAt);expect(second.members[0].packet.requestBody).toBe(packets[0].requestBody);
  await expect(owner.query('UPDATE public_memory_ingest_requests SET request_body=request_body||\' \' WHERE id=$1',[packets[0].idempotencyKey])).rejects.toThrow('MEMORY_PACKET_IMMUTABLE');
 });
 it('claims one lease, replays lost ACK bytes, and refuses stale ACK after replacement',async()=>{
  const {o,packets}=await fixture();await seal(o,packets);const [first]=await call(runtime,o,{action:'claim',limit:1});
  expect(await call(runtime,o,{action:'claim',limit:1})).toEqual([]);
  await owner.query("UPDATE public_memory_ingest_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[first.id]);
  const [second]=await call(runtime,o,{action:'claim',limit:1});expect(second.packet.requestBody).toBe(first.packet.requestBody);
  expect(await call(runtime,o,{action:'ack',id:first.id,leaseToken:first.leaseToken,result:result(packets[0])})).toBe(false);
  expect(await call(runtime,o,{action:'ack',id:second.id,leaseToken:second.leaseToken,result:result(packets[0])})).toBe(true);
  expect(await call(runtime,o,{action:'complete'})).toBe(true);
 });
 it('settles an accepted expected-anchor conflict without inventing identity',async()=>{
  const {o,packets}=await fixture();await seal(o,packets);const [lease]=await call(runtime,o,{action:'claim',limit:1});
  expect(await call(runtime,o,{action:'ack',id:lease.id,leaseToken:lease.leaseToken,result:result(packets[0],true)})).toBe(true);
  expect(await call(runtime,o,{action:'complete'})).toBe(true);
  expect((await call(runtime,o,{action:'read'})).members[0].result.globalCandidateId).toBeNull();
 });
 it('cannot acknowledge one purchase with another purchase of the same person',async()=>{
  const a=await fixture(),b=await fixture();await seal(a.o,a.packets);await seal(b.o,b.packets);
  const [lease]=await call(runtime,a.o,{action:'claim',limit:1});
  await expect(call(runtime,a.o,{action:'ack',id:lease.id,leaseToken:lease.leaseToken,result:result(b.packets[0])})).rejects.toThrow('MEMORY_ACK_INVALID');
  expect(await call(runtime,b.o,{action:'ack',id:lease.id,leaseToken:lease.leaseToken,result:result(a.packets[0])})).toBe(false);
 });
 it('privacy suppression removes stored body and never becomes sendable again',async()=>{
  const {o,packets}=await fixture();await seal(o,packets);
  await call(runtime,o,{action:'suppress_member',id:packets[0].idempotencyKey});
  const snapshot=await call(runtime,o,{action:'read'});expect(snapshot.members[0].packet.requestBody).toBeNull();
  expect(await call(runtime,o,{action:'claim',limit:1})).toEqual([]);
  expect(await call(runtime,o,{action:'complete'})).toBe(true);
  await expect(owner.query("UPDATE public_memory_ingest_requests SET state='pending' WHERE id=$1",[packets[0].idempotencyKey])).rejects.toThrow('MEMORY_PACKET_IMMUTABLE');
 });
 it('blocks conflicts rather than counting them as success, and refuses premature parent release',async()=>{
  const {o,packets}=await fixture();await seal(o,packets);const [lease]=await call(runtime,o,{action:'claim',limit:1});
  await call(runtime,o,{action:'fail',id:lease.id,leaseToken:lease.leaseToken,code:'idempotency_conflict',terminal:true});
  expect(await call(runtime,o,{action:'complete'})).toBe(false);
  await expect(owner.query('UPDATE crustdata_acquisition_receipts SET result=NULL WHERE id=$1',[o.acquisitionReceiptId])).rejects.toThrow('MEMORY_UNRESOLVED_PURCHASE_RETAINED');
  expect((await runtime.query('SELECT signal_memory_ingest_work($1,$2,10) result',[o.tenantId,o.sourcingRequestId])).rows[0].result).toEqual([]);
 });
 it('prepares 300 profiles atomically under the existing five-second transaction budget',async()=>{
  const {o,packets}=await fixture(300);const start=performance.now();const snapshot=await seal(o,packets);
  const ms=performance.now()-start;expect(snapshot.memberCount).toBe(300);expect(ms).toBeLessThan(5000);
  console.info('FINAL_MEMORY_PREPARATION_PG',JSON.stringify({members:300,bytes:packets.reduce((n,p)=>n+Buffer.byteLength(p.requestBody),0),ms:Math.round(ms)}));
 });
 it('rejects missing ACK status and failure code rather than accepting SQL null',async()=>{
  const {o,packets}=await fixture();await seal(o,packets);const [lease]=await call(runtime,o,{action:'claim',limit:1});
  const ack:Record<string,unknown>=result(packets[0]);delete ack.deliveryStatus;
  await expect(call(runtime,o,{action:'ack',id:lease.id,leaseToken:lease.leaseToken,result:ack})).rejects.toThrow('MEMORY_ACK_INVALID');
  await expect(call(runtime,o,{action:'fail',id:lease.id,leaseToken:lease.leaseToken})).rejects.toThrow('MEMORY_FAILURE_INVALID');
  await expect(call(runtime,o,{action:'claim'})).rejects.toThrow('MEMORY_COMMAND_INVALID');
 });
 it('does not grant a ninth attempt after an eighth-attempt worker crash',async()=>{
  const {o,packets}=await fixture();await seal(o,packets);
  for(let i=0;i<8;i++){
   const [lease]=await call(runtime,o,{action:'claim',limit:1});expect(lease.packet.requestBody).toBe(packets[0].requestBody);
   await owner.query("UPDATE public_memory_ingest_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[lease.id]);
  }
  expect(await call(runtime,o,{action:'claim',limit:1})).toEqual([]);
  expect((await call(runtime,o,{action:'read'})).members[0].state).toBe('blocked');
  expect(await call(runtime,o,{action:'complete'})).toBe(false);
 });
 it('compacts only acknowledged, delivered, old requests and preserves their identity',async()=>{
  const {o,packets}=await fixture();await seal(o,packets);const [lease]=await call(runtime,o,{action:'claim',limit:1});
  expect(await call(runtime,o,{action:'compact'})).toBe(false);
  await call(runtime,o,{action:'ack',id:lease.id,leaseToken:lease.leaseToken,result:result(packets[0])});
  await call(runtime,o,{action:'complete'});
  await owner.query("UPDATE job_sourcing_requests SET status='complete',callback_status='delivered' WHERE id=$1",[o.sourcingRequestId]);
  await call(runtime,o,{action:'compact'});
  expect((await call(runtime,o,{action:'read'})).members[0].packet.requestBody).toBe(packets[0].requestBody);
  await owner.query("UPDATE public_memory_ingest_requests SET acknowledged_at=clock_timestamp()-interval '25 hours' WHERE id=$1",[lease.id]);
  await call(runtime,o,{action:'compact'});
  const member=(await call(runtime,o,{action:'read'})).members[0];
  expect(member.packet.requestBody).toBeNull();expect(member.packet.wireSha256).toBe(packets[0].wireSha256);
  expect(await call(runtime,o,{action:'claim',limit:1})).toEqual([]);
 });
});
