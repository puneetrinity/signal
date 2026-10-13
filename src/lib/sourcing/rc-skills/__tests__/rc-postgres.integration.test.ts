import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createRankingContract,rankingHash} from '../../rubric/contracts';
import {RankingRepository} from '../../rubric/repository';
import {adaptProfile} from '../../rubric/evidence';
import {rcPublicIdentities} from '../membership';
import {createObservation,createRcFinish,rcValidUntil} from '../contracts';
import {RcRepository,type RcBaseline} from '../repository';
import {encodeRcPreparation} from '../canonical-transport';
import {prisma} from '@/lib/prisma';
import {runRcTick,sealedRcEvidence} from '../worker';
import {RcProviderError} from '../provider';
import {drainRcOutbox} from '../outbox';
import type {RcCacheFinish} from '../memory';

const enabled=process.env.SIGNAL_RC_DISPOSABLE==='1';
describe.skipIf(process.env.SIGNAL_RC_PREPARE_RUNTIME!=='1')('RC prepare caller deadline on isolated restricted runtime',()=>{
 let owner:Client,definition:string;
 beforeAll(async()=>{
  const url=new URL(process.env.SIGNAL_RC_OWNER_URL??'');
  if(url.hostname!=='127.0.0.1'||!url.pathname.endsWith('_test')||!url.username.endsWith('_test'))throw Error('LOCAL_TEST_REQUIRED');
  const runtime=new URL(process.env.DATABASE_URL??'');
  if(runtime.hostname!==url.hostname||runtime.port!==url.port||runtime.pathname!==url.pathname||runtime.username===url.username)throw Error('SEPARATE_RUNTIME_REQUIRED');
  owner=new Client({connectionString:url.toString()});await owner.connect();
  const rights=await prisma.$queryRawUnsafe<any[]>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  expect(rights[0]).toEqual({rolsuper:false,rolbypassrls:false});
  definition=(await owner.query("SELECT pg_get_functiondef('signal_rc_prepare(text,uuid,jsonb)'::regprocedure) d")).rows[0].d;
  await owner.query('CREATE TABLE rc_prepare_deadline_probe(id integer)');
 });
 afterAll(async()=>{if(definition)await owner.query(definition);await owner?.query('DROP TABLE IF EXISTS rc_prepare_deadline_probe');await owner?.end();await prisma.$disconnect();});
 it('cancels the actual statement at 30 seconds and rolls back preceding writes',async()=>{
  const injected=definition.replace('BEGIN\n',"BEGIN\n INSERT INTO rc_prepare_deadline_probe VALUES(1); PERFORM pg_sleep(32);\n");
  expect(injected).not.toBe(definition);await owner.query(injected);
  const before=await prisma.$queryRawUnsafe<any[]>("SELECT current_setting('statement_timeout') s,current_setting('lock_timeout') l");
  const start=Date.now();
  try{
   await expect(new RcRepository().prepare({tenantId:'org_1',flowRunId:randomUUID(),executionAttemptId:'test',processingLeaseId:'test'},[],
    {version:1,asOf:new Date().toISOString(),evidence:[],withheld:[],identities:[],cache:[]})).rejects.toThrow(/statement timeout|57014/);
   expect(Date.now()-start).toBeGreaterThan(29000);expect(Date.now()-start).toBeLessThan(35000);
   expect((await owner.query('SELECT count(*)::integer n FROM rc_prepare_deadline_probe')).rows[0].n).toBe(0);
   expect(await prisma.$queryRawUnsafe<any[]>("SELECT current_setting('statement_timeout') s,current_setting('lock_timeout') l")).toEqual(before);
  }finally{await owner.query(definition);}
 },45000);
 it('sets the two-second lock timeout before the function starts',async()=>{
  const injected=definition.replace('BEGIN\n',"BEGIN\n INSERT INTO rc_prepare_deadline_probe VALUES(2);\n");
  await owner.query(injected);await owner.query('BEGIN');await owner.query('LOCK TABLE rc_prepare_deadline_probe IN ACCESS EXCLUSIVE MODE');
  const start=Date.now();
  try{
   await expect(new RcRepository().prepare({tenantId:'org_1',flowRunId:randomUUID(),executionAttemptId:'test',processingLeaseId:'test'},[],
    {version:1,asOf:new Date().toISOString(),evidence:[],withheld:[],identities:[],cache:[]})).rejects.toThrow(/lock timeout|55P03/);
   expect(Date.now()-start).toBeGreaterThan(1900);expect(Date.now()-start).toBeLessThan(5000);
  }finally{await owner.query('ROLLBACK');await owner.query(definition);}
 },10000);
});
describe.skipIf(!enabled)('RC database authority on a fresh disposable PostgreSQL',()=>{
 let db:Client;
 const tenant='org_28',hash='a'.repeat(64);
 const one=async(sql:string,args:unknown[]=[]) => (await db.query(sql,args)).rows[0]?.result;
 async function refusal(action:()=>Promise<unknown>,message:string){
  await db.query('SAVEPOINT refused');await expect(action()).rejects.toThrow(message);await db.query('ROLLBACK TO SAVEPOINT refused');
 }
 beforeAll(async()=>{
  const target=new URL(process.env.SIGNAL_RC_OWNER_URL??'');
  if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||!target.pathname.endsWith('_test')||!target.username.endsWith('_test'))throw Error('DISPOSABLE_TARGET_REQUIRED');
  db=new Client({connectionString:target.toString(),connectionTimeoutMillis:2000});await db.connect();
  expect((await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  expect((await db.query('SHOW server_version_num')).rows[0].server_version_num).toMatch(/^17/);
  if(process.env.SIGNAL_RC_EXPECT_LOCALE)expect((await db.query('SELECT datcollate FROM pg_database WHERE datname=current_database()')).rows[0].datcollate).toBe(process.env.SIGNAL_RC_EXPECT_LOCALE);
  if(await one("SELECT to_regclass('public.job_sourcing_requests') result"))throw Error('FRESH_DISPOSABLE_REQUIRED');
  const manifest=JSON.parse(readFileSync('prisma/baseline/manifest.json','utf8'));
  await db.query('BEGIN');
  await db.query("SET LOCAL statement_timeout='30s'");
  await db.query("SET LOCAL lock_timeout='2s'");
  await db.query("SET LOCAL signal.ranking_privacy_max_age_ms='120000'");
  await db.query(readFileSync(manifest.baselinePath,'utf8').replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
  for(const name of readdirSync('prisma/migrations').filter(n=>n>manifest.baselineMigrationThrough).sort()){
   const sql=readFileSync(`prisma/migrations/${name}/migration.sql`,'utf8');
   try{await db.query(sql);}catch(error){const e=error as Error&{position?:string};throw Error(`${name}: ${e.message}; ${sql.slice(Math.max(0,Number(e.position)-100),Number(e.position)+120)}`);}
  }
 },120000);
 beforeEach(async()=>{await db.query('SAVEPOINT fixture');});
 afterEach(async()=>{await db.query('ROLLBACK TO SAVEPOINT fixture');});
 afterAll(async()=>{await db?.query('ROLLBACK');await db?.end();});
 async function fixture(rcUnavailable=false){
  await db.query("INSERT INTO governed_sourcing_tenants(tenant_id,enabled_at,policy_hash,allow_new,organization_ref,callback_url) VALUES($1,clock_timestamp(),$2,true,'28','https://flow.example/api/webhooks/signal/callback')",[tenant,hash]);
  const flow=randomUUID(),ranking=createRankingContract(randomUUID(),hash,{schemaVersion:3,compilerVersion:3,taxonomyVersion:3,criteria:[{
   id:randomUUID(),label:'AWS',class:'must_have',subject:'skill',requirement:{kind:'accepted_skills',primary:'AWS',alternatives:['Amazon Web Services']},
   use:'assessment',evidenceKinds:['profile_evidence'],provenance:{kind:'recruiter_edit'}}]});
  const body={protocolVersion:2,flowRunId:flow,organizationRef:'28',externalJobId:'vanta:jobs:95101',
   briefVersionId:ranking.briefVersionId,materialHash:hash,artifactHash:hash,compilerVersion:'1',queryArtifact:{jobContext:{}},
   rankingContract:ranking,callbackUrl:'https://flow.example/api/webhooks/signal/callback'};
  const bound=await one('SELECT signal_sourcing_bind($1,$2,$3) result',[tenant,flow,body]),lease=randomUUID(),policy=randomUUID();
  await db.query("UPDATE job_sourcing_requests SET status='processing',processing_lease_id=$2 WHERE id=$1",[bound.requestId,lease]);
  await db.query(`INSERT INTO rc_rate_policies(id,policy_hash,rc_account_hash,rc_fetch_credits_max,rpm,enabled)
   VALUES($1,$2,$2,1,500,$3)`,[policy,hash,!rcUnavailable]);
  await db.query('INSERT INTO rc_org_policies(tenant_id,policy_id,enabled) VALUES($1,$2,true)',[tenant,policy]);
  const command={version:1,requestId:bound.requestId,generation:1,contractHash:ranking.contractHash,executionAttemptId:bound.executionAttemptId,processingLeaseId:lease};
  const admitted=await one('SELECT signal_rc_admit($1,$2,$3) result',[tenant,flow,command]);
  const identities=rcPublicIdentities([{candidateId:'candidate-a',globalCandidateId:randomUUID(),url:'https://linkedin.com/in/person-a'}]);
  await db.query(`INSERT INTO candidates(id,"tenantId","linkedinId","linkedinUrl","updatedAt") VALUES('candidate-a',$1,'person-a',$2,clock_timestamp())`,[tenant,identities[0].url]);
  await db.query(`INSERT INTO candidate_global_links(id,"tenantId","candidateId","globalCandidateId") VALUES($1,$2,'candidate-a',$3)`,[randomUUID(),tenant,identities[0].globalCandidateId]);
  await db.query("INSERT INTO candidate_privacy_projection(tenant_id,candidate_id,generation,decision,evaluated_cursor) VALUES($1,'candidate-a',1,'allow',0)",[tenant]);
  await db.query("UPDATE candidate_privacy_sync_state SET status='healthy',active_generation=1,expected_candidates=1,projected_candidates=1,last_success_at=clock_timestamp() WHERE consumer_name='discover'");
  const evidence=[adaptProfile({candidateId:'candidate-a',organizationRef:'28',sourceVersion:'fixture-v1',observedAt:'2020-01-01T00:00:00.000Z',profile:{skills:['Java']}})];
  const baseline:RcBaseline={version:1,asOf:'2026-01-01T00:00:00.000Z',evidence,withheld:[],identities,cache:[]};
  await db.query(`INSERT INTO crustdata_acquisition_receipts(id,"tenantId","sourcingRequestId","acquisitionGeneration",slot,status,
   "requestFingerprint","requestInput","requestMetadata",result,"updatedAt") VALUES('receipt-a',$1,$2,1,'exact','complete',$3,'{}','{}',$4,clock_timestamp())`,
   [tenant,bound.requestId,hash,{profiles:[{social_handles:{professional_network_identifier:{profile_url:identities[0].url}}}]}]);
  const prepare={version:1,receiptIds:['receipt-a'],baseline,baselineHash:rankingHash(baseline),asOf:baseline.asOf};
  const claim={version:1,operation:'CHECK',identityHash:identities[0].identityHash,executionAttemptId:command.executionAttemptId,processingLeaseId:lease};
  return {flow,command,admitted,prepare,claim,ranking};
 }
 it('tagged preparation preserves the historical hash, baseline and replay',async()=>{
  const f=await fixture(),tagged=encodeRcPreparation(f.prepare.baseline,f.prepare.receiptIds);
  expect(await one('SELECT signal_rc_prepare_transport($1) result',[tagged])).toEqual(f.prepare);
  expect(await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,tagged])).toMatchObject({baselineHash:f.prepare.baselineHash,replayed:false});
  expect(await one('SELECT baseline result FROM rc_sourcing_runs')).toEqual(f.prepare.baseline);
  expect(await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,f.prepare])).toMatchObject({replayed:true});
  expect(await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,tagged])).toMatchObject({replayed:true});
 });
 it('rejects canonical spelling attacks and malformed text without leaking text',async()=>{
  const f=await fixture(),tagged=encodeRcPreparation(f.prepare.baseline,f.prepare.receiptIds);
  const original=tagged.baselineTransport.evidenceCanonical[0];
  for(const changed of [' '+original,original+' ',original.replace('{','{"candidateId":"other",'),'{SECRET_INVALID_PROFILE']){
   const cmd=structuredClone(tagged);cmd.baselineTransport.evidenceCanonical=[changed];
   await db.query('SAVEPOINT bad_text');let error='';try{await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,cmd]);}catch(e){error=String(e);}
   expect(error).toMatch(/CANONICAL/);expect(error).not.toContain('SECRET_INVALID_PROFILE');await db.query('ROLLBACK TO SAVEPOINT bad_text');
  }
  expect(await one('SELECT count(*)::integer result FROM rc_lookup_attempts')).toBe(0);
  expect(await one('SELECT baseline IS NULL result FROM rc_sourcing_runs')).toBe(true);
 });
 it('checks identity membership without losing withheld identities or accepting missing IDs',async()=>{
  const f=await fixture();
  for(const candidateId of ['unknown',null]){
   const base=structuredClone(f.prepare.baseline);(base.identities[0] as any).candidateId=candidateId;
   await refusal(()=>one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,{...f.prepare,baseline:base,baselineHash:rankingHash(base)}]),'RC_IDENTITY_CONFLICT');
  }
  const base={...f.prepare.baseline,evidence:[],withheld:[{candidateId:'candidate-a',reason:'evidence_too_large' as const,evidenceHash:hash,bytes:65537,limit:65536 as const}]};
  expect(await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,encodeRcPreparation(base,f.prepare.receiptIds)])).toMatchObject({replayed:false});
 });
 it('reports tagged commitment rejection before stale authority and never dispatches',async()=>{
  const f=await fixture(),cmd=encodeRcPreparation(f.prepare.baseline,f.prepare.receiptIds);cmd.baselineHash=hash;
  await db.query("UPDATE job_sourcing_requests SET processing_lease_id='different'");
  await refusal(()=>one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,cmd]),'RC_BASELINE_CONFLICT');
  expect(await one('SELECT count(*)::integer result FROM rc_lookup_attempts')).toBe(0);
 });
 it('rejects invalid records at every position and cache version spelling variants',async()=>{
  const f=await fixture(),base=f.prepare.baseline;
  for(const index of [0,1,2]){
   const cmd=encodeRcPreparation({...base,evidence:[...base.evidence,...base.evidence,...base.evidence]},f.prepare.receiptIds);
   cmd.baselineTransport.evidenceCanonical[index]='null';
   await refusal(()=>one('SELECT signal_rc_prepare_transport($1) result',[cmd]),'CANONICAL');
  }
  const all=encodeRcPreparation(base,f.prepare.receiptIds);all.baselineTransport.evidenceCanonical=['null','null'];
  await refusal(()=>one('SELECT signal_rc_prepare_transport($1) result',[all]),'CANONICAL');
  const upstreamAt='2026-01-01T00:00:00Z';
  const observation=createObservation({version:1,outcome:'success',identityHash:base.identities[0].identityHash,skills:['AWS','é😀'],upstreamAt,observedAt:new Date().toISOString(),validUntil:rcValidUntil(upstreamAt),timestampSource:'check_last_update'});
  const full={...base,cache:[{identityHash:observation.identityHash,observation}]};
  const good=encodeRcPreparation(full,f.prepare.receiptIds);
  expect((await one('SELECT signal_rc_prepare_transport($1) result',[good])).baseline).toEqual(full);
  for(const number of ['1.0','1e0']){
   const changed=structuredClone(good);changed.baselineTransport.cacheCanonical[0]=changed.baselineTransport.cacheCanonical[0].replace('"version":1','"version":'+number);
   await refusal(()=>one('SELECT signal_rc_prepare_transport($1) result',[changed]),'CANONICAL');
  }
 });
 it('does not block Crustdata admission when RC account policy is disabled',async()=>{
  const f=await fixture(true);expect(f.admitted).toMatchObject({enabled:true,rcAvailable:false});
  expect(await one('SELECT rc_available result FROM rc_sourcing_runs')).toBe(false);
  expect(await one('SELECT safe_code result FROM rc_operations_events')).toBe('RC_ACCOUNT_UNAVAILABLE');
 });
 it('records pending receipt delivery durably and idempotently without losing bought data',async()=>{
  const f=await fixture(),command={version:1,action:'delivery_result',tenantId:tenant,flowRunId:f.flow,pending:true};
  for(let i=0;i<2;i++)expect(await one('SELECT signal_rc_maintain($1) result',[command])).toEqual({version:1,state:'recorded'});
  expect(await one('SELECT count(*)::int result FROM rc_operations_events')).toBe(1);
  expect(await one('SELECT safe_code result FROM rc_operations_events')).toBe('RC_RECEIPT_DELIVERY');
  expect(await one('SELECT count(*)::int result FROM crustdata_acquisition_receipts WHERE result IS NOT NULL')).toBe(1);
 });
 it('does not price-gate either purchase slot and has no monetary or expiry columns',async()=>{
  const f=await fixture();
  expect(await one("SELECT count(*)::int result FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'rc_%' AND (column_name LIKE '%paise%' OR column_name LIKE '%expires%' OR column_name='currency')")).toBe(0);
  expect(await one('SELECT signal_rc_admit($1,$2,$3) result',[tenant,f.flow,f.command])).toMatchObject({enabled:true});
  expect(await one('SELECT signal_rc_admit($1,$2,$3) result',[tenant,f.flow,{...f.command,purchaseSlot:'exact'}])).toMatchObject({enabled:true});
  expect(await one('SELECT signal_rc_admit($1,$2,$3) result',[tenant,f.flow,{...f.command,purchaseSlot:'spill'}])).toMatchObject({enabled:true});
  expect(await one('SELECT count(*)::int result FROM crustdata_acquisition_receipts')).toBe(1);
 });
 it('binds exactly one snapshot, receipt union and original deadline',async()=>{
  const f=await fixture();
  expect(await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,f.prepare])).toMatchObject({replayed:false});
  const deadline=await one('SELECT deadline_at result FROM rc_sourcing_runs');
  expect(await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,f.prepare])).toMatchObject({replayed:true});
  expect(await one('SELECT deadline_at result FROM rc_sourcing_runs')).toEqual(deadline);
  expect(await one('SELECT count(*)::integer result FROM rc_purchase_members')).toBe(1);
  await refusal(()=>one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,{...f.prepare,baselineHash:hash}]),'RC_BASELINE_CONFLICT');
 });
 it('skips paid RC work and records an alert when the cache cannot be read',async()=>{
  const f=await fixture(),repository=new RcRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const identity={tenantId:tenant,flowRunId:f.flow,executionAttemptId:f.claim.executionAttemptId,processingLeaseId:f.claim.processingLeaseId};
  await repository.skipCache(identity);
  expect(await one('SELECT rc_available result FROM rc_sourcing_runs')).toBe(false);
  expect(await one('SELECT paid_lookups result FROM rc_sourcing_runs')).toBe(0);
  expect(await one('SELECT safe_code result FROM rc_operations_events')).toBe('RC_CACHE_UNAVAILABLE');
  await repository.prepare(identity,f.prepare.receiptIds,f.prepare.baseline);
  const provider=vi.fn();
  expect((await runRcTick({identity,repository,provider,privacyCursor:async()=>0})).state).toBe('sealed');
  expect(provider).not.toHaveBeenCalled();
 });
 it('reuses a cache hit without an RC account configuration',async()=>{
  const f=await fixture(true);
  await db.query('UPDATE rc_rate_policies SET rc_account_hash=NULL,rc_fetch_credits_max=NULL,rpm=NULL');
  const observation=createObservation({version:1,outcome:'success',identityHash:f.claim.identityHash,skills:['AWS'],
   upstreamAt:'2026-01-01T00:00:00Z',observedAt:'2026-01-02T00:00:00Z',validUntil:rcValidUntil('2026-01-01T00:00:00Z'),timestampSource:'check_last_update'});
  f.prepare.baseline.cache.push({identityHash:f.claim.identityHash,observation});
  f.prepare.baselineHash=rankingHash(f.prepare.baseline);
  await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,f.prepare]);
  const claimed=await one('SELECT signal_rc_claim($1,$2,$3) result',[tenant,f.flow,f.claim]);
  const finish=createRcFinish({version:1,outcome:{kind:'cached',upstreamAt:observation.upstreamAt,
   retryableFree:false,safeCode:'ok',quota:{minuteLimit:null,minuteLeft:null,resetAt:null,retryAfterMs:null,dailyLeft:null}},observation,observedCredits:0});
  expect(await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,claimed.attemptId,finish])).toMatchObject({replayed:false});
  expect(await one('SELECT count(*)::int result FROM rc_account_windows')).toBe(0);
  expect(await one('SELECT state result FROM rc_purchase_members')).toBe('cached');
 });
 it('refuses omitted or foreign receipts before establishing paid membership',async()=>{
  const f=await fixture();await refusal(()=>one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,{...f.prepare,receiptIds:[]}]),'RC_RECEIPT_BINDING_CONFLICT');
  expect(await one('SELECT count(*)::integer result FROM rc_purchase_members')).toBe(0);
 });
 it('rejects extra cache fields even when the caller recomputes the baseline hash',async()=>{
  const f=await fixture();
  const observation={...createObservation({version:1,outcome:'no_skills',identityHash:f.claim.identityHash,skills:[],
   upstreamAt:null,observedAt:'2026-01-01T00:00:00Z',validUntil:null,timestampSource:'check_last_update'}),email:'never-store@fixture.invalid'};
  const baseline={...f.prepare.baseline,cache:[{identityHash:f.claim.identityHash,observation}]};
  await refusal(()=>one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,
   {...f.prepare,baseline,baselineHash:rankingHash(baseline)}]),'RC_CACHE_CONFLICT');
  expect(await one('SELECT baseline IS NULL result FROM rc_sourcing_runs')).toBe(true);
 });
 it('progress-only reads expose no identities or working evidence and do not mutate progress',async()=>{
  const f=await fixture();await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,f.prepare]);
  const before=await one('SELECT revision::text result FROM rc_sourcing_runs');
  await db.query("SELECT set_config('signal.rc_progress_only','true',true)");
  const progress=await one('SELECT signal_rc_read($1,$2) result',[tenant,f.flow]);
  expect(Object.keys(progress).sort()).toEqual(['notificationDelivered','processed','safeReason','state','total','updatedAt','version']);
  expect(progress).toMatchObject({state:'enriching_skills',processed:0,total:1});
  expect(await one('SELECT revision::text result FROM rc_sourcing_runs')).toBe(before);
  await refusal(()=>one('SELECT signal_rc_read($1,$2) result',['org_999',f.flow]),'RC_BINDING_REFUSED');
 });
 it('records dispatch once and rejects a stale worker',async()=>{
  const f=await fixture();await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,f.prepare]);
  const claimed=await one('SELECT signal_rc_claim($1,$2,$3) result',[tenant,f.flow,f.claim]);
  const command={version:1,privacyCursor:0,executionAttemptId:f.claim.executionAttemptId,processingLeaseId:f.claim.processingLeaseId};
  await refusal(()=>one('SELECT signal_rc_dispatch($1,$2,$3,$4) result',[tenant,f.flow,claimed.attemptId,{...command,processingLeaseId:'wrong'}]),'RC_EXECUTION_STALE');
  expect(await one('SELECT signal_rc_dispatch($1,$2,$3,$4) result',[tenant,f.flow,claimed.attemptId,command])).toMatchObject({state:'granted'});
  expect(await one('SELECT signal_rc_dispatch($1,$2,$3,$4) result',[tenant,f.flow,claimed.attemptId,command])).toMatchObject({state:'already_dispatched'});
  expect(await one('SELECT sum(reserved_requests)::integer result FROM rc_account_windows')).toBe(1);
 });
 const noQuota={minuteLimit:null,minuteLeft:null,resetAt:null,retryAfterMs:null,dailyLeft:null};
 const clockFix=()=>readFileSync('prisma/migrations/20261011000000_rc_clock_tolerance/migration.sql','utf8');
 const oldRoutine=(name:string)=>{const sql=readFileSync('prisma/migrations/20261009000000_rc_skills/migration.sql','utf8');
  const start=sql.indexOf('CREATE FUNCTION public.'+name+'('),end=sql.indexOf(';',sql.indexOf('REVOKE ALL ON FUNCTION',start))+1;
  return sql.slice(start,end).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');};
 const ahead=async(seconds:number)=>await one("SELECT to_char(clock_timestamp()+$1*interval '1 second','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') result",[seconds]);
 it('reproduces old prepare skew refusal and accepts only bounded application/cache skew',async()=>{
  const f=await fixture();
  const command=async(seconds:number)=>{const at=await ahead(seconds),observation=createObservation({version:1,outcome:'success',
   identityHash:f.claim.identityHash,skills:['AWS'],upstreamAt:'2026-01-01T00:00:00Z',observedAt:at,
   validUntil:rcValidUntil('2026-01-01T00:00:00Z'),timestampSource:'check_last_update'});
   const baseline={...f.prepare.baseline,asOf:at,cache:[{identityHash:f.claim.identityHash,observation}]};
   return {...f.prepare,asOf:at,baseline,baselineHash:rankingHash(baseline)};};
  await db.query(oldRoutine('signal_rc_prepare'));
  const old=await command(2);
  await refusal(()=>one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,old]),'RC_BASELINE_INVALID');
  await db.query(clockFix());
  const far=await command(60);
  await refusal(()=>one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,far]),'RC_BASELINE_INVALID');
  const farCache={...far,baseline:{...far.baseline,asOf:f.prepare.baseline.asOf},asOf:f.prepare.asOf};
  farCache.baselineHash=rankingHash(farCache.baseline);
  await refusal(()=>one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,farCache]),'RC_CACHE_CONFLICT');
  expect(await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,await command(2)])).toMatchObject({replayed:false});
 });
 it('reproduces paid-result rejection under injected clock skew without another FETCH',async()=>{
  const f=await dispatched(),upstreamAt='2026-01-01T00:00:00.000000Z';
  await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,f.claimed.attemptId,
   createRcFinish({version:1,outcome:{kind:'eligible',upstreamAt,retryableFree:false,safeCode:'ok',quota:noQuota},observation:null,observedCredits:0})]);
  const fetch=await one('SELECT signal_rc_claim($1,$2,$3) result',[tenant,f.flow,{...f.claim,operation:'FETCH'}]);
  await one('SELECT signal_rc_dispatch($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,f.dispatch]);
  const result=async(seconds:number)=>createRcFinish({version:1,outcome:{kind:'success',upstreamAt,retryableFree:false,safeCode:'ok',quota:noQuota},
   observation:createObservation({version:1,outcome:'success',identityHash:f.claim.identityHash,skills:['AWS'],upstreamAt,
    observedAt:await ahead(seconds),validUntil:rcValidUntil(upstreamAt),timestampSource:'check_last_update'}),observedCredits:1});
  await db.query(oldRoutine('signal_rc_finish'));
  const old=await result(2);
  await refusal(()=>one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,old]),'RC_OBSERVATION_INVALID');
  await db.query(clockFix());
  const far=await result(60);
  await refusal(()=>one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,far]),'RC_OBSERVATION_INVALID');
  const near=await result(2);
  expect(await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,near])).toMatchObject({replayed:false});
  expect(await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,near])).toMatchObject({replayed:true});
  expect(await one('SELECT paid_lookups result FROM rc_sourcing_runs')).toBe(1);
  expect(await one('SELECT count(*)::int result FROM rc_skill_outbox')).toBe(1);
 });
 it('automatically cancels proven no-dispatch failures and excludes them from watchdog recovery',async()=>{
  const f=await fixture();await db.query('DELETE FROM crustdata_acquisition_receipts');
  const repository=new RcRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const identity={tenantId:tenant,flowRunId:f.flow,executionAttemptId:f.claim.executionAttemptId,processingLeaseId:f.claim.processingLeaseId};
  expect(await repository.failure(identity,0,3)).toEqual({version:1,state:'cancelled'});
  expect(await one('SELECT cancellation IS NOT NULL result FROM governed_sourcing_bindings')).toBe(true);
  expect(await one('SELECT state result FROM rc_sourcing_runs')).toBe('closed_unrecoverable');
  expect((await repository.maintenance({version:1,action:'tick'}) as {stalled:number}).stalled).toBe(0);
 });
 it('resumes completed purchases automatically twice, then stalls without cancellation or a new generation',async()=>{
  const f=await fixture(),repository=new RcRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const identity={tenantId:tenant,flowRunId:f.flow,executionAttemptId:f.claim.executionAttemptId,processingLeaseId:f.claim.processingLeaseId};
  for(let attempt=0;attempt<3;attempt++){
   await db.query("UPDATE job_sourcing_requests SET status='processing',processing_lease_id=$1",[identity.processingLeaseId]);
   expect((await repository.failure(identity,attempt,100)).state).toBe(attempt<2?'retry':'stalled');
  }
  expect(await one('SELECT cancellation IS NULL result FROM governed_sourcing_bindings')).toBe(true);
  expect(await one('SELECT acquisition_generation result FROM job_sourcing_requests')).toBe(1);
  expect(await one('SELECT count(*)::int result FROM crustdata_acquisition_receipts')).toBe(1);
 });
 it('uncertain purchase cannot be cancelled or automatically retried',async()=>{
  const f=await fixture(),repository=new RcRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  await db.query("UPDATE crustdata_acquisition_receipts SET status='uncertain'");
  expect((await repository.failure({tenantId:tenant,flowRunId:f.flow,executionAttemptId:f.claim.executionAttemptId,
   processingLeaseId:f.claim.processingLeaseId},0,3)).state).toBe('stalled');
  expect(await one('SELECT cancellation IS NULL result FROM governed_sourcing_bindings')).toBe(true);
 });
 async function dispatched(){
  const f=await fixture();await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,f.prepare]);
  const claimed=await one('SELECT signal_rc_claim($1,$2,$3) result',[tenant,f.flow,f.claim]);
  const dispatch={version:1,privacyCursor:0,executionAttemptId:f.claim.executionAttemptId,processingLeaseId:f.claim.processingLeaseId};
  await one('SELECT signal_rc_dispatch($1,$2,$3,$4) result',[tenant,f.flow,claimed.attemptId,dispatch]);
  return {...f,claimed,dispatch};
 }
 it('enforces 300 paid dispatches and never dispatches a FETCH twice',async()=>{
  const f=await dispatched();
  const checked=createRcFinish({version:1,outcome:{kind:'eligible',upstreamAt:'2026-01-01T00:00:00Z',retryableFree:false,safeCode:'ok',quota:noQuota},observation:null,observedCredits:0});
  await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,f.claimed.attemptId,checked]);
  const fetch=await one('SELECT signal_rc_claim($1,$2,$3) result',[tenant,f.flow,{...f.claim,operation:'FETCH'}]);
  await db.query('UPDATE rc_sourcing_runs SET paid_lookups=300');
  await refusal(()=>one('SELECT signal_rc_dispatch($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,f.dispatch]),'RC_LOOKUP_LIMIT');
  await refusal(()=>db.query('UPDATE rc_sourcing_runs SET paid_lookups=301'),'check constraint');
  await db.query('UPDATE rc_sourcing_runs SET paid_lookups=299');
  expect(await one('SELECT signal_rc_dispatch($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,f.dispatch])).toMatchObject({state:'granted'});
  expect(await one('SELECT signal_rc_dispatch($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,f.dispatch])).toMatchObject({state:'already_dispatched'});
  expect(await one('SELECT paid_lookups result FROM rc_sourcing_runs')).toBe(300);
 });
 it('credits breach disables further RC for this run even after operator resume',async()=>{
  const f=await dispatched();
  const breached=createRcFinish({version:1,outcome:{kind:'failed',upstreamAt:null,retryableFree:false,safeCode:'credits_breach',quota:noQuota},observation:null,observedCredits:1});
  await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,f.claimed.attemptId,breached]);
  expect(await one('SELECT rc_available result FROM rc_sourcing_runs')).toBe(false);
  expect(await one('SELECT safe_code result FROM rc_operations_events')).toBe('RC_CREDITS_BREACH');
  const before=await one('SELECT signal_rc_read($1,$2) result',[tenant,f.flow]);
  await one('SELECT signal_rc_recover($1,$2,$3) result',[tenant,f.flow,{version:1,action:'resume',requestId:randomUUID(),expectedRevision:before.revision,reason:'Finish without further skills calls',hold:null}]);
  expect(await one('SELECT rc_available result FROM rc_sourcing_runs')).toBe(false);
 });
 it('keeps the CHECK timestamp and stores each paid success with a minimal durable outbox',async()=>{
  const f=await dispatched(),upstreamAt='2026-01-01T00:00:00.000000Z';
  const checked=createRcFinish({version:1,outcome:{kind:'eligible',upstreamAt,retryableFree:false,safeCode:'ok',quota:noQuota},observation:null,observedCredits:0});
  expect(await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,f.claimed.attemptId,checked])).toMatchObject({replayed:false});
  expect(await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,f.claimed.attemptId,checked])).toMatchObject({replayed:true});
  const fetch=await one('SELECT signal_rc_claim($1,$2,$3) result',[tenant,f.flow,{...f.claim,operation:'FETCH'}]);
  expect(await one('SELECT signal_rc_dispatch($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,f.dispatch])).toMatchObject({state:'granted'});
  const observation=createObservation({version:1,outcome:'success',identityHash:f.claim.identityHash,skills:['AWS'],upstreamAt,
   observedAt:new Date().toISOString(),validUntil:rcValidUntil(upstreamAt),timestampSource:'check_last_update'});
  const finished=createRcFinish({version:1,outcome:{kind:'success',upstreamAt,retryableFree:false,safeCode:'ok',quota:noQuota},observation,observedCredits:1});
  expect(await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,finished])).toMatchObject({replayed:false});
  expect(await one('SELECT paid_lookups result FROM rc_sourcing_runs')).toBe(1);
  expect(await one('SELECT minimal_payload result FROM rc_skill_outbox')).toMatchObject({observation,originAttempt:fetch.attemptId});
  expect(await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,finished])).toMatchObject({replayed:true});
  expect(await one('SELECT count(*)::integer result FROM rc_skill_outbox')).toBe(1);
  await refusal(()=>one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,fetch.attemptId,{...finished,outcomeHash:hash}]),'RC_OUTCOME_CONFLICT');
 });
 it('does not turn withdrawal after dispatch into failed work for other candidates',async()=>{
  const f=await dispatched();await db.query("UPDATE candidate_privacy_projection SET decision='block_global' WHERE tenant_id=$1",[tenant]);
  const observation=createObservation({version:1,outcome:'no_skills',identityHash:f.claim.identityHash,skills:[],upstreamAt:'2026-01-01T00:00:00Z',
   observedAt:new Date().toISOString(),validUntil:null,timestampSource:'check_last_update'});
  const finished=createRcFinish({version:1,outcome:{kind:'no_skills',upstreamAt:observation.upstreamAt,retryableFree:false,safeCode:'ok',quota:noQuota},observation,observedCredits:0});
  expect(await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,f.claimed.attemptId,finished])).toMatchObject({replayed:false});
  expect(await one('SELECT state result FROM rc_purchase_members')).toBe('restricted');
  expect(await one('SELECT count(*)::integer result FROM rc_skill_outbox')).toBe(0);
  expect(await one('SELECT outcome result FROM rc_lookup_attempts')).toEqual({kind:'restricted'});
 });
 it('allows only one proven-free CHECK retry, never a third',async()=>{
  const f=await dispatched();
  const finished=createRcFinish({version:1,outcome:{kind:'failed',upstreamAt:null,retryableFree:true,safeCode:'transport',quota:noQuota},observation:null,observedCredits:0});
  await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,f.claimed.attemptId,finished]);
  const second=await one('SELECT signal_rc_claim($1,$2,$3) result',[tenant,f.flow,f.claim]);
  expect(second.attemptId).not.toBe(f.claimed.attemptId);
  await one('SELECT signal_rc_dispatch($1,$2,$3,$4) result',[tenant,f.flow,second.attemptId,f.dispatch]);
  await one('SELECT signal_rc_finish($1,$2,$3,$4) result',[tenant,f.flow,second.attemptId,finished]);
  expect(await one('SELECT signal_rc_claim($1,$2,$3) result',[tenant,f.flow,f.claim])).toMatchObject({state:'done'});
  expect(await one('SELECT count(*)::integer result FROM rc_lookup_attempts')).toBe(2);
 });
 it('runs the real repository and worker, seals once and drains only minimal skills to Memory',async()=>{
  const f=await fixture(),repository=new RcRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const identity={tenantId:tenant,flowRunId:f.flow,executionAttemptId:f.claim.executionAttemptId,processingLeaseId:f.claim.processingLeaseId};
  await repository.prepare(identity,f.prepare.receiptIds,f.prepare.baseline);
  const quota={creditsConsumed:0,creditsLeft:1000,minuteLimit:500,minuteLeft:400,resetAt:null,dailyLeft:null};
  const provider={check:vi.fn(async()=>({outcome:'eligible' as const,upstreamAt:'2026-01-01T00:00:00.000000Z',quota,correlationHash:null})),
   fetchSkills:vi.fn(async()=>({skills:['AWS'],quota:{...quota,creditsConsumed:1},correlationHash:null}))};
  const tick=()=>runRcTick({identity,repository,provider:()=>provider,privacyCursor:async()=>0});
  expect((await tick()).state).toBe('waiting');
  const result=await tick();expect(result.state).toBe('sealed');
  if(result.state!=='sealed')throw Error('fixture did not seal');
  expect(sealedRcEvidence(result.snapshot).evidence[0].facts.map(f=>f.value)).toContain('aws');
  expect((await tick()).state).toBe('sealed');expect(provider.check).toHaveBeenCalledTimes(1);expect(provider.fetchSkills).toHaveBeenCalledTimes(1);
  const memory={read:vi.fn(),finish:vi.fn(async(_tenant:string,body:RcCacheFinish)=>({version:1 as const,status:'stored' as const,receiptId:randomUUID(),contentHash:body.observation.contentHash}))};
  expect(await drainRcOutbox({tenantId:tenant,flowRunId:f.flow,repository,memory})).toMatchObject({delivered:1,pending:false});
  expect(await drainRcOutbox({tenantId:tenant,flowRunId:f.flow,repository,memory})).toMatchObject({delivered:0,pending:false});
  expect(memory.finish).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(memory.finish.mock.calls[0])).not.toMatch(/linkedin|email|profile_url/);
  const ranking=new RankingRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const published=await ranking.publish({...identity,contract:f.ranking,
   evidence:sealedRcEvidence(result.snapshot).evidence,sourceTypes:new Map([['candidate-a','discovered']])});
  await db.query("UPDATE job_sourcing_requests SET status='complete',processing_lease_id=NULL,callback_status='delivered' WHERE id=$1",[f.command.requestId]);
  const cleanup=()=>one('SELECT signal_rc_maintain($1) result',[{version:1,action:'cleanup'}]);
  // Publishing and RC cache acknowledgement are insufficient until the paid
  // Crustdata receipt has independently reached Memory.
  expect(await cleanup()).toMatchObject({ready:0,cleaned:0});
  // Callback's normal release is safe only with a durable Memory acknowledgement.
  await db.query("UPDATE crustdata_acquisition_receipts SET status='released'");
  expect(await cleanup()).toMatchObject({ready:0,cleaned:0});
  await db.query("UPDATE crustdata_acquisition_receipts SET memory_ingested_at=clock_timestamp()");
  expect(await cleanup()).toMatchObject({ready:1,cleaned:0});
  await db.query("UPDATE crustdata_acquisition_receipts SET status='complete',memory_ingested_at=NULL");
  expect(await cleanup()).toMatchObject({ready:0,cleaned:0});
  await db.query('UPDATE crustdata_acquisition_receipts SET memory_ingested_at=clock_timestamp()');
  expect(await cleanup()).toMatchObject({ready:1,cleaned:0});
  expect(await cleanup()).toMatchObject({ready:0,cleaned:0});
  await db.query("UPDATE rc_sourcing_runs SET safe_to_clean_at=clock_timestamp()-interval '25 hours',retention_hold=true");
  expect(await cleanup()).toMatchObject({cleaned:0});
  expect(await one('SELECT safe_to_clean_at IS NULL result FROM rc_sourcing_runs')).toBe(true);
  await db.query('UPDATE rc_sourcing_runs SET retention_hold=false');
  expect(await cleanup()).toMatchObject({ready:1,cleaned:0});
  await db.query("UPDATE rc_sourcing_runs SET safe_to_clean_at=clock_timestamp()-interval '25 hours'");
  expect(await cleanup()).toMatchObject({cleaned:1});
  expect(await cleanup()).toMatchObject({ready:0,cleaned:0});
  expect(await one('SELECT baseline IS NULL result FROM rc_sourcing_runs')).toBe(true);
  expect(await one('SELECT count(*)::int result FROM rc_lookup_attempts WHERE outcome IS NOT NULL')).toBe(0);
  expect(await one('SELECT count(*)::int result FROM crustdata_acquisition_receipts WHERE result IS NOT NULL')).toBe(1);
  expect(await one("SELECT count(*)::int result FROM rc_lookup_attempts WHERE operation='FETCH' AND dispatch_at IS NOT NULL")).toBe(1);
  expect(await ranking.read(tenant,f.flow,published.revisionId)).toEqual(published);
 });
 it('a possible paid failure is retained, sealed and never retried',async()=>{
  const f=await fixture(),repository=new RcRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const identity={tenantId:tenant,flowRunId:f.flow,executionAttemptId:f.claim.executionAttemptId,processingLeaseId:f.claim.processingLeaseId};
  await repository.prepare(identity,f.prepare.receiptIds,f.prepare.baseline);
  const quota={creditsConsumed:0,creditsLeft:1000,minuteLimit:500,minuteLeft:400,resetAt:null,dailyLeft:null};
  const provider={check:vi.fn(async()=>({outcome:'eligible' as const,upstreamAt:'2026-01-01T00:00:00.000000Z',quota,correlationHash:null})),
   fetchSkills:vi.fn(async()=>{throw new RcProviderError('transport',true);})};
  const tick=()=>runRcTick({identity,repository,provider:()=>provider,privacyCursor:async()=>0});
  await tick();const result=await tick();expect(result.state).toBe('sealed');await tick();
  expect(provider.fetchSkills).toHaveBeenCalledTimes(1);
  expect(await one("SELECT state result FROM rc_lookup_attempts WHERE operation='FETCH'")).toBe('uncertain');
  expect(await one('SELECT paid_lookups result FROM rc_sourcing_runs')).toBe(1);
 });
 it('detects a stalled worker, deduplicates incidents and never deletes unfinished evidence',async()=>{
  const f=await fixture();await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,f.prepare]);
  await db.query("UPDATE rc_sourcing_runs SET heartbeat_at=clock_timestamp()-interval '2 days',last_progress_at=clock_timestamp()-interval '2 days'");
  expect(await one('SELECT signal_rc_maintain($1) result',[{version:1,action:'tick'}])).toMatchObject({stalled:1});
  expect(await one('SELECT signal_rc_maintain($1) result',[{version:1,action:'tick'}])).toMatchObject({stalled:0});
  expect(await one('SELECT count(*)::integer result FROM rc_operations_events')).toBe(1);
  expect(await one('SELECT signal_rc_maintain($1) result',[{version:1,action:'cleanup'}])).toMatchObject({cleaned:0});
  expect(await one('SELECT baseline IS NOT NULL result FROM rc_sourcing_runs')).toBe(true);
  const progress=(await one('SELECT signal_rc_read($1,$2) result',[tenant,f.flow])).progress;
  expect(progress).toMatchObject({state:'stalled',notificationDelivered:false,safeReason:'recovery_pending'});
  const alerts=await one('SELECT signal_rc_maintain($1) result',[{version:1,action:'alerts'}]);
  expect(alerts.events).toHaveLength(1);
  await one('SELECT signal_rc_maintain($1) result',[{version:1,action:'alert_result',id:alerts.events[0].id,delivered:true}]);
  expect((await one('SELECT signal_rc_read($1,$2) result',[tenant,f.flow])).progress.notificationDelivered).toBe(true);
 });
 it('owner recovery preserves the original deadline, paid marker and immutable command receipt',async()=>{
  const f=await dispatched();
  await db.query("UPDATE rc_lookup_attempts SET dispatch_at=clock_timestamp()-interval '11 seconds'");
  await db.query("UPDATE rc_sourcing_runs SET state='stalled',stalled_at=clock_timestamp()");
  const before=await one('SELECT signal_rc_read($1,$2) result',[tenant,f.flow]);
  const command={version:1,action:'resume',requestId:randomUUID(),expectedRevision:before.revision,reason:'Synthetic worker recovery',hold:null};
  const receipt=await one('SELECT signal_rc_recover($1,$2,$3) result',[tenant,f.flow,command]);
  expect(await one('SELECT signal_rc_recover($1,$2,$3) result',[tenant,f.flow,command])).toEqual(receipt);
  expect(await one('SELECT deadline_at::text result FROM rc_sourcing_runs')).not.toBeNull();
  const after=await one('SELECT signal_rc_read($1,$2) result',[tenant,f.flow]);
  expect(after.deadlineAt).toBe(before.deadlineAt);expect(after.attempts).toEqual(before.attempts);
  expect(await one('SELECT status result FROM job_sourcing_requests WHERE id=$1',[f.command.requestId])).toBe('queued');
  expect(await one('SELECT execution_attempt_id result FROM job_sourcing_requests WHERE id=$1',[f.command.requestId])).toBe(f.command.executionAttemptId);
  const pending=await one('SELECT signal_rc_maintain($1) result',[{version:1,action:'resumes'}]);
  expect(pending.runs).toHaveLength(1);expect(pending.runs[0]).toMatchObject({token:command.requestId,requestId:f.command.requestId,acquisitionGeneration:1});
  const claim={version:1,action:'execution_claim',tenantId:tenant,requestId:f.command.requestId,generation:1,
   executionAttemptId:f.command.executionAttemptId,processingLeaseId:randomUUID(),resumeToken:null};
  expect(await one('SELECT signal_rc_maintain($1) result',[claim])).toEqual({version:1,state:'rejected'});
  expect(await one('SELECT signal_rc_maintain($1) result',[{...claim,resumeToken:randomUUID()}])).toEqual({version:1,state:'rejected'});
  expect(await one('SELECT signal_rc_maintain($1) result',[{...claim,resumeToken:command.requestId}])).toEqual({version:1,state:'claimed'});
  // A worker may start before the enqueue acknowledgement commits. Its intent
  // must remain available for an idempotent add/ack, not become stranded.
  expect((await one('SELECT signal_rc_maintain($1) result',[{version:1,action:'resumes'}])).runs).toHaveLength(1);
  await one('SELECT signal_rc_maintain($1) result',[{version:1,action:'resume_ack',tenantId:tenant,flowRunId:f.flow,token:command.requestId}]);
  expect((await one('SELECT signal_rc_maintain($1) result',[{version:1,action:'resumes'}])).runs).toEqual([]);
  await refusal(()=>one('SELECT signal_rc_recover($1,$2,$3) result',[tenant,f.flow,{...command,reason:'Changed replay'}]),'RC_RECOVERY_CONFLICT');
  await refusal(()=>one('SELECT signal_rc_recover($1,$2,$3) result',[tenant,f.flow,{...command,requestId:randomUUID()}]),'RC_RECOVERY_STALE');
 });
 it('operator recovery can publish sealed evidence after exhausted ranking attempts without changing input',async()=>{
  const f=await fixture(true),repository=new RcRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const identity={tenantId:tenant,flowRunId:f.flow,executionAttemptId:f.claim.executionAttemptId,processingLeaseId:f.claim.processingLeaseId};
  await repository.prepare(identity,f.prepare.receiptIds,f.prepare.baseline);
  const tick=await runRcTick({identity,repository,provider:()=>{throw Error('No provider allowed');},privacyCursor:async()=>0});
  if(tick.state!=='sealed')throw Error('Fixture must seal');
  const interrupted=new RankingRepository(async(sql,args)=>{
   if(sql.includes('signal_ranking_finish'))throw Error('publication outage');
   return (await db.query(sql,args)).rows;
  });
  await expect(interrupted.publish({...identity,contract:f.ranking,evidence:sealedRcEvidence(tick.snapshot).evidence,
   sourceTypes:new Map([['candidate-a','discovered']])})).rejects.toThrow('publication outage');
  await db.query('UPDATE governed_ranking_runs SET attempt_count=3');
  await repository.failure(identity,2,3);
  const frozen=await one('SELECT input_sha256 result FROM governed_ranking_runs');
  const before=await repository.read(tenant,f.flow);
  const result=await one('SELECT signal_rc_recover($1,$2,$3) result',[tenant,f.flow,{version:1,action:'resume',requestId:randomUUID(),
   expectedRevision:before!.revision,reason:'Resume sealed ranking computation',hold:null}]);
  expect(result.rankingAttemptsBefore).toBe(3);
  const executionAttemptId=await one('SELECT execution_attempt_id result FROM job_sourcing_requests');
  const lease=randomUUID();await db.query("UPDATE job_sourcing_requests SET status='processing',processing_lease_id=$1",[lease]);
  const ranking=new RankingRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  expect(await ranking.resume({...identity,executionAttemptId,processingLeaseId:lease,contract:f.ranking})).not.toBeNull();
  expect(await one('SELECT status result FROM job_sourcing_requests')).toBe('complete');
  expect(await one('SELECT input_sha256 result FROM governed_ranking_runs')).toBe(frozen);
  expect(await one('SELECT count(*)::int result FROM crustdata_acquisition_receipts')).toBe(1);
  expect(await one("SELECT count(*)::int result FROM rc_lookup_attempts WHERE operation='FETCH'")).toBe(0);
 });
 it('closing an unrecoverable run leaves ingestion work and working data intact',async()=>{
  const f=await fixture();await one('SELECT signal_rc_prepare($1,$2,$3) result',[tenant,f.flow,f.prepare]);
  const before=await one('SELECT signal_rc_read($1,$2) result',[tenant,f.flow]);
  await one('SELECT signal_rc_recover($1,$2,$3) result',[tenant,f.flow,{version:1,action:'close',requestId:randomUUID(),
   expectedRevision:before.revision,reason:'Synthetic safe closure',hold:null}]);
  expect(await one('SELECT state result FROM rc_sourcing_runs')).toBe('closed_unrecoverable');
  expect(await one('SELECT signal_rc_maintain($1) result',[{version:1,action:'cleanup'}])).toMatchObject({cleaned:0});
  expect(await one('SELECT baseline IS NOT NULL result FROM rc_sourcing_runs')).toBe(true);
  expect((await one('SELECT signal_rc_maintain($1) result',[{version:1,action:'deliveries'}])).runs).toEqual([
   {tenantId:tenant,flowRunId:f.flow,requestId:f.command.requestId}]);
 });
});
