import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {checkServerIdentity} from 'node:tls';
import {Client} from 'pg';
import {PrismaClient} from '@prisma/client';
import ts from 'typescript';
import {TARGET,RELEASE,requireThat,digest,rollbackPrisma,privacyOnlyFetch} from './core.mjs';

export function sourceHash(){
  execFileSync('git',['merge-base','--is-ancestor',RELEASE,'HEAD'],{stdio:'pipe'});
  execFileSync('git',['diff','--exit-code',RELEASE,'--','src',':!src/**/__tests__/**','prisma','scripts/check-immutable-memory-ingest.mjs',
    'package.json','package-lock.json','tsconfig.json'],{stdio:'pipe'});
  const files=execFileSync('git',['ls-files','src','prisma','scripts/check-immutable-memory-ingest.mjs'],{encoding:'utf8'}).trim().split('\n');
  files.push('scripts/job192-probe/core.mjs','scripts/job192-probe/production.mjs','scripts/job192-probe/cli.mjs');
  files.push('package.json','package-lock.json','tsconfig.json');
  return digest(files.sort().map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]));
}

/** Both clients connect to the same certificate-authenticated localhost tunnel.
 * No tunnel is started here. No URL containing insecure SSL overrides is accepted. */
export function connection(env){
  const u=new URL(env.JOB192_RUNTIME_URL);
  requireThat(['postgres:','postgresql:'].includes(u.protocol)&&u.hostname==='localhost'&&u.port&&
    !u.search&&env.JOB192_CA_FILE&&env.JOB192_EXPECTED_DATABASE&&env.JOB192_EXPECTED_ROLE&&env.JOB192_TARGET_ID,'VERIFIED_CONNECTION_REQUIRED');
  requireThat(decodeURIComponent(u.pathname.slice(1))===env.JOB192_EXPECTED_DATABASE&&decodeURIComponent(u.username)===env.JOB192_EXPECTED_ROLE,'DATABASE_IDENTITY');
  const ca=readFileSync(env.JOB192_CA_FILE,'utf8');
  const owner=new URL(env.JOB192_READ_OWNER_URL);
  requireThat(owner.hostname===u.hostname&&owner.port===u.port&&owner.pathname===u.pathname&&!owner.search&&
    ['postgres:','postgresql:'].includes(owner.protocol)&&decodeURIComponent(owner.username)===env.JOB192_EXPECTED_OWNER&&
    owner.username!==u.username,'OWNER_CONNECTION_REFUSED');
  const pg={connectionString:owner.toString(),ssl:{ca,rejectUnauthorized:true,servername:'localhost',
    checkServerIdentity:(_name,cert)=>checkServerIdentity('localhost',cert)},connectionTimeoutMillis:5000,
    options:'-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=1000'};
  // Prisma's PostgreSQL connector calls the CA option sslcert and requires strict acceptance explicitly.
  u.searchParams.set('sslmode','require');u.searchParams.set('sslaccept','strict');u.searchParams.set('sslcert',env.JOB192_CA_FILE);
  return {pg,prisma:u.toString()};
}
export async function connect(env){
  const options=connection(env),db=new Client(options.pg);
  try{
  await db.connect();
  const identity=(await db.query('SELECT current_database() db,current_user actor,session_user session')).rows[0];
  requireThat(identity.db===env.JOB192_EXPECTED_DATABASE&&identity.actor===env.JOB192_EXPECTED_OWNER&&identity.session===identity.actor,'DATABASE_IDENTITY');
  const roles=await db.query(`SELECT rolsuper,rolbypassrls,
    has_table_privilege(rolname,'public.public_memory_ingest_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') direct_access,
    has_function_privilege(rolname,'public.signal_memory_ingest(jsonb,jsonb)','EXECUTE') entry_access
    FROM pg_roles WHERE rolname=$1`,[env.JOB192_EXPECTED_ROLE]);
  requireThat(roles.rowCount===1&&!roles.rows[0].rolsuper&&!roles.rows[0].rolbypassrls&&!roles.rows[0].direct_access&&roles.rows[0].entry_access,'RUNTIME_ROLE_REFUSED');
  const {MEMORY_CATALOG_SQL,MEMORY_CATALOG_SHA256}=await import('../check-immutable-memory-ingest.mjs');
  requireThat((await db.query(MEMORY_CATALOG_SQL)).rows[0].digest===MEMORY_CATALOG_SHA256,'CATALOG_CHANGED');
  return {db,options};
  }catch(error){await db.end().catch(()=>{});throw error;}
}
export async function readState(db,expectedIdentity){
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    const one=async(sql,args=[])=>{const r=await db.query(sql,args);requireThat(r.rowCount===1,'EXACT_ROW_REQUIRED');return r.rows[0].row;};
    const identity=await one('SELECT to_jsonb(i) row FROM signal_schema_control.target_identity i');
    requireThat(identity.target_id===expectedIdentity,'DATABASE_IDENTITY');
    const request=await one('SELECT to_jsonb(j) row FROM job_sourcing_requests j WHERE id=$1 AND "tenantId"=$2',[TARGET.requestId,TARGET.tenantId]);
    const purchase=await one('SELECT to_jsonb(a) row FROM crustdata_acquisition_receipts a WHERE id=$1 AND "tenantId"=$2',[TARGET.purchaseId,TARGET.tenantId]);
    const rc=await one('SELECT to_jsonb(r) row FROM rc_sourcing_runs r WHERE request_id=$1',[TARGET.requestId]);
    const counts=(await db.query(`SELECT
      (SELECT count(*)::int FROM crustdata_acquisition_receipts WHERE "sourcingRequestId"=$1) purchases,
      (SELECT count(*)::int FROM public_memory_ingest_requests WHERE request_id=$1) packets,
      (SELECT count(*)::int FROM rc_lookup_attempts WHERE run_id=$2::uuid) lookups`,[TARGET.requestId,rc.id])).rows[0];
    await db.query('COMMIT');return {identity,request,purchase,rc,counts};
  }catch(error){await db.query('ROLLBACK');throw error;}
}

export function mapper(source){
  const tree=ts.createSourceFile('orchestrator.ts',source,ts.ScriptTarget.Latest,true);
  const found=[];
  const visit=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='mappedForRanking')found.push(node.initializer.getText(tree));ts.forEachChild(node,visit);};visit(tree);
  requireThat(found.length===1,'MAPPER_CHANGED');
  return ts.transpileModule('return '+found[0],{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
}
export async function probe(s,options,base,checkInside){
  requireThat(process.env.NODE_ENV==='production'&&process.env.LOG_LEVEL==='silent'&&
    !process.env.SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER&&!process.env.REDIS_URL&&!process.env.REDIS_HOST&&!process.env.REDIS_PORT,'PROBE_ENVIRONMENT_REFUSED');
  requireThat(!globalThis.prisma,'PRISMA_ALREADY_INITIALIZED');
  const savedFetch=globalThis.fetch;
  globalThis.fetch=privacyOnlyFetch(base,savedFetch,12);
  const real=new PrismaClient({datasources:{db:{url:options.prisma}},log:[]});
  const rollback=rollbackPrisma(real,checkInside);globalThis.prisma=rollback.client;
  let setupStage='module_load';
  try{
    const {ImmutableMemoryRepository,prepareMemoryPacket}=await import('../../src/lib/sourcing/immutable-memory-ingest.ts');
    const {memoryPreparationFailure,memoryPreparationStage}=await import('../../src/lib/sourcing/memory-preparation-diagnostics.ts');
    const {buildObservedCandidatePublicMarket,resolvePublicCandidateRoleFamily}=await import('../../src/lib/sourcing/public-memory-materialization.ts');
    const {extractLinkedInIdFromUrl}=await import('../../src/lib/sourcing/discovery.ts');
    setupStage='mapper';
    const profiles=s.purchase.result.profiles;
    // Only snapshot.skillsNormalized uses topSkills; the Memory adapter uses raw crustdata skills.
    const mapped=new Function('crustProfiles','requirements','acquisitionRungByProfile','buildObservedCandidatePublicMarket',
      'resolvePublicCandidateRoleFamily','extractLinkedInIdFromUrl',mapper(readFileSync('src/lib/sourcing/orchestrator.ts','utf8')))(
      profiles,{topSkills:[]},new Map(profiles.map(p=>[p,'exact'])),buildObservedCandidatePublicMarket,resolvePublicCandidateRoleFamily,extractLinkedInIdFromUrl);
    requireThat(mapped.length===300,'MAPPED_COUNT_CHANGED');
    const {resolvePublicIdentities}=await import('../../src/lib/sourcing/activegraph-client.ts');
    const {addExpectedGlobalIdentityReceipt,expectedGlobalCandidateIdForCandidate}=await import('../../src/lib/sourcing/public-memory-identity.ts');
    setupStage='identity_lookup';
    const identities=await resolvePublicIdentities(TARGET.tenantId,mapped.map(c=>c.linkedinUrl),TARGET.requestId);
    requireThat(identities!==null,'IDENTITY_LOOKUP_UNAVAILABLE');
    const receipts={expectedByIdentity:new Map(),conflictedIdentityKeys:new Set()};
    for(const identity of identities.results){
      const slug=extractLinkedInIdFromUrl(identity.normalizedLinkedinUrl);
      if(slug)addExpectedGlobalIdentityReceipt(receipts,`li:${slug.toLowerCase()}`,identity.globalCandidateId);
    }
    const owner={tenantId:TARGET.tenantId,sourcingRequestId:TARGET.requestId,acquisitionReceiptId:TARGET.purchaseId,acquisitionGeneration:1,acquisitionSlot:'exact'};
    const fence={executionAttemptId:s.request.execution_attempt_id,processingLeaseId:s.request.processing_lease_id};
    const repository=new ImmutableMemoryRepository();
    try{
      await memoryPreparationStage('read_existing',()=>repository.read(owner));
      const packets=await memoryPreparationStage('packet_build',()=>mapped.map(candidate=>prepareMemoryPacket(owner,candidate,
        {...owner,acquiredAt:new Date(s.purchase.startedAt),profileObservedAt:new Date(s.purchase.startedAt),
          expectedGlobalCandidateId:expectedGlobalCandidateIdForCandidate(candidate,receipts.expectedByIdentity),
          publicMarket:candidate.publicMarket,publicCandidateRoleFamily:candidate.publicCandidateRoleFamily})));
      await repository.prepare(owner,packets,fence);
      throw Error('ROLLBACK_SENTINEL_MISSING');
    }catch(error){
      if(error===rollback.sentinel&&rollback.completed)return {outcome:'prepared_then_rolled_back',transactions:rollback.transactions,expectedIdentityMode:'fresh_readonly_lookup'};
      return {outcome:'failed',...memoryPreparationFailure(error),transactions:rollback.transactions,expectedIdentityMode:'fresh_readonly_lookup'};
    }
  }catch(error){
    const {memoryPreparationFailure}=await import('../../src/lib/sourcing/memory-preparation-diagnostics.ts');
    return {outcome:'failed',stage:setupStage,reason:memoryPreparationFailure(error).reason,transactions:rollback.transactions};
  }finally{globalThis.fetch=savedFetch;delete globalThis.prisma;await real.$disconnect();}
}
