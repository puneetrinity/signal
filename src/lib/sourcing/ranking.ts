import type { JobRequirements } from './jd-digest';
import { canonicalizeSkill, getSkillSurfaceForms, buildSkillMatchSet, hasRequiredContext } from './jd-digest';
import type { JobTrack } from './types';
import { isNoisyHint, PLACEHOLDER_HINTS } from './hint-sanitizer';
import { SENIORITY_LADDER, normalizeSeniorityFromText, seniorityDistance, type SeniorityBand } from '@/lib/taxonomy/seniority';
import {
  resolveRoleDeterministic,
  adjacencyMap,
  type RoleResolution,
} from '@/lib/taxonomy/role-service';
import {
  canonicalizeLocation as canonicalizeLocationDeterministic,
  isMeaningfulLocation as isMeaningfulLocationDeterministic,
  extractPrimaryCity as extractPrimaryCityDeterministic,
  hasCountryTokenOverlap as hasCountryTokenOverlapDeterministic,
  resolveLocationDeterministic,
  type LocationResolution,
} from '@/lib/taxonomy/location-service';

export interface CandidateForRanking {
  id: string;
  headlineHint: string | null;
  seniorityHint?: string | null;
  locationHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
  enrichmentStatus: string;
  lastEnrichedAt: Date | null;
  snapshot?: {
    skillsNormalized: string[];
    roleType: string | null;
    seniorityBand: string | null;
    location: string | null;
    activityRecencyDays?: number | null;
    computedAt: Date;
    staleAfter: Date;
  } | null;
}

export type LocationMatchType = 'city_exact' | 'city_alias' | 'country_only' | 'unknown_location' | 'none';

/** Location match types that represent a confirmed geographic signal. */
export const STRONG_LOCATION_TYPES = new Set<LocationMatchType>(['city_exact', 'city_alias', 'country_only']);
export type MatchTier = 'strict_location' | 'expanded_location';

export interface FitBreakdown {
  skillScore: number;
  skillScoreMethod: 'snapshot' | 'text_fallback';
  roleScore: number;
  seniorityScore: number;
  activityFreshnessScore: number;
  locationBoost: number;
  unknownLocationPromotion?: boolean;
}

export interface ScoredCandidate {
  candidateId: string;
  fitScore: number;
  fitBreakdown: FitBreakdown;
  matchTier: MatchTier;
  locationMatchType: LocationMatchType;
}

export function compareFitWithConfidence(a: ScoredCandidate, b: ScoredCandidate, epsilon: number): number {
  const delta = b.fitScore - a.fitScore;
  if (Math.abs(delta) >= epsilon) return delta;

  // Within epsilon: prefer snapshot-scored (higher confidence) over text fallback
  const confA = a.fitBreakdown.skillScoreMethod === 'snapshot' ? 1 : 0;
  const confB = b.fitBreakdown.skillScoreMethod === 'snapshot' ? 1 : 0;
  if (confA !== confB) return confB - confA;

  // Deterministic tie-breaker: stable ordering across runs
  if (a.candidateId < b.candidateId) return -1;
  if (a.candidateId > b.candidateId) return 1;
  return 0;
}

// Location-specific noise patterns (shared isNoisyHint already covers
// linkedin, view…profile, URLs, www — only location-stricter checks here)
const LOCATION_NOISE_PATTERNS: RegExp[] = [
  /\bprofessional community\b/i,
  /\beducation:/i,
  /\bexperience:/i,
  /\.com\b/i,
  /\.org\b/i,
];

// Shared placeholders + location-specific extras (e.g. dots, "not specified")
const LOCATION_PLACEHOLDERS = new Set([
  ...PLACEHOLDER_HINTS,
  '.',
  '..',
  'n a',
  'not specified',
]);

const COUNTRY_TOKENS = new Set([
  'india',
  'usa',
  'us',
  'united',
  'states',
  'uk',
  'kingdom',
  'canada',
  'australia',
  'germany',
  'france',
]);

export function canonicalizeLocation(text: string): string {
  return canonicalizeLocationDeterministic(text);
}

function isMeaningfulNormalizedLocation(normalized: string): boolean {
  if (!normalized) return false;
  if (LOCATION_PLACEHOLDERS.has(normalized)) return false;
  if (normalized.length <= 1) return false;
  const tokens = normalized.split(/[\s,]+/).map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.every((token) => token.length <= 1)) return false;
  return true;
}

export function isMeaningfulLocation(text: string | null | undefined): boolean {
  return isMeaningfulLocationDeterministic(text);
}

export function isNoisyLocationHint(text: string): boolean {
  const raw = text.trim();
  if (!raw) return true;

  // Shared base rules (placeholders, ellipsis, linkedin/profile/URL patterns)
  if (isNoisyHint(raw)) return true;

  // Location-specific stricter checks
  if (raw.length > 80) return true;
  if (LOCATION_NOISE_PATTERNS.some((pattern) => pattern.test(raw))) return true;

  const alphaNum = raw.replace(/[^a-z0-9]/gi, '').length;
  if (alphaNum < 3) return true;
  return false;
}

function locationTokens(text: string): string[] {
  return canonicalizeLocation(text)
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

export function extractPrimaryCity(normalizedLocation: string): string | null {
  return extractPrimaryCityDeterministic(normalizedLocation);
}

function hasCountryTokenOverlap(targetLocation: string, candidateLocation: string): boolean {
  return hasCountryTokenOverlapDeterministic(targetLocation, candidateLocation);
}

const SHORT_ALIAS_ALLOWLIST = new Set(['ts', 'js', 'go', 'pg', 'k8s']);

function buildSkillRegex(form: string): RegExp {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const needsLeadingBoundary = /^\w/.test(form);
  const needsTrailingBoundary = /\w$/.test(form);
  const prefix = needsLeadingBoundary ? '\\b' : '(?:^|[^a-z0-9])';
  const suffix = needsTrailingBoundary ? '\\b' : '(?=$|[^a-z0-9])';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'i');
}

function computeSkillScore(
  candidate: CandidateForRanking,
  topSkills: string[],
  domain: string | null,
): { score: number; method: 'snapshot' | 'text_fallback' } {
  if (topSkills.length === 0) return { score: 0, method: 'text_fallback' };

  // Prefer snapshot skills (concept-expanded set intersection)
  if (candidate.snapshot?.skillsNormalized?.length) {
    const snapshotSet = buildSkillMatchSet(candidate.snapshot.skillsNormalized);
    let matchCount = 0;
    for (const skill of topSkills) {
      const forms = getSkillSurfaceForms(skill);
      if (forms.some((form) => snapshotSet.has(canonicalizeSkill(form)))) matchCount++;
    }
    const overlapRatio = matchCount / topSkills.length;

    let domainMatch = 0;
    if (domain) {
      const domainForms = getSkillSurfaceForms(domain);
      if (domainForms.some((form) => snapshotSet.has(canonicalizeSkill(form)))) domainMatch = 1;
    }

    return { score: 0.8 * overlapRatio + 0.2 * domainMatch, method: 'snapshot' };
  }

  // Fallback: textBag regex with alias-aware matching
  const textBag = [candidate.headlineHint, candidate.searchTitle, candidate.searchSnippet]
    .filter(Boolean)
    .join(' ');
  const lowerBag = textBag.toLowerCase();
  let matchCount = 0;
  for (const skill of topSkills) {
    const canonical = canonicalizeSkill(skill);
    // Ambiguous skills (go, rust, swift…) require nearby tech context
    if (!hasRequiredContext(canonical, textBag)) continue;
    const forms = getSkillSurfaceForms(skill);
    let matched = false;
    for (const form of forms) {
      // Skip short purely-alpha forms not in allowlist to avoid false positives
      if (form.length <= 2 && /^[a-z]+$/.test(form) && !SHORT_ALIAS_ALLOWLIST.has(form)) continue;
      if (buildSkillRegex(form).test(lowerBag)) { matched = true; break; }
    }
    if (matched) matchCount++;
  }
  const overlapRatio = matchCount / topSkills.length;

  let domainMatch = 0;
  if (domain) {
    const domainForms = getSkillSurfaceForms(domain);
    for (const form of domainForms) {
      if (form.length <= 2 && /^[a-z]+$/.test(form) && !SHORT_ALIAS_ALLOWLIST.has(form)) continue;
      if (buildSkillRegex(form).test(lowerBag)) { domainMatch = 1; break; }
    }
  }

  return { score: 0.8 * overlapRatio + 0.2 * domainMatch, method: 'text_fallback' };
}

function computeSeniorityScore(candidate: CandidateForRanking, targetLevel: string | null): number {
  if (!targetLevel) return 0.5; // neutral when no target
  const targetBand = targetLevel.toLowerCase() as SeniorityBand;
  const targetIdx = SENIORITY_LADDER.indexOf(targetBand);
  if (targetIdx === -1) return 0.5;

  // Prefer snapshot band
  let candidateBand: SeniorityBand | null = null;
  if (candidate.snapshot?.seniorityBand) {
    candidateBand = candidate.snapshot.seniorityBand as SeniorityBand;
  } else if (candidate.seniorityHint) {
    candidateBand = candidate.seniorityHint as SeniorityBand;
  } else {
    candidateBand = normalizeSeniorityFromText(candidate.headlineHint);
  }

  if (!candidateBand) return 0.3; // unknown seniority
  const diff = seniorityDistance(candidateBand, targetBand);
  if (diff === 0) return 1;
  if (diff === 1) return 0.5;
  return 0;
}

interface LocationClassification {
  matchTier: MatchTier;
  locationMatchType: LocationMatchType;
}

function classifyLocationMatch(
  candidate: CandidateForRanking,
  targetLocation: string | null,
  preResolvedLocation?: LocationResolution | null,
): LocationClassification {
  if (!isMeaningfulLocation(targetLocation)) {
    // No location constraint → everyone is strict (location irrelevant)
    return { matchTier: 'strict_location', locationMatchType: 'none' };
  }

  const target = targetLocation!;
  const loc = candidate.snapshot?.location ?? candidate.locationHint;

  if (!isMeaningfulLocation(loc) || isNoisyLocationHint(loc ?? '')) {
    return { matchTier: 'expanded_location', locationMatchType: 'unknown_location' };
  }

  const candidateLocation = loc!;
  const targetResolution = resolveLocationDeterministic(target);
  const targetNorm = targetResolution.normalized;
  const targetCity = targetResolution.city;

  const safePreResolved = preResolvedLocation && (
    preResolvedLocation.source === 'deterministic' || preResolvedLocation.confidence >= 0.7
  )
    ? preResolvedLocation
    : null;
  const candidateResolution = safePreResolved ?? resolveLocationDeterministic(candidateLocation);
  const candidateNorm = candidateResolution.normalized;

  if (targetCity && candidateNorm && candidateNorm.includes(targetCity)) {
    // City match after alias normalization. Check if it matched pre-alias.
    const rawTargetCity = targetResolution.rawCity;
    const isExact = Boolean(rawTargetCity && candidateResolution.rawNormalized.includes(rawTargetCity));

    return {
      matchTier: 'strict_location',
      locationMatchType: isExact ? 'city_exact' : 'city_alias',
    };
  }

  const countryMatch = targetResolution.countryCode
    ? targetResolution.countryCode === candidateResolution.countryCode
    : hasCountryTokenOverlap(target, candidateLocation);

  if (countryMatch) {
    if (!targetCity) {
      // Target is country-only → country match is strict
      return { matchTier: 'strict_location', locationMatchType: 'country_only' };
    }
    // Target has a city but candidate is same country, different city → expanded
    return { matchTier: 'expanded_location', locationMatchType: 'country_only' };
  }

  return { matchTier: 'expanded_location', locationMatchType: 'none' };
}

function computeRoleScore(
  candidate: CandidateForRanking,
  targetRoleFamily: string | null,
  track?: JobTrack,
  preResolved?: RoleResolution | null,
): number {
  if (!targetRoleFamily) return 0.5; // neutral when job has no role family

  // Use pre-resolved role if provided, otherwise resolve deterministically
  const resolution = preResolved ?? resolveRoleDeterministic(
    candidate.headlineHint ?? candidate.searchTitle ?? '',
  );

  const candidateFamily = resolution.family;
  const confidence = resolution.confidence;

  if (!candidateFamily) {
    // For non-tech/blended, unknown role is harsher — random engineers should sink
    return track !== 'tech' ? 0.15 : 0.3;
  }

  // Confidence gates: only full scoring at >= 0.7
  if (confidence < 0.5) {
    return track !== 'tech' ? 0.15 : 0.3;
  }

  if (candidateFamily === targetRoleFamily) {
    // Full exact match scoring at confidence >= 0.5 (adjacency/mismatch assist)
    return confidence >= 0.7 ? 1.0 : 0.8;
  }

  const adjacency = adjacencyMap.get(`${candidateFamily}:${targetRoleFamily}`);
  if (adjacency !== undefined) {
    return confidence >= 0.7 ? adjacency : adjacency * 0.7;
  }

  return 0.1; // mismatch
}

function computeFreshnessScore(candidate: CandidateForRanking): number {
  // TODO(Phase 3b): use computeSerpEvidence() confidence to weight freshness
  // when SOURCE_SERP_EVIDENCE_IN_FRESHNESS=true. See serp-signals.ts.
  // Prefer explicit activity recency derived from SERP signals.
  const recencyDays = candidate.snapshot?.activityRecencyDays;
  const daysSince = typeof recencyDays === 'number' && Number.isFinite(recencyDays)
    ? Math.max(0, recencyDays)
    : (() => {
      const ts = candidate.snapshot?.computedAt ?? candidate.lastEnrichedAt;
      if (!ts) return Number.POSITIVE_INFINITY;
      return (Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24);
    })();

  if (!Number.isFinite(daysSince)) return 0.1;
  if (daysSince <= 30) return 1.0;
  if (daysSince <= 90) return 0.7;
  if (daysSince <= 180) return 0.4;
  return 0.1;
}

function computeLocationBoost(
  locationMatchType: LocationMatchType,
  hasLocationRequirement: boolean,
): number {
  if (!hasLocationRequirement) return 0.5; // neutral
  switch (locationMatchType) {
    case 'city_exact': return 1.0;
    case 'city_alias': return 0.85;
    case 'country_only': return 0.5;
    case 'unknown_location': return 0.3;
    case 'none': return 0.1;
  }
}

const TRACK_WEIGHTS: Record<JobTrack, { skill: number; role: number; seniority: number; freshness: number }> = {
  tech:     { skill: 0.45, role: 0.15, seniority: 0.25, freshness: 0.15 },
  non_tech: { skill: 0.25, role: 0.30, seniority: 0.30, freshness: 0.15 },
  blended:  { skill: 0.35, role: 0.25, seniority: 0.25, freshness: 0.15 },
};

export function rankCandidates(
  candidates: CandidateForRanking[],
  requirements: JobRequirements,
  options?: {
    fitScoreEpsilon?: number;
    locationBoostWeight?: number;
    track?: JobTrack;
    preResolvedRoles?: Map<string, RoleResolution>;
    preResolvedLocations?: Map<string, LocationResolution>;
  },
): ScoredCandidate[] {
  // Location boost weight: 0 (default/disabled) preserves existing weights exactly.
  const locationWeight = options?.locationBoostWeight ?? 0;
  const remaining = 1.0 - locationWeight;
  const base = TRACK_WEIGHTS[options?.track ?? 'tech'];
  const weights = {
    skill: base.skill * remaining,
    role: base.role * remaining,
    seniority: base.seniority * remaining,
    freshness: base.freshness * remaining,
    location: locationWeight,
  };

  return candidates
    .map((c) => {
      const { score: skillScore, method: skillScoreMethod } = computeSkillScore(c, requirements.topSkills, requirements.domain);
      // Prefer candidate-id keyed pre-resolved roles; keep title-key fallback for compatibility.
      const preResolved = options?.preResolvedRoles?.get(c.id)
        ?? options?.preResolvedRoles?.get((c.headlineHint ?? c.searchTitle ?? '').trim().toLowerCase())
        ?? null;
      const roleScore = computeRoleScore(c, requirements.roleFamily, options?.track, preResolved);
      const seniorityScore = computeSeniorityScore(c, requirements.seniorityLevel);
      const activityFreshnessScore = computeFreshnessScore(c);
      const preResolvedLocation = options?.preResolvedLocations?.get(c.id) ?? null;
      const { matchTier, locationMatchType } = classifyLocationMatch(c, requirements.location, preResolvedLocation);
      const locationBoost = computeLocationBoost(locationMatchType, !!requirements.location);

      // Dampen seniority contribution when role is a clear mismatch or unknown on non-tech/blended.
      // A "Senior Software Engineer" shouldn't outrank a TAM just because of seniority.
      const isRoleMismatch = requirements.roleFamily && (
        roleScore <= 0.1 ||
        (options?.track !== 'tech' && roleScore <= 0.15)
      );
      const seniorityDampen = isRoleMismatch ? 0.4 : 1.0;
      const effectiveSeniority = seniorityScore * seniorityDampen;

      const fitScore =
        weights.skill * skillScore +
        weights.role * roleScore +
        weights.seniority * effectiveSeniority +
        weights.freshness * activityFreshnessScore +
        weights.location * locationBoost;

      return {
        candidateId: c.id,
        fitScore,
        fitBreakdown: { skillScore, skillScoreMethod, roleScore, seniorityScore, activityFreshnessScore, locationBoost },
        matchTier,
        locationMatchType,
      };
    })
    .sort((a, b) => {
      const epsilon = options?.fitScoreEpsilon ?? 0;
      return epsilon > 0 ? compareFitWithConfidence(a, b, epsilon) : b.fitScore - a.fitScore;
    });
}
