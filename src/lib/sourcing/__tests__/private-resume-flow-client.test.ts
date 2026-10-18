import { createHash, randomUUID } from 'node:crypto';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { checkFlowResumeEligibility, type FlowEligibilityBody } from '../private-resume-flow-client';

let keys:Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async()=>{keys=await generateKeyPair('RS256',{extractable:true});
  vi.stubEnv('SIGNAL_JWT_PRIVATE_KEY',await exportPKCS8(keys.privateKey));});
const body=():FlowEligibilityBody=>({version:1,flowRunId:randomUUID(),revisionId:randomUUID(),requestId:'request',
  externalJobId:189,items:[{key:'one',identity:{candidateId:randomUUID(),referenceId:randomUUID(),
    applicationId:123,applicationJobId:188,resumeVersionId:randomUUID(),sourceId:randomUUID(),generationId:randomUUID(),sourceHash:'a'.repeat(64)}}]});
describe('Flow private applicant transport',()=>{
  it('binds the signed token to the exact canonical batch, request and execution',async()=>{
    const request=body(),execution=randomUUID();let calls=0;
    const transport=(async(url,init)=>{
      calls++;
      expect(String(url)).toBe('https://flow.invalid/api/internal/sourcing/candidate-eligibility');
      expect(init?.redirect).toBe('error');
      const token=new Headers(init?.headers).get('authorization')!.slice(7);
      const {payload}=await jwtVerify(token,keys.publicKey,{issuer:'signal',audience:'vantahire'});
      const hash=createHash('sha256').update(String(init?.body)).digest('hex');
      expect(payload).toMatchObject({sub:'sourcing',scopes:'sourcing:candidates:read',tenant_id:'org_32',
        request_id:request.requestId,flow_run_id:request.flowRunId,execution_attempt_id:execution,body_hash:hash});
      expect(payload.exp!-payload.iat!).toBe(300);
      return Response.json({version:1,bodyHash:hash,checkedAt:new Date().toISOString(),results:[{key:'one',decision:'allow'}]});
    }) as typeof fetch;
    const result=await checkFlowResumeEligibility('org_32',execution,request,
      {baseUrl:'https://flow.invalid/api/webhooks/signal/callback',deadlineAt:Date.now()+5000,fetch:transport});
    expect(result.results).toEqual([{key:'one',decision:'allow'}]);expect(calls).toBe(1);
  });
  it.each(['wrong-hash','wrong-item','partial','extra-field'])('rejects %s, with no retry',async mode=>{
    let calls=0;
    const transport=(async(_url,init)=>{
      calls++;const result:Record<string,unknown>={version:1,bodyHash:createHash('sha256').update(String(init?.body)).digest('hex'),
        checkedAt:new Date().toISOString(),results:[{key:'one',decision:'allow'}]};
      if(mode==='wrong-hash')result.bodyHash='b'.repeat(64);
      if(mode==='wrong-item')result.results=[{key:'different',decision:'allow'}];
      if(mode==='partial')result.results=[];
      if(mode==='extra-field')result.email='synthetic@example.invalid';
      return Response.json(result);
    }) as typeof fetch;
    await expect(checkFlowResumeEligibility('org_32',randomUUID(),body(),
      {baseUrl:'https://flow.invalid',deadlineAt:Date.now()+5000,fetch:transport})).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('times out while reading a response, rather than waiting indefinitely',async()=>{
    const transport=vi.fn(async()=>new Response(new ReadableStream({start(){}}))) as unknown as typeof fetch;
    await expect(checkFlowResumeEligibility('org_32',randomUUID(),body(),
      {baseUrl:'https://flow.invalid',deadlineAt:Date.now()+50,fetch:transport})).rejects.toThrow('DEADLINE');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('refuses duplicate batch identities before sending',async()=>{
    const request=body();request.items.push({...request.items[0],key:'another'});
    const transport=vi.fn();
    await expect(checkFlowResumeEligibility('org_32',randomUUID(),request,
      {baseUrl:'https://flow.invalid',deadlineAt:Date.now()+5000,fetch:transport})).rejects.toThrow('INVALID');
    expect(transport).not.toHaveBeenCalled();
  });
});
