import {createHash} from 'node:crypto';

export const TARGET=Object.freeze({tenantId:'org_32',requestId:'21e28b02-06f1-4f26-9906-615049b945da',
  purchaseId:'cmvfcajtq0001pk1zdcum9xt7',externalJobId:'vanta:jobs:192'});
export const RELEASE='8e927642ca40d3814f4526a14428e8a993192567';
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function requireThat(ok,code){if(!ok)throw Error(code);}
export function validate(s){
  const {request:r,purchase:p,rc,counts}=s;
  requireThat(r.id===TARGET.requestId&&r.tenantId===TARGET.tenantId&&r.externalJobId===TARGET.externalJobId&&
    r.status==='processing'&&r.protocol_version===2&&r.acquisition_generation===1&&r.execution_attempt_id&&r.processing_lease_id&&
    r.completedAt===null,'REQUEST_CHANGED');
  requireThat(p.id===TARGET.purchaseId&&p.tenantId===TARGET.tenantId&&p.sourcingRequestId===r.id&&
    p.acquisitionGeneration===1&&p.slot==='exact'&&p.status==='complete'&&p.memory_delivery_contract===2&&
    p.memory_prepared_at===null&&p.memory_ingested_at===null&&p.memory_member_count===null,'PURCHASE_CHANGED');
  requireThat(Array.isArray(p.result?.profiles)&&p.result.profiles.length===300&&
    new Set(p.result.profiles.map(x=>String(x.crustdata_person_id))).size===300,'PURCHASE_COUNT_CHANGED');
  requireThat(rc.request_id===r.id&&rc.state==='stalled'&&rc.paid_lookups===0&&rc.rc_started_at===null&&
    rc.resume_token===null&&rc.resume_enqueued_at===null&&rc.execution_attempt_id===r.execution_attempt_id&&
    rc.processing_lease_id===r.processing_lease_id,'RC_CHANGED');
  requireThat(counts.purchases===1&&counts.packets===0&&counts.lookups===0,'WORK_ALREADY_STARTED');
  requireThat(s.identity.system==='discover'&&s.identity.environment==='production'&&s.identity.target_id,'DATABASE_IDENTITY');
}
// Include exact purchase/result and execution/RC rows, but never emit their contents.
export function stateHash(s){return digest(s);}
export function plan(s,sourceHash,now=Date.now()){
  validate(s);
  const body={version:1,mode:'rollback-only',target:TARGET,sourceHash,stateHash:stateHash(s),
    targetIdentity:s.identity.target_id,createdAt:now,expiresAt:now+15*60*1000,
    profiles:300,maxPreparationTransactions:1,newPurchases:0,rcLookups:0,committedWrites:0};
  return {...body,approvalHash:digest(body)};
}
export function approve(p,approval,s,sourceHash,now=Date.now()){
  const {approvalHash,...body}=p;
  requireThat(approval===approvalHash&&approvalHash===digest(body),'APPROVAL_MISMATCH');
  requireThat(Number.isFinite(p.createdAt)&&p.createdAt<=now&&p.expiresAt===p.createdAt+15*60*1000&&now<p.expiresAt,'PLAN_EXPIRED');
  requireThat(JSON.stringify(p.target)===JSON.stringify(TARGET)&&p.version===1&&p.mode==='rollback-only'&&
    p.sourceHash===sourceHash&&p.stateHash===stateHash(s)&&p.targetIdentity===s.identity.target_id&&
    p.profiles===300&&p.maxPreparationTransactions===1&&p.newPurchases===0&&p.rcLookups===0&&p.committedWrites===0,'PLAN_CHANGED');
  validate(s);
}

/** No COMMIT path: the actual Prisma transaction always receives an exception.
 * Only the preparation routine's SQL and privacy reads are exposed to the code under test. */
export function rollbackPrisma(real,checkInside=async()=>{}){
  const sentinel=Object.freeze(new Error('JOB192_PREPARED_ROLLED_BACK'));
  let transactions=0,completed=false;
  const query=(client,inside)=>(sql,...values)=>{
    if(typeof sql==='string'&&sql==='SELECT public.signal_memory_ingest($1::jsonb,$2::jsonb) AS result'){
      const owner=JSON.parse(values[0]),command=JSON.parse(values[1]);
      requireThat(owner.tenantId===TARGET.tenantId&&owner.sourcingRequestId===TARGET.requestId&&
        owner.acquisitionReceiptId===TARGET.purchaseId&&owner.acquisitionGeneration===1&&owner.acquisitionSlot==='exact','SQL_OWNER_REFUSED');
      requireThat((inside?['append','seal']:['anchors','read']).includes(command.action),'SQL_ACTION_REFUSED');
    }else requireThat(Array.isArray(sql)&&sql.raw&&sql.join('').includes('candidate_privacy_sync_state'),'SQL_QUERY_REFUSED');
    return typeof sql==='string'?client.$queryRawUnsafe(sql,...values):client.$queryRaw(sql,...values);
  };
  const view=(client,inside)=>({$queryRawUnsafe:query(client,inside),$queryRaw:query(client,inside),
    $executeRawUnsafe:(sql,...args)=>{
      requireThat(inside&&sql==='SELECT pg_advisory_xact_lock(hashtextextended($1,0))','SQL_WRITE_REFUSED');
      return client.$executeRawUnsafe(sql,...args);
    },
    $executeRaw:(sql,...args)=>{
      requireThat(inside&&Array.isArray(sql)&&sql.raw&&/^\s*SELECT pg_advisory_xact_lock\(/.test(sql.join('')),'SQL_WRITE_REFUSED');
      return client.$executeRaw(sql,...args);
    }});
  return {sentinel,get completed(){return completed;},get transactions(){return transactions;},
    client:{...view(real,false),$transaction:async(fn,options)=>{
      requireThat(++transactions===1&&options.maxWait===2000&&options.timeout===5000,'TRANSACTION_REFUSED');
      return real.$transaction(async tx=>{
        await checkInside(tx);
        await fn(view(tx,true));completed=true;throw sentinel;
      },options);
    }}};
}

export function privacyOnlyFetch(base,fetchImpl,maximum=8){
  const origin=new URL(base);requireThat(origin.protocol==='https:'&&!origin.username&&!origin.password&&!origin.search&&
    (origin.pathname==='/'||origin.pathname===''),'MEMORY_ORIGIN_REFUSED');
  let calls=0;
  return async(input,init={})=>{
    const u=new URL(input instanceof Request?input.url:String(input));
    const method=(init.method??(input instanceof Request?input.method:'GET')).toUpperCase();
    requireThat(u.origin===origin.origin&&!u.username&&!u.password&&!u.hash&&(
      method==='GET'&&u.pathname==='/candidate-privacy/snapshot'&&u.search==='?limit=1'||
      method==='POST'&&['/candidate-privacy/eligibility/batch','/global-candidates/public-identities'].includes(u.pathname)&&!u.search), 'NETWORK_DESTINATION_REFUSED');
    requireThat(++calls<=maximum,'NETWORK_CALL_CAP');
    return fetchImpl(input,{...init,redirect:'error'});
  };
}
