import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeSourcedCandidateLinkedInUrl } from '../sourced-candidate-adapter';
import { rcSkillsSchema, rcTimeSchema, type RcFreeRejection } from './contracts';
import { RC_LIMITS } from './config';

export type RcOperation='CHECK'|'FETCH';
export type RcFailureCode='unauthorized'|'rate_limited'|'restricted'|'transport'|'invalid_response'|'identity_mismatch'|'credits_breach'|'deadline';
/** Fixed diagnostic class for logs only. Never a body, URL, key, header value or person identifier. */
export type RcFailureDetail='http_4xx'|'http_5xx'|'http_other'|'oversize'|'no_body'|'not_json'|'envelope'|'quota_missing'
  |'not_found_shape'|'check_shape'|'skills_shape'|'timeout'|'network';
/** Deliberately no provider body, URL, key or native transport cause in errors. */
export class RcProviderError extends Error {
  constructor(readonly code:RcFailureCode, readonly possiblePaid:boolean,
    readonly retryAfterMs:number|null=null, readonly observedCredits:number|null=null,
    readonly rejectionProof:RcFreeRejection|null=null, readonly detail:RcFailureDetail|null=null) {
    super('RC_'+code.toUpperCase());this.name='RcProviderError';
  }
}
const count=z.number().int().nonnegative().safe();
const obj=(value:unknown):Record<string,unknown> => value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export type Quota={creditsConsumed:number;creditsLeft:number|null;minuteLimit:number|null;minuteLeft:number|null;resetAt:string|null;dailyLeft:number|null};
const numeric=(value:unknown):number|null=>count.safeParse(value).success?value as number:null;
const time=(value:unknown):string|null=>rcTimeSchema.safeParse(value).success?value as string:null;
function quota(raw:Record<string,unknown>):Quota {
  const q=obj(raw.quotas),workspace=obj(q.workspace),key=obj(q.key);
  const limits=[obj(workspace.minuteRateLimit),obj(key.minuteRateLimit)];
  const minimum=(values:unknown[])=>{const numbers=values.map(numeric).filter((v):v is number=>v!==null);return numbers.length?Math.min(...numbers):null;};
  const creditsConsumed=numeric(q.creditsConsumed);
  if(creditsConsumed===null)throw new RcProviderError('invalid_response',true,null,null,null,'quota_missing');
  const resets=limits.map(v=>time(v.nextReset)).filter((v):v is string=>v!==null);
  return {creditsConsumed,creditsLeft:numeric(obj(workspace.credits).left),
    minuteLimit:minimum(limits.map(v=>v.limit)),minuteLeft:minimum(limits.map(v=>v.left)),
    resetAt:resets.length?resets.sort((a,b)=>Date.parse(b)-Date.parse(a))[0]:null,
    dailyLeft:minimum([obj(workspace.dailyLimit).left,obj(key.dailyLimit).left])};
}
function correlation(raw:Record<string,unknown>,response:Response):string|null {
  const value=obj(raw.metadata).requestId??response.headers.get('x-request-id');
  return typeof value==='string'&&value.length>0&&value.length<=256
    ?createHash('sha256').update(value).digest('hex'):null;
}
async function boundedJson(response:Response,allowNotFound=false):Promise<Record<string,unknown>> {
  const declared=response.headers.get('content-length');
  if(declared!==null && (/^\d+$/.test(declared)?Number(declared)>RC_LIMITS.responseBytes:true)) {
    await response.body?.cancel();throw new RcProviderError('invalid_response',true,null,null,null,'oversize');
  }
  if(!response.body)throw new RcProviderError('invalid_response',true,null,null,null,'no_body');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try {
    while(true) {
      const next=await reader.read();if(next.done)break;
      bytes+=next.value.byteLength;
      if(bytes>RC_LIMITS.responseBytes)throw new RcProviderError('invalid_response',true,null,null,null,'oversize');
      chunks.push(next.value);
    }
    let parsed:unknown;
    try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
    // Preserve the pre-diagnostic behaviour exactly: a decode/parse failure was always
    // classified as transport (free CHECK retry, FETCH possibly paid); only the detail is new.
    catch{throw new RcProviderError('transport',true,null,null,null,'not_json');}
    const raw=obj(parsed);
    if(allowNotFound && raw.success===false && raw.error==='REQUEST_ERROR' && raw.data===null)return raw;
    if(raw.success!==true || raw.error!==null || raw.data===null || typeof raw.data!=='object' || Array.isArray(raw.data))
      throw new RcProviderError('invalid_response',true,null,null,null,'envelope');
    return raw;
  } finally {
    await reader.cancel().catch(()=>undefined);reader.releaseLock();
  }
}
export type CheckResult={
  outcome:'eligible'|'not_found'|'no_skills'|'unusable_age';
  upstreamAt:string|null;quota:Quota;correlationHash:string|null;
};
export type FetchResult={skills:string[];quota:Quota;correlationHash:string|null;
  upstreamAt?:string|null;outcome?:'success'|'no_skills'|'not_found'|'unusable_age'};

/** Cached V2 only. No live fetch, redirects, fallback or retry inside the transport.
 * The caller must persist its per-run dispatch grant BEFORE invoking either call.
 * Tests supply a fake transport; a custom origin is loopback-only and test-only.
 */
export function createRcProvider(options:{
  apiKey:string;fetchImpl?:typeof fetch;testOrigin?:string;now?:()=>number;
}) {
  const transport=options.fetchImpl??fetch,now=options.now??Date.now;
  let origin='https://api.reversecontact.com';
  if(!options.apiKey || options.apiKey.length>8192 || /[\r\n\0]/.test(options.apiKey))throw Error('RC_CONFIGURATION_INVALID');
  if(options.testOrigin!==undefined) {
    const url=new URL(options.testOrigin);
    if(process.env.NODE_ENV!=='test'||url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||
      url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('RC_TEST_ORIGIN_REFUSED');
    origin=url.origin;
  }
  async function request(operation:RcOperation,url:string,deadlineAt:number,direct=false) {
    const canonical=normalizeSourcedCandidateLinkedInUrl(url);
    if(now()>=deadlineAt)throw new RcProviderError('deadline',false);
    const signal=AbortSignal.timeout(Math.min(RC_LIMITS.timeoutMs,Math.max(1,Math.floor(deadlineAt-now()))));
    try {
      const response=await transport(origin+(operation==='CHECK'?'/v2/fetch/persons/check':'/v2/fetch/persons'),{
        method:'POST',redirect:'error',headers:{Authorization:'Bearer '+options.apiKey,'Content-Type':'application/json'},
        body:JSON.stringify({url:canonical}),signal,
      });
      if(direct && operation==='FETCH' && response.status===404){
        const raw=await boundedJson(response,true),quotas=quota(raw);
        if(quotas.creditsConsumed!==0)throw new RcProviderError('credits_breach',true,null,quotas.creditsConsumed);
        if(raw.success!==false||raw.error!=='REQUEST_ERROR'||raw.data!==null)throw new RcProviderError('invalid_response',true,null,null,null,'not_found_shape');
        return {data:{},quota:quotas,correlationHash:correlation(raw,response),upstreamAt:null,notFound:true};
      }
      if(!response.ok) {
        await response.body?.cancel().catch(()=>undefined);
        const paid=operation==='FETCH';
        if([401,402,403].includes(response.status))throw new RcProviderError('unauthorized',paid);
        if(response.status===451)throw new RcProviderError('restricted',paid);
        if(response.status===429) {
          const raw=response.headers.get('retry-after'),seconds=raw!==null&&/^\d+$/.test(raw)?Number(raw):null;
          const date=raw!==null?Date.parse(raw):NaN;
          const delay=seconds!==null?seconds*1000:Number.isFinite(date)?Math.max(0,date-now()):60_000;
          throw new RcProviderError('rate_limited',paid,Math.min(Math.max(delay,1000),86_400_000));
        }
        throw new RcProviderError('transport',paid,null,null,null,
          response.status>=500&&response.status<600?'http_5xx':response.status>=400&&response.status<500?'http_4xx':'http_other');
      }
      const raw=await boundedJson(response),quotas=quota(raw);
      if(operation==='CHECK' && quotas.creditsConsumed!==0)throw new RcProviderError('credits_breach',true,null,quotas.creditsConsumed);
      return {data:obj(raw.data),quota:quotas,correlationHash:correlation(raw,response),
        upstreamAt:time(obj(raw.metadata).updatedAt),notFound:false};
    }catch(error) {
      if(error instanceof RcProviderError) {
        if(operation==='CHECK'&&error.code!=='credits_breach')throw new RcProviderError(error.code,false,error.retryAfterMs,error.observedCredits,null,error.detail);
        throw error;
      }
      const timedOut=error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError');
      throw new RcProviderError('transport',operation==='FETCH',null,null,null,timedOut?'timeout':'network');
    }
  }
  return {
    async check(url:string,deadlineAt:number):Promise<CheckResult> {
      const {data,quota,correlationHash}=await request('CHECK',url,deadlineAt);
      if(typeof data.exists!=='boolean')throw new RcProviderError('invalid_response',false,null,null,null,'check_shape');
      if(!data.exists)return {outcome:'not_found',upstreamAt:null,quota,correlationHash};
      const upstreamAt=time(data.lastUpdate),age=upstreamAt===null?null:now()-Date.parse(upstreamAt);
      if(age===null||age<0||age>RC_LIMITS.horizonDays*86_400_000)
        return {outcome:'unusable_age',upstreamAt,quota,correlationHash};
      const skillCount=numeric(data.skillCount);
      if(skillCount===null)throw new RcProviderError('invalid_response',false,null,null,null,'check_shape');
      return {outcome:skillCount===0?'no_skills':'eligible',upstreamAt,quota,correlationHash};
    },
    async fetchSkills(url:string,deadlineAt:number,maximumCredits:number,mode:'legacy'|'direct'='legacy'):Promise<FetchResult> {
      if(!Number.isSafeInteger(maximumCredits)||maximumCredits<1)throw Error('RC_CREDITS_LIMIT_REQUIRED');
      const {data,quota,correlationHash,upstreamAt,notFound}=await request('FETCH',url,deadlineAt,mode==='direct');
      if(quota.creditsConsumed>maximumCredits)throw new RcProviderError('credits_breach',true,null,quota.creditsConsumed);
      if(notFound)return {skills:[],quota,correlationHash,upstreamAt:null,outcome:'not_found'};
      let returned:string;
      try{returned=normalizeSourcedCandidateLinkedInUrl(typeof data.linkedinUrl==='string'?data.linkedinUrl:'');}
      catch{throw new RcProviderError('identity_mismatch',true,null,quota.creditsConsumed);}
      if(returned!==normalizeSourcedCandidateLinkedInUrl(url))throw new RcProviderError('identity_mismatch',true,null,quota.creditsConsumed);
      const skills=rcSkillsSchema.safeParse(data.skills);
      if(!skills.success)throw new RcProviderError('invalid_response',true,null,quota.creditsConsumed,null,'skills_shape');
      // Only explicit allowlisted fields leave this boundary. No names, emails,
      // raw body, profile history, photo, provider IDs or hidden metadata.
      if(mode==='legacy')return {skills:skills.data,quota,correlationHash};
      const age=upstreamAt===null?null:now()-Date.parse(upstreamAt);
      const usable=age!==null&&age>=0&&age<=RC_LIMITS.horizonDays*86_400_000;
      return {skills:usable?skills.data:[],quota,correlationHash,upstreamAt,
        outcome:!usable?'unusable_age':skills.data.length?'success':'no_skills'};
    },
  };
}
