import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {Client} from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createRankingContract,rankingHash} from '../contracts';
import {adaptProfile,evidenceBytes,type WithheldProfile} from '../evidence';
import {rankEvidence} from '../score';
import {RankingRepository} from '../repository';
import {RANKING_CATALOG_SQL,RANKING_CATALOG_SHA256} from '../../../../../scripts/check-rubric-ranking.mjs';

const enabled=process.env.SIGNAL_RANKING_DISPOSABLE==='1';
describe.skipIf(!enabled)('ranking atomic database publication',()=>{
 let db:Client;
 const tenant='ranking-disposable',hash='a'.repeat(64);
 const one=async(sql:string,args:unknown[]=[]) => (await db.query(sql,args)).rows[0]?.result;
 const contract=()=>createRankingContract(randomUUID(),hash,{schemaVersion:2,compilerVersion:2,taxonomyVersion:2,criteria:[{
  id:randomUUID(),label:'Backend role',class:'preferred',subject:'title',requirement:{kind:'accepted_titles',values:['Backend Engineer']},
  use:'assessment',evidenceKinds:['profile_evidence'],provenance:{kind:'recruiter_edit'}}]});
 async function refusal(action:()=>Promise<unknown>,message:string){
  await db.query('SAVEPOINT rejected');await expect(action()).rejects.toThrow(message);await db.query('ROLLBACK TO SAVEPOINT rejected');
 }
 async function fixture(){
  const flow=randomUUID(),ranking=contract(),body={protocolVersion:2,flowRunId:flow,organizationRef:'28',externalJobId:'vanta:jobs:95101',
   briefVersionId:ranking.briefVersionId,materialHash:hash,artifactHash:hash,compilerVersion:'1',queryArtifact:{jobContext:{}},
   rankingContract:ranking,callbackUrl:'https://flow.example/api/webhooks/signal/callback'};
  const bound=await one('SELECT signal_sourcing_bind($1,$2,$3) result',[tenant,flow,body]);
  const processingLeaseId=randomUUID();
  await db.query("UPDATE job_sourcing_requests SET status='processing',processing_lease_id=$2 WHERE id=$1",[bound.requestId,processingLeaseId]);
  const evidence=['z','a'].map(candidateId=>adaptProfile({candidateId,organizationRef:'28',sourceVersion:'fixture-v1',observedAt:'2020-01-01T00:00:00.000Z',
   profile:{experience:{employment_details:{past:[{title:'Senior Backend Engineer',start_date:'2010-01-01',end_date:'2019-01-01'}]}}}}));
  for(const e of evidence) {
   await db.query(`INSERT INTO candidates(id,"tenantId","linkedinId","linkedinUrl","updatedAt") VALUES($1,$2,$1,$3,clock_timestamp())`,[e.candidateId,tenant,'https://example.invalid/'+e.candidateId]);
   await db.query("INSERT INTO candidate_privacy_projection(tenant_id,candidate_id,generation,decision,evaluated_cursor) VALUES($1,$2,1,'allow',0)",[tenant,e.candidateId]);
  }
  await db.query("UPDATE candidate_privacy_sync_state SET status='healthy',active_generation=1,expected_candidates=2,projected_candidates=2,last_success_at=clock_timestamp() WHERE consumer_name='discover'");
  const command={contractHash:ranking.contractHash,executionAttemptId:bound.executionAttemptId,processingLeaseId,evidence};
  const claim=()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,flow,command]);
  return {flow,ranking,body,bound,command,claim,evidence,processingLeaseId};
 }
 beforeAll(async()=>{
  const target=new URL(process.env.SIGNAL_RANKING_OWNER_URL??'');
  if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||!target.pathname.endsWith('_test')||!target.username.endsWith('_test'))throw Error('DISPOSABLE_TARGET_REQUIRED');
  db=new Client({connectionString:target.toString(),connectionTimeoutMillis:2000});await db.connect();
  expect((await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  if(process.env.SIGNAL_SOURCING_EXPECT_LOCALE){
   expect((await db.query('SHOW server_version_num')).rows[0].server_version_num).toMatch(/^17/);
   expect((await db.query('SELECT datcollate FROM pg_database WHERE datname=current_database()')).rows[0].datcollate).toBe(process.env.SIGNAL_SOURCING_EXPECT_LOCALE);
  }
  if((await db.query("SELECT to_regclass('public.job_sourcing_requests') relation")).rows[0].relation)throw Error('FRESH_DISPOSABLE_REQUIRED');
  const manifest=JSON.parse(readFileSync('prisma/baseline/manifest.json','utf8')),baseline=readFileSync(manifest.baselinePath,'utf8');
  expect(createHash('sha256').update(baseline).digest('hex')).toBe(manifest.baselineSha256);
  await db.query('BEGIN');
  await db.query(baseline.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
  for(const name of readdirSync('prisma/migrations').filter(n=>n>manifest.baselineMigrationThrough).sort()) {
   const sql=readFileSync(resolve('prisma/migrations',name,'migration.sql'),'utf8');
   try { await db.query(sql); } catch(error) {
    const e=error as Error&{position?:string;internalPosition?:string;internalQuery?:string};
    throw Error(`${name}: ${e.message}; position=${e.position}; internal=${e.internalPosition}; context=${sql.slice(Math.max(0,Number(e.position)-100),Number(e.position)+120)}`);
   }
  }
 },120000);
 beforeEach(async()=>{
  await db.query('SAVEPOINT fixture');
  await db.query("INSERT INTO governed_sourcing_tenants(tenant_id,enabled_at,policy_hash,allow_new,organization_ref,callback_url) VALUES($1,clock_timestamp(),$2,true,'28','https://flow.example/api/webhooks/signal/callback')",[tenant,hash]);
 });
 afterEach(async()=>{await db.query('ROLLBACK TO SAVEPOINT fixture');});
 afterAll(async()=>{await db?.query('ROLLBACK');await db?.end();});
 it('matches the C-ordered catalog digest under the database locale',async()=>{
  expect((await db.query(RANKING_CATALOG_SQL)).rows[0].digest).toBe(RANKING_CATALOG_SHA256);
 });
 it('matches SQL byte sizing for nested unicode and escaped evidence',async()=>{
  const f=await fixture();
  const value={...f.evidence[0],extra:['é 😀 \n\t\"\\',{},[],1e-7]};
  expect(await one('SELECT octet_length($1::jsonb::text) result',[value])).toBe(evidenceBytes(value));
 });
 it('accepts exactly 64KiB evidence in SQL and refuses one byte over without sealing a run',async()=>{
  const f=await fixture(),e={...f.evidence[0],facts:Array.from({length:150},()=>({...f.evidence[0].facts[0],value:'x'.repeat(40)}))};
  while(evidenceBytes(e)<65536){const room=65536-evidenceBytes(e),fact=e.facts.find(f=>f.value.length<500);if(!fact)throw Error('fixture capacity');fact.value+='x'.repeat(Math.min(room,500-fact.value.length));}
  expect(await one('SELECT octet_length($1::jsonb::text) result',[e])).toBe(65536);
  const over=structuredClone(e);over.facts.find(f=>f.value.length<500)!.value+='x';
  await refusal(()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,evidence:[over]}]),'gr_item_shape_ck');
  expect(await one('SELECT count(*)::integer result FROM governed_ranking_runs')).toBe(0);
  const claimed=await one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,evidence:[e]}]);
  expect(claimed.evidence).toHaveLength(1);
 });
 it('upgrades a committed-0025 sealed run without rewriting its input or evidence',async()=>{
  // Disposable savepoint only: reconstruct the prior functions/column layout,
  // seal an old-format input, then exercise the real forward migration.
  await db.query('ALTER TABLE governed_ranking_runs DROP COLUMN withheld_profiles');
  const old=readFileSync('prisma/migrations/20261006000000_rubric_ranking/migration.sql','utf8');
  await db.query(old.slice(old.indexOf('CREATE FUNCTION public.signal_ranking_claim'),old.indexOf('CREATE FUNCTION public.signal_ranking_read')).replaceAll('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
  const f=await fixture();f.command.evidence=f.evidence.map(e=>({...e,presentationSource:'pool' as const}));
  const sealed=await f.claim();
  await db.query(readFileSync('prisma/migrations/20261008000000_rubric_evidence_isolation/migration.sql','utf8'));
  expect(await one('SELECT withheld_profiles result FROM governed_ranking_runs')).toEqual([]);
  expect(await one('SELECT input_sha256 result FROM governed_ranking_runs')).toBe(sealed.inputHash);
  const replacement=randomUUID();await db.query('UPDATE job_sourcing_requests SET processing_lease_id=$2 WHERE id=$1',[f.bound.requestId,replacement]);
  const repo=new RankingRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const result=await repo.resume({tenantId:tenant,flowRunId:f.flow,contract:f.ranking,executionAttemptId:f.bound.executionAttemptId,processingLeaseId:replacement});
  expect(result?.revisionId).toBe(sealed.revisionId);expect(result?.items.map(i=>i.candidateId)).toEqual(['a','z']);
 });
 it.each([false,true])('isolates oversized candidates, seals retry and publishes counts only (all=%s)',async all=>{
  const f=await fixture(),repo=new RankingRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const withheld:WithheldProfile[]=(all?['a','z']:['z']).map(candidateId=>({candidateId,reason:'evidence_too_large',evidenceHash:hash,bytes:65537,limit:65536}));
  const input={tenantId:tenant,flowRunId:f.flow,contract:f.ranking,executionAttemptId:f.bound.executionAttemptId,processingLeaseId:f.processingLeaseId,
   evidence:all?[]:f.evidence.filter(e=>e.candidateId==='a'),withheld,sourceTypes:new Map([['a','pool' as const]])};
  const result=await repo.publish(input);
  expect(result.items.map(e=>e.candidateId)).toEqual(all?[]:['a']);expect(JSON.stringify(result)).not.toContain('evidence_too_large');
  expect(await repo.publish(input)).toEqual(result);
  expect(await one('SELECT withheld_profiles result FROM governed_ranking_runs')).toEqual(withheld);
  const diagnostics=await one('SELECT diagnostics result FROM job_sourcing_requests WHERE id=$1',[f.bound.requestId]);
  expect(diagnostics.rubricRanking).toMatchObject({consideredCount:2,withheldCount:withheld.length,publishedCount:all?0:1});
  expect(JSON.stringify(diagnostics.rubricRanking)).not.toContain('candidateId');
  await refusal(()=>repo.publish({...input,withheld:withheld.map(e=>({...e,bytes:65538}))}),'RANKING_INPUT_CONFLICT');
  await refusal(()=>db.query("UPDATE governed_ranking_runs SET withheld_profiles='[]'"),'RANKING_IMMUTABLE');
 });
 it('refuses foreign, duplicate and invalid withholding and requires current privacy projections',async()=>{
  const f=await fixture(),withheld={candidateId:'z',reason:'evidence_too_large',evidenceHash:hash,bytes:65537,limit:65536};
  const claim=(w:unknown)=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,evidence:f.evidence.filter(e=>e.candidateId==='a'),withheld:w}]);
  await refusal(()=>claim([{...withheld,candidateId:'foreign'}]),'RANKING_EVIDENCE_SCOPE');
  await refusal(()=>claim([{...withheld,candidateId:'a'}]),'RANKING_DUPLICATE_IDENTITY');
  await refusal(()=>claim([{...withheld,bytes:65536}]),'RANKING_INVALID_WITHHOLDING');
  await db.query("DELETE FROM candidate_privacy_projection WHERE candidate_id='z'");
  await refusal(()=>claim([withheld]),'candidate_privacy_unavailable');
 });
 it('resumes the same withheld set after replacement and preserves its input hash',async()=>{
  const f=await fixture(),repo=new RankingRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const withheld=[{candidateId:'z',reason:'evidence_too_large',evidenceHash:hash,bytes:65537,limit:65536}];
  const claimed=await one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,
   evidence:f.evidence.filter(e=>e.candidateId==='a').map(e=>({...e,presentationSource:'pool'})),withheld}]);
  expect(claimed.inputHash).toBe(rankingHash({contractHash:f.ranking.contractHash,asOf:claimed.asOf,evidence:claimed.evidence,withheld}));
  const replacement=randomUUID();await db.query('UPDATE job_sourcing_requests SET processing_lease_id=$2 WHERE id=$1',[f.bound.requestId,replacement]);
  const result=await repo.resume({tenantId:tenant,flowRunId:f.flow,contract:f.ranking,executionAttemptId:f.bound.executionAttemptId,processingLeaseId:replacement});
  expect(result?.items.map(i=>i.candidateId)).toEqual(['a']);
  expect(await one('SELECT input_sha256 result FROM governed_ranking_runs')).toBe(claimed.inputHash);
  expect(await one('SELECT withheld_profiles result FROM governed_ranking_runs')).toEqual(withheld);
 });
 it('binds protocol2 exactly and refuses new protocol1 or changed contracts',async()=>{
  const f=await fixture();expect(await one('SELECT signal_sourcing_bind($1,$2,$3) result',[tenant,f.flow,f.body])).toMatchObject({idempotent:true});
  const {rankingContract:unused,...legacy}=f.body;
  const next=randomUUID();await refusal(()=>one('SELECT signal_sourcing_bind($1,$2,$3) result',[tenant,next,{...legacy,flowRunId:next,protocolVersion:1}]),'GOVERNED_PROTOCOL_CONFLICT');
  await refusal(()=>one('SELECT signal_sourcing_bind($1,$2,$3) result',[tenant,next,{...f.body,flowRunId:next,rankingContract:{...unused,contractHash:hash}}]),'RANKING_CONTRACT_CONFLICT');
 });
 it('seals all evidence and matches the TypeScript canonical input hash',async()=>{
  const f=await fixture(),claimed=await f.claim();
  expect(claimed.evidence.map((x:{candidateId:string})=>x.candidateId)).toEqual(['a','z']);
  expect(claimed.inputHash).toBe(rankingHash({contractHash:f.ranking.contractHash,asOf:claimed.asOf,evidence:claimed.evidence}));
  expect(await one('SELECT count(*)::integer result FROM governed_ranking_items')).toBe(2);
  await refusal(f.claim,'RANKING_CLAIM_REFUSED');
  await refusal(()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,evidence:f.evidence.slice(0,1)}]),'RANKING_INPUT_CONFLICT');
 });
 it('claims the full 2000-person bounded pool within its database lease budget',async()=>{
  const f=await fixture();
  const additional=Array.from({length:1998},(_,i)=>`load-${String(i).padStart(4,'0')}`);
  await db.query(`INSERT INTO candidates(id,"tenantId","linkedinId","linkedinUrl","updatedAt")
    SELECT id,$1,id,'https://example.invalid/'||id,clock_timestamp() FROM unnest($2::text[]) id`,[tenant,additional]);
  await db.query(`INSERT INTO candidate_privacy_projection(tenant_id,candidate_id,generation,decision,evaluated_cursor)
    SELECT $1,id,1,'allow',0 FROM unnest($2::text[]) id`,[tenant,additional]);
  await db.query("UPDATE candidate_privacy_sync_state SET expected_candidates=2000,projected_candidates=2000,last_success_at=clock_timestamp()");
  const evidence=[...f.evidence,...additional.map(candidateId=>({...f.evidence[0],candidateId}))];
  const start=Date.now();
  const claim=await one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,evidence}]);
  expect(claim.evidence).toHaveLength(2000);
  expect(Date.now()-start).toBeLessThan(30000);
  expect(claim.inputHash).toBe(rankingHash({contractHash:f.ranking.contractHash,asOf:claim.asOf,evidence:claim.evidence}));
 },40000);
 it('publishes one immutable ordering and callback-pending state atomically',async()=>{
  const f=await fixture(),repo=new RankingRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const input={tenantId:tenant,flowRunId:f.flow,contract:f.ranking,executionAttemptId:f.bound.executionAttemptId,processingLeaseId:f.processingLeaseId,
   evidence:f.evidence,sourceTypes:new Map([['z','discovered' as const],['a','pool' as const]])};
  const result=await repo.publish(input);
  expect(result.items.map(i=>[i.candidateId,i.ordinal,i.N,i.D])).toEqual([['a',1,1,1],['z',2,1,1]]);
  expect(await repo.publish(input)).toEqual(result);
  expect((await db.query('SELECT status,callback_status,"resultCount" FROM job_sourcing_requests WHERE id=$1',[f.bound.requestId])).rows[0]).toEqual({status:'complete',callback_status:'pending',resultCount:2});
  expect((await db.query('SELECT "candidateId",rank,"fitScore" FROM job_sourcing_candidates ORDER BY rank')).rows).toEqual([{candidateId:'a',rank:1,fitScore:null},{candidateId:'z',rank:2,fitScore:null}]);
  await refusal(()=>db.query("UPDATE governed_ranking_items SET score_n=0"),'RANKING_IMMUTABLE');
  await refusal(()=>db.query("UPDATE governed_ranking_runs SET state='failed'"),'RANKING_IMMUTABLE');
  await refusal(()=>db.query('DELETE FROM governed_ranking_items'),'RANKING_IMMUTABLE');
  await refusal(()=>db.query('TRUNCATE governed_ranking_items'),'RANKING_IMMUTABLE');
  expect(await one('SELECT signal_ranking_read($1,$2,$3) result',['foreign',f.flow,result.revisionId])).toBeNull();
 });
 it('rejects a manufactured order with no partial publication',async()=>{
  const f=await fixture(),claim=await f.claim(),scored=rankEvidence(f.ranking,claim.evidence,claim.asOf);
  const items=scored.items.map((i,index)=>({...i,ordinal:2-index,selectedOrdinal:2-index,sourceType:'pool'}));
  const body={inputHash:claim.inputHash,items};
  await refusal(()=>one('SELECT signal_ranking_finish($1,$2,$3,$4) result',[tenant,f.flow,claim.lease,{...body,outputHash:rankingHash(body)}]),'RANKING_ORDER_CONFLICT');
  expect(await one('SELECT count(*)::integer result FROM job_sourcing_candidates')).toBe(0);
  expect(await one('SELECT count(*)::integer result FROM governed_ranking_items WHERE assessment IS NOT NULL')).toBe(0);
 });
 it('resumes a sealed pool after worker replacement without acquiring new evidence',async()=>{
  const f=await fixture(),repo=new RankingRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const input={tenantId:tenant,flowRunId:f.flow,contract:f.ranking,executionAttemptId:f.bound.executionAttemptId,processingLeaseId:f.processingLeaseId};
  expect(await repo.resume(input)).toBeNull();
  f.command.evidence=f.evidence.map(e=>({...e,presentationSource:'pool' as const}));
  const first=await f.claim();
  const replacement=randomUUID();
  await db.query('UPDATE job_sourcing_requests SET processing_lease_id=$2 WHERE id=$1',[f.bound.requestId,replacement]);
  await refusal(()=>repo.resume(input),'GOVERNED_EXECUTION_STALE');
  const resumed=await repo.resume({...input,processingLeaseId:replacement});
  expect(resumed?.revisionId).toBe(first.revisionId);
  expect(resumed?.asOf).toBe(first.asOf);
  expect(resumed?.items.map(i=>i.candidateId)).toEqual(['a','z']);
  expect(await one('SELECT attempt_count result FROM governed_ranking_runs')).toBe(2);
  expect(await one('SELECT input_sha256 result FROM governed_ranking_runs')).toBe(first.inputHash);
  expect(await repo.resume({...input,processingLeaseId:replacement})).toEqual(resumed);
 });
 it('caps interrupted ranking attempts and rejects stale workers',async()=>{
  const f=await fixture(),first=await f.claim();
  let last=first;
  for(let attempt=2;attempt<=3;attempt++) {
   const replacement=randomUUID();
   await db.query('UPDATE job_sourcing_requests SET processing_lease_id=$2 WHERE id=$1',[f.bound.requestId,replacement]);
   await refusal(f.claim,'GOVERNED_EXECUTION_STALE');
   last=await one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,processingLeaseId:replacement,evidence:null}]);
   expect(last.inputHash).toBe(first.inputHash);
   expect(last.lease).not.toBe(first.lease);
  }
  const replacement=randomUUID();
  await db.query('UPDATE job_sourcing_requests SET processing_lease_id=$2 WHERE id=$1',[f.bound.requestId,replacement]);
  await refusal(()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,processingLeaseId:replacement,evidence:null}]),'RANKING_CLAIM_REFUSED');
  expect(await one('SELECT attempt_count result FROM governed_ranking_runs')).toBe(3);
  expect(await one('SELECT count(*)::integer result FROM job_sourcing_candidates')).toBe(0);
 });
 it.each(['block_global','block_all','review'])('suppresses only the newly restricted person at publication: %s',async decision=>{
  const f=await fixture();
  const claim=await f.claim(),scored=rankEvidence(f.ranking,claim.evidence,claim.asOf);
  const body={inputHash:claim.inputHash,items:scored.items.map((i,index)=>({...i,ordinal:index+1,selectedOrdinal:index+1,sourceType:'pool'}))};
  await db.query('UPDATE candidate_privacy_projection SET decision=$1 WHERE candidate_id=$2',[decision,'a']);
  await one('SELECT signal_ranking_finish($1,$2,$3,$4) result',[tenant,f.flow,claim.lease,{...body,outputHash:rankingHash(body)}]);
  expect(await one('SELECT count(*)::integer result FROM job_sourcing_candidates')).toBe(1);
  expect(await one('SELECT state result FROM governed_ranking_runs')).toBe('ready');
  const read=await one('SELECT signal_ranking_read($1,$2,$3) result',[tenant,f.flow,claim.revisionId]);
  expect(read.items.map((i:{candidateId:string;ordinal:number})=>[i.candidateId,i.ordinal])).toEqual([['z',2]]);
 });
 it.each(['stale','rebuilding','cursor','missing'])('refuses an unhealthy or incomplete privacy projection: %s',async mode=>{
  const f=await fixture();
  if(mode==='stale')await db.query("UPDATE candidate_privacy_sync_state SET last_success_at=clock_timestamp()-interval '301 seconds'");
  if(mode==='rebuilding')await db.query("UPDATE candidate_privacy_sync_state SET status='rebuilding'");
  if(mode==='cursor')await db.query('UPDATE candidate_privacy_sync_state SET cursor=1');
  if(mode==='missing')await db.query("DELETE FROM candidate_privacy_projection WHERE candidate_id='a'");
  await refusal(f.claim,'candidate_privacy_unavailable');
  expect(await one('SELECT count(*)::integer result FROM governed_ranking_runs')).toBe(0);
 });
 it('rejects cross-organization evidence and duplicate input identities',async()=>{
  const f=await fixture();
  await refusal(()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,evidence:[{...f.evidence[0],organizationRef:'99'}]}]),'RANKING_EVIDENCE_SCOPE');
  await refusal(()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,evidence:[f.evidence[0],f.evidence[0]]}]),'RANKING_DUPLICATE_IDENTITY');
  expect(await one('SELECT count(*)::integer result FROM governed_ranking_runs')).toBe(0);
 });
 it('rejects malformed nested evidence before sealing any rows',async()=>{
  const f=await fixture();
  for(const fact of [null,{...f.evidence[0].facts[0],scope:'public',organizationRef:'28'},
    {...f.evidence[0].facts[0],kind:'headline'},{...f.evidence[0].facts[0],extra:true}]) {
    await refusal(()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,
      {...f.command,evidence:[{...f.evidence[0],facts:[fact]}]}]),'RANKING_INVALID_EVIDENCE');
  }
  expect(await one('SELECT count(*)::integer result FROM governed_ranking_runs')).toBe(0);
 });
 it('refuses null and fractional assessment scores without rounding them into valid points',async()=>{
  const f=await fixture(),claim=await f.claim(),scored=rankEvidence(f.ranking,claim.evidence,claim.asOf);
  const items=scored.items.map((i,index)=>({...i,ordinal:index+1,selectedOrdinal:index+1,sourceType:'pool'}));
  for(const patch of [{weight:null},{weight:1.2},{points:0.5},{state:null},{criterionIds:[randomUUID()]},{labels:['Unapproved criterion']}]) {
    const changed=structuredClone(items);Object.assign(changed[0].assessments[0],patch);
    const body={inputHash:claim.inputHash,items:changed};
    await refusal(()=>one('SELECT signal_ranking_finish($1,$2,$3,$4) result',[tenant,f.flow,claim.lease,
      {...body,outputHash:rankingHash(body)}]),'RANKING_INVALID_RESULT');
  }
  expect(await one('SELECT count(*)::integer result FROM job_sourcing_candidates')).toBe(0);
 });
});
