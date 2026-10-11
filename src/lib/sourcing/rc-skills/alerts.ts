import {z} from 'zod';

export const rcAlertSchema=z.object({
 id:z.string().uuid(),runId:z.string().uuid(),
 kind:z.enum(['stalled','rate_unavailable','cache_delivery','receipt_delivery','closed']),
 code:z.string().regex(/^RC_[A-Z_]{1,64}$/),createdAt:z.string().datetime({offset:true}),
 escalation:z.enum(['primary','backup','retention_review']),
}).strict();
export type RcAlert=z.infer<typeof rcAlertSchema>;

/** Minimal operations event only. No profile data, provider response or secret
 * appears in the body/logs. A failed send leaves the durable event pending. */
export async function deliverRcAlert(event:RcAlert,options:{transport?:typeof fetch;testUrl?:string}={}):Promise<boolean>{
 const parsed=rcAlertSchema.parse(event);
 try{
  if(options.testUrl&&process.env.NODE_ENV!=='test')return false;
  const configured=options.testUrl??process.env.RC_OPS_ALERT_WEBHOOK_URL;
  if(!configured)return false;
  const url=new URL(configured);
  const local=['127.0.0.1','[::1]','localhost'].includes(url.hostname);
  if(url.username||url.password||url.hash||
   (url.protocol!=='https:'&&!(options.testUrl&&url.protocol==='http:'&&local)))return false;
  const response=await (options.transport??fetch)(url,{method:'POST',redirect:'error',
   signal:AbortSignal.timeout(10_000),headers:{'Content-Type':'application/json'},
   body:JSON.stringify({version:1,event:parsed})});
  await response.body?.cancel();
  return response.ok;
 }catch{return false;}
}
