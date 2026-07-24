import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobRequirements } from '../jd-digest';

const requirements: JobRequirements = {
  title: 'Senior Backend Engineer',
  topSkills: ['typescript'],
  seniorityLevel: 'senior',
  domain: 'Software Engineering',
  roleFamily: 'backend',
  location: 'Pune, India',
  experienceYears: 5,
  experienceYearsMax: null,
  education: null,
  titleSearchTerms: ['platform engineer'],
  adjacentBuckets: [],
  adjacentLocations: [],
  querySeniorityLevels: ['mid', 'senior', 'lead'],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Crustdata search contract', () => {
  it('returns provider totals while applying the ladder query overrides', async () => {
    vi.stubEnv('CRUSTDATA_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_count: 640,
        profiles: [
          { social_handles: { professional_network_identifier: { profile_url: 'https://linkedin.com/in/alice' } } },
          { social_handles: { professional_network_identifier: { profile_url: 'https://linkedin.com/in/alice' } } },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { searchPeople } = await import('../crustdata-client');
    const result = await searchPeople(requirements, 300, { excludePersonIds: [1, 2] });

    expect(result).toMatchObject({
      providerTotal: 640,
      rawReturnedCount: 2,
      requestedLimit: 300,
    });
    expect(result.profiles).toHaveLength(1);

    const request = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as {
      filters: { conditions: Array<{ field?: string; conditions?: Array<{ field: string; value: unknown }> }> };
    };
    const conditions = request.filters.conditions;
    const titleGroup = conditions.find((condition) => condition.conditions?.[0]?.field === 'experience.employment_details.current.title');
    expect(titleGroup?.conditions?.map((condition) => condition.value)).toEqual(['platform engineer']);
    const seniorityGroup = conditions.find((condition) => condition.conditions?.[0]?.field === 'experience.employment_details.current.seniority_level');
    expect(seniorityGroup?.conditions?.map((condition) => condition.value)).toEqual(
      expect.arrayContaining(['Entry Level', 'Senior', 'Manager', 'Director']),
    );
  });
});
