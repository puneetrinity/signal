import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobRequirements } from '../jd-digest';
const capacity=vi.hoisted(()=>vi.fn().mockResolvedValue(undefined));
vi.mock('../crustdata-rate-gate',async original=>({...await original<typeof import('../crustdata-rate-gate')>(),acquireCrustdataAccountCapacity:capacity}));

const requirements: JobRequirements = {
  title: 'Backend Engineer',
  topSkills: ['python'],
  seniorityLevel: 'senior',
  domain: 'software',
  roleFamily: 'backend',
  location: 'Bengaluru, India',
  experienceYears: null,
  experienceYearsMax: null,
  education: null,
  titleSearchTerms: ['backend engineer'],
  adjacentBuckets: [],
  adjacentLocations: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  capacity.mockReset().mockResolvedValue(undefined);
});

describe('Crustdata person search result contract', () => {
  it('returns provider total and raw count separately from deduplicated profiles', async () => {
    vi.stubEnv('CRUSTDATA_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_count: 297,
        profiles: [
          {
            crustdata_person_id: 101,
            social_handles: {
              professional_network_identifier: {
                profile_url: 'https://linkedin.com/in/alice',
              },
            },
          },
          {
            crustdata_person_id: 101,
            social_handles: {
              professional_network_identifier: {
                profile_url: 'https://linkedin.com/in/alice',
              },
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { searchPeople } = await import('../crustdata-client');
    const result = await searchPeople(requirements, 300, {
      excludePersonIds: [7, 8],
    });

    expect(result.providerTotal).toBe(297);
    expect(result.rawReturnedCount).toBe(2);
    expect(result.requestedLimit).toBe(300);
    expect(result.profiles).toHaveLength(1);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.limit).toBe(300);
    expect(JSON.stringify(request.filters)).toContain('not_in');
    expect(capacity).toHaveBeenCalledTimes(1);
    expect(capacity.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('redirect');
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });
  it('does not dispatch if shared capacity cannot be established',async()=>{
    vi.stubEnv('CRUSTDATA_API_KEY','test-key');capacity.mockRejectedValue(Error('CRUSTDATA_RATE_UNAVAILABLE'));
    const transport=vi.fn();vi.stubGlobal('fetch',transport);
    const {searchPeople}=await import('../crustdata-client');
    await expect(searchPeople(requirements)).rejects.toThrow('CRUSTDATA_NO_DISPATCH');
    expect(transport).not.toHaveBeenCalled();
  });
  it('applies bounded transport only to governed calls and rechecks immediately before dispatch',async()=>{
    vi.stubEnv('CRUSTDATA_API_KEY','test-key');
    const transport=vi.fn().mockResolvedValue({ok:true,json:async()=>({profiles:[],total_count:0})});vi.stubGlobal('fetch',transport);
    const {searchPeople}=await import('../crustdata-client');
    const beforeDispatch=vi.fn().mockResolvedValue(undefined);
    await searchPeople(requirements,300,{governed:true,capacityAcquired:true,beforeDispatch});
    expect(capacity).not.toHaveBeenCalled();expect(beforeDispatch.mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[0]);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({redirect:'error',signal:expect.any(AbortSignal)});
    beforeDispatch.mockRejectedValueOnce(Error('grant expired'));
    await expect(searchPeople(requirements,300,{governed:true,capacityAcquired:true,beforeDispatch})).rejects.toThrow('CRUSTDATA_NO_DISPATCH');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
