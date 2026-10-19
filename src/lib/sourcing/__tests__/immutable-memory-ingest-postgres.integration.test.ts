import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ImmutableMemoryRepository, awaitMemoryAcquisition, runImmutableMemoryCycle, prepareMemoryPacket, type FrozenMemoryPacket, type MemoryAcquisitionOwner } from '../immutable-memory-ingest';
import { repairRcPurchaseIngestion } from '../public-memory-ingest-outbox';
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
  for(const name of migrations){await owner.query('BEGIN');try{await owner.query(await readFile(resolve(root,'prisma/migrations',name,'migration.sql'),'utf8'));await owner.query('COMMIT');}catch(e){await owner.query('ROLLBACK');throw e;}}
  const {MEMORY_CATALOG_SQL,MEMORY_CATALOG_SHA256}=await import('../../../../scripts/check-immutable-memory-ingest.mjs');
  const catalog=(await owner.query(MEMORY_CATALOG_SQL)).rows[0].digest;
  expect(catalog).toBe(MEMORY_CATALOG_SHA256);console.info('MEMORY_CATALOG',catalog);
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
