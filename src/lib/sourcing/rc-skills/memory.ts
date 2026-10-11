import {randomUUID} from 'node:crypto';
import {SignJWT,importPKCS8} from 'jose';
import {z} from 'zod';
import {cacheReadSchema,cacheFinishSchema,observationSchema} from './contracts';

const itemSchema=z.object({globalCandidateId:z.string().uuid(),
  state:z.enum(['available','no_data','miss','restricted']),observation:observationSchema.nullable(),
}).strict().refine(v=>v.state==='miss'||v.state==='restricted'?v.observation===null:
  v.observation!==null&&(v.state==='available')===(v.observation.outcome==='success'),'Invalid cache state');
const readResponse=z.object({version:z.literal(1),candidates:z.array(itemSchema).max(100)}).strict();
const finishResponse=z.object({version:z.literal(1),status:z.enum(['stored','replayed']),
  receiptId:z.string().uuid(),contentHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export type RcCacheItem=z.infer<typeof itemSchema>;
export type RcCacheReceipt=z.infer<typeof finishResponse>;
export type RcCacheFinish=z.infer<typeof cacheFinishSchema>;
export class RcMemoryError extends Error {
  constructor(readonly code:'unavailable'|'restricted'|'conflict'|'invalid_response'|'configuration',readonly retryable:boolean){
    super('RC_MEMORY_'+code.toUpperCase());this.name='RcMemoryError';
  }
}

/** This dedicated signer never broadens the existing KG/contact signer scopes. */
async function sign(tenantId:string,scope:'rc-skills:read'|'rc-skills:write'):Promise<string> {
  if(!/^org_[1-9][0-9]*$/.test(tenantId))throw new RcMemoryError('configuration',false);
  const pem=process.env.SIGNAL_JWT_PRIVATE_KEY;
  if(!pem)throw new RcMemoryError('configuration',false);
  const key=await importPKCS8(pem.includes('-----BEGIN')?pem:Buffer.from(pem,'base64').toString('utf8'),'RS256');
  return new SignJWT({tenant_id:tenantId,actor_type:'service',scopes:[scope]})
    .setProtectedHeader({alg:'RS256',kid:process.env.SIGNAL_JWT_ACTIVE_KID||'v1'})
    .setIssuer('signal').setAudience('activekg').setSubject('signal-service')
    .setIssuedAt().setExpirationTime('5m').setJti(randomUUID()).sign(key);
}

async function bounded(response:Response):Promise<unknown> {
  if(!response.body)throw new RcMemoryError('invalid_response',true);
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try {
    while(true){const next=await reader.read();if(next.done)break;
      size+=next.value.byteLength;if(size>1_048_576)throw new RcMemoryError('invalid_response',true);
      parts.push(next.value);}
    return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(parts)));
  }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}

export interface RcMemoryClient {
  read(tenantId:string,candidateIds:string[]):Promise<RcCacheItem[]>;
  finish(tenantId:string,command:RcCacheFinish):Promise<RcCacheReceipt>;
}

/** No eager environment/key/database access. Instantiated only behind the RC gate. */
export function createRcMemoryClient(options:{transport?:typeof fetch;testOrigin?:string;
  testSigner?:(tenantId:string,scope:'rc-skills:read'|'rc-skills:write')=>Promise<string>}={}):RcMemoryClient {
  if((options.testOrigin||options.testSigner)&&process.env.NODE_ENV!=='test')throw new RcMemoryError('configuration',false);
  async function call(tenantId:string,operation:'read'|'finish',body:unknown):Promise<unknown> {
    try {
      if(!/^org_[1-9][0-9]*$/.test(tenantId))throw new RcMemoryError('configuration',false);
      const configured=options.testOrigin??process.env.ACTIVEGRAPH_URL;
      if(!configured)throw new RcMemoryError('configuration',false);
      const origin=new URL(configured);
      const local=['127.0.0.1','[::1]','localhost'].includes(origin.hostname);
      // Configured Railway private-network service origins use HTTP. Never
      // permit an arbitrary public HTTP host or a redirect carrying the JWT.
      const privateService=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.railway\.internal$/.test(origin.hostname);
      if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||
        (origin.protocol!=='https:'&&!(origin.protocol==='http:'&&(privateService||local&&process.env.NODE_ENV!=='production'))))
        throw new RcMemoryError('configuration',false);
      const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>65536)throw new RcMemoryError('configuration',false);
      const scope=operation==='read'?'rc-skills:read':'rc-skills:write';
      const token=await (options.testSigner??sign)(tenantId,scope);
      const response=await (options.transport??fetch)(new URL('/internal/rc-skills/'+operation,origin),{
        method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:encoded,signal:AbortSignal.timeout(10_000),
      });
      if(!response.ok){await response.body?.cancel().catch(()=>undefined);
        if(response.status===403||response.status===451)throw new RcMemoryError('restricted',false);
        if(response.status===409)throw new RcMemoryError('conflict',false);
        throw new RcMemoryError('unavailable',response.status>=500||response.status===429);}
      return await bounded(response);
    }catch(error){if(error instanceof RcMemoryError)throw error;throw new RcMemoryError('unavailable',true);}
  }
  return {
    async read(tenantId,candidateIds){
      const body=cacheReadSchema.parse({version:1,candidateIds});
      const parsed=readResponse.safeParse(await call(tenantId,'read',body));
      if(!parsed.success)throw new RcMemoryError('invalid_response',true);
      const wanted=new Set(candidateIds.map(v=>v.toLowerCase()));
      const got=new Set(parsed.data.candidates.map(v=>v.globalCandidateId.toLowerCase()));
      if(got.size!==wanted.size||got.size!==parsed.data.candidates.length||[...got].some(v=>!wanted.has(v)))
        throw new RcMemoryError('invalid_response',true);
      return parsed.data.candidates;
    },
    async finish(tenantId,command){
      const body=cacheFinishSchema.parse(command);
      const parsed=finishResponse.safeParse(await call(tenantId,'finish',body));
      if(!parsed.success||parsed.data.contentHash!==body.observation.contentHash)
        throw new RcMemoryError('invalid_response',true);
      return parsed.data;
    },
  };
}
