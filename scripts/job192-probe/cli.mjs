import {readFile,lstat,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {plan,approve,stateHash,requireThat,digest} from './core.mjs';
import {connect,readState,sourceHash,probe} from './production.mjs';

async function privateFile(path){
  const info=await lstat(path);
  requireThat(info.isFile()&&(info.mode&0o077)===0&&info.uid===process.getuid()&&info.size<=32768,'PRIVATE_PLAN_REQUIRED');
  return JSON.parse(await readFile(path,'utf8'));
}
export async function consumeApproval(directory,approval){
  requireThat(/^[a-f0-9]{64}$/.test(approval),'APPROVAL_MISMATCH');
  const dir=await lstat(directory??'');
  requireThat(dir.isDirectory()&&(dir.mode&0o077)===0&&dir.uid===process.getuid(),'PRIVATE_LEDGER_REQUIRED');
  const spent=await open(resolve(directory,approval+'.spent'),'wx',0o600);
  try{await spent.writeFile(JSON.stringify({approval,startedAt:new Date().toISOString()}));await spent.sync();}finally{await spent.close();}
  const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
}
export async function main(argv,env=process.env){
  const [command,path,approval,...extra]=argv;
  requireThat(extra.length===0&&(command==='preview'?!path&&!approval:command==='probe'&&path&&/^[a-f0-9]{64}$/.test(approval??'')),'ARGUMENT_REFUSED');
  requireThat(env.NODE_ENV==='production'&&env.LOG_LEVEL==='silent'&&!env.SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER&&!env.REDIS_URL&&!env.REDIS_HOST&&!env.REDIS_PORT,'PROBE_ENVIRONMENT_REFUSED');
  requireThat(env.NODE_TLS_REJECT_UNAUTHORIZED!=='0','TLS_BYPASS_REFUSED');
  // Provider credentials are unnecessary. Refuse them rather than trusting a call-site convention.
  requireThat(!Object.keys(env).some(k=>/^(CRUSTDATA|GROQ|REVERSECONTACT|REVERSE_CONTACT|FULLENRICH|FULL_ENRICH|RC_API)_.*(KEY|TOKEN|SECRET)$/.test(k)&&env[k]),'PAID_CREDENTIALS_REFUSED');
  const hash=digest({source:sourceHash(),runtimeUrl:env.JOB192_RUNTIME_URL,ownerUrl:env.JOB192_READ_OWNER_URL,
    ca:await readFile(env.JOB192_CA_FILE,'utf8'),database:env.JOB192_EXPECTED_DATABASE,
    owner:env.JOB192_EXPECTED_OWNER,role:env.JOB192_EXPECTED_ROLE,targetId:env.JOB192_TARGET_ID,
    ledgerDirectory:resolve(env.JOB192_LEDGER_DIR??''),
    serviceConfig:Object.fromEntries(Object.entries(env).filter(([key])=>/^(SIGNAL_|ACTIVEGRAPH_)/.test(key)).sort(([a],[b])=>a.localeCompare(b)))});let db;
  try{
    const connection=await connect(env);db=connection.db;
    const before=await readState(db,env.JOB192_TARGET_ID);
    if(command==='preview')return plan(before,hash);
    const approved=await privateFile(path);
    approve(approved,approval,before,hash);
    // A restart cannot repeat this approved attempt. No automatic clearing of the ledger.
    await consumeApproval(env.JOB192_LEDGER_DIR,approval);
    const result=await probe(before,connection.options,env.ACTIVEGRAPH_URL,async tx=>{
      // Recheck the exact execution fence without altering it. Count is also checked by the real append SQL.
      const rows=await tx.$queryRawUnsafe(`SELECT id FROM job_sourcing_requests WHERE id=$1 AND "tenantId"=$2
        AND status='processing' AND execution_attempt_id=$3 AND processing_lease_id=$4`,
        approved.target.requestId,approved.target.tenantId,before.request.execution_attempt_id,before.request.processing_lease_id);
      requireThat(rows.length===1,'EXECUTION_CHANGED');
    });
    const after=await readState(db,env.JOB192_TARGET_ID);
    requireThat(stateHash(before)===stateHash(after),'POSTCHECK_CHANGED_MANUAL_REVIEW');
    return {...result,unchanged:true,committedWrites:0,newPurchases:0,rcLookups:0};
  }finally{await db?.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main(process.argv.slice(2)).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(()=>{
    // Never emit raw Prisma, database, auth or profile errors.
    process.stderr.write('JOB192_PROBE_REFUSED_OR_FAILED_NO_AUTOMATIC_RETRY\n');process.exitCode=1;
  });
}
