import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {SignJWT,importPKCS8} from 'jose';
import {governedEnabled,governedPreviewSchema,parseGovernedSource,previewObservation,governedSourceSchema,type GovernedSource} from './governed-contracts';
import {buildJobRequirements} from './jd-digest';
import {buildCrustdataPreviewRequest,CRUSTDATA_API_VERSION,CRUSTDATA_SEARCH_URL} from './crustdata-client';
import {takeCrustdataPermit,type RateGateRedis} from './crustdata-rate-gate';
import { createLogger } from '@/lib/logger';

const previewLog=createLogger('governed-preview');
/** Fixed diagnostic classes for logs only; never a body, header value, key or query. */
export function previewFailureReason(error:unknown,stage:'command'|'request'|'body',status:number|null,credits:string|null):string {
  const message=error instanceof Error?error.message:'';
  const timedOut=error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError');
  if(stage==='command')return 'command_invalid';
  // The same request signal also bounds the body read, so a timeout can arrive after headers.
  if(timedOut)return 'timeout';
  if(stage==='request')return 'network';
  if(message==='GOVERNED_PREVIEW_HTTP')return status!==null&&status>=500?'http_5xx':status===429?'http_429':status!==null&&status>=400?'http_4xx':'http_other';
  if(message==='GOVERNED_PREVIEW_EMPTY')return 'empty_body';
  if(message==='GOVERNED_PREVIEW_RESPONSE_TOO_LARGE')return 'body_too_large';
  if(error instanceof SyntaxError)return 'not_json';
  if(message==='GOVERNED_PREVIEW_INVALID')return 'invalid_shape';
  if(message==='GOVERNED_PREVIEW_EVIDENCE_UNAVAILABLE'){
    if(credits===null)return 'credits_header_missing';
    const value=Number(credits);
    if(!Number.isFinite(value)||value<0)return 'credits_header_invalid';
    if(value>0.03)return 'credits_over_limit';
    return 'count_invalid';
  }
  return 'unexpected';
}

const statements={
  bind:'SELECT public.signal_sourcing_bind($1,$2::uuid,$3::jsonb) result',
  execution:'SELECT public.signal_sourcing_execution($1,$2,$3::jsonb,$4::jsonb) result',
  evidence:'SELECT public.signal_sourcing_receipt_evidence($1,$2,$3) result',
  cancel:'SELECT public.signal_sourcing_cancel($1,$2,$3::jsonb) result',
  cancelEvidence:'SELECT public.signal_sourcing_cancel_evidence($1,$2) result',
  boundCommand:'SELECT public.signal_sourcing_bound_command($1,$2) result',
  delivery:'SELECT public.signal_sourcing_delivery($1,$2,$3,$4::jsonb,$5::timestamptz) result',
  grantTransition:'SELECT public.signal_sourcing_grant_transition($1,$2::uuid,$3,$4::jsonb) result',
  previewAdmit:'SELECT public.signal_sourcing_preview_admit($1,$2,$3::jsonb) result',
  previewClaim:'SELECT public.signal_sourcing_preview_claim($1,$2::uuid,$3::uuid) result',
  previewFinish:'SELECT public.signal_sourcing_preview_finish($1,$2::uuid,$3::uuid,$4::jsonb) result',
  tenant:'SELECT public.signal_sourcing_tenant($1) result',
} as const;
type Query=(sql:string,args:unknown[])=>Promise<Array<Record<string,unknown>>>;
/** Closed public codes only. Prisma wraps PostgreSQL exceptions in meta;
 * never return the wrapper (which can contain SQL or connection details). */
export function governedAdmissionRefusal(error:unknown):{error:string;status:number}|null {
  const codes:Record<string,number>={GOVERNED_REQUEST_CONFLICT:409,GOVERNED_TARGET_MISMATCH:409,
    GOVERNED_TENANT_REQUIRED:409,GOVERNED_DISABLED:409,GOVERNED_INVALID_COMMAND:400,
    GOVERNED_PROTOCOL_CONFLICT:409,RANKING_CONTRACT_CONFLICT:409,RANKING_OUTPUT_CONFLICT:409};
  if(!(error instanceof Error))return null;
  let code=error.message;
  const wrapped=error as Error & {code?:string;meta?:{code?:string;message?:string}};
  if(wrapped.code==='P2010' && wrapped.meta?.code==='P0001') {
    code=(wrapped.meta.message??'').replace(/^ERROR: /,'');
  }
  return Object.hasOwn(codes,code)?{error:code,status:codes[code]}:null;
}
/** Only fixed parameterized statements. Product runtime receives EXECUTE on
 * these routines, not generic new-table write access. No network inside SQL. */
export class GovernedRepository {
  constructor(private readonly suppliedQuery?:Query){}
  private async query(sql:string,args:unknown[]) {
    if(this.suppliedQuery) return this.suppliedQuery(sql,args);
    const {prisma}=await import('@/lib/prisma');
    return prisma.$queryRawUnsafe<Array<Record<string,unknown>>>(sql,...args.map(v=>v!==null && typeof v==='object'?JSON.stringify(v):v));
  }
  async call<T>(operation:Exclude<keyof typeof statements,'tenant'>,args:unknown[]):Promise<T|null> {
    const rows=await this.query(statements[operation],args);
    return (rows[0]?.result??null) as T|null;
  }
  async tenant(tenantId:string) {
    const rows=await this.query(statements.tenant,[tenantId]);
    return z.object({latched:z.boolean(),allowNew:z.boolean(),organizationRef:z.string().nullable(),callbackUrl:z.string().nullable()}).strict().parse(rows[0]?.result);
  }
}

export async function bindGovernedSource(repository:GovernedRepository,tenantId:string,body:unknown,
  target:{externalJobId:string;callbackUrl:string;production:boolean}) {
  if(!governedEnabled()) throw Error('GOVERNED_DISABLED');
  const command=parseGovernedSource(body,target);
  return repository.call('bind',[tenantId,command.flowRunId,command]);
}
export async function admitGovernedPreview(repository:GovernedRepository,tenantId:string,jobId:string,body:unknown) {
  if(!governedEnabled()) throw Error('GOVERNED_DISABLED');
  const command=governedPreviewSchema.parse(body);
  if(Buffer.byteLength(JSON.stringify(command),'utf8')>131072) throw Error('GOVERNED_BODY_TOO_LARGE');
  return repository.call('previewAdmit',[tenantId,jobId,command]);
}

/** Fixed operator-bound Flow origin and machine-only scope. Neither the public
 * source route nor a browser can select this endpoint or credential scope. */
export async function sendFlowSourcingEvidence(binding:GovernedSource,identity:{tenantId:string;requestId:string;executionAttemptId:string},
  body:unknown,transport:typeof fetch=fetch):Promise<unknown> {
  const configured=process.env.SIGNAL_JWT_PRIVATE_KEY;
  if(!configured)throw Error('GOVERNED_SIGNER_UNAVAILABLE');
  const key=await importPKCS8(configured.includes('-----BEGIN')?configured:Buffer.from(configured,'base64').toString('utf8'),'RS256');
  const callback=new URL(binding.callbackUrl);
  if(callback.username||callback.password||callback.hash||callback.search||
    (process.env.NODE_ENV==='production'?callback.protocol!=='https:':!['https:','http:'].includes(callback.protocol)))throw Error('GOVERNED_TARGET_MISMATCH');
  const target=new URL('/api/internal/sourcing/grant',callback);
  const token=await new SignJWT({tenant_id:identity.tenantId,request_id:identity.requestId,execution_attempt_id:identity.executionAttemptId,
    acquisition_generation:1,scopes:'sourcing:grant'}).setProtectedHeader({alg:'RS256',kid:process.env.SIGNAL_JWT_ACTIVE_KID||'v1'})
    .setIssuer('signal').setAudience('vantahire').setSubject('sourcing').setIssuedAt().setExpirationTime('5m').setJti(randomUUID()).sign(key);
  const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded,'utf8')>131072)throw Error('GOVERNED_BODY_TOO_LARGE');
  const response=await transport(target,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
    body:encoded,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('GOVERNED_FLOW_REFUSED');
  return boundedPreviewBody(response);
}

/** The existing callback-redelivery loop also repairs lost accounting acks.
 * Evidence is reconstructed exclusively by fixed owner routines; no model,
 * provider call, request reset or new purchase is involved. */
export async function flushGovernedEvidence(repository:GovernedRepository,tenantId:string,requestId:string) {
  const raw=await repository.call('boundCommand',[tenantId,requestId]);
  if(!raw)return;
  const binding=governedSourceSchema.parse(raw);
  const cancellation=await repository.call<Record<string,unknown>>('cancelEvidence',[tenantId,requestId]);
  const evidence=cancellation?[cancellation]:await Promise.all(['exact','spill'].map(slot=>repository.call<Record<string,unknown>>('evidence',[tenantId,requestId,slot])));
  for(const entry of evidence){
    if(!entry)continue;
    if(typeof entry.executionAttemptId!=='string')throw Error('GOVERNED_EVIDENCE_INVALID');
    await sendFlowSourcingEvidence(binding,{tenantId,requestId,executionAttemptId:entry.executionAttemptId},entry);
  }
}

async function boundedPreviewBody(response:Response):Promise<unknown> {
  const stream=response.body;
  if(!stream) throw Error('GOVERNED_PREVIEW_EMPTY');
  const reader=stream.getReader();const pieces:Uint8Array[]=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>65536)throw Error('GOVERNED_PREVIEW_RESPONSE_TOO_LARGE');pieces.push(value);}
    return JSON.parse(Buffer.concat(pieces).toString('utf8'));
  }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}

type PreviewLease={previewId:string;lease:string;command:unknown};
/** Worker-only path. External transport is the sole test substitution; SQL
 * claim, real builder and rate permission are exercised independently too.
 * Duplicate queue deliveries cannot reclaim a started preview. */
export async function runGovernedPreview(repository:GovernedRepository,redis:RateGateRedis,
  tenantId:string,previewId:string,transport:typeof fetch=fetch) {
  if(!governedEnabled()) throw Error('GOVERNED_DISABLED');
  const key=process.env.CRUSTDATA_API_KEY;
  if(!key) throw Error('GOVERNED_PREVIEW_CONFIGURATION');
  // Acquire account capacity before marking provider-started. A rate refusal
  // may retry this queue item, but never creates another preview identity.
  const permit=await takeCrustdataPermit(redis,'preview');
  if(!permit.allowed) return {state:'waiting',retryAfterMs:permit.retryAfterMs} as const;
  const leased=await repository.call<PreviewLease>('previewClaim',[tenantId,previewId,randomUUID()]);
  if(!leased) return {state:'not_claimed'} as const;
  let result:Record<string,unknown>;
  let stage:'command'|'request'|'body'='command',status:number|null=null,credits:string|null=null;
  try {
    const command=governedPreviewSchema.parse(leased.command);
    if(command.previewId!==previewId || leased.previewId!==previewId) throw Error('GOVERNED_PREVIEW_BINDING');
    const payload=buildCrustdataPreviewRequest(buildJobRequirements(command.queryArtifact.jobContext));
    stage='request';
    const response=await transport(CRUSTDATA_SEARCH_URL,{method:'POST',headers:{
      'Content-Type':'application/json','Authorization':`Bearer ${key}`,'x-api-version':CRUSTDATA_API_VERSION,
    },body:JSON.stringify(payload),signal:AbortSignal.timeout(15000),redirect:'error'});
    // Any started request without complete cost/count evidence is unknown.
    // In particular 429/5xx/timeouts never become a free automatic retry.
    stage='body';status=response.status;credits=response.headers.get('X-Credits-Used');
    if(!response.ok) throw Error('GOVERNED_PREVIEW_HTTP');
    result={state:'complete',...previewObservation(await boundedPreviewBody(response),credits)};
  }catch(error){
    result={state:'unknown'};
    previewLog.warn({event:'governed_preview_unknown',previewId,reason:previewFailureReason(error,stage,status,credits),
      httpStatus:status},'Pool-size preview ended unknown');
  }
  // A database error propagates. Its expired lease later becomes unknown; do
  // not mask a failed durable finish with an in-memory success response.
  await repository.call('previewFinish',[tenantId,previewId,leased.lease,result]);
  return {state:result.state as 'complete'|'unknown'};
}
