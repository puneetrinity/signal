import {describe,expect,it,vi} from 'vitest';
import {createRcProvider} from '../provider';
import {RC_LIMITS} from '../config';
const url='https://www.linkedin.com/in/rc-synthetic-person';
const now=Date.parse('2026-10-08T00:00:00.000Z');
const response=(data:unknown,credits=0)=>new Response(JSON.stringify({
  success:true,error:null,data,quotas:{creditsConsumed:credits,workspace:{credits:{left:1000},
    minuteRateLimit:{limit:500,left:400,nextReset:'2026-10-08T00:01:00.000Z'}},
    key:{minuteRateLimit:{limit:300,left:290,nextReset:'2026-10-08T00:01:00.000Z'}}},
  metadata:{requestId:'private-provider-reference'},email:'private@example.invalid',
}),{headers:{'content-type':'application/json'}});
function client(reply:()=>Response|Promise<Response>) {
  const transport=vi.fn(async(_input:Parameters<typeof fetch>[0],_init?:Parameters<typeof fetch>[1])=>reply());
  return {transport,provider:createRcProvider({apiKey:'fake-test-key',fetchImpl:transport as typeof fetch,now:()=>now})};
}
describe('RC cached V2 transport, fake HTTP only',()=>{
  it('direct fetch reads freshness from metadata, never profile dates or local time',async()=>{
    const old=response({linkedinUrl:url,skills:['Python'],lastUpdate:'2020-01-01T00:00:00Z'},1);
    const raw=await old.json();raw.metadata.updatedAt='2026-01-01T00:00:00.000Z';
    const {provider,transport}=client(()=>new Response(JSON.stringify(raw)));
    const result=await provider.fetchSkills(url,now+300000,1,'direct');
    expect(result).toMatchObject({skills:['Python'],outcome:'success',upstreamAt:'2026-01-01T00:00:00.000Z'});
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0]).toBe('https://api.reversecontact.com/v2/fetch/persons');
    expect(JSON.stringify(result)).not.toMatch(/private@|private-provider-reference|lastUpdate/);
  });
  it.each([null,'bad','2027-01-01T00:00:00Z','2020-01-01T00:00:00Z'])('direct fetch refuses unusable metadata date %s',async updatedAt=>{
    const raw=await response({linkedinUrl:url,skills:['Python']},1).json();raw.metadata.updatedAt=updatedAt;
    const {provider}=client(()=>new Response(JSON.stringify(raw)));
    expect(await provider.fetchSkills(url,now+300000,1,'direct')).toMatchObject({outcome:'unusable_age',skills:[]});
  });
  it('accepts only the structured zero-credit direct not-found response',async()=>{
    const raw=await response({},0).json();Object.assign(raw,{success:false,error:'REQUEST_ERROR',data:null});
    const {provider}=client(()=>new Response(JSON.stringify(raw),{status:404}));
    expect(await provider.fetchSkills(url,now+300000,1,'direct')).toMatchObject({outcome:'not_found',skills:[],upstreamAt:null,quota:{creditsConsumed:0}});
    for(const body of ['<html>not found</html>',JSON.stringify({...raw,error:'OTHER'}),JSON.stringify({...raw,quotas:{creditsConsumed:1}})]){
      const invalid=client(()=>new Response(body,{status:404})).provider;
      await expect(invalid.fetchSkills(url,now+300000,1,'direct')).rejects.toMatchObject({possiblePaid:true});
    }
  });
  it('never retries a direct FETCH429 without approved charge proof',async()=>{
    const {provider,transport}=client(()=>new Response('',{status:429,headers:{'retry-after':'2'}}));
    await expect(provider.fetchSkills(url,now+300000,1,'direct')).rejects.toMatchObject({code:'rate_limited',possiblePaid:true});
    expect(transport).toHaveBeenCalledOnce();
  });
  it('projects CHECK fields and obeys the lower account/key quota without leaking IDs',async()=>{
    const {provider,transport}=client(()=>response({exists:true,lastUpdate:'2026-01-01T00:00:00.000Z',skillCount:2,private:'discard'}));
    const result=await provider.check(url,now+300000);
    expect(result).toMatchObject({outcome:'eligible',quota:{creditsConsumed:0,minuteLimit:300,minuteLeft:290}});
    const wire=JSON.stringify(result);
    expect(wire).not.toContain('private');expect(wire).not.toContain('@');
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0]).toBe('https://api.reversecontact.com/v2/fetch/persons/check');
  });
  it.each([null,'bad','2027-01-01T00:00:00Z','2020-01-01T00:00:00Z'])('never substitutes local time for %s',async lastUpdate=>{
    const {provider}=client(()=>response({exists:true,lastUpdate,skillCount:2}));
    expect((await provider.check(url,now+300000)).outcome).toBe('unusable_age');
  });
  it('accepts the exact 1095-day boundary and explicit no-skills',async()=>{
    const {provider}=client(()=>response({exists:true,lastUpdate:new Date(now-1095*86400000).toISOString(),skillCount:0}));
    expect((await provider.check(url,now+300000)).outcome).toBe('no_skills');
  });
  it('not-found does not require content counters',async()=>{
    const {provider}=client(()=>response({exists:false,lastUpdate:null}));
    expect((await provider.check(url,now+300000)).outcome).toBe('not_found');
  });
  it('missing skill count is invalid, never no-data',async()=>{
    const {provider}=client(()=>response({exists:true,lastUpdate:'2026-01-01T00:00:00Z'}));
    await expect(provider.check(url,now+300000)).rejects.toMatchObject({code:'invalid_response',possiblePaid:false});
  });
  it('projects only skills, quota and correlation; empty is explicit no-data',async()=>{
    for(const skills of [[],['AWS','Amazon Web Services']]) {
      const {provider}=client(()=>response({linkedinUrl:url,skills,email:'private@example.invalid',
        firstName:'PRIVATE_NAME',experience:[{private:'history'}]},1));
      const result=await provider.fetchSkills(url,now+300000,1);
      expect(result.skills).toEqual(skills);
      expect(Object.keys(result).sort()).toEqual(['correlationHash','quota','skills']);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_NAME|private@|history/);
    }
  });
  it.each([undefined,null,{},[''],['a'.repeat(501)],Array(501).fill('AWS')])('never trims malformed skills %#',async skills=>{
    const {provider}=client(()=>response({linkedinUrl:url,skills},1));
    await expect(provider.fetchSkills(url,now+300000,1)).rejects.toMatchObject({code:'invalid_response',possiblePaid:true});
  });
  it('quarantines a different returned identity',async()=>{
    const {provider}=client(()=>response({linkedinUrl:'https://www.linkedin.com/in/someone-else',skills:['AWS']},1));
    await expect(provider.fetchSkills(url,now+300000,1)).rejects.toMatchObject({code:'identity_mismatch'});
  });
  it.each([401,402,403,429,451,500,503])('makes no automatic retry after HTTP %i',async status=>{
    const {provider,transport}=client(()=>new Response('private error with email',{status,headers:{'retry-after':'2'}}));
    await expect(provider.fetchSkills(url,now+300000,1)).rejects.toMatchObject({possiblePaid:true});
    expect(transport).toHaveBeenCalledOnce();
  });
  it('timeout is uncertain, not completed no-data',async()=>{
    const {provider,transport}=client(()=>{throw new DOMException('private URL/key','AbortError');});
    await expect(provider.fetchSkills(url,now+300000,1)).rejects.toMatchObject({code:'transport',possiblePaid:true,message:'RC_TRANSPORT'});
    expect(transport).toHaveBeenCalledOnce();
  });
  it('rejects oversized streamed responses before parsing without retaining the body',async()=>{
    const {provider}=client(()=>new Response(new ReadableStream({
      start(controller){controller.enqueue(new Uint8Array(RC_LIMITS.responseBytes+1));controller.close();}
    })));
    await expect(provider.fetchSkills(url,now+300000,1)).rejects.toMatchObject({code:'invalid_response'});
  });
  it('refuses a passed deadline without transport and never leaks credentials',async()=>{
    const {provider,transport}=client(()=>response({}));
    await expect(provider.fetchSkills(url,now,1)).rejects.toMatchObject({code:'deadline',possiblePaid:false});
    expect(transport).not.toHaveBeenCalled();
  });
  it('detects paid CHECK or FETCH overbilling and reports only observed credits',async()=>{
    const {provider}=client(()=>response({linkedinUrl:url,skills:['AWS']},2));
    await expect(provider.check(url,now+300000)).rejects.toMatchObject({code:'credits_breach',observedCredits:2});
    await expect(provider.fetchSkills(url,now+300000,1)).rejects.toMatchObject({code:'credits_breach',observedCredits:2});
  });
  it('does not accept a non-loopback test origin',()=>{
    expect(()=>createRcProvider({apiKey:'fake',testOrigin:'https://example.invalid'})).toThrow('RC_TEST_ORIGIN_REFUSED');
  });
});
