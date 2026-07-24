import { describe, expect, it } from 'vitest';
import type { JobRequirements } from '../jd-digest';
import {
  buildCanonicalQueryFingerprint,
  buildRelaxationRungs,
  selectRelaxationRung,
  type CoverageState,
} from '../relaxation-ladder';

const requirements: JobRequirements = {
  title: 'Senior Backend Engineer',
  topSkills: ['typescript', 'postgresql'],
  seniorityLevel: 'senior',
  domain: 'Software Engineering',
  roleFamily: 'backend',
  location: 'Bengaluru, India',
  experienceYears: 5,
  experienceYearsMax: null,
  education: null,
  titleSearchTerms: ['backend engineer', 'backend developer'],
  adjacentBuckets: [
    ['backend engineer', 'platform engineer'],
    ['site reliability engineer'],
  ],
  adjacentLocations: [
    { metro: 'Pune', country: 'India' },
    { metro: 'Austin', country: 'United States' },
  ],
};

const countryCode = (location: string) => {
  if (location.toLowerCase().includes('india')) return 'IN';
  if (location.toLowerCase().includes('united states')) return 'US';
  return null;
};

function select(states: CoverageState[] = []) {
  const rungs = buildRelaxationRungs(requirements, 'IN', countryCode, 8);
  return selectRelaxationRung(
    rungs,
    new Map(states.map((state) => [state.rung, state])),
    {
      enabled: true,
      requestedLimit: 300,
      saturationRatio: 0.5,
      staleBefore: new Date('2026-07-17T00:00:00.000Z'),
    },
  );
}

describe('relaxation ladder', () => {
  it('builds title, seniority, and same-country geo rungs without reusing exact titles', () => {
    const rungs = buildRelaxationRungs(requirements, 'IN', countryCode, 8);

    expect(rungs.map((rung) => rung.id)).toEqual([
      'exact',
      'adjacent_title:0',
      'adjacent_title:1',
      'seniority:+-1',
      'adjacent_geo:0',
    ]);
    expect(rungs[1]?.requirements.titleSearchTerms).toEqual(['platform engineer']);
    expect(rungs[3]?.requirements.querySeniorityLevels).toEqual(['mid', 'senior', 'lead']);
    expect(rungs[4]?.requirements.location).toBe('Pune, India');
  });

  it('keeps the first run exact', () => {
    expect(select().rung.id).toBe('exact');
    expect(select().reason).toBe('first_observation');
  });

  it('advances after a provider shortfall even without a ratio baseline', () => {
    const selected = select([{
      rung: 'exact',
      baselineTotal: null,
      baselineObservedAt: null,
      lastProviderTotal: 200,
      lastRawReturnedCount: 200,
      lastObservedAt: new Date('2026-07-24T00:00:00.000Z'),
    }]);

    expect(selected.rung.id).toBe('adjacent_title:0');
    expect(selected.reason).toBe('shortfall_saturated');
    expect(selected.saturatedRungs).toEqual([
      expect.objectContaining({ rung: 'exact', shortfall: true }),
    ]);
  });

  it('advances when known matching coverage reaches the ratio threshold', () => {
    const selected = select([{
      rung: 'exact',
      baselineTotal: 1000,
      baselineObservedAt: new Date('2026-07-24T00:00:00.000Z'),
      lastProviderTotal: 500,
      lastRawReturnedCount: 300,
      lastObservedAt: new Date('2026-07-24T00:00:00.000Z'),
    }]);

    expect(selected.rung.id).toBe('adjacent_title:0');
    expect(selected.reason).toBe('ratio_saturated');
    expect(selected.saturatedRungs).toEqual([
      expect.objectContaining({ rung: 'exact', ratio: 0.5 }),
    ]);
  });

  it('does not use stale saturation state', () => {
    const selected = select([{
      rung: 'exact',
      baselineTotal: 1000,
      baselineObservedAt: new Date('2026-07-01T00:00:00.000Z'),
      lastProviderTotal: 100,
      lastRawReturnedCount: 100,
      lastObservedAt: new Date('2026-07-01T00:00:00.000Z'),
    }]);

    expect(selected.rung.id).toBe('exact');
    expect(selected.reason).toBe('first_observation');
  });

  it('fingerprints query constraints independently of title-array order', () => {
    const reordered = {
      ...requirements,
      topSkills: ['postgresql', 'typescript'],
      titleSearchTerms: ['backend developer', 'backend engineer'],
    };
    expect(buildCanonicalQueryFingerprint(reordered)).toBe(buildCanonicalQueryFingerprint(requirements));
  });
});
