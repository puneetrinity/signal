import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {Client} from 'pg';
import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect} from 'vitest';
import {adaptNetworkPublication} from '../rubric/evidence';
import {canonical,rankingHash,createRankingContract} from '../rubric/contracts';
import {rankEvidence} from '../rubric/score';
import {networkHitSchema,revalidatedNetworkHits,deduplicateNetworkAgainstProviders} from '../candidate-network';
import {signActiveGraphJWT} from '../activegraph-auth';
import {RANKING_CATALOG_SQL,NETWORK_CATALOG_SQL,RANKING_CATALOG_SHA256,NETWORK_CATALOG_SHA256,NETWORK_FUNCTIONS,NETWORK_PRIVATE_FUNCTIONS,assertNetworkCatalog} from '../../../../scripts/check-rubric-ranking.mjs';
import {RC_CATALOG_SQL,RC_CATALOG_SHA256} from '../../../../scripts/check-rc-skills.mjs';
import {PRIVATE_RESUME_CATALOG_SQL,PRIVATE_RESUME_CATALOG_SHA256} from '../../../../scripts/check-private-resume.mjs';

describe.skipIf(process.env.SIGNAL_NETWORK_DISPOSABLE!=='1')('native publication full-schema database',()=>{
  let db:Client;
  const tenant='org_28';
  const one=async(sql:string,args:unknown[]=[]) => {
    try{return (await db.query(sql,args)).rows[0]?.result;}
    catch(error){const e=error as Error&{detail?:string;where?:string};throw Error(`${e.message}: ${e.detail??''}; ${e.where??''}`);}
  };
  beforeAll(async()=>{
    const target=new URL(process.env.SIGNAL_NETWORK_OWNER_URL??'');
    if(target.hostname!=='127.0.0.1'||!target.pathname.endsWith('_test')||!target.username.endsWith('_test'))throw Error('DISPOSABLE_TARGET_REQUIRED');
    db=new Client({connectionString:target.toString(),connectionTimeoutMillis:2000});await db.connect();
    expect((await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
    if((await db.query("SELECT to_regclass('public.candidates') relation")).rows[0].relation)throw Error('FRESH_DISPOSABLE_REQUIRED');
    const manifest=JSON.parse(readFileSync('prisma/baseline/manifest.json','utf8'));
    const baseline=readFileSync(manifest.baselinePath,'utf8');
    expect(createHash('sha256').update(baseline).digest('hex')).toBe(manifest.baselineSha256);
    await db.query('BEGIN');
    await db.query(baseline.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
    for(const name of readdirSync('prisma/migrations').filter(n=>n>manifest.baselineMigrationThrough).sort()){
      try{await db.query(readFileSync(`prisma/migrations/${name}/migration.sql`,'utf8'));}
      catch(error){throw Error(`${name}: ${(error as Error).message}`);}
    }
  },120000);
  beforeEach(async()=>{await db.query('SAVEPOINT fixture');await db.query("SET LOCAL signal.ranking_privacy_max_age_ms='120000'");});
  afterEach(async()=>{await db.query('ROLLBACK TO SAVEPOINT fixture');});
  afterAll(async()=>{if(db){await db.query('ROLLBACK');await db.end();}});
  function hit(){
    const facts={displayName:'Synthetic Candidate',headline:'Engineer',currentLocation:null,skills:['Python'],employment:[],education:[]};
    const subjectId=randomUUID();
    return networkHitSchema.parse({kind:'candidate_network',identity:`network:${subjectId}`,subjectId,publicationId:randomUUID(),globalCandidateId:randomUUID(),
      profileVersion:1,preferenceVersion:1,consentRevision:1,contentHash:rankingHash(facts),encoderVersion:1,observedAt:'2026-01-01T00:00:00.000Z',facts,similarity:0.8});
  }
  async function materialize(value=hit()){
    const id=await one('SELECT signal_network_candidate_materialize($1,$2) result',[tenant,value]);
    return {id,hit:value,evidence:adaptNetworkPublication(id,'28',value)};
  }
  async function refused(operation:()=>Promise<unknown>){
    await db.query('SAVEPOINT refused');await expect(operation()).rejects.toThrow();await db.query('ROLLBACK TO SAVEPOINT refused');
  }
  it('stores one native identity without LinkedIn or contact data and replays exactly',async()=>{
    const f=await materialize();expect((await materialize(f.hit)).id).toBe(f.id);
    expect((await db.query('SELECT "identityKind","linkedinUrl","linkedinId","privateCandidateRef" FROM candidates WHERE id=$1',[f.id])).rows[0])
      .toEqual({identityKind:'candidate_network',linkedinUrl:null,linkedinId:null,privateCandidateRef:null});
    expect(await one('SELECT count(*)::int result FROM candidate_network_sources')).toBe(1);
    expect(await one('SELECT signal_private_contact_allowed($1,$2) result',[tenant,f.id])).toBe(false);
  });
  it('refuses a changed publication or canonical binding',async()=>{
    const f=await materialize();
    await refused(()=>materialize({...f.hit,consentRevision:2}));
    await refused(()=>materialize({...f.hit,contentHash:'b'.repeat(64)}));
    expect(await one('SELECT signal_network_evidence_bound($1,$2) result',[tenant,{...f.evidence,networkIdentity:{subjectId:f.hit.subjectId}}])).toBe(false);
    expect(await one('SELECT signal_network_evidence_bound($1,$2) result',['org_29',f.evidence])).toBe(false);
  });
  it('matches TypeScript canonical evidence and keeps the historical private validator strict',async()=>{
    const f=await materialize();
    expect(await one("SELECT signal_ranking_rebuild('evidence',$1) result",[f.evidence])).toBe(canonical(f.evidence));
    const {networkIdentity,...unbound}=f.evidence as typeof f.evidence&{networkIdentity:unknown};
    expect(networkIdentity).toBeTruthy();
    await refused(()=>one("SELECT signal_ranking_rebuild('evidence',$1) result",[unbound]));
  });
  it('refuses nested private fields, contact values and wrong types even with a valid recomputed hash',async()=>{
    const original=hit();
    for(const facts of [
      {...original.facts,employment:[{employer:'Acme',title:'Engineer',start:null,end:null,current:true,email:'hidden@example.test'}]},
      {...original.facts,skills:['hidden@example.test']},
      {...original.facts,headline:'+919876543210'},
      {...original.facts,currentLocation:{city:'Pune',countryCode:'IN',displayCountry:'India',phone:'1234567890'}},
      {...original.facts,skills:{}},
      {...original.facts,education:[{institution:'College',qualification:'BSc',start:{value:'2020',precision:'year',private:'x'},end:null,current:false}]},
      {...original.facts,displayName:'a'.repeat(201)},
    ]){
      await refused(()=>one('SELECT signal_network_candidate_materialize($1,$2) result',[tenant,{...original,facts,contentHash:rankingHash(facts)}]));
    }
    expect(await one('SELECT count(*)::int result FROM candidate_network_sources')).toBe(0);
  });
  it('accepts full structured dates without mistaking them for phone numbers',async()=>{
    const original=hit();
    const facts={...original.facts,employment:[{employer:'Acme',title:'Engineer',start:{value:'2020-01-01',precision:'day' as const},end:{value:'2023-12-31',precision:'day' as const},current:false}]};
    const result=await materialize({...original,facts,contentHash:rankingHash(facts)});
    expect(result.id).toBeTruthy();
  });
  async function rankPublication(value=hit()){
    const f=await materialize(value),flow=randomUUID(),hash='a'.repeat(64);
    const contract=createRankingContract(randomUUID(),hash,{schemaVersion:4,compilerVersion:4,taxonomyVersion:4,criteria:[{
      id:randomUUID(),label:'Python',class:'must_have',subject:'skill',requirement:{kind:'accepted_skills',primary:'Python',alternatives:[]},
      use:'assessment',evidenceKinds:['candidate_provided'],provenance:{kind:'recruiter_edit'}}]});
    await db.query("INSERT INTO governed_sourcing_tenants(tenant_id,enabled_at,policy_hash,allow_new,organization_ref,callback_url) VALUES($1,clock_timestamp(),$2,true,'28','https://flow.example/api/webhooks/signal/callback')",[tenant,hash]);
    const bound=await one('SELECT signal_sourcing_bind($1,$2,$3) result',[tenant,flow,{protocolVersion:2,flowRunId:flow,organizationRef:'28',externalJobId:'vanta:jobs:95101',
      briefVersionId:contract.briefVersionId,materialHash:hash,artifactHash:hash,compilerVersion:'1',queryArtifact:{jobContext:{}},rankingContract:contract,callbackUrl:'https://flow.example/api/webhooks/signal/callback'}]);
    const processingLeaseId=randomUUID();
    await db.query("UPDATE job_sourcing_requests SET status='processing',processing_lease_id=$2 WHERE id=$1",[bound.requestId,processingLeaseId]);
    await db.query("INSERT INTO candidate_privacy_projection(tenant_id,candidate_id,generation,decision,evaluated_cursor) VALUES($1,$2,1,'allow',0)",[tenant,f.id]);
    await db.query("UPDATE candidate_privacy_sync_state SET status='healthy',active_generation=1,cursor=0,expected_candidates=1,projected_candidates=1,last_success_at=clock_timestamp() WHERE consumer_name='discover'");
    const evidence={...f.evidence,presentationSource:'pool' as const};
    const claim=await one('SELECT signal_ranking_claim($1,$2,$3) result',[tenant,flow,{contractHash:contract.contractHash,executionAttemptId:bound.executionAttemptId,processingLeaseId,evidence:[evidence]}]);
    const ranked=rankEvidence(contract,claim.evidence,claim.asOf);
    expect(ranked.items[0].N).toBe(3);
    const selected=new Map(ranked.selected.map(i=>[i.candidateId,i.selectedOrdinal]));
    const items=ranked.items.map((item,index)=>({...item,ordinal:index+1,selectedOrdinal:selected.get(item.candidateId)??null,sourceType:'pool'}));
    const result={inputHash:claim.inputHash,items};
    await one('SELECT signal_ranking_finish($1,$2,$3,$4) result',[tenant,flow,claim.lease,{...result,outputHash:rankingHash(result)}]);
    const stored=await one('SELECT signal_network_ranking_sources($1,$2,$3) result',[tenant,flow,claim.revisionId]);
    expect(stored[0].candidateId).toBe(f.id);expect(stored[0].hit.facts).toEqual(f.hit.facts);
    return {stored,read:()=>one('SELECT signal_network_ranking_sources($1,$2,$3) result',[tenant,flow,claim.revisionId])};
  }
  it('ranks and publishes through existing governed SQL and scorer',async()=>{
    await rankPublication();
  });
  it.skipIf(!process.env.P7_MEMORY_ORIGIN)('reads a real signed Memory publication and ranks that exact projection',async()=>{
    const origin=new URL(process.env.P7_MEMORY_ORIGIN!);
    expect(origin.hostname).toBe('127.0.0.1');
    const token=await signActiveGraphJWT(tenant,'kg:read','p7-native-proof');
    const response=await fetch(`${origin.origin}/global-candidates/search`,{method:'POST',redirect:'error',
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({surface:'public_v2',query_text:'Python Engineer',limit:5}),signal:AbortSignal.timeout(5000)});
    expect(response.status).toBe(200);
    const data=await response.json();
    const value=networkHitSchema.parse(data.results.find((r:{subjectId?:string})=>r.subjectId===process.env.P7_SUBJECT));
    expect(value.contentHash).toBe(process.env.P7_CONTENT_HASH);
    const comparison=await fetch(`${origin.origin}/global-candidates/network/validate`,{method:'POST',redirect:'error',
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({publicationIds:[value.publicationId],includeResultKeys:true}),signal:AbortSignal.timeout(5000)});
    expect(comparison.status).toBe(200);
    const checked=revalidatedNetworkHits([value],await comparison.json());
    expect(deduplicateNetworkAgainstProviders(checked,[{linkedinUrl:'https://www.linkedin.com/in/john-doe/'}])).toEqual([]);
    expect(deduplicateNetworkAgainstProviders(checked,[{linkedinUrl:'https://linkedin.com/in/somebody-else'}])).toHaveLength(1);
    expect(JSON.stringify(checked)).not.toContain('linkedin.com');
    const ranked=await rankPublication(value);
    expect(JSON.stringify(ranked.stored)).not.toContain('secret@example.test');
    expect(JSON.stringify(ranked.stored)).not.toContain('photoUrl');
    const withdrawn=await fetch(`${origin.origin}/_proof/withdraw`,{method:'POST',
      headers:{'x-proof-token':process.env.P7_CONTROL_TOKEN!},signal:AbortSignal.timeout(5000)});
    expect(withdrawn.status).toBe(200);
    const validation=await fetch(`${origin.origin}/global-candidates/network/validate`,{method:'POST',
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({publicationIds:[value.publicationId]}),signal:AbortSignal.timeout(5000)});
    expect(await validation.json()).toEqual({schemaVersion:1,publications:[]});
    expect(await ranked.read()).toEqual(ranked.stored); // Existing search is never deleted by withdrawal.
  });
  it('measures the complete protected catalogues on the forward schema',async()=>{
    const expected:Record<string,string>={ranking:RANKING_CATALOG_SHA256,network:NETWORK_CATALOG_SHA256,rc:RC_CATALOG_SHA256,privateResume:PRIVATE_RESUME_CATALOG_SHA256};
    for(const [name,sql] of Object.entries({ranking:RANKING_CATALOG_SQL,network:NETWORK_CATALOG_SQL,rc:RC_CATALOG_SQL,privateResume:PRIVATE_RESUME_CATALOG_SQL})){
      const digest=(await db.query(sql)).rows[0].digest;
      console.info('P7 catalogue',name,digest);
      expect(digest).toBe(expected[name]);
    }
  });
  it('permits only routine-based runtime access and detects a private-helper grant',async()=>{
    for(const signature of NETWORK_FUNCTIONS)await db.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO p7_discover_runtime_test`);
    const tx={$queryRawUnsafe:async(sql:string,...params:unknown[])=>(await db.query(sql,params)).rows};
    await assertNetworkCatalog(tx,{role:'p7_discover_runtime_test'});
    await db.query('SET LOCAL ROLE p7_discover_runtime_test');
    expect((await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
    await refused(()=>db.query('SELECT * FROM candidate_network_sources'));
    await refused(()=>db.query("SELECT signal_network_facts_valid('{}')"));
    const id=await one('SELECT signal_network_candidate_materialize($1,$2) result',[tenant,hit()]);
    expect(typeof id).toBe('string');
    await db.query('RESET ROLE');
    await db.query(`GRANT EXECUTE ON FUNCTION public.${NETWORK_PRIVATE_FUNCTIONS[0]} TO p7_discover_runtime_test`);
    await expect(assertNetworkCatalog(tx,{role:'p7_discover_runtime_test'})).rejects.toThrow('privileges');
  });
});
