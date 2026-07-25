import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobRequirements } from '../jd-digest';

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
  });
});
