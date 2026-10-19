// Disposable process recovery proof. All HTTP is directed to a local fake;
// no ambient application credentials, provider keys or production DB are read.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import pg from 'pg';

const root=resolve(import.meta.dirname,'..');
const load=name=>import('../src/lib/sourcing/'+name+'.ts');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function target(raw){
 const url=new URL(raw??'');
 assert.equal(url.hostname,'127.0.0.1');
 assert.match(url.pathname,/^\/[a-z0-9_]+_rc_process_test$/);
 assert.match(url.username,/_test$/);
 return url.toString();
}
async function child(){
 const input=JSON.parse(await readFile(process.argv[3],'utf8'));
 const db=new pg.Client({connectionString:target(input.dsn),connectionTimeoutMillis:2000});
 const {RcRepository}=await load('rc-skills/repository');
 const {runRcTick}=await load('rc-skills/worker');
 const {createRcProvider}=await load('rc-skills/provider');
 await db.connect();
 try{
  const repository=new RcRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const provider=createRcProvider({apiKey:'synthetic-test-only',testOrigin:input.origin});
  const result=await runRcTick({identity:input.identity,repository,provider:()=>provider,privacyCursor:async()=>0});
  console.log(JSON.stringify({state:result.state}));
 }finally{await db.end();}
}
async function main(protocolMode){
 assert.equal(process.env.SIGNAL_RC_PROCESS_DISPOSABLE,'1');
 const dsn=target(process.env.SIGNAL_RC_PROCESS_OWNER_URL);
 const db=new pg.Client({connectionString:dsn,connectionTimeoutMillis:2000});
 const dir=await mkdtemp(join(tmpdir(),'rc-process-proof-'));
 const children=new Set();let server,owned=false;
 const calls={check:0,fetch:0,cache:0};
 await db.connect();
 const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.result;
 const wait=async(predicate,ms=15000)=>{const until=Date.now()+ms;while(!await predicate()){
  if(Date.now()>until)throw Error('RC_PROCESS_WAIT_TIMEOUT');await pause(25);
 }};
 const cleanEnv={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',
  UV_THREADPOOL_SIZE:'1',NODE_OPTIONS:'--max-old-space-size=512'};
 function start(file,maintenance=false,skipReadiness=true){
  const args=maintenance?[...(skipReadiness?['--import',resolve(root,'scripts/test-support-skip-schema-ready.mjs')]:[]),
   resolve(root,'scripts/rc-skills-maintenance.mjs'),'--once']:
   ['--import','tsx',import.meta.filename,'--child',file];
  // Maintenance now always runs the shared Memory delivery step, which validates its
  // Memory/privacy configuration even with no work. Use the standard disposable test
  // adapter and a non-routable Memory URL: no work is queued here, so nothing is sent.
  const env=maintenance?{...cleanEnv,RC_SKILLS_ENABLED:'true',DATABASE_URL:dsn,
   ACTIVEGRAPH_URL:'http://127.0.0.1:9',SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER:'disposable_passthrough'}:cleanEnv;
  const processChild=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
  children.add(processChild);let output='';
  processChild.stdout.on('data',data=>{output+=data;});
  processChild.stderr.on('data',data=>{output+=data;});
  const done=new Promise((yes,no)=>{processChild.on('error',no);processChild.on('close',(code,signal)=>{
   children.delete(processChild);yes({code,signal,output});
  });});
  return {processChild,done};
 }
 try{
  assert.match((await db.query('SHOW server_version_num')).rows[0].server_version_num,/^17/);
  assert.equal(await one("SELECT NOT rolsuper AND NOT rolbypassrls result FROM pg_roles WHERE rolname=current_user"),true);
  assert.equal(await one("SELECT count(*)::int result FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'"),0);
  await db.query("SELECT pg_advisory_lock(hashtextextended('rc-process-proof',0))");
  owned=true;
  const manifest=JSON.parse(await readFile(resolve(root,'prisma/baseline/manifest.json'),'utf8'));
  await db.query(await readFile(resolve(root,manifest.baselinePath),'utf8'));
  for(const name of (await readdir(resolve(root,'prisma/migrations'))).filter(n=>n>manifest.baselineMigrationThrough).sort())
   await db.query(await readFile(resolve(root,'prisma/migrations',name,'migration.sql'),'utf8'));
  // The real entrypoint must refuse this raw-SQL database: it has no schema-control
  // identity/ledger, so readiness fails before any maintenance work.
  const refused=await start(undefined,true,false).done;
  assert.notEqual(refused.code,0,'maintenance must refuse to start without schema readiness');
  assert.doesNotMatch(refused.output,/rc_maintenance_cycle/);
  const maintenance=await start(undefined,true).done;
  assert.equal(maintenance.code,0,'independent maintenance entrypoint must start on the migrated local DB: '+maintenance.output);
  assert.match(maintenance.output,/rc_maintenance_cycle/);
  // Reuse the single reviewed synthetic SQL fixture, not a second seed model.
  // Exact source boundaries fail closed if the fixture is renamed/restructured.
  const source=await readFile(resolve(root,'src/lib/sourcing/rc-skills/__tests__/rc-postgres.integration.test.ts'),'utf8');
  const fixture=source.match(/ async function fixture\(rcUnavailable=false,protocolMode:1\|2=1\)\{[\s\S]*?\n \}\n(?= it\()/)?.[0];
  assert.ok(fixture,'RC_PROCESS_FIXTURE_MISSING');
  const imports=[['createRankingContract,rankingHash','rubric/contracts'],['adaptProfile','rubric/evidence'],
   ['rcPublicIdentities','rc-skills/membership']].map(([names,path])=>
   `import {${names}} from ${JSON.stringify(resolve(root,'src/lib/sourcing',path+'.ts'))};`).join('\n');
  const seed=join(dir,'seed.ts');
  await writeFile(seed,`import {randomUUID} from 'node:crypto';\n${imports}\nexport async function seed(db){\nconst tenant='org_28',hash='a'.repeat(64);\nconst one=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.result;\n${fixture}\nreturn fixture(false,${protocolMode});\n}`,{mode:0o600});
  const f=await (await import(pathToFileURL(seed).href)).seed(db);
  const {rcPublicIdentities}=await load('rc-skills/membership');
  const second=rcPublicIdentities([{candidateId:'candidate-b',globalCandidateId:randomUUID(),url:'https://linkedin.com/in/person-b'}])[0];
  await db.query(`INSERT INTO candidates(id,"tenantId","linkedinId","linkedinUrl","updatedAt") VALUES($1,'org_28','person-b',$2,clock_timestamp())`,[second.candidateId,second.url]);
  await db.query(`INSERT INTO candidate_global_links(id,"tenantId","candidateId","globalCandidateId") VALUES($1,'org_28',$2,$3)`,[randomUUID(),second.candidateId,second.globalCandidateId]);
  await db.query("INSERT INTO candidate_privacy_projection(tenant_id,candidate_id,generation,decision,evaluated_cursor) VALUES('org_28','candidate-b',1,'allow',0)");
  await db.query('UPDATE candidate_privacy_sync_state SET expected_candidates=2,projected_candidates=2');
  f.prepare.baseline.identities.push(second);
  f.prepare.baseline.evidence.push({...f.prepare.baseline.evidence[0],candidateId:second.candidateId});
  await db.query(`UPDATE crustdata_acquisition_receipts SET result=jsonb_set(result,'{profiles}',result->'profiles'||$1::jsonb)`,
   [JSON.stringify([{social_handles:{professional_network_identifier:{profile_url:second.url}}}])]);
  const {RcRepository}=await load('rc-skills/repository');
  const {sealedRcEvidence}=await load('rc-skills/worker');
  const repository=new RcRepository(async(sql,args)=>(await db.query(sql,args)).rows);
  const identity={tenantId:'org_28',flowRunId:f.flow,executionAttemptId:f.claim.executionAttemptId,processingLeaseId:f.claim.processingLeaseId};
  await repository.prepare(identity,f.prepare.receiptIds,f.prepare.baseline);
  const deadline=(await repository.read('org_28',f.flow)).deadlineAt;
  const upstream=new Date(Date.now()-86400000).toISOString();
  let held=false;
  server=createServer(async(req,res)=>{
   try{
    let text='';for await(const chunk of req){text+=chunk;if(text.length>65536)throw Error('fixture body bound');}
    const body=JSON.parse(text);
    if(req.url==='/internal/rc-skills/finish'){
     calls.cache++;assert.ok(!/email|linkedin|profile_url/.test(text));
     res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,status:'stored',receiptId:randomUUID(),contentHash:body.observation.contentHash}));return;
    }
    assert.ok(['/v2/fetch/persons/check','/v2/fetch/persons'].includes(req.url));
    const check=req.url.endsWith('/check');calls[check?'check':'fetch']++;
    if(!check&&body.url===second.url){held=true;return;}
    const data=check?{exists:true,lastUpdate:upstream,skillCount:1}:{linkedinUrl:body.url,skills:['AWS'],email:'must-discard@fixture.invalid'};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,error:null,data,metadata:{updatedAt:upstream},quotas:{creditsConsumed:check?0:1}}));
   }catch{res.statusCode=500;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const input=join(dir,'input.json');await writeFile(input,JSON.stringify({dsn,identity,origin}),{mode:0o600});
  let result;
  if(protocolMode===1){
   result=await start(input).done;assert.equal(result.code,0);assert.match(result.output,/waiting/);assert.equal(calls.check,2);
  }
  const interrupted=start(input);
  await wait(async()=>held&&await one("SELECT count(*)::int result FROM rc_lookup_attempts WHERE operation='FETCH' AND state='success'")===1);
  interrupted.processChild.kill('SIGKILL');assert.equal((await interrupted.done).signal,'SIGKILL');
  // Actual timeout age, not rewritten dispatch state or a renewed deadline.
  await wait(async()=>{
   const snapshot=await repository.read('org_28',f.flow);
   return snapshot.attempts.filter(a=>a.state==='dispatched').every(a=>a.dispatchAt&&Date.now()-Date.parse(a.dispatchAt)>11000);
  },30000);
  result=await start(input).done;assert.equal(result.code,0);
  const recovery=await repository.read('org_28',f.flow);
  assert.match(result.output,/sealed/,JSON.stringify({state:recovery.state,members:recovery.members.map(m=>m.state),
   attempts:recovery.attempts.map(a=>({operation:a.operation,state:a.state,ageMs:a.dispatchAt?Date.now()-Date.parse(a.dispatchAt):null}))}));
  const snapshot=await repository.read('org_28',f.flow);
  assert.equal(snapshot.deadlineAt,deadline);assert.equal(snapshot.state,'partial');
  assert.equal(await one("SELECT count(*)::int result FROM rc_lookup_attempts WHERE operation='FETCH' AND state='uncertain'"),1);
  assert.equal(await one('SELECT paid_lookups result FROM rc_sourcing_runs'),2);
  assert.ok(sealedRcEvidence(snapshot).evidence.find(e=>e.candidateId==='candidate-a').facts.some(f=>f.value==='aws'));
  assert.ok(!JSON.stringify(snapshot).includes('must-discard'));
  result=await start(input).done;assert.equal(result.code,0);assert.equal(calls.fetch,2);assert.equal(calls.check,protocolMode===1?2:0);
  const {createRcMemoryClient}=await load('rc-skills/memory');
  const {drainRcOutbox}=await load('rc-skills/outbox');
  const memory=createRcMemoryClient({testOrigin:origin,testSigner:async()=> 'synthetic'});
  assert.equal((await drainRcOutbox({tenantId:'org_28',flowRunId:f.flow,repository,memory})).delivered,1);
  assert.equal((await drainRcOutbox({tenantId:'org_28',flowRunId:f.flow,repository,memory})).delivered,0);
  assert.equal(calls.cache,1);
  console.log(`RC_PROCESS_PASS mode=${protocolMode}: killed paid fetch; partial success retained; no repeat purchase; immutable seal; minimal idempotent cache delivery`);
 }finally{
  await Promise.all([...children].map(child=>new Promise(resolve=>{
   child.once('close',resolve);child.kill('SIGKILL');
  })));
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(owned){await db.query('DROP SCHEMA public CASCADE');await db.query('CREATE SCHEMA public AUTHORIZATION CURRENT_USER');}
  await db.end();await rm(dir,{recursive:true,force:true});
 }
}
if(process.argv[2]==='--child')child().catch(()=>{console.error('RC child proof failed');process.exitCode=1;});
else (async()=>{for(const mode of [1,2])await main(mode);})().catch(error=>{console.error('RC process proof failed:',error.stack);process.exitCode=1;});
