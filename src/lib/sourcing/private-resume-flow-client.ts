import { createHash, randomUUID } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { privateResumeIdentity, privateResumeTenant, type PrivateResumeIdentity } from './private-resume-contracts';

const uuid = z.string().uuid().refine(value => value !== '00000000-0000-0000-0000-000000000000');
const opaque = z.string().min(1).max(200).refine(value => !!value.trim() && !/[\x00-\x1f\x7f]/.test(value));
export const flowEligibilityBody = z.object({ version: z.literal(1), flowRunId: uuid,
  revisionId: uuid, requestId: opaque, externalJobId: z.number().int().min(1).max(2147483647),
  items: z.array(z.object({key:opaque,identity:privateResumeIdentity}).strict()).min(1).max(100),
}).strict();
export type FlowEligibilityBody = z.infer<typeof flowEligibilityBody>;
const responseSchema = z.object({version:z.literal(1),bodyHash:z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt:z.string().datetime({offset:true}),results:z.array(z.object({key:opaque,
    decision:z.enum(['allow','same_job','privacy_restricted','source_changed','not_found','unavailable']),
  }).strict()).min(1).max(100),
}).strict();

export async function checkFlowResumeEligibility(tenantId:string,executionAttemptId:string,raw:FlowEligibilityBody,
  options:{baseUrl:string;deadlineAt:number;fetch?:typeof fetch}) {
  privateResumeTenant.parse(tenantId);uuid.parse(executionAttemptId);
  const body=flowEligibilityBody.parse(raw),encoded=JSON.stringify(body);
  if(Buffer.byteLength(encoded)>65536 || new Set(body.items.map(item=>item.key)).size!==body.items.length
    || new Set(body.items.map(item=>JSON.stringify(item.identity))).size!==body.items.length)
    throw Error('FLOW_CANDIDATE_INVALID');
  const hash=createHash('sha256').update(encoded).digest('hex');
  const remaining=Math.min(5000,options.deadlineAt-Date.now());
  if(!Number.isFinite(remaining)||remaining<=0)throw Error('FLOW_CANDIDATE_DEADLINE');
  const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
    controller.abort();void reader?.cancel().catch(()=>undefined);reject(Error('FLOW_CANDIDATE_DEADLINE'));
  },remaining);});
  try{return await Promise.race([timeout,(async()=>{
    const configured=process.env.SIGNAL_JWT_PRIVATE_KEY;
    if(!configured)throw Error('FLOW_CANDIDATE_UNAVAILABLE');
    const pem=configured.includes('-----BEGIN')?configured:Buffer.from(configured,'base64').toString('utf8');
    const key=await importPKCS8(pem,'RS256'),now=Math.floor(Date.now()/1000);
    const token=await new SignJWT({tenant_id:tenantId,request_id:body.requestId,flow_run_id:body.flowRunId,
      execution_attempt_id:executionAttemptId,body_hash:hash,scopes:'sourcing:candidates:read'})
      .setProtectedHeader({alg:'RS256',kid:process.env.SIGNAL_JWT_ACTIVE_KID||'v1'})
      .setIssuer('signal').setAudience('vantahire').setSubject('sourcing').setIssuedAt(now)
      .setExpirationTime(now+300).setJti(randomUUID()).sign(key);
    if(controller.signal.aborted)throw Error('FLOW_CANDIDATE_DEADLINE');
    const url=new URL('/api/internal/sourcing/candidate-eligibility',options.baseUrl);
    const response=await(options.fetch??fetch)(url,{method:'POST',headers:{authorization:`Bearer ${token}`,
      'content-type':'application/json'},body:encoded,redirect:'error',signal:controller.signal});
    if(!response.ok||!response.body){void response.body?.cancel().catch(()=>undefined);throw Error('FLOW_CANDIDATE_UNAVAILABLE');}
    reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
      if(size>65536)throw Error('FLOW_CANDIDATE_INVALID');chunks.push(part.value);}
    const result=responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if(result.bodyHash!==hash||result.results.length!==body.items.length
      ||result.results.some((value,index)=>value.key!==body.items[index]!.key))throw Error('FLOW_CANDIDATE_INVALID');
    return result;
  })()]);}catch(error){
    if(error instanceof Error&&['FLOW_CANDIDATE_DEADLINE','FLOW_CANDIDATE_INVALID'].includes(error.message))throw error;
    throw Error('FLOW_CANDIDATE_UNAVAILABLE');
  }finally{if(timer)clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>undefined);}
}

export function eligibilityItems(identities:readonly PrivateResumeIdentity[]) {
  return identities.map(identity=>({key:identity.candidateId,identity}));
}
