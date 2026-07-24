import { createHash } from 'crypto';
import type { JobRequirements } from './jd-digest';

export type RelaxationRungKind = 'exact' | 'adjacent_title' | 'seniority' | 'adjacent_geo';

export interface RelaxationRung {
  id: string;
  kind: RelaxationRungKind;
  requirements: JobRequirements;
  description: string;
}

export interface CoverageState {
  rung: string;
  baselineTotal: number | null;
  baselineObservedAt: Date | null;
  lastProviderTotal: number | null;
  lastRawReturnedCount: number;
  lastObservedAt: Date;
}

export interface RelaxationSelection {
  rung: RelaxationRung;
  reason: 'first_observation' | 'headroom' | 'ratio_saturated' | 'shortfall_saturated' | 'all_rungs_saturated' | 'disabled';
  saturation: {
    ratio: number | null;
    shortfall: boolean;
    baselineFresh: boolean;
  };
  saturatedRungs: Array<{
    rung: string;
    ratio: number | null;
    shortfall: boolean;
    baselineFresh: boolean;
  }>;
}

const SENIORITY_ORDER = ['entry', 'mid', 'senior', 'lead', 'executive'];

function uniqueTitleTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  return terms.filter((term) => {
    const normalized = term.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function buildCanonicalQueryFingerprint(requirements: JobRequirements): string {
  const input = {
    title: requirements.title?.trim().toLowerCase() ?? null,
    topSkills: [...requirements.topSkills].map((skill) => skill.toLowerCase()).sort(),
    seniorityLevel: requirements.seniorityLevel?.trim().toLowerCase() ?? null,
    location: requirements.location?.trim().toLowerCase() ?? null,
    titleSearchTerms: uniqueTitleTerms(requirements.titleSearchTerms).sort(),
    adjacentBuckets: requirements.adjacentBuckets.map((bucket) => uniqueTitleTerms(bucket).sort()),
    adjacentLocations: requirements.adjacentLocations
      .map((location) => ({ metro: location.metro.trim().toLowerCase(), country: location.country.trim().toLowerCase() }))
      .sort((a, b) => `${a.country}|${a.metro}`.localeCompare(`${b.country}|${b.metro}`)),
  };
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function adjacentSeniorityLevels(seniorityLevel: string | null): string[] {
  if (!seniorityLevel) return [];
  const index = SENIORITY_ORDER.indexOf(seniorityLevel.trim().toLowerCase());
  if (index < 0) return [];

  return [SENIORITY_ORDER[index - 1], SENIORITY_ORDER[index], SENIORITY_ORDER[index + 1]]
    .filter((level): level is string => Boolean(level));
}

/**
 * Builds the only query variants the ladder may buy. The caller keeps the
 * original requirements for ranking; these overrides affect Crustdata only.
 */
export function buildRelaxationRungs(
  requirements: JobRequirements,
  originalCountryCode: string | null,
  countryCodeForLocation: (location: string) => string | null,
  maxRungs: number,
): RelaxationRung[] {
  const rungs: RelaxationRung[] = [{
    id: 'exact',
    kind: 'exact',
    requirements,
    description: 'exact job segment',
  }];

  for (const [index, bucket] of requirements.adjacentBuckets.entries()) {
    const titles = uniqueTitleTerms(bucket).filter((title) => !requirements.titleSearchTerms.includes(title));
    if (titles.length === 0) continue;
    rungs.push({
      id: `adjacent_title:${index}`,
      kind: 'adjacent_title',
      requirements: { ...requirements, titleSearchTerms: titles },
      description: `adjacent titles: ${titles.join(', ')}`,
    });
  }

  const seniorityLevels = adjacentSeniorityLevels(requirements.seniorityLevel);
  if (seniorityLevels.length > 1) {
    rungs.push({
      id: 'seniority:+-1',
      kind: 'seniority',
      requirements: { ...requirements, querySeniorityLevels: seniorityLevels },
      description: `seniority band: ${seniorityLevels.join(', ')}`,
    });
  }

  if (originalCountryCode) {
    for (const [index, location] of requirements.adjacentLocations.entries()) {
      if (countryCodeForLocation(location.country) !== originalCountryCode) continue;
      rungs.push({
        id: `adjacent_geo:${index}`,
        kind: 'adjacent_geo',
        requirements: { ...requirements, location: `${location.metro}, ${location.country}` },
        description: `adjacent metro: ${location.metro}, ${location.country}`,
      });
    }
  }

  return rungs.slice(0, Math.max(1, maxRungs));
}

export function selectRelaxationRung(
  rungs: RelaxationRung[],
  states: Map<string, CoverageState>,
  options: {
    enabled: boolean;
    requestedLimit: number;
    saturationRatio: number;
    staleBefore: Date;
  },
): RelaxationSelection {
  const exact = rungs[0]!;
  if (!options.enabled || rungs.length === 1) {
    return {
      rung: exact,
      reason: 'disabled',
      saturation: { ratio: null, shortfall: false, baselineFresh: false },
      saturatedRungs: [],
    };
  }

  const saturatedRungs: RelaxationSelection['saturatedRungs'] = [];
  for (const rung of rungs) {
    const state = states.get(rung.id);
    if (!state || state.lastObservedAt < options.staleBefore) {
      return {
        rung,
        reason: saturatedRungs.length === 0
          ? 'first_observation'
          : saturatedRungs[saturatedRungs.length - 1]!.shortfall
            ? 'shortfall_saturated'
            : 'ratio_saturated',
        saturation: { ratio: null, shortfall: false, baselineFresh: false },
        saturatedRungs,
      };
    }

    const baselineFresh = Boolean(
      state.baselineTotal != null &&
      state.baselineObservedAt &&
      state.baselineObservedAt >= options.staleBefore,
    );
    const ratio = baselineFresh && state.lastProviderTotal != null && state.baselineTotal! > 0
      ? Math.max(0, Math.min(1, (state.baselineTotal! - state.lastProviderTotal) / state.baselineTotal!))
      : null;
    const shortfall = state.lastRawReturnedCount < options.requestedLimit;
    const saturatedByRatio = ratio != null && ratio >= options.saturationRatio;

    if (!saturatedByRatio && !shortfall) {
      return {
        rung,
        reason: 'headroom',
        saturation: { ratio, shortfall, baselineFresh },
        saturatedRungs,
      };
    }
    saturatedRungs.push({ rung: rung.id, ratio, shortfall, baselineFresh });
  }

  const finalRung = rungs[rungs.length - 1]!;
  const finalState = states.get(finalRung.id);
  return {
    rung: finalRung,
    reason: 'all_rungs_saturated',
    saturation: {
      ratio: finalState?.baselineTotal != null && finalState.lastProviderTotal != null && finalState.baselineTotal > 0
        ? Math.max(0, Math.min(1, (finalState.baselineTotal - finalState.lastProviderTotal) / finalState.baselineTotal))
        : null,
      shortfall: (finalState?.lastRawReturnedCount ?? 0) < options.requestedLimit,
      baselineFresh: Boolean(finalState?.baselineObservedAt && finalState.baselineObservedAt >= options.staleBefore),
    },
    saturatedRungs,
  };
}
