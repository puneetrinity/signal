import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const logs=vi.hoisted(()=>({info:vi.fn(),warn:vi.fn(),error:vi.fn()}));
vi.mock('@/lib/logger',()=>({createLogger:()=>logs}));
vi.mock('../activegraph-auth', () => ({ signActiveGraphJWT: vi.fn(async () => 'test-token') }));
vi.mock('@/lib/candidate-privacy/repository', () => ({ requireHealthyCandidatePrivacyContext: vi.fn(async () => ({})) }));
vi.mock('@/lib/candidate-privacy/decision', () => ({ createCandidateAdmissionProofs: vi.fn(), requireNewCandidateAllowed: vi.fn() }));
import { createCandidateAdmissionProofs } from '@/lib/candidate-privacy/decision';
import { searchPublicGlobalPool, searchTenantPrivateCandidates, searchGlobalPool } from '../activegraph-client';
import type { JobRequirements } from '../jd-digest';
const requirements = { title: 'Engineer', topSkills: ['python'], titleSearchTerms: [] } as unknown as JobRequirements;
const ids = ['123e4567-e89b-42d3-a456-426614174000', '223e4567-e89b-42d3-a456-426614174000'];
function response(surface: 'public' | 'private') {
  return surface === 'public' ? {
    surface: 'public_v1', count: 2, applied_limit: 300,
    results: ids.map(id => ({ id, name: null, headline: null, linkedin_url: null, linkedin_id: null,
      role_family: null, seniority_band: null, skills_normalized: null, public_skills_normalized: [],
      location_city: null, location_country_code: null, similarity: 0.5, crustdata_profile: null,
      tenant_candidate_id: null, signal_candidate_id: null, evidence_surface: 'public' })),
  } : {
    surface: 'tenant_private_v1', total: 2, total_available: 2, truncated: false, applied_limit: 300,
    results: ids.map(id => ({ candidate_id: id, global_candidate_id: id, display_name: null,
      linkedin_url: null, linkedin_id: null, headline: null, location_raw: null, skills: [],
      seniority_level: null, keyword_score: 1, skill_overlap_count: 0, evidence_surface: 'tenant_private_v1' })),
  };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());
describe('Memory result privacy filtering', () => {
  it.each(['public','private'] as const)('records only bounded phase metrics for strict %s retrieval',async surface=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(response(surface)))));
    vi.mocked(createCandidateAdmissionProofs).mockResolvedValue(new Map([['1',{} as never]]));
    if(surface==='public')await searchPublicGlobalPool(requirements,'org',300,'private-request',{timeoutMs:1000});
    else await searchTenantPrivateCandidates(requirements,'org',300,'private-request',{timeoutMs:1000});
    const [metrics,message]=logs.info.mock.calls.at(-1)!;
    expect(message).toBe('Memory retrieval phase timings');
    expect(Object.keys(metrics).sort()).toEqual(['appliedLimit','bodyReadMs','networkMs','parseMs','privacyMs','requestHash','requestedLimit','returnedCount','surface'].sort());
    expect(metrics).toMatchObject({requestedLimit:300,appliedLimit:300,returnedCount:1});
    expect(metrics.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(metrics)).not.toContain('private-request');
    for(const key of ['networkMs','bodyReadMs','parseMs','privacyMs'])expect(metrics[key]).toBeGreaterThanOrEqual(0);
  });
  it.each(['public', 'private'] as const)('keeps the allowed %s result in order', async surface => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response(surface)))));
    vi.mocked(createCandidateAdmissionProofs).mockResolvedValue(new Map([['1', {} as never]]));
    const result = surface === 'public'
      ? await searchPublicGlobalPool(requirements, 'org', 300)
      : await searchTenantPrivateCandidates(requirements, 'org', 300);
    expect(result?.results).toHaveLength(1);
    expect(result?.results[0]).toMatchObject(surface === 'public' ? { id: ids[1] } : { candidateId: ids[1] });
    expect(result).toMatchObject(surface === 'public' ? { count: 1 } : { total: 1 });
  });
  it.each(['public', 'private'] as const)('makes an incomplete %s privacy response unavailable', async surface => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response(surface)))));
    vi.mocked(createCandidateAdmissionProofs).mockRejectedValue(new Error('candidate_privacy_conflict'));
    const result = surface === 'public'
      ? await searchPublicGlobalPool(requirements, 'org', 300)
      : await searchTenantPrivateCandidates(requirements, 'org', 300);
    expect(result).toBeNull();
  });
  it('does not relax the legacy lane', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [{ id: ids[0] }], count: 1, applied_limit: 300 }))));
    vi.mocked(createCandidateAdmissionProofs).mockResolvedValue(new Map());
    expect(await searchGlobalPool(requirements, 'org', 300)).toBeNull();
  });
});
