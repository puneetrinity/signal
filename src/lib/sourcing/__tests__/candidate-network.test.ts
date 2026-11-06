import {describe,it,expect,vi,afterEach} from 'vitest';
import {deduplicateNetworkHits,deduplicateNetworkAgainstProviders,networkHitSchema,networkSourcingEnabled,revalidatedNetworkHits} from '../candidate-network';
import {rankingHash,createRankingContract} from '../rubric/contracts';
import {adaptNetworkPublication,evidenceSchema,selectEmployment} from '../rubric/evidence';
import {scoreEvidence,relevantWorkSources} from '../rubric/score';
vi.mock('../activegraph-auth',()=>({signActiveGraphJWT:vi.fn().mockResolvedValue('test-token')}));
vi.mock('@/lib/candidate-privacy/repository',()=>({requireHealthyCandidatePrivacyContext:vi.fn().mockResolvedValue(undefined)}));
vi.mock('@/lib/candidate-privacy/decision',()=>({createCandidateAdmissionProofs:vi.fn(async (anchors:{key:string}[])=>new Map(anchors.map(a=>[a.key,{}])))}));
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

export function networkFixture(){
  const facts={displayName:'José',headline:'Engineer',currentLocation:{city:'Bengaluru',countryCode:'IN',displayCountry:'India'},
    skills:['Python'],employment:[],education:[]};
  return {kind:'candidate_network' as const,identity:'network:11111111-1111-4111-8111-111111111111',
    subjectId:'11111111-1111-4111-8111-111111111111',publicationId:'22222222-2222-4222-8222-222222222222',
    globalCandidateId:'33333333-3333-4333-8333-333333333333',profileVersion:1,preferenceVersion:1,consentRevision:1,
    contentHash:rankingHash(facts),encoderVersion:1 as const,observedAt:'2026-11-03T00:00:00Z',facts,similarity:0.8};
}
describe('native network sourcing',()=>{
  const checked=(hits:ReturnType<typeof networkFixture>[],url='https://linkedin.com/in/John-Doe')=>revalidatedNetworkHits(hits,{
    schemaVersion:1,publications:hits.map(({subjectId,publicationId,profileVersion,preferenceVersion,consentRevision,contentHash})=>
      ({subjectId,publicationId,profileVersion,preferenceVersion,consentRevision,contentHash})),
    resultKeys:hits.map(({subjectId,publicationId,profileVersion,preferenceVersion,consentRevision,contentHash})=>
      ({subjectId,publicationId,profileVersion,preferenceVersion,consentRevision,contentHash,linkedinUrl:url})),
  });
  it('reuses public identity normalization without merging or serializing comparison evidence',()=>{
    const hit=networkFixture(),validated=checked([hit]);
    const providers=[{linkedinUrl:'https://www.linkedin.com/in/john-doe/'}];
    expect(deduplicateNetworkAgainstProviders(validated,providers)).toEqual([]);
    expect(deduplicateNetworkAgainstProviders([hit],providers)).toEqual([hit]);
    expect(deduplicateNetworkAgainstProviders(validated,[{linkedinUrl:'https://linkedin.com/in/other'}])).toEqual(validated);
    expect(JSON.stringify(validated)).not.toContain('linkedin.com');
    expect(providers).toEqual([{linkedinUrl:'https://www.linkedin.com/in/john-doe/'}]);
  });
  it('does not collapse ambiguous claims or provider aliases',()=>{
    const first=networkFixture(),second={...first,subjectId:'44444444-4444-4444-8444-444444444444',
      identity:'network:44444444-4444-4444-8444-444444444444',publicationId:'55555555-5555-4555-8555-555555555555'};
    const providers=[{linkedinUrl:'https://linkedin.com/in/john-doe'}];
    expect(deduplicateNetworkAgainstProviders(checked([first,second]),providers)).toHaveLength(2);
    expect(deduplicateNetworkAgainstProviders(checked([first]),[...providers,...providers])).toHaveLength(1);
  });
  it('never reuses a comparison key from a previous validation',()=>{
    const hit=checked([networkFixture()])[0];
    const {subjectId,publicationId,profileVersion,preferenceVersion,consentRevision,contentHash}=hit;
    const next=revalidatedNetworkHits([hit],{schemaVersion:1,publications:[{subjectId,publicationId,profileVersion,preferenceVersion,consentRevision,contentHash}]});
    expect(deduplicateNetworkAgainstProviders(next,[{linkedinUrl:'https://linkedin.com/in/john-doe'}])).toHaveLength(1);
  });
  it('refuses a comparison receipt for another profile revision or withdrawn publication',()=>{
    const hit=networkFixture(),{subjectId,publicationId,profileVersion,preferenceVersion,consentRevision,contentHash}=hit;
    const authority={subjectId,publicationId,profileVersion,preferenceVersion,consentRevision,contentHash};
    for(const publications of [[],[authority]])expect(()=>revalidatedNetworkHits([hit],{schemaVersion:1,publications,
      resultKeys:[{...authority,profileVersion:2,linkedinUrl:'https://linkedin.com/in/john-doe'}]})).toThrow('NETWORK_AUTHORITY_CONFLICT');
  });
  it('is default off and refuses malformed configuration',()=>{
    expect(networkSourcingEnabled({})).toBe(false);
    expect(networkSourcingEnabled({CANDIDATE_NETWORK_SOURCING_ENABLED:'true'})).toBe(true);
    expect(()=>networkSourcingEnabled({CANDIDATE_NETWORK_SOURCING_ENABLED:'1'})).toThrow();
  });
  it('needs neither LinkedIn nor a fabricated provider blob',()=>{
    const hit=networkHitSchema.parse(networkFixture());
    expect(hit).not.toHaveProperty('linkedinUrl');expect(hit).not.toHaveProperty('crustdata_profile');
  });
  it.each(['email','phone','photoUrl','preferences','applicationId','resumeUrl'])('refuses extra %s',field=>{
    const hit=networkFixture();const facts={...hit.facts,[field]:'private'};
    expect(()=>networkHitSchema.parse({...hit,facts,contentHash:rankingHash(facts)})).toThrow();
  });
  it('refuses contact text even with a matching fingerprint',()=>{
    const hit=networkFixture();const facts={...hit.facts,headline:'Email me at private@example.test'};
    expect(()=>networkHitSchema.parse({...hit,facts,contentHash:rankingHash(facts)})).toThrow();
  });
  it('deduplicates exact native identity only',()=>{
    const hit=networkFixture();expect(deduplicateNetworkHits([hit,hit])).toEqual([hit]);
    expect(()=>deduplicateNetworkHits([hit,{...hit,consentRevision:2}])).toThrow('NETWORK_PUBLICATION_CONFLICT');
    expect(()=>deduplicateNetworkHits([hit,{...hit,identity:'network:44444444-4444-4444-8444-444444444444',subjectId:'44444444-4444-4444-8444-444444444444'}])).toThrow('NETWORK_IDENTITY_CONFLICT');
  });
  it('keeps same-name unverified identities separate',()=>{
    const hit=networkFixture();const second={...hit,identity:'network:44444444-4444-4444-8444-444444444444',
      subjectId:'44444444-4444-4444-8444-444444444444',publicationId:'55555555-5555-4555-8555-555555555555',globalCandidateId:'66666666-6666-4666-8666-666666666666'};
    expect(deduplicateNetworkHits([hit,second])).toHaveLength(2);
  });
  it('drops withdrawn authority and refuses substituted receipts',()=>{
    const hit=networkFixture();const authority={subjectId:hit.subjectId,publicationId:hit.publicationId,
      profileVersion:1,preferenceVersion:1,consentRevision:1,contentHash:hit.contentHash};
    expect(revalidatedNetworkHits([hit],{schemaVersion:1,publications:[authority]})).toEqual([hit]);
    expect(revalidatedNetworkHits([hit],{schemaVersion:1,publications:[]})).toEqual([]);
    expect(()=>revalidatedNetworkHits([hit],{schemaVersion:1,publications:[{...authority,consentRevision:2}]})).toThrow();
  });
});

describe('native Memory transport',()=>{
  it('revalidates exact receipts with one signed request and no redirects',async()=>{
    vi.stubEnv('CANDIDATE_NETWORK_SOURCING_ENABLED','true');
    const hit=networkFixture();
    const {subjectId,publicationId,profileVersion,preferenceVersion,consentRevision,contentHash}=hit;
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({schemaVersion:1,
      publications:[{subjectId,publicationId,profileVersion,preferenceVersion,consentRevision,contentHash}]})));
    vi.stubGlobal('fetch',fetch);
    const {validateNetworkPublications}=await import('../activegraph-client');
    expect(await validateNetworkPublications([hit],'org_1')).toEqual([hit]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({redirect:'error',headers:{Authorization:'Bearer test-token'}});
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({publicationIds:[hit.publicationId],includeResultKeys:true});
  });
  it.each([401,403,422,429,503])('does not retry an upstream %s',async status=>{
    vi.stubEnv('CANDIDATE_NETWORK_SOURCING_ENABLED','true');
    const fetch=vi.fn().mockResolvedValue(new Response('',{status}));vi.stubGlobal('fetch',fetch);
    const {validateNetworkPublications}=await import('../activegraph-client');
    await expect(validateNetworkPublications([networkFixture()],'org_1')).rejects.toThrow('MEMORY_RETRIEVAL');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not fetch while disabled',async()=>{
    vi.stubEnv('CANDIDATE_NETWORK_SOURCING_ENABLED','false');
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    const {validateNetworkPublications}=await import('../activegraph-client');
    await expect(validateNetworkPublications([networkFixture()],'org_1')).rejects.toThrow('CONFIGURATION');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['{"schemaVersion":1,"publications":[]}\u0000','\ufffd'])('refuses malformed body %s',async body=>{
    vi.stubEnv('CANDIDATE_NETWORK_SOURCING_ENABLED','true');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(body)));
    const {validateNetworkPublications}=await import('../activegraph-client');
    await expect(validateNetworkPublications([networkFixture()],'org_1')).rejects.toThrow('INVALID_CONTRACT');
  });
});

describe('native evidence uses the existing scorer',()=>{
  const contract=(kinds:string[])=>createRankingContract('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a'.repeat(64),{
    schemaVersion:4,compilerVersion:4,taxonomyVersion:4,criteria:[{
      id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',label:'Python',class:'must_have',subject:'skill',
      requirement:{kind:'accepted_skills',primary:'Python',alternatives:[]},evidenceKinds:kinds,
      use:'assessment',provenance:{kind:'recruiter_edit'},
    }],
  });
  it('honours candidate-provided versus provider evidence permissions',()=>{
    const evidence=adaptNetworkPublication('local-id','1',networkFixture());
    expect(scoreEvidence(contract(['candidate_provided']),evidence,'2026-11-04T00:00:00Z').N).toBe(3);
    expect(scoreEvidence(contract(['profile_evidence']),evidence,'2026-11-04T00:00:00Z').N).toBe(0);
    expect(evidence.facts.every(f=>f.kind==='candidate_provided'&&f.scope==='public')).toBe(true);
    expect(evidence.facts.some(f=>f.value.includes('josé')||f.value==='engineer')).toBe(false);
  });
  it('binds public candidate-provided dates to the native publication only',()=>{
    const raw=networkFixture();
    const facts={...raw.facts,employment:[{employer:'Acme',title:'Developer',
      start:{value:'2020-01',precision:'month' as const},end:{value:'2025-01',precision:'month' as const},current:false}]};
    const evidence=adaptNetworkPublication('local-id','1',{...raw,facts,contentHash:rankingHash(facts)});
    expect(selectEmployment(evidence,['candidate_provided'],'2026-11-04T00:00:00Z').ref).toBe('network.employment');
    expect(relevantWorkSources(evidence,['candidate_provided'],'2026-11-04T00:00:00Z')[0].ref).toBe('network.employment');
    expect(selectEmployment(evidence,['profile_evidence'],'2026-11-04T00:00:00Z').intervals).toEqual([]);
    const {networkIdentity,...unbound}=evidence as typeof evidence&{networkIdentity:unknown};
    expect(networkIdentity).toBeTruthy();expect(evidenceSchema.safeParse(unbound).success).toBe(false);
    expect(evidenceSchema.safeParse({...evidence,networkIdentity:{...(networkIdentity as object),consentRevision:0}}).success).toBe(false);
  });
});
