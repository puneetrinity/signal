import {describe,expect,it} from 'vitest';
import {cacheFinishSchema,cacheReadSchema,createObservation,observationSchema,rcCanonicalTime,rcTimestampMicros,rcValidUntil,approvedRcFreeRejection,rcFreeRejectionSchema,createRcFinish} from '../contracts';
import fixture from '../../../../../research/fixtures/rc-skills-v1.json';
import {rankingHash} from '../../rubric/contracts';
import {createRcMemoryClient} from '../memory';

describe('Memory/Discover minimal RC wire',()=>{
  it('has no enabled free-retry policy and refuses malformed proof envelopes',()=>{
    const proof={version:1,kind:'rc_429_uncharged',httpStatus:429,providerCode:'synthetic-unpaid-429',creditsConsumed:0,
      requestIdHash:'a'.repeat(64),retryAfterAt:'2026-10-13T00:00:00Z',policyVersion:'fixture-only-v1'};
    expect(rcFreeRejectionSchema.safeParse(proof).success).toBe(true);
    expect(approvedRcFreeRejection(proof)).toBe(null);
    for(const delta of [{creditsConsumed:1},{httpStatus:503},{requestIdHash:'raw-request-id'},{retryAfterAt:'bad'},{secret:'forbidden'}]){
      expect(rcFreeRejectionSchema.safeParse({...proof,...delta}).success).toBe(false);
      expect(approvedRcFreeRejection({...proof,...delta})).toBe(null);
    }
    const outcome={kind:'rejected_free',upstreamAt:null,retryableFree:true,safeCode:'rate_limited',rejectionProof:proof,
      quota:{minuteLimit:null,minuteLeft:null,resetAt:null,retryAfterMs:1000,dailyLeft:null}} as const;
    expect(()=>createRcFinish({version:1,observation:null,observedCredits:1,outcome} as any)).toThrow();
    expect(()=>createRcFinish({version:1,observation:null,observedCredits:0,outcome:{...outcome,kind:'uncertain'}} as any)).toThrow();
  });
  it('matches the pinned Python hash with Unicode and microsecond timestamps',()=>{
    expect(observationSchema.parse(fixture.observation)).toEqual(fixture.observation);
    const {contentHash,...body}=fixture.observation;
    expect(rankingHash(body)).toBe(contentHash);
    expect(createObservation({...body,version:1,outcome:'success',timestampSource:'check_last_update'})).toEqual(fixture.observation);
  });
  it('preserves microseconds and canonicalizes offset timestamps before hashing',()=>{
    const value='2026-01-01T05:30:00.123456+05:30';
    expect(rcCanonicalTime(value)).toBe('2026-01-01T00:00:00.123456Z');
    expect(rcValidUntil(value)).toBe('2028-12-31T00:00:00.123456Z');
    expect(rcTimestampMicros(value)-rcTimestampMicros('2026-01-01T00:00:00.123455Z')).toBe(BigInt(1));
    expect(rcCanonicalTime('1969-12-31T23:59:59.123456Z')).toBe('1969-12-31T23:59:59.123456Z');
  });
  it.each(['invalid','2026-02-30T00:00:00Z','2026-01-01T00:00:00.1234567Z'])('safe-parse refuses %s without throwing',upstreamAt=>{
    expect(observationSchema.safeParse({...fixture.observation,upstreamAt}).success).toBe(false);
  });
  it.each(['email','profile','linkedinUrl','employer'])('refuses raw provider field %s',key=>{
    expect(observationSchema.safeParse({...fixture.observation,[key]:'discard'}).success).toBe(false);
  });
  it('does not silently change hashed timestamps or skills',()=>{
    expect(observationSchema.safeParse({...fixture.observation,observedAt:'2026-10-08T00:00:00.000Z'}).success).toBe(false);
    expect(observationSchema.safeParse({...fixture.observation,skills:['Kafka']}).success).toBe(false);
  });
  it('bounds observations even when each individual skill is within its limit',()=>{
    const {contentHash:_ignored,...body}=fixture.observation;
    expect(()=>createObservation({...body,version:1,outcome:'success',timestampSource:'check_last_update',skills:Array(200).fill('x'.repeat(400))})).toThrow();
  });
  it('refuses duplicate UUID spellings and extra finish fields',()=>{
    const id='abcdefab-1234-4123-8123-abcdefabcdef';
    expect(cacheReadSchema.safeParse({version:1,candidateIds:[id,id.toUpperCase()]}).success).toBe(false);
    const body={version:1,globalCandidateId:id,originRun:id,originAttempt:id,observation:fixture.observation};
    expect(cacheFinishSchema.safeParse(body).success).toBe(true);
    expect(cacheFinishSchema.safeParse({...body,email:'private@fixture.invalid'}).success).toBe(false);
  });
});

describe('minimal Memory cache client',()=>{
  it('permits configured private service HTTP but refuses public HTTP and misleading hostnames',async()=>{
    for(const [origin,allowed] of [['http://memory.railway.internal:8000',true],
      ['http://memory.example',false],['http://memory.railway.internal.example',false],
      ['http://user:password@memory.railway.internal',false]] as const){
      let called=false;
      const memory=createRcMemoryClient({testOrigin:origin,testSigner:async()=> 'synthetic',
        transport:async(_url,init)=>{called=true;expect(init?.redirect).toBe('error');return Response.json({version:1,candidates:[]});}});
      if(allowed)expect(await memory.read('org_1',[])).toEqual([]);
      else await expect(memory.read('org_1',[])).rejects.toThrow('CONFIGURATION');
      expect(called).toBe(allowed);
    }
  });
  const id='abcdefab-1234-4123-8123-abcdefabcdef';
  const client=(response:Response)=>createRcMemoryClient({testOrigin:'http://127.0.0.1:8000',
    testSigner:async(tenant,scope)=>{expect(tenant).toBe('org_1');expect(['rc-skills:read','rc-skills:write']).toContain(scope);return 'synthetic';},
    transport:async(url,init)=>{expect(String(url)).toMatch(/\/internal\/rc-skills\/(read|finish)$/);
      expect(init?.redirect).toBe('error');return response;}});
  it('accepts only the exact requested IDs with minimal observations',async()=>{
    const candidates=[{globalCandidateId:id,state:'available',observation:fixture.observation}];
    expect(await client(Response.json({version:1,candidates})).read('org_1',[id])).toEqual(candidates);
    await expect(client(Response.json({version:1,candidates:[...candidates,...candidates]})).read('org_1',[id])).rejects.toThrow('INVALID_RESPONSE');
    await expect(client(Response.json({version:1,candidates:[]})).read('org_1',[id])).rejects.toThrow('INVALID_RESPONSE');
  });
  it('does not accept email or inconsistent availability from Memory',async()=>{
    for(const entry of [{globalCandidateId:id,state:'miss',observation:fixture.observation},
      {globalCandidateId:id,state:'available',observation:{...fixture.observation,email:'discard'}}]){
      await expect(client(Response.json({version:1,candidates:[entry]})).read('org_1',[id])).rejects.toThrow('INVALID_RESPONSE');
    }
  });
  it.each([[403,'restricted',false],[409,'conflict',false],[404,'unavailable',false],[503,'unavailable',true]] as const)(
    'maps permanent/retryable HTTP %i without exposing body',async(status,code,retryable)=>{
      await expect(client(new Response('secret-provider-body',{status})).read('org_1',[])).rejects.toMatchObject({code,retryable});
    });
  it('validates the returned write hash',async()=>{
    const command=cacheFinishSchema.parse({version:1,globalCandidateId:id,originRun:id,originAttempt:id,observation:fixture.observation});
    await expect(client(Response.json({version:1,status:'stored',receiptId:id,contentHash:'0'.repeat(64)})).finish('org_1',command)).rejects.toThrow('INVALID_RESPONSE');
  });
});
