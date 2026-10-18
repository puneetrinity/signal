import { beforeAll, describe, expect, it } from 'vitest';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { signPrivateResumeSourcingJWT } from '../activegraph-auth';
import { readPrivateResumes, revalidatePrivateResumes } from '../private-resume-client';

const request = () => ({version:1 as const, requestId:'test-request', externalJobId:189,
  flowRunId:randomUUID(), artifactHash:'a'.repeat(64), query:'Python', limit:100});
const identity = () => ({candidateId:randomUUID(), referenceId:randomUUID(), applicationId:123,
  applicationJobId:188, resumeVersionId:randomUUID(), sourceId:randomUUID(), generationId:randomUUID(),
  sourceHash:'b'.repeat(64)});
const hit = () => ({identity:identity(), linkedPublicId:null, distance:0.2,
  evidence:{version:1,kind:'candidate_provided',scope:'org_32',sourceVersion:1,
    observedAt:'2026-10-18T00:00:00Z',skills:['Python','C++'],location:{city:'Bengaluru',country:'India'},
    currentTitle:'Backend engineer',seniority:'senior',primaryTitles:[],domains:[],functions:[],
    certifications:[],industries:[]}});
const reply = () => ({version:1,requestId:'test-request',results:[hit()],retrievalLimit:100,
  saturated:false,counts:{returned:1,withheldInvalidEvidence:0}});
const options = (body:unknown) => ({deadlineAt:Date.now()+9000,baseUrl:'http://synthetic.invalid',
  fetch:(async () => Response.json(body)) as typeof fetch});
let publicKey: CryptoKey;
beforeAll(async () => {
  const keys=await generateKeyPair('RS256',{extractable:true});
  publicKey=keys.publicKey;
  process.env.SIGNAL_JWT_PRIVATE_KEY=await exportPKCS8(keys.privateKey);
});

describe('private resume Memory contract (synthetic transport only)', () => {
  it('signs the exact dedicated Memory authority',async () => {
    const token=await signPrivateResumeSourcingJWT('org_32','test-request');
    const {payload,protectedHeader}=await jwtVerify(token,publicKey,{issuer:'signal',audience:'activekg'});
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload.sub).toBe('signal-service');
    expect(payload.scopes).toEqual(['organization-candidate-sourcing:read']);
    expect(payload.actor_type).toBe('service');
    expect(payload.tenant_id).toBe('org_32');
    expect(payload.request_id).toBe('test-request');
    expect(payload.exp!-payload.iat!).toBe(300);
    expect(payload.jti).toBeTruthy();
  });
  it.each(['org_0','org_032','org_2147483648','public'])('refuses tenant %s before transport',async tenant => {
    await expect(signPrivateResumeSourcingJWT(tenant,'test-request')).rejects.toThrow('PRIVATE_RESUME_AUTHORITY_INVALID');
  });
  it('keeps private identities without a LinkedIn stand-in',async () => {
    const response=reply();
    const actual=await readPrivateResumes(request(),'org_32',options(response));
    expect(actual).toEqual(response);
    expect(JSON.stringify(actual)).not.toContain('linkedin');
  });
  it.each(['foreign','same-job','request','extra-contact','null-identity','duplicate','count','oversize'])
  ('refuses %s response without exposing its contents',async mode => {
    const body=reply();
    if(mode==='foreign')body.results[0].evidence.scope='org_99';
    if(mode==='same-job')body.results[0].identity.applicationJobId=189;
    if(mode==='request')body.requestId='different';
    if(mode==='extra-contact')Object.assign(body.results[0],{email:'private@example.invalid'});
    if(mode==='null-identity')Object.assign(body.results[0],{identity:null});
    if(mode==='duplicate'){body.results.push(body.results[0]);body.counts.returned=2;}
    if(mode==='count')body.counts.returned=0;
    if(mode==='oversize'){
      const names=Array(10).fill('界'.repeat(500));
      Object.assign(body.results[0].evidence,{skills:Array(100).fill('界'.repeat(120)),domains:names,
        functions:names,certifications:names,industries:names});
    }
    await expect(readPrivateResumes(request(),'org_32',options(body))).rejects.toThrow('PRIVATE_RESUME_INVALID_CONTRACT');
  });
  it('checks revalidation tuples exactly, not just returned decisions',async () => {
    const item=identity();
    const req={version:1 as const,requestId:'test-request',externalJobId:189,items:[item]};
    const body={version:1,requestId:'test-request',results:[{identity:item,decision:'allow'}]};
    expect(await revalidatePrivateResumes(req,'org_32',options(body))).toEqual(body);
    await expect(revalidatePrivateResumes(req,'org_32',options({...body,results:[]})))
      .rejects.toThrow('PRIVATE_RESUME_INVALID_CONTRACT');
    await expect(revalidatePrivateResumes(req,'org_32',options({...body,results:[{identity:identity(),decision:'allow'}]})))
      .rejects.toThrow('PRIVATE_RESUME_INVALID_CONTRACT');
  });
  it('deadline covers body reading and never retries',async () => {
    let calls=0;
    const opts={...options(null),deadlineAt:Date.now()+30,fetch:(async () => {
      calls++;
      return new Response(new ReadableStream({start(){ /* intentionally pending */ }}));
    }) as typeof fetch};
    await expect(readPrivateResumes(request(),'org_32',opts)).rejects.toThrow('PRIVATE_RESUME_DEADLINE');
    expect(calls).toBe(1);
  });
  it('does not turn an upstream refusal into empty success or echo its body',async () => {
    const opts={...options(null),fetch:(async () => new Response('private upstream text',{status:503})) as typeof fetch};
    await expect(readPrivateResumes(request(),'org_32',opts)).rejects.toThrow('PRIVATE_RESUME_UNAVAILABLE');
  });
  it('bounds streamed response bytes',async () => {
    const opts={...options(null),fetch:(async () => new Response('x'.repeat(8*1024*1024+1))) as typeof fetch};
    await expect(readPrivateResumes(request(),'org_32',opts)).rejects.toThrow('PRIVATE_RESUME_INVALID_CONTRACT');
  });
});
