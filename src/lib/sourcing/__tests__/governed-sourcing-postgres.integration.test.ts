import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {Client} from 'pg';
import {GOVERNED_CATALOG_SQL,GOVERNED_CATALOG_SHA256} from '../../../../scripts/check-governed-sourcing.mjs';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';

const enabled=process.env.SIGNAL_SOURCING_DISPOSABLE==='1';
const tenant='governed-disposable', hash='a'.repeat(64);
describe.skipIf(!enabled)('governed Discover SQL components, real PostgreSQL',()=>{
  let db:Client;
  const one=async(sql:string,args:unknown[]=[]) => (await db.query(sql,args)).rows[0]?.result;
  const command=(id:string)=>({protocolVersion:1,previewId:id,artifactHash:hash,queryArtifact:{queryHash:hash}});
  const admit=(id:string,body=command(id),who=tenant)=>one('SELECT signal_sourcing_preview_admit($1,$2,$3) result',[who,'vanta:jobs:95101',body]);
  const claim=(id:string,who=tenant)=>one('SELECT signal_sourcing_preview_claim($1,$2,$3) result',[who,id,randomUUID()]);
  const finish=(id:string,lease:string,result:unknown)=>one('SELECT signal_sourcing_preview_finish($1,$2,$3,$4) result',[tenant,id,lease,result]);
  async function bindHistorical(flow:string,body:unknown){
    // Issue the historical receipt with the shipped routine inside this isolated
    // transaction, then restore 5C before exercising replay/control behavior.
    const definition=(migration:string)=>{
      const source=readFileSync(resolve('prisma/migrations',migration,'migration.sql'),'utf8');
      const sql=source.match(/CREATE(?: OR REPLACE)? FUNCTION public\.signal_sourcing_bind\([\s\S]*?REVOKE ALL ON FUNCTION public\.signal_sourcing_bind\(text,uuid,jsonb\) FROM PUBLIC;/)?.[0];
      if(!sql)throw Error('Missing historical bind fixture');
      return sql.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
    };
    await db.query(definition('20261004000000_governed_sourcing'));
    const result=await one('SELECT signal_sourcing_bind($1,$2,$3) result',[tenant,flow,body]);
    await db.query(definition('20261006000000_rubric_ranking'));
    return result;
  }
  async function grantFixture(){
    const flow=randomUUID(),body={protocolVersion:1,flowRunId:flow,organizationRef:'28',externalJobId:'vanta:jobs:95101',
      briefVersionId:randomUUID(),materialHash:hash,artifactHash:hash,compilerVersion:'1',queryArtifact:{jobContext:{}},
      callbackUrl:'https://flow.example/api/webhooks/signal/callback'};
    const bound=await bindHistorical(flow,body);
    const fence={acquisitionGeneration:1,executionAttemptId:bound.executionAttemptId,processingLeaseId:randomUUID()};
    await db.query("UPDATE job_sourcing_requests SET status='processing',processing_lease_id=$2 WHERE id=$1",[bound.requestId,fence.processingLeaseId]);
    const grant={grantId:randomUUID(),providerInputHash:hash,expiresAt:new Date(Date.now()+50000).toISOString(),state:'issued',
      executionAttemptId:fence.executionAttemptId,processingLeaseId:fence.processingLeaseId};
    const transition=(command:unknown)=>one('SELECT signal_sourcing_grant_transition($1,$2,$3,$4) result',[tenant,flow,'exact',command]);
    await transition(grant);
    return {flow,bound,fence,grant,transition};
  }
  beforeAll(async()=>{
    const target=new URL(process.env.SIGNAL_SOURCING_OWNER_URL??'');
    if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||!target.pathname.endsWith('_test')||!target.username.endsWith('_test')) throw Error('DISPOSABLE_TARGET_REQUIRED');
    db=new Client({connectionString:target.toString(),connectionTimeoutMillis:2000});await db.connect();
    const role=(await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    expect(role).toEqual({rolsuper:false,rolbypassrls:false});
    if(process.env.SIGNAL_SOURCING_EXPECT_LOCALE){
      expect((await db.query('SHOW server_version_num')).rows[0].server_version_num).toMatch(/^17/);
      expect((await db.query('SELECT datcollate FROM pg_database WHERE datname=current_database()')).rows[0].datcollate).toBe(process.env.SIGNAL_SOURCING_EXPECT_LOCALE);
    }
    if((await db.query("SELECT to_regclass('public.job_sourcing_requests') relation")).rows[0].relation) throw Error('FRESH_DISPOSABLE_REQUIRED');
    const manifest=JSON.parse(readFileSync('prisma/baseline/manifest.json','utf8'));
    const baseline=readFileSync(manifest.baselinePath,'utf8');
    expect(createHash('sha256').update(baseline).digest('hex')).toBe(manifest.baselineSha256);
    // Component proof only, not release-service/catalog verification. Strip the
    // baseline's outer transaction in memory so all owned test DDL rolls back.
    expect(baseline.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(baseline.match(/^COMMIT;$/gm)).toHaveLength(1);
    await db.query('BEGIN');
    try {
      await db.query(baseline.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
      for(const name of readdirSync('prisma/migrations').filter(n=>n>manifest.baselineMigrationThrough).sort()) {
        await db.query(readFileSync(resolve('prisma/migrations',name,'migration.sql'),'utf8'));
      }
    }catch(error){await db.query('ROLLBACK');throw error;}
  },120000);
  beforeEach(async()=>{
    await db.query('SAVEPOINT fixture');
    await db.query("INSERT INTO governed_sourcing_tenants(tenant_id,enabled_at,policy_hash,allow_new,organization_ref,callback_url) VALUES($1,clock_timestamp(),$2,true,'28','https://flow.example/api/webhooks/signal/callback')",[tenant,hash]);
  });
  afterEach(async()=>{await db.query('ROLLBACK TO SAVEPOINT fixture');});
  afterAll(async()=>{await db?.query('ROLLBACK');await db?.end();});
  it('reads the durable tenant latch through the fixed owner observation',async()=>{
    expect(await one('SELECT signal_sourcing_tenant($1) result',[tenant])).toEqual({latched:true,allowNew:true,organizationRef:'28',callbackUrl:'https://flow.example/api/webhooks/signal/callback'});
    await db.query('UPDATE governed_sourcing_tenants SET allow_new=false WHERE tenant_id=$1',[tenant]);
    expect(await one('SELECT signal_sourcing_tenant($1) result',[tenant])).toMatchObject({latched:true,allowNew:false});
    expect(await one('SELECT signal_sourcing_tenant($1) result',['other'])).toEqual({latched:false,allowNew:false,organizationRef:null,callbackUrl:null});
  });
  it('reproduces the complete governed catalog from the non-superuser owner',async()=>{
    const digest=(await db.query(GOVERNED_CATALOG_SQL)).rows[0].digest;
    if(process.env.SIGNAL_SOURCING_CATALOG_PRINT==='1')console.info('GOVERNED_CATALOG_SHA256='+digest);
    else expect(digest).toBe(GOVERNED_CATALOG_SHA256);
  });
  it('binds the organization and callback to operator-provisioned tenant settings',async()=>{
    const flow=randomUUID(),body={protocolVersion:1,flowRunId:flow,organizationRef:'28',externalJobId:'vanta:jobs:95101',
      briefVersionId:randomUUID(),materialHash:hash,artifactHash:hash,compilerVersion:'1',queryArtifact:{jobContext:{}},
      callbackUrl:'https://flow.example/api/webhooks/signal/callback'};
    for(const patch of [{organizationRef:'29'},{callbackUrl:'https://foreign.example/callback'}]) {
      await db.query('SAVEPOINT wrong_binding');
      await expect(one('SELECT signal_sourcing_bind($1,$2,$3) result',[tenant,flow,{...body,...patch}])).rejects.toThrow('GOVERNED_TARGET_MISMATCH');
      await db.query('ROLLBACK TO SAVEPOINT wrong_binding');
    }
    const first=await bindHistorical(flow,body);
    expect(first).toMatchObject({flowRunId:flow,acquisitionGeneration:1,idempotent:false});
    expect(await one('SELECT signal_sourcing_bind($1,$2,$3) result',[tenant,flow,body])).toMatchObject({requestId:first.requestId,idempotent:true});
  });
  it('terminal cancellation fences the old lease and all unused grants before producing refund evidence',async()=>{
    const f=await grantFixture();
    const proof=await one('SELECT signal_sourcing_cancel($1,$2,$3) result',[tenant,f.bound.requestId,f.fence]);
    expect(proof).toMatchObject({action:'no_dispatch',flowRunId:f.flow,discoverRequestId:f.bound.requestId,executionAttemptId:f.fence.executionAttemptId});
    expect(await one('SELECT signal_sourcing_cancel($1,$2,$3) result',[tenant,f.bound.requestId,f.fence])).toEqual(proof);
    expect((await db.query('SELECT status,processing_lease_id FROM job_sourcing_requests WHERE id=$1',[f.bound.requestId])).rows[0]).toEqual({status:'failed',processing_lease_id:null});
    expect((await db.query('SELECT state FROM governed_sourcing_grants WHERE flow_run_id=$1',[f.flow])).rows[0].state).toBe('no_dispatch');
    await expect(f.transition({...f.grant,state:'started',receiptId:'missing'})).rejects.toThrow('GOVERNED_EXECUTION_STALE');
  });
  it('a real started receipt blocks cancellation and produces only counts evidence',async()=>{
    const f=await grantFixture(),receipt=randomUUID();
    await db.query(`INSERT INTO crustdata_acquisition_receipts(id,"tenantId","sourcingRequestId","acquisitionGeneration",slot,status,"requestFingerprint","requestInput","requestMetadata","updatedAt")
      VALUES($1,$2,$3,1,'exact','started',$4,'{}','{}',clock_timestamp())`,[receipt,tenant,f.bound.requestId,hash]);
    await f.transition({...f.grant,state:'started',receiptId:receipt});
    expect(await one('SELECT signal_sourcing_cancel($1,$2,$3) result',[tenant,f.bound.requestId,f.fence])).toBeNull();
    await db.query(`UPDATE crustdata_acquisition_receipts SET status='complete',result=$2 WHERE id=$1`,[receipt,
      {rawReturnedCount:3,providerTotal:3,profiles:[{private:'must-not-leak'}]}]);
    const evidence=await one('SELECT signal_sourcing_receipt_evidence($1,$2,$3) result',[tenant,f.bound.requestId,'exact']);
    expect(evidence).toMatchObject({state:'complete',rawReturnedCount:3,providerTotal:3,grantId:f.grant.grantId});
    expect(JSON.stringify(evidence)).not.toContain('private');
    const expired=(await db.query("UPDATE governed_sourcing_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE flow_run_id=$1 RETURNING expires_at::text",[f.flow])).rows[0].expires_at;
    await expect(f.transition({...f.grant,expiresAt:expired,state:'started',receiptId:receipt})).rejects.toThrow('GOVERNED_GRANT_EXPIRED');
  });
  it.each([62,55])('accepts a valid Flow clock offset with %s seconds remaining',async seconds=>{
    const f=await grantFixture();
    const expiresAt=(await db.query("SELECT (clock_timestamp()+$1*interval '1 second')::text value",[seconds])).rows[0].value;
    const command={...f.grant,grantId:randomUUID(),expiresAt};
    expect(await one('SELECT signal_sourcing_grant_transition($1,$2,$3,$4) result',[tenant,f.flow,'spill',command])).toMatchObject({state:'issued'});
  });
  it.each([4,70])('refuses a grant outside the conservative skew window: %s seconds',async seconds=>{
    const f=await grantFixture();
    const expiresAt=(await db.query("SELECT (clock_timestamp()+$1*interval '1 second')::text value",[seconds])).rows[0].value;
    await expect(one('SELECT signal_sourcing_grant_transition($1,$2,$3,$4) result',[tenant,f.flow,'spill',{...f.grant,grantId:randomUUID(),expiresAt}])).rejects.toThrow('GOVERNED_GRANT_EXPIRED');
  });
  it('retains caught pre-transport failure evidence and permits only terminal cancellation',async()=>{
    const f=await grantFixture(),receipt=randomUUID();
    await db.query(`INSERT INTO crustdata_acquisition_receipts(id,"tenantId","sourcingRequestId","acquisitionGeneration",slot,status,"requestFingerprint","requestInput","requestMetadata","updatedAt")
      VALUES($1,$2,$3,1,'exact','started',$4,'{}','{}',clock_timestamp())`,[receipt,tenant,f.bound.requestId,hash]);
    await f.transition({...f.grant,state:'started',receiptId:receipt});
    await db.query("UPDATE crustdata_acquisition_receipts SET status='no_dispatch' WHERE id=$1",[receipt]);
    expect(await one('SELECT signal_sourcing_receipt_evidence($1,$2,$3) result',[tenant,f.bound.requestId,'exact'])).toBeNull();
    expect(await one('SELECT signal_sourcing_cancel($1,$2,$3) result',[tenant,f.bound.requestId,f.fence])).toMatchObject({action:'no_dispatch'});
    expect((await db.query('SELECT status FROM crustdata_acquisition_receipts WHERE id=$1',[receipt])).rows).toEqual([{status:'no_dispatch'}]);
    await expect(f.transition({...f.grant,state:'started',receiptId:receipt})).rejects.toThrow('GOVERNED_EXECUTION_STALE');
  });
  it('persists empty delivery identity and refuses a stale execution rather than minting a revision',async()=>{
    const f=await grantFixture();
    const deliver=(execution=f.fence.executionAttemptId)=>one('SELECT signal_sourcing_delivery($1,$2,$3,$4,$5) result',
      [tenant,f.bound.requestId,execution,JSON.stringify([]),null]);
    const first=await deliver();
    expect(first).toMatchObject({protocolVersion:1,flowRunId:f.flow,artifactHash:hash,revision:1,orderedSignalIds:[]});
    expect(await deliver()).toEqual(first);
    await expect(deliver(randomUUID())).rejects.toThrow('GOVERNED_EXECUTION_STALE');
  });
  it('persists one preview identity and replays without another claim',async()=>{
    const id=randomUUID();expect(await admit(id)).toMatchObject({previewId:id,state:'pending'});
    expect(await admit(id)).toMatchObject({previewId:id,state:'pending'});
    const lease=await claim(id);expect(lease).toMatchObject({previewId:id});
    expect(await claim(id)).toBeNull();
    expect(await finish(id,lease.lease,{state:'complete',count:123,countRelation:'approximate',creditsUsed:0.03})).toMatchObject({state:'complete',count:123});
    expect(await admit(id)).toMatchObject({state:'complete',count:123,creditsUsed:0.03});
    expect(await claim(id)).toBeNull();
    expect((await db.query('SELECT count(*)::integer n FROM governed_sourcing_previews')).rows[0].n).toBe(1);
  });
  it('never reclaims a provider-started preview after a crash',async()=>{
    const id=randomUUID();await admit(id);await claim(id);
    await db.query("UPDATE governed_sourcing_previews SET lease_until=clock_timestamp()-interval '1 second' WHERE preview_id=$1",[id]);
    expect(await claim(id)).toBeNull();expect(await admit(id)).toMatchObject({state:'unknown',count:null,creditsUsed:null});
    expect(await claim(id)).toBeNull();
  });
  it('does not dispatch a preview left queued beyond its bound',async()=>{
    const id=randomUUID();await admit(id);
    await db.query("UPDATE governed_sourcing_previews SET created_at=clock_timestamp()-interval '16 minutes' WHERE preview_id=$1",[id]);
    expect(await claim(id)).toBeNull();expect(await admit(id)).toMatchObject({state:'unavailable'});
  });
  it('refuses a changed body under a previously admitted identity',async()=>{
    const id=randomUUID();await admit(id);
    const body={...command(id),queryArtifact:{queryHash:hash,extra:'different'}};
    await expect(admit(id,body)).rejects.toThrow('GOVERNED_REQUEST_CONFLICT');
  });
  it('refuses wrong tenant and stale worker lease',async()=>{
    const id=randomUUID();await admit(id);const lease=await claim(id);
    await db.query('SAVEPOINT wrong_tenant');
    await expect(claim(id,'foreign')).rejects.toThrow('GOVERNED_DISABLED');
    await db.query('ROLLBACK TO SAVEPOINT wrong_tenant');
    await expect(finish(id,randomUUID(),{state:'unknown'})).rejects.toThrow('GOVERNED_LEASE_STALE');
    expect(lease.lease).toBeTruthy();
  });
  it('allows status replay but no new work after the tenant is disabled',async()=>{
    const id=randomUUID();await admit(id);
    await db.query('UPDATE governed_sourcing_tenants SET allow_new=false WHERE tenant_id=$1',[tenant]);
    expect(await admit(id)).toMatchObject({state:'pending'});
    await expect(admit(randomUUID())).rejects.toThrow('GOVERNED_DISABLED');
  });
  it('never accepts a fabricated zero or above-cap credits',async()=>{
    for(const result of [{state:'complete',count:null,countRelation:'approximate',creditsUsed:0.03},
      {state:'complete',count:0,countRelation:'eq',creditsUsed:0.04},{state:'unknown',count:0}]) {
      const id=randomUUID();await admit(id);const lease=await claim(id);
      await db.query('SAVEPOINT bad_result');
      await expect(finish(id,lease.lease,result)).rejects.toThrow('GOVERNED_INVALID_RECEIPT');
      await db.query('ROLLBACK TO SAVEPOINT bad_result');
    }
  });
});
