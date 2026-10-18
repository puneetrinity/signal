import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {Client} from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {canonical,createRankingContract,rankingHash} from '../contracts';
import {adaptProfile,evidenceBytes,evidenceSchema,type WithheldProfile} from '../evidence';
import {rankEvidence} from '../score';
import {RankingRepository} from '../repository';
import {RANKING_CATALOG_SQL,RANKING_CATALOG_SHA256} from '../../../../../scripts/check-rubric-ranking.mjs';

const enabled=process.env.SIGNAL_RANKING_DISPOSABLE==='1';
describe.skipIf(process.env.SIGNAL_RANKING_STAGE1_RUNTIME!=='1')('Stage1 real restricted-wrapper contention and deadline',()=>{
 let owner:Client,blocker:Client;
 const tenant='org_98271',hash='a'.repeat(64);
 beforeAll(async()=>{
  for(const raw of [process.env.SIGNAL_RANKING_OWNER_URL,process.env.DATABASE_URL]){
   const u=new URL(raw??'');if(u.hostname!=='127.0.0.1'||!u.pathname.endsWith('_test')||!u.username.endsWith('_test'))throw Error('DISPOSABLE_TARGET_REQUIRED');
  }
  owner=new Client({connectionString:process.env.SIGNAL_RANKING_OWNER_URL});blocker=new Client({connectionString:process.env.SIGNAL_RANKING_OWNER_URL});
  await owner.connect();await blocker.connect();
  const {prisma}=await import('@/lib/prisma');
  expect((await prisma.$queryRawUnsafe<Array<{rolsuper:boolean;rolbypassrls:boolean}>>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))[0]).toEqual({rolsuper:false,rolbypassrls:false});
  expect((await prisma.$queryRawUnsafe<Array<{raw:boolean;helper:boolean}>>("SELECT has_table_privilege(current_user,'governed_ranking_runs','SELECT') raw,has_function_privilege(current_user,'signal_ranking_canonical(jsonb)','EXECUTE') helper"))[0]).toEqual({raw:false,helper:false});
  await owner.query("INSERT INTO governed_sourcing_tenants(tenant_id,enabled_at,policy_hash,allow_new,organization_ref,callback_url) VALUES($1,clock_timestamp(),$2,true,'28','https://flow.example/api/webhooks/signal/callback') ON CONFLICT DO NOTHING",[tenant,hash]);
 });
 afterAll(async()=>{await blocker?.query('ROLLBACK');await blocker?.end();await owner?.end();const {prisma}=await import('@/lib/prisma');await prisma.$disconnect();});
 async function fixture(){
  const flow=randomUUID(),candidateId=randomUUID(),contract=createRankingContract(randomUUID(),hash,{schemaVersion:3,compilerVersion:3,taxonomyVersion:3,criteria:[{
   id:randomUUID(),label:'Python',class:'must_have',subject:'skill',requirement:{kind:'accepted_skills',primary:'Python',alternatives:[]},use:'assessment',evidenceKinds:['profile_evidence'],provenance:{kind:'recruiter_edit'}}]});
  const body={protocolVersion:2,flowRunId:flow,organizationRef:'28',externalJobId:'vanta:jobs:'+flow,briefVersionId:contract.briefVersionId,materialHash:hash,artifactHash:hash,compilerVersion:'1',queryArtifact:{jobContext:{}},rankingContract:contract,callbackUrl:'https://flow.example/api/webhooks/signal/callback'};
  const bound=(await owner.query('SELECT signal_sourcing_bind($1,$2,$3) result',[tenant,flow,body])).rows[0].result,processingLeaseId=randomUUID();
  await owner.query("UPDATE job_sourcing_requests SET status='processing',processing_lease_id=$2 WHERE id=$1",[bound.requestId,processingLeaseId]);
  await owner.query('INSERT INTO candidates(id,"tenantId","linkedinId","linkedinUrl","updatedAt") VALUES($1,$2,$1,$3,clock_timestamp())',[candidateId,tenant,'https://linkedin.com/in/'+candidateId]);
  await owner.query("INSERT INTO candidate_privacy_projection(tenant_id,candidate_id,generation,decision,evaluated_cursor) VALUES($1,$2,1,'allow',0)",[tenant,candidateId]);
  await owner.query("UPDATE candidate_privacy_sync_state SET status='healthy',active_generation=1,cursor=0,expected_candidates=(SELECT count(*) FROM candidate_privacy_projection),projected_candidates=(SELECT count(*) FROM candidate_privacy_projection),last_success_at=clock_timestamp()");
  return{tenantId:tenant,flowRunId:flow,contract,executionAttemptId:bound.executionAttemptId,processingLeaseId,
   evidence:[adaptProfile({candidateId,organizationRef:'28',profile:{skills:['Python']},sourceVersion:hash,observedAt:'2026-01-01T00:00:00.000Z'})],sourceTypes:new Map([[candidateId,'pool' as const]])};
 }
 it('a real busy response rolls back untouched and retries to publication without changing execution',async()=>{
  const f=await fixture();await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('discover_candidate_privacy_admission_v1',0))");
  const pending=new RankingRepository().publish(f);void pending.catch(()=>{});
  try{await new Promise(r=>setTimeout(r,2700));
   expect((await owner.query('SELECT count(*)::int n FROM governed_ranking_runs WHERE flow_run_id=$1',[f.flowRunId])).rows[0].n).toBe(0);
  }finally{await blocker.query('COMMIT');}
  expect((await pending).items).toHaveLength(1);
  expect((await owner.query('SELECT execution_attempt_id,processing_lease_id FROM governed_ranking_runs WHERE flow_run_id=$1',[f.flowRunId])).rows[0]).toEqual({execution_attempt_id:f.executionAttemptId,processing_lease_id:f.processingLeaseId});
 },15000);
 it('the real wrapper cancels a slow statement at 30 seconds before acquiring the shared lock',async()=>{
  const f=await fixture(),old=(await owner.query("SELECT pg_get_functiondef('signal_ranking_transport_parse(text)'::regprocedure) definition")).rows[0].definition;
  try{
   await owner.query("CREATE OR REPLACE FUNCTION public.signal_ranking_transport_parse(p_text text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$ BEGIN PERFORM pg_sleep(31); RETURN p_text::jsonb; END $$");
   const start=Date.now();await expect(new RankingRepository().publish(f)).rejects.toThrow(/statement timeout|57014/);
   expect(Date.now()-start).toBeGreaterThanOrEqual(29000);expect(Date.now()-start).toBeLessThan(35000);
   expect((await owner.query('SELECT count(*)::int n FROM governed_ranking_runs WHERE flow_run_id=$1',[f.flowRunId])).rows[0].n).toBe(0);
  }finally{await owner.query(old);}
 },40000);
 it('the real Prisma client logs only fixed errors for rejected canonical text',async()=>{
  const f=await fixture();
  const script=`const fs=require('node:fs'),{prisma}=require('./src/lib/prisma.ts');(async()=>{
   const data=JSON.parse(fs.readFileSync(0,'utf8'));
   try{await prisma.$queryRawUnsafe('SELECT public.signal_ranking_claim($1,$2::uuid,$3::jsonb)',...data);process.exitCode=2;}
   catch(e){console.error(JSON.stringify({message:e.message,meta:e.meta}));if(!e.message.includes('RANKING_INVALID_CANONICAL_TEXT'))process.exitCode=3;}
   finally{await prisma.$disconnect();}})().catch(()=>{process.exitCode=4});`;
  const command={transportVersion:1,responseMode:'compact',contractHash:f.contract.contractHash,executionAttemptId:f.executionAttemptId,processingLeaseId:f.processingLeaseId,
   evidenceCanonical:['{"x":PRIVATE_SENTINEL_9281}'],withheldCanonical:[]};
  const child=spawnSync(process.execPath,['--require','tsx/cjs','-e',script],{cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',DATABASE_URL:process.env.DATABASE_URL},input:JSON.stringify([f.tenantId,f.flowRunId,JSON.stringify(command)]),encoding:'utf8',timeout:15000});
  expect(child.stdout+child.stderr).not.toContain('PRIVATE_SENTINEL_9281');
  expect(child.status,child.stderr).toBe(0);expect(child.stdout+child.stderr).toContain('RANKING_INVALID_CANONICAL_TEXT');
  expect((await owner.query('SELECT count(*)::int n FROM governed_ranking_runs WHERE flow_run_id=$1',[f.flowRunId])).rows[0].n).toBe(0);
 },20000);
});
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
  await db.query("SET LOCAL statement_timeout='30s'");
  await db.query("SET LOCAL lock_timeout='2s'");
  await db.query("SET LOCAL signal.ranking_privacy_max_age_ms='120000'");
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
 it('validates the tagged text transport with exact character parity and fixed parser errors',async()=>{
  const f=await fixture(),e=f.evidence[0];
  for(const value of [String.fromCharCode(...Array.from({length:31},(_,i)=>i+1)),String.fromCharCode(127),'雪😀\u2028\u2029e\u0301é','"\\/']){
   const v={...e,facts:[{...e.facts[0],value}]};
   expect(await one("SELECT signal_ranking_transport_record('evidence',$1) result",[canonical(v)])).toEqual(v);
  }
  for(const text of ['{"PRIVATE_SENTINEL_9281":','{"x":"PRIVATE_SENTINEL_9281\\u0000"}','{"x":"PRIVATE_SENTINEL_9281\\ud800"}']){
   await db.query('SAVEPOINT parser');
   try{await db.query("SELECT signal_ranking_transport_record('evidence',$1)",[text]);throw Error('accepted');}
   catch(error){const err=error as Error&{detail?:string;hint?:string;where?:string};expect(err.message).toBe('RANKING_INVALID_CANONICAL_TEXT');expect(JSON.stringify([err.message,err.detail,err.hint,err.where])).not.toContain('PRIVATE_SENTINEL_9281');}
   finally{await db.query('ROLLBACK TO SAVEPOINT parser');}
  }
  for(const text of [canonical(e)+' ',' '+canonical(e),'{"candidateId":"other",'+canonical(e).slice(1),canonical(e).replace('candidateId','\\u0063andidateId')])
   await refusal(()=>one("SELECT signal_ranking_transport_record('evidence',$1) result",[text]),'RANKING_NONCANONICAL_TEXT');
  for(const observedAt of ['0000-02-29T00:00Z','2026-01-01T00:00Z','2000-02-29T23:59:59.1234567Z','2024-02-29T00:00:00Z',
   '1900-02-29T00:00:00Z','2100-02-29T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T23:59:60Z',
   '2026-01-01T00:00:00+00:00','2026-01-01T00:00:00','2026-01-01T00:00:00Z\n']){
   const v={...e,facts:[{...e.facts[0],observedAt}]};
   if(evidenceSchema.safeParse(v).success)expect(await one("SELECT signal_ranking_transport_record('evidence',$1) result",[canonical(v)])).toEqual(v);
   else await refusal(()=>one("SELECT signal_ranking_transport_record('evidence',$1) result",[canonical(v)]),'RANKING_INVALID_CANONICAL_SHAPE');
  }
 });
 it('does not lose an invalid first, middle, last or all-invalid record in aggregation',async()=>{
  const f=await fixture();
  for(const invalid of [[0],[1],[2],[0,1,2]]){
   const texts=['a','b','c'].map((candidateId,index)=>canonical({...f.evidence[0],candidateId,...(invalid.includes(index)?{facts:[{...f.evidence[0].facts[0],extra:true}]}:{})}));
   const {evidence:ignored,...metadata}=f.command;void ignored;
   await refusal(()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...metadata,transportVersion:1,responseMode:'compact',evidenceCanonical:texts,withheldCanonical:[]}]),'RANKING_INVALID_CANONICAL_SHAPE');
   expect(await one('SELECT count(*)::integer result FROM governed_ranking_runs')).toBe(0);
  }
 });
 it('rejects noncanonical numeric spelling, coercions, unsafe numbers and nested fields',async()=>{
  const f=await fixture(),ranked=rankEvidence(f.ranking,f.evidence,'2026-10-01T00:00:00.000Z');
  const item={...ranked.items[0],ordinal:1,selectedOrdinal:1,sourceType:'pool'};
  expect(await one("SELECT signal_ranking_transport_record('item',$1) result",[canonical(item)])).toEqual(item);
  for(const text of [canonical(item).replace('"ordinal":1','"ordinal":1.0'),canonical(item).replace('"ordinal":1','"ordinal":1e0'),canonical(item).replace(/"L":\d+/, '"L":-0')])
   await refusal(()=>one("SELECT signal_ranking_transport_record('item',$1) result",[text]),'RANKING_NONCANONICAL_TEXT');
  for(const value of [{...item,N:'1'},{...item,ordinal:1.5},{...item,ordinal:9007199254740992},{...item,extra:true},
   {...item,experience:{...item.experience,lowerDays:false}},{...item,assessments:[{...item.assessments[0],weight:2}]}])
   await refusal(()=>one("SELECT signal_ranking_transport_record('item',$1) result",[canonical(value)]),'RANKING_INVALID_CANONICAL_SHAPE');
  for(const key of Object.keys(f.evidence[0])){
   const changed={...f.evidence[0],[key]:123};
   await refusal(()=>one("SELECT signal_ranking_transport_record('evidence',$1) result",[canonical(changed)]),'RANKING_INVALID_CANONICAL_SHAPE');
  }
  for(const value of [null,1,'PRIVATE_SENTINEL_9281',[],true])for(const key of ['facts','employment'])
   await refusal(()=>one("SELECT signal_ranking_transport_record('evidence',$1) result",[canonical({...f.evidence[0],[key]:[value]})]),'RANKING_INVALID_CANONICAL_SHAPE');
  const unicode={...f.evidence[0],facts:[{...f.evidence[0].facts[0],value:'😀'.repeat(250)}]};
  expect(await one("SELECT signal_ranking_transport_record('evidence',$1) result",[canonical(unicode)])).toEqual(unicode);
  unicode.facts[0].value+='a';
  await refusal(()=>one("SELECT signal_ranking_transport_record('evidence',$1) result",[canonical(unicode)]),'RANKING_INVALID_CANONICAL_SHAPE');
  for(const eligibility of ['in_range','wider','unconstrained','outside_experience_range','experience_unavailable','uncertain_boundary','wider_skills_not_established'])
   expect(await one("SELECT signal_ranking_transport_record('item',$1) result",[canonical({...item,eligibility,ordinal:2000,selectedOrdinal:null})])).toEqual({...item,eligibility,ordinal:2000,selectedOrdinal:null});
 });
 it('proves tagged input order, disjoint IDs and scope before sealing',async()=>{
  const f=await fixture(),ordered=[...f.evidence].sort((a,b)=>Buffer.compare(Buffer.from(a.candidateId),Buffer.from(b.candidateId)));
  const cmd={transportVersion:1,responseMode:'compact',contractHash:f.ranking.contractHash,executionAttemptId:f.bound.executionAttemptId,processingLeaseId:f.processingLeaseId,evidenceCanonical:ordered.map(canonical),withheldCanonical:[] as string[]};
  const run=(command:unknown)=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,command]);
  await refusal(()=>run({...cmd,evidenceCanonical:[...cmd.evidenceCanonical].reverse()}),'RANKING_INPUT_ORDER');
  await refusal(()=>run({...cmd,evidenceCanonical:[cmd.evidenceCanonical[0],cmd.evidenceCanonical[0]]}),'RANKING_INPUT_ORDER');
  const w={candidateId:ordered[0].candidateId,reason:'evidence_too_large',evidenceHash:hash,bytes:65537,limit:65536};
  await refusal(()=>run({...cmd,withheldCanonical:[canonical(w)]}),'RANKING_DUPLICATE_IDENTITY');
  for(const e of [
   {...ordered[0],organizationRef:'29'},
   {...ordered[0],facts:[{...ordered[0].facts[0],scope:'organization',organizationRef:'29'}]},
   {...ordered[0],facts:[{...ordered[0].facts[0],scope:'public',organizationRef:'28'}]},
  ])await refusal(()=>run({...cmd,evidenceCanonical:[canonical(e)]}),e.organizationRef==='29'?'RANKING_EVIDENCE_SCOPE':'RANKING_INVALID_CANONICAL_SHAPE');
  expect(await one('SELECT count(*)::integer result FROM governed_ranking_runs')).toBe(0);
  await db.query("UPDATE candidate_privacy_projection SET decision='block_all' WHERE candidate_id=$1",[ordered[0].candidateId]);
  expect((await run(cmd)).state).toBe('reprepare');
 });
 it('tagged buffers preserve withheld hashes and exact saved-evidence comparison',async()=>{
  const f=await fixture(),e=f.evidence.find(e=>e.candidateId==='a')!;
  const withheld=[{candidateId:'z',reason:'evidence_too_large',evidenceHash:hash,bytes:65537,limit:65536}];
  const cmd={transportVersion:1,responseMode:'compact',contractHash:f.ranking.contractHash,executionAttemptId:f.bound.executionAttemptId,processingLeaseId:f.processingLeaseId,evidenceCanonical:[canonical(e)],withheldCanonical:withheld.map(canonical)};
  const run=(command:unknown)=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,command]);
  const first=await run(cmd);expect(first.inputHash).toBe(rankingHash({asOf:first.asOf,contractHash:f.ranking.contractHash,evidence:[e],withheld}));
  await db.query("UPDATE governed_ranking_runs SET lease_until=clock_timestamp()-interval '1 second'");
  await refusal(()=>run({...cmd,evidenceCanonical:[canonical({...e,presentationSource:'pool_enriched'})]}),'RANKING_INPUT_CONFLICT');
  const resumed=await run(cmd);expect(resumed.inputHash).toBe(first.inputHash);
  await db.query("UPDATE governed_ranking_runs SET lease_until=clock_timestamp()-interval '1 second'");
  const saved=await run({...f.command,evidence:null});expect(saved.evidence).toEqual([e]);expect(saved.withheld).toEqual(withheld);expect(saved.inputHash).toBe(first.inputHash);
 });
 it('accounts for exact logical jsonb bytes without rebuilding a full command',async()=>{
  const f=await fixture(),e={...f.evidence.find(e=>e.candidateId==='a')!,employment:[{title:'雪😀\n\"\\'}]};
  const withheld=[{candidateId:'z',reason:'evidence_too_large',evidenceHash:hash,bytes:65537,limit:65536}];
  const metadata={responseMode:'compact',contractHash:f.ranking.contractHash,executionAttemptId:f.bound.executionAttemptId,processingLeaseId:f.processingLeaseId};
  const logical={...metadata,evidence:[e],withheld};
  const exact=await one('SELECT octet_length($1::jsonb::text) result',[logical]);expect(exact).toBe(evidenceBytes(logical));
  const definition=await one("SELECT pg_get_functiondef('signal_ranking_claim(text,uuid,jsonb)'::regprocedure) result");
  expect(definition).toContain('logical_bytes>134217728');
  // Disposable mutation of only the threshold exercises the real accounting
  // at below/exact/above boundaries without allocating a 128MiB test command.
  for(const limit of [exact-1,exact,exact+1]){
   await db.query('SAVEPOINT size_probe');
   await db.query(definition.replace('logical_bytes>134217728',`logical_bytes>${limit}`));
   const run=()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...metadata,transportVersion:1,evidenceCanonical:[canonical(e)],withheldCanonical:withheld.map(canonical)}]);
   if(limit<exact)await expect(run()).rejects.toThrow('RANKING_INVALID_COMMAND');
   else expect((await run()).state).toBe('reserved_compact');
   await db.query('ROLLBACK TO SAVEPOINT size_probe');
  }
 });
 it('tagged claim and finish preserve the historical canonical hashes, including recovery',async()=>{
  const f=await fixture(),{computeRankingMessage}=await import('../ranking-compute-worker');
  const prepared=computeRankingMessage({kind:'prepare',input:{contract:f.ranking,executionAttemptId:f.bound.executionAttemptId,processingLeaseId:f.processingLeaseId,evidence:f.evidence,sourceTypes:f.evidence.map(e=>[e.candidateId,'pool'])}});
  if(prepared.kind!=='prepared')throw Error('prepare');
  const claim=await one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,prepared.command]);
  expect(claim.state).toBe('reserved_compact');
  expect(claim.inputHash).toBe(rankingHash({asOf:claim.asOf,contractHash:f.ranking.contractHash,evidence:prepared.evidence}));
  const computed=computeRankingMessage({kind:'claim',input:{contract:f.ranking,claim,expected:prepared}});
  if(computed.kind!=='computed'||computed.state!=='reserved')throw Error('compute');
  const finished=await one('SELECT signal_ranking_finish($1,$2,$3,$4) result',[tenant,f.flow,computed.lease,computed.command]);
  expect(finished.outputHash).toBe(computed.outputHash);
  expect(await one("SELECT count(*)::integer result FROM governed_ranking_items WHERE evidence_sha256<>encode(sha256(convert_to(signal_ranking_canonical(evidence),'UTF8')),'hex')")).toBe(0);
 });
 it('preserves canonical bytes for nested, empty and escaped input and rejects nontext contract hashes',async()=>{
  const {canonical}=await import('../contracts');
  for(const value of [{},[],{z:[null,true,1e-7,'é 😀\n"'],a:{b:2,a:1}},'plain']){
   expect(await one('SELECT public.signal_ranking_canonical($1::jsonb) result',[JSON.stringify(value)])).toBe(canonical(value));
  }
  const f=await fixture();
  await refusal(()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,contractHash:123}]),'RANKING_INVALID_COMMAND');
 });
 it('requires the configured privacy bound and rechecks it at claim',async()=>{
  const f=await fixture();
  await db.query("SET LOCAL signal.ranking_privacy_max_age_ms=''");
  await refusal(f.claim,'candidate_privacy_configuration_invalid');
  await db.query("SET LOCAL signal.ranking_privacy_max_age_ms='60000'");
  await db.query("UPDATE candidate_privacy_sync_state SET last_success_at=clock_timestamp()-interval '70 seconds'");
  await refusal(f.claim,'candidate_privacy_unavailable');
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
  // Upgrade through the current routines before running the current wrapper.
  const stage1=readFileSync('prisma/migrations/20261012000000_ranking_lock_work/migration.sql','utf8');
  await db.query(stage1.slice(stage1.indexOf('CREATE OR REPLACE FUNCTION public.signal_ranking_claim')));
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
 it('publishes schema-4 resume evidence with immutable provenance and no public identity',async()=>{
  const tenant='org_28';
  await db.query("INSERT INTO governed_sourcing_tenants(tenant_id,enabled_at,policy_hash,allow_new,organization_ref,callback_url) VALUES($1,clock_timestamp(),$2,true,'28','https://flow.example/api/webhooks/signal/callback')",[tenant,hash]);
  const flow=randomUUID(),identity={candidateId:randomUUID(),referenceId:randomUUID(),applicationId:123,applicationJobId:188,
   resumeVersionId:randomUUID(),sourceId:randomUUID(),generationId:randomUUID(),sourceHash:hash};
  const candidateId=await one('SELECT signal_private_candidate_materialize($1,$2) result',
   [tenant,{identity,linkedPublicId:null,observedAt:'2026-01-01T00:00:00Z'}]);
  const ranking=createRankingContract(randomUUID(),hash,{schemaVersion:4,compilerVersion:4,taxonomyVersion:4,criteria:[{
   id:randomUUID(),label:'Python',class:'must_have',subject:'skill',requirement:{kind:'accepted_skills',primary:'Python',alternatives:[]},
   use:'assessment',evidenceKinds:['candidate_provided','profile_evidence'],provenance:{kind:'recruiter_edit'}}]});
  const body={protocolVersion:2,flowRunId:flow,organizationRef:'28',externalJobId:'vanta:jobs:95101',briefVersionId:ranking.briefVersionId,
   materialHash:hash,artifactHash:hash,compilerVersion:'1',queryArtifact:{jobContext:{}},rankingContract:ranking,
   callbackUrl:'https://flow.example/api/webhooks/signal/callback'};
  const bound=await one('SELECT signal_sourcing_bind($1,$2,$3) result',[tenant,flow,body]),processingLeaseId=randomUUID();
  await db.query("UPDATE job_sourcing_requests SET status='processing',processing_lease_id=$2 WHERE id=$1",[bound.requestId,processingLeaseId]);
  await db.query("INSERT INTO candidate_privacy_projection(tenant_id,candidate_id,generation,decision,evaluated_cursor) VALUES($1,$2,1,'allow',0)",[tenant,candidateId]);
  await db.query("UPDATE candidate_privacy_sync_state SET status='healthy',active_generation=1,expected_candidates=1,projected_candidates=1,last_success_at=clock_timestamp() WHERE consumer_name='discover'");
  const evidence=evidenceSchema.parse({candidateId,organizationRef:'28',version:'rubric-evidence-v2',employment:[],employmentSources:[],resumeIdentity:identity,
   facts:[{field:'skill',value:'Python',ref:'resume.skill',kind:'candidate_provided',scope:'organization',organizationRef:'28',sourceVersion:hash,observedAt:'2026-01-01T00:00:00.000Z'}]});
  expect(await one("SELECT signal_ranking_transport_record('evidence',$1) result",[canonical(evidence)])).toEqual(evidence);
  const repo=new RankingRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const result=await repo.publish({tenantId:tenant,flowRunId:flow,contract:ranking,executionAttemptId:bound.executionAttemptId,
   processingLeaseId,evidence:[evidence],sourceTypes:new Map([[candidateId,'pool' as const]])});
  expect(result.items).toHaveLength(1);expect(result.items[0]).toMatchObject({candidateId,N:3,D:3});
  expect(await one('SELECT signal_private_ranking_sources($1,$2,$3) result',[tenant,flow,result.revisionId])).toEqual([{candidateId,identity}]);
  expect(await one('SELECT signal_private_contact_allowed($1,$2) result',[tenant,candidateId])).toBe(false);
 });
 it('compact claim returns only sealed metadata; replacement recovery returns the identical stored pool',async()=>{
  const f=await fixture();
  await refusal(()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,responseMode:'invalid'}]),'RANKING_INVALID_COMMAND');
  await refusal(()=>one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,responseMode:'compact',evidence:null}]),'RANKING_INVALID_COMMAND');
  const compact=await one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,responseMode:'compact'}]);
  expect(Object.keys(compact).sort()).toEqual(['asOf','contractHash','inputHash','lease','revisionId','state']);
  expect(compact.state).toBe('reserved_compact');expect(compact.contractHash).toBe(f.ranking.contractHash);
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(600);
  expect(compact.inputHash).toBe(rankingHash({contractHash:f.ranking.contractHash,asOf:compact.asOf,evidence:[...f.evidence].sort((a,b)=>a.candidateId.localeCompare(b.candidateId))}));
  const replacement=randomUUID();await db.query('UPDATE job_sourcing_requests SET processing_lease_id=$2 WHERE id=$1',[f.bound.requestId,replacement]);
  const recovered=await one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,f.flow,{...f.command,processingLeaseId:replacement,evidence:null}]);
  expect(recovered.state).toBe('reserved');expect(recovered.evidence).toHaveLength(2);
  expect(recovered.inputHash).toBe(compact.inputHash);expect(recovered.revisionId).toBe(compact.revisionId);
  expect(recovered.inputHash).toBe(rankingHash({contractHash:f.ranking.contractHash,asOf:recovered.asOf,evidence:recovered.evidence}));
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
