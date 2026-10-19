import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connection,sourceHash,mapper} from './production.mjs';
import {main,consumeApproval} from './cli.mjs';
import {execFileSync} from 'node:child_process';
test('reviewed source pins match and mapper fails closed if missing or duplicated',()=>{
  assert.match(sourceHash(),/^[a-f0-9]{64}$/);
  assert.throws(()=>mapper('const other=[];'));
  assert.throws(()=>mapper('const mappedForRanking=[];function x(){const mappedForRanking=[];}'));
});
test('connection requires authenticated TLS on a localhost tunnel for both roles',()=>{
  const dir=mkdtempSync(join(tmpdir(),'job192-cert-test-')),file=join(dir,'ca.crt');
  writeFileSync(file,'-----BEGIN CERTIFICATE-----\nsynthetic-not-a-real-certificate\n-----END CERTIFICATE-----\n');
  const env={JOB192_RUNTIME_URL:'postgresql://runtime:synthetic@localhost:55499/test',
    JOB192_READ_OWNER_URL:'postgresql://owner:synthetic@localhost:55499/test',JOB192_CA_FILE:file,
    JOB192_EXPECTED_DATABASE:'test',JOB192_EXPECTED_ROLE:'runtime',JOB192_EXPECTED_OWNER:'owner',JOB192_TARGET_ID:'synthetic'};
  try{
    const options=connection(env);
    assert.equal(options.pg.ssl.rejectUnauthorized,true);
    assert.match(options.pg.options,/default_transaction_read_only=on/);
    const prisma=new URL(options.prisma);
    assert.equal(prisma.searchParams.get('sslaccept'),'strict');assert.equal(prisma.searchParams.get('sslmode'),'require');
    for(const url of ['postgresql://runtime:x@example.test:55499/test','postgresql://runtime:x@localhost:55499/test?sslmode=disable'])
      assert.throws(()=>connection({...env,JOB192_RUNTIME_URL:url}));
    assert.throws(()=>connection({...env,JOB192_CA_FILE:undefined}));
    assert.throws(()=>connection({...env,JOB192_READ_OWNER_URL:env.JOB192_RUNTIME_URL}));
    assert.throws(()=>connection({...env,JOB192_READ_OWNER_URL:'postgresql://owner:x@localhost:55500/test'}));
  }finally{unlinkSync(file);rmdirSync(dir);}
});
test('entry refuses production mutation commands and unsafe environment before any connection',async()=>{
  await assert.rejects(main(['apply'],{}),/ARGUMENT_REFUSED/);
  await assert.rejects(main(['preview'],{}),/PROBE_ENVIRONMENT_REFUSED/);
  await assert.rejects(main(['preview'],{NODE_ENV:'production',LOG_LEVEL:'silent',REDIS_HOST:'example'}),/PROBE_ENVIRONMENT_REFUSED/);
  await assert.rejects(main(['preview'],{NODE_ENV:'production',LOG_LEVEL:'silent',CRUSTDATA_API_KEY:'synthetic'}),/PAID_CREDENTIALS_REFUSED/);
  await assert.rejects(main(['preview'],{NODE_ENV:'production',LOG_LEVEL:'silent',NODE_TLS_REJECT_UNAUTHORIZED:'0'}),/TLS_BYPASS_REFUSED/);
});
test('spent approval survives a fresh process; copying a plan cannot reset its hash ledger',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'job192-ledger-test-')),approval='a'.repeat(64);
  try{
    await consumeApproval(dir,approval);
    await assert.rejects(consumeApproval(dir,approval),{code:'EEXIST'});
    const code=`import {consumeApproval} from ${JSON.stringify(new URL('./cli.mjs',import.meta.url).href)};
      try {await consumeApproval(${JSON.stringify(dir)},${JSON.stringify(approval)});process.exitCode=1;}
      catch(e){if(e.code!=='EEXIST')process.exitCode=2;}`;
    execFileSync(process.execPath,['--input-type=module','-e',code],{stdio:'pipe'});
  }finally{unlinkSync(join(dir,approval+'.spent'));rmdirSync(dir);}
});
