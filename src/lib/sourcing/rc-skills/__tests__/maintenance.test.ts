import {describe,it,expect,vi} from 'vitest';
import {deliverRcAlert} from '../alerts';
import {runRcMaintenanceCycle,enqueueRcResumes} from '../maintenance';

const alert={id:'10000000-0000-4000-8000-000000000001',runId:'20000000-0000-4000-8000-000000000001',
 kind:'stalled' as const,code:'RC_STALLED',createdAt:'2026-10-09T00:00:00Z',escalation:'primary' as const};
describe('RC independent maintenance',()=>{
 it('replays operator-approved enqueue after a queue failure or lost ack without minting another execution',async()=>{
  const run={tenantId:'org_1',flowRunId:alert.runId,token:alert.id,requestId:'saved-request',externalJobId:'vanta:jobs:1',
   callbackUrl:'https://flow.example/callback',acquisitionGeneration:1,executionAttemptId:'30000000-0000-4000-8000-000000000001'};
  let pending=true,loseAck=true;
  const maintenance=vi.fn(async(c:Record<string,unknown>)=>{
   if(c.action==='resumes')return {version:1,runs:pending?[run]:[]};
   expect(c).toEqual({version:1,action:'resume_ack',tenantId:run.tenantId,flowRunId:run.flowRunId,token:run.token});
   if(loseAck){loseAck=false;throw Error('lost acknowledgement');}
   pending=false;return {version:1,state:'recorded'};
  });
  const enqueue=vi.fn().mockRejectedValueOnce(Error('Redis unavailable')).mockResolvedValue(undefined);
  expect(await enqueueRcResumes({maintenance},enqueue)).toEqual({enqueued:0,failed:1});
  expect(await enqueueRcResumes({maintenance},enqueue)).toEqual({enqueued:0,failed:1});
  expect(await enqueueRcResumes({maintenance},enqueue)).toEqual({enqueued:1,failed:0});
  expect(await enqueueRcResumes({maintenance},enqueue)).toEqual({enqueued:0,failed:0});
  expect(enqueue.mock.calls).toEqual([[run],[run],[run]]);
 });
 it('off is completely inert',async()=>{
  const maintenance=vi.fn(),deliver=vi.fn(),notify=vi.fn();
  expect(await runRcMaintenanceCycle({repository:{maintenance},enabled:false,cleanupDue:true,deliver,notify}))
   .toMatchObject({enabled:false,cleaned:0});
  expect(maintenance).not.toHaveBeenCalled();expect(deliver).not.toHaveBeenCalled();expect(notify).not.toHaveBeenCalled();
 });
 it('keeps stall alerts independent of slow receipt delivery',async()=>{
  const maintenance=vi.fn(async(c:Record<string,unknown>)=>{
   if(c.action==='tick')return {version:1,stalled:1};
   if(c.action==='alerts')return {version:1,events:[alert]};
   if(c.action==='alert_result')return {version:1,state:'recorded'};
   throw Error('Independent alerts must not attempt delivery or cleanup');
  });
  const deliver=vi.fn();
  expect(await runRcMaintenanceCycle({repository:{maintenance},enabled:true,cleanupDue:true,
   alertsOnly:true,notify:async()=>true,deliver})).toMatchObject({stalled:1,alertsDelivered:1,deliveriesAttempted:0,cleaned:0});
  expect(deliver).not.toHaveBeenCalled();
 });
 it('retains failed alerts and deliveries, and cleans only when due',async()=>{
  const commands:Record<string,unknown>[]=[];
  const maintenance=vi.fn(async(command:Record<string,unknown>)=>{
   commands.push(command);
   if(command.action==='tick')return {version:1,stalled:1};
   if(command.action==='alerts')return {version:1,events:[alert]};
   if(command.action==='alert_result'||command.action==='delivery_result')return {version:1,state:'recorded'};
   if(command.action==='deliveries')return {version:1,runs:[{tenantId:'org_1',flowRunId:alert.runId,requestId:'request'}]};
   throw Error('Unexpected action');
  });
  const result=await runRcMaintenanceCycle({repository:{maintenance},enabled:true,cleanupDue:false,
   notify:async()=>false,deliver:async()=>{throw Error('Memory unavailable');}});
  expect(result).toMatchObject({stalled:1,alertsPending:1,alertsDelivered:0,deliveriesPending:1,cleaned:0});
  expect(commands).toContainEqual({version:1,action:'alert_result',id:alert.id,delivered:false});
  expect(commands.map(c=>c.action)).not.toContain('cleanup');
 });
 it('accepts an acknowledged alert and bounded cleanup counts',async()=>{
  const maintenance=vi.fn(async(c:Record<string,unknown>)=>c.action==='tick'?{version:1,stalled:0}
   :c.action==='alerts'?{version:1,events:[alert]}:c.action==='alert_result'?{version:1,state:'recorded'}
   :c.action==='deliveries'?{version:1,runs:[]}:{version:1,ready:1,cleaned:2});
  expect(await runRcMaintenanceCycle({repository:{maintenance},enabled:true,cleanupDue:true,
   notify:async()=>true,deliver:async()=>true})).toMatchObject({alertsDelivered:1,alertsPending:0,ready:1,cleaned:2});
 });
 it('refuses a payload-bearing alert before sending anything',async()=>{
  const transport=vi.fn();
  await expect(deliverRcAlert({...alert,profile:'private'} as typeof alert,{transport})).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
 });
 it('sends only the closed event and never follows redirects',async()=>{
  const transport=vi.fn(async(_url: string|URL|Request,_options?:RequestInit)=>new Response(null,{status:204}));
  expect(await deliverRcAlert(alert,{transport,testUrl:'http://127.0.0.1:12345/alert'})).toBe(true);
  const options=transport.mock.calls[0]?.[1] as RequestInit|undefined;
  expect(options?.redirect).toBe('error');expect(JSON.parse(String(options?.body))).toEqual({version:1,event:alert});
 });
 it('does not acknowledge a refused webhook',async()=>{
  expect(await deliverRcAlert(alert,{transport:async()=>new Response(null,{status:503}),testUrl:'http://127.0.0.1:12345/alert'})).toBe(false);
 });
});
