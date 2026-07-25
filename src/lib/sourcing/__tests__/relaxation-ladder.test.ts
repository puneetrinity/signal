import { describe, expect, it } from 'vitest';
import { parseJdDigest, type JobRequirements } from '../jd-digest';
import {
  buildFineQueryFingerprint,
  buildRelaxationRungs,
  isProviderShortfall,
  nextActiveRungId,
  nextShortfallStreak,
  selectSpillRung,
  type RelaxationState,
} from '../relaxation-ladder';

const requirements: JobRequirements = {
  title: 'Senior Backend Python Engineer',
  topSkills: ['python', 'django'],
  seniorityLevel: 'senior',
  domain: 'software',
  roleFamily: 'backend',
  location: 'Bengaluru, India',
  experienceYears: 5,
  experienceYearsMax: null,
  education: null,
  titleSearchTerms: ['backend engineer', 'python developer'],
  adjacentBuckets: [['django developer', 'backend developer']],
  adjacentLocations: [
    { metro: 'Hyderabad', country: 'India' },
    { metro: 'Austin', country: 'United States' },
  ],
};

const countryCodeForLocation = (value: string): string | null => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'india') return 'IN';
  if (normalized === 'united states') return 'US';
  return null;
};

function buildRungs() {
  return buildRelaxationRungs(requirements, 'IN', countryCodeForLocation, 8);
}

function state(
  activeRung: string | null,
  shortfallStreak = 0,
): RelaxationState {
  return {
    activeRung,
    shortfallStreak,
    lastExactProviderTotal: 200,
    lastExactRequestedLimit: 300,
    lastProviderTotal: 50,
    lastRequestedLimit: 100,
    lastSpillObservedAt: new Date('2026-07-25T00:00:00.000Z'),
    lastObservedAt: new Date('2026-07-25T00:00:00.000Z'),
  };
}

describe('capacity-fill relaxation ladder', () => {
  it('parses Flow v3 adjacency fields and safely drops malformed values', () => {
    const parsed = parseJdDigest(
      JSON.stringify({
        topSkills: ['python'],
        adjacentBuckets: [['Django Developer', ''], 'not-a-bucket'],
        adjacentLocations: [
          { metro: 'Hyderabad', country: 'India' },
          { metro: '', country: 'India' },
        ],
      }),
    );

    expect(parsed.adjacentBuckets).toEqual([['django developer']]);
    expect(parsed.adjacentLocations).toEqual([
      { metro: 'Hyderabad', country: 'India' },
    ]);
  });

  it('builds exact first, then title, seniority, and same-country geo rungs', () => {
    const rungs = buildRungs();

    expect(rungs.map((rung) => rung.id)).toEqual([
      'exact',
      'adjacent_title:0',
      'seniority:+-1',
      'adjacent_geo:0',
    ]);
    expect(rungs[1]?.requirements.titleSearchTerms).toEqual([
      'django developer',
      'backend developer',
    ]);
    expect(rungs[2]?.requirements.querySeniorityLevels).toEqual([
      'mid',
      'senior',
      'lead',
    ]);
    expect(rungs[3]?.requirements.location).toBe('Hyderabad, India');
    expect(rungs.some((rung) => rung.description.includes('Austin'))).toBe(
      false,
    );
  });

  it('uses only the current adjacent rung; exact never becomes a spill', () => {
    const rungs = buildRungs();

    expect(selectSpillRung(rungs, null, true)?.id).toBe('adjacent_title:0');
    expect(selectSpillRung(rungs, state('seniority:+-1'), true)?.id).toBe(
      'seniority:+-1',
    );
    expect(selectSpillRung(rungs, state('adjacent_geo:0'), true)?.id).toBe(
      'adjacent_geo:0',
    );
    expect(selectSpillRung(rungs, state('missing-rung'), true)?.id).toBe(
      'adjacent_title:0',
    );
    expect(selectSpillRung(rungs, state('seniority:+-1'), false)).toBeNull();
  });

  it('uses the provider post-exclusion total, not mapped result count, for depletion', () => {
    expect(isProviderShortfall(299, 300)).toBe(true);
    expect(isProviderShortfall(300, 300)).toBe(false);
    expect(isProviderShortfall(700, 300)).toBe(false);
    expect(isProviderShortfall(null, 300)).toBe(false);
  });

  it('advances an adjacent rung only after a persistent shortfall', () => {
    const rungs = buildRungs();
    const staleBefore = new Date('2026-07-24T00:00:00.000Z');
    const first = nextShortfallStreak(null, 99, 100, staleBefore);
    const second = nextShortfallStreak(
      state('adjacent_title:0', first),
      99,
      100,
      staleBefore,
    );

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(nextActiveRungId(rungs, 'adjacent_title:0')).toBe('seniority:+-1');
    expect(nextActiveRungId(rungs, 'adjacent_geo:0')).toBe('adjacent_geo:0');
  });

  it('resets a depletion streak when the active rung can fill its requested capacity', () => {
    const staleBefore = new Date('2026-07-24T00:00:00.000Z');
    expect(
      nextShortfallStreak(state('adjacent_title:0', 1), 100, 100, staleBefore),
    ).toBe(0);
  });

  it('uses a stable fine fingerprint despite input ordering', () => {
    const reordered: JobRequirements = {
      ...requirements,
      topSkills: ['django', 'python'],
      titleSearchTerms: ['python developer', 'backend engineer'],
      adjacentLocations: [...requirements.adjacentLocations].reverse(),
    };

    expect(buildFineQueryFingerprint(reordered)).toBe(
      buildFineQueryFingerprint(requirements),
    );
  });
});
