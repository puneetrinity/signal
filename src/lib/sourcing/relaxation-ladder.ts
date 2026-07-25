import { createHash } from 'crypto';
import type { JobRequirements } from './jd-digest';

export type RelaxationRungKind =
  | 'exact'
  | 'adjacent_title'
  | 'seniority'
  | 'adjacent_geo';

export interface RelaxationRung {
  id: string;
  kind: RelaxationRungKind;
  requirements: JobRequirements;
  description: string;
}

export interface RelaxationState {
  activeRung: string | null;
  shortfallStreak: number;
  lastExactProviderTotal: number | null;
  lastExactRequestedLimit: number;
  lastProviderTotal: number | null;
  lastRequestedLimit: number;
  lastSpillObservedAt: Date | null;
  lastObservedAt: Date;
}

const SENIORITY_ORDER = ['entry', 'mid', 'senior', 'lead', 'executive'];

function normalizeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  return terms
    .map((term) => term.trim().toLowerCase())
    .filter((term) => {
      if (!term || seen.has(term)) return false;
      seen.add(term);
      return true;
    });
}

/**
 * Fine key for one exact Crustdata query shape. It intentionally includes the
 * complete digest-derived filter set. Cross-org sharing uses a separate coarse
 * market key in #12, not this ladder key.
 */
export function buildFineQueryFingerprint(
  requirements: JobRequirements,
): string {
  const input = {
    title: requirements.title?.trim().toLowerCase() ?? null,
    topSkills: normalizeTerms(requirements.topSkills).sort(),
    seniorityLevel: requirements.seniorityLevel?.trim().toLowerCase() ?? null,
    location: requirements.location?.trim().toLowerCase() ?? null,
    titleSearchTerms: normalizeTerms(requirements.titleSearchTerms).sort(),
    adjacentBuckets: requirements.adjacentBuckets.map((bucket) =>
      normalizeTerms(bucket).sort(),
    ),
    adjacentLocations: requirements.adjacentLocations
      .map((location) => ({
        metro: location.metro.trim().toLowerCase(),
        country: location.country.trim().toLowerCase(),
      }))
      .sort((a, b) =>
        `${a.country}|${a.metro}`.localeCompare(`${b.country}|${b.metro}`),
      ),
  };
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function adjacentSeniorityLevels(seniorityLevel: string | null): string[] {
  if (!seniorityLevel) return [];
  const index = SENIORITY_ORDER.indexOf(seniorityLevel.trim().toLowerCase());
  if (index < 0) return [];

  return [
    SENIORITY_ORDER[index - 1],
    SENIORITY_ORDER[index],
    SENIORITY_ORDER[index + 1],
  ].filter((level): level is string => Boolean(level));
}

/**
 * Build the only markets the ladder may explore. These requirements are for
 * Crustdata retrieval only; ranking always receives the original job.
 */
export function buildRelaxationRungs(
  requirements: JobRequirements,
  originalCountryCode: string | null,
  countryCodeForLocation: (location: string) => string | null,
  maxRungs: number,
): RelaxationRung[] {
  const rungs: RelaxationRung[] = [
    {
      id: 'exact',
      kind: 'exact',
      requirements,
      description: 'exact job segment',
    },
  ];

  const exactTitles = new Set(normalizeTerms(requirements.titleSearchTerms));
  for (const [index, bucket] of requirements.adjacentBuckets.entries()) {
    const titles = normalizeTerms(bucket).filter(
      (title) => !exactTitles.has(title),
    );
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
      if (countryCodeForLocation(location.country) !== originalCountryCode)
        continue;
      rungs.push({
        id: `adjacent_geo:${index}`,
        kind: 'adjacent_geo',
        requirements: {
          ...requirements,
          location: `${location.metro}, ${location.country}`,
        },
        description: `adjacent metro: ${location.metro}, ${location.country}`,
      });
    }
  }

  return rungs.slice(0, Math.max(1, maxRungs));
}

/**
 * The exact query is never selected here: it runs before every spill decision.
 * The active rung is advanced only after it has repeatedly confirmed a
 * provider shortfall. A run can use this one adjacent rung only.
 */
export function selectSpillRung(
  rungs: RelaxationRung[],
  state: RelaxationState | null,
  enabled: boolean,
): RelaxationRung | null {
  if (!enabled) return null;
  const adjacentRungs = rungs.slice(1);
  if (adjacentRungs.length === 0) return null;
  return (
    adjacentRungs.find((rung) => rung.id === state?.activeRung) ??
    adjacentRungs[0]!
  );
}

export function isProviderShortfall(
  providerTotal: number | null,
  requestedLimit: number,
): boolean {
  return providerTotal !== null && providerTotal < requestedLimit;
}

export function nextShortfallStreak(
  previous: RelaxationState | null,
  providerTotal: number | null,
  requestedLimit: number,
  staleBefore: Date,
): number {
  if (!isProviderShortfall(providerTotal, requestedLimit)) return 0;
  if (
    !previous?.lastSpillObservedAt ||
    previous.lastSpillObservedAt < staleBefore
  )
    return 1;
  return previous.shortfallStreak + 1;
}

export function nextActiveRungId(
  rungs: RelaxationRung[],
  currentRungId: string,
): string {
  const index = rungs.findIndex((rung) => rung.id === currentRungId);
  if (index < 1 || index >= rungs.length - 1) return currentRungId;
  return rungs[index + 1]!.id;
}
