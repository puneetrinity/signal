import type { JobRequirements } from './jd-digest';
import { canonicalizeSkill } from './jd-digest';
import { SENIORITY_LADDER, normalizeSeniorityFromText, seniorityDistance, type SeniorityBand } from '@/lib/taxonomy/seniority';
import { detectRoleFamilyFromTitle } from '@/lib/taxonomy/role-family';

export interface CandidateForRanking {
  id: string;
  headlineHint: string | null;
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
    computedAt: Date;
    staleAfter: Date;
  } | null;
}

export type LocationMatchType = 'city_exact' | 'city_alias' | 'country_only' | 'none';
export type MatchTier = 'strict_location' | 'expanded_location';

export interface FitBreakdown {
  skillScore: number;
  roleScore: number;
  seniorityScore: number;
  activityFreshnessScore: number;
}

export interface ScoredCandidate {
  candidateId: string;
  fitScore: number;
  fitBreakdown: FitBreakdown;
  matchTier: MatchTier;
  locationMatchType: LocationMatchType;
}

const LOCATION_ALIAS_REWRITES: Array<[RegExp, string]> = [
  [/\bbengaluru\b/gi, 'bangalore'],
  [/\bbombay\b/gi, 'mumbai'],
  [/\bnyc\b/gi, 'new york'],
  [/\bsf\b/gi, 'san francisco'],
];

const LOCATION_NOISE_PATTERNS: RegExp[] = [
  /\blinkedin\b/i,
  /\bview\b.*\bprofile\b/i,
  /\bprofessional community\b/i,
  /\beducation:/i,
  /\bexperience:/i,
  /https?:\/\//i,
  /\bwww\./i,
  /\.com\b/i,
  /\.org\b/i,
];

const LOCATION_PLACEHOLDERS = new Set([
  '.',
  '..',
  '...',
  '-',
  'na',
  'n a',
  'n/a',
  'unknown',
  'not specified',
  'none',
  'null',
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

function canonicalizeLocation(text: string): string {
  let normalized = text.toLowerCase().trim();
  for (const [pattern, replacement] of LOCATION_ALIAS_REWRITES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(/[^a-z0-9\s,]/g, ' ').replace(/\s+/g, ' ').trim();
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

function isMeaningfulLocation(text: string | null | undefined): boolean {
  if (!text) return false;
  return isMeaningfulNormalizedLocation(canonicalizeLocation(text));
}

function isNoisyLocationHint(text: string): boolean {
  const raw = text.trim();
  if (!raw) return true;
  if (raw.length > 80) return true;
  if (/\.{3,}|…/.test(raw)) return true;
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

function extractPrimaryCity(normalizedLocation: string): string | null {
  const [firstSegmentRaw] = normalizedLocation.split(',');
  const firstSegment = firstSegmentRaw?.trim() ?? '';
  if (!firstSegment) return null;
  const firstSegmentTokens = firstSegment.split(/\s+/).filter(Boolean);
  if (firstSegmentTokens.length === 0) return null;
  if (firstSegmentTokens.every((token) => COUNTRY_TOKENS.has(token))) return null;
  return firstSegment;
}

function hasCountryTokenOverlap(targetLocation: string, candidateLocation: string): boolean {
  const targetTokens = locationTokens(targetLocation).filter((token) => COUNTRY_TOKENS.has(token));
  if (targetTokens.length === 0) return false;
  const candidateTokens = new Set(locationTokens(candidateLocation));
  return targetTokens.some((token) => candidateTokens.has(token));
}

function computeSkillScore(
  candidate: CandidateForRanking,
  topSkills: string[],
  domain: string | null,
): number {
  if (topSkills.length === 0) return 0;

  // Prefer snapshot skills (set intersection, no regex needed)
  if (candidate.snapshot?.skillsNormalized?.length) {
    const snapshotSet = new Set(candidate.snapshot.skillsNormalized.map((s) => canonicalizeSkill(s)));
    let matchCount = 0;
    for (const skill of topSkills) {
      if (snapshotSet.has(canonicalizeSkill(skill))) matchCount++;
    }
    const overlapRatio = matchCount / topSkills.length;

    let domainMatch = 0;
    if (domain && snapshotSet.has(domain.toLowerCase())) domainMatch = 1;

    return 0.8 * overlapRatio + 0.2 * domainMatch;
  }

  // Fallback: textBag regex
  const textBag = [candidate.headlineHint, candidate.searchTitle, candidate.searchSnippet]
    .filter(Boolean)
    .join(' ');
  const lowerBag = textBag.toLowerCase();
  let matchCount = 0;
  for (const skill of topSkills) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lowerBag)) matchCount++;
  }
  const overlapRatio = matchCount / topSkills.length;

  let domainMatch = 0;
  if (domain) {
    const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const domainRe = new RegExp(`\\b${escapedDomain}\\b`, 'i');
    if (domainRe.test(lowerBag)) domainMatch = 1;
  }

  return 0.8 * overlapRatio + 0.2 * domainMatch;
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
): LocationClassification {
  if (!isMeaningfulLocation(targetLocation)) {
    // No location constraint → everyone is strict (location irrelevant)
    return { matchTier: 'strict_location', locationMatchType: 'none' };
  }

  const target = targetLocation!;
  const loc = candidate.snapshot?.location ?? candidate.locationHint;

  if (!isMeaningfulLocation(loc) || isNoisyLocationHint(loc ?? '')) {
    return { matchTier: 'expanded_location', locationMatchType: 'none' };
  }

  const candidateLocation = loc!;
  const targetNorm = canonicalizeLocation(target);
  const candidateNorm = canonicalizeLocation(candidateLocation);
  const targetCity = extractPrimaryCity(targetNorm);

  if (targetCity && candidateNorm && candidateNorm.includes(targetCity)) {
    // City match after alias normalization. Check if it matched pre-alias.
    const rawTarget = target.toLowerCase().replace(/[^a-z0-9\s,]/g, ' ').replace(/\s+/g, ' ').trim();
    const rawCandidate = candidateLocation.toLowerCase().replace(/[^a-z0-9\s,]/g, ' ').replace(/\s+/g, ' ').trim();
    const rawTargetCity = extractPrimaryCity(rawTarget);
    const isExact = Boolean(rawTargetCity && rawCandidate.includes(rawTargetCity));

    return {
      matchTier: 'strict_location',
      locationMatchType: isExact ? 'city_exact' : 'city_alias',
    };
  }

  if (hasCountryTokenOverlap(target, candidateLocation)) {
    if (!targetCity) {
      // Target is country-only → country match is strict
      return { matchTier: 'strict_location', locationMatchType: 'country_only' };
    }
    // Target has a city but candidate is same country, different city → expanded
    return { matchTier: 'expanded_location', locationMatchType: 'country_only' };
  }

  return { matchTier: 'expanded_location', locationMatchType: 'none' };
}

function computeRoleScore(candidate: CandidateForRanking, targetRoleFamily: string | null): number {
  if (!targetRoleFamily) return 0.5; // neutral when job has no role family

  const headline = candidate.headlineHint ?? candidate.searchTitle ?? '';
  const candidateFamily = detectRoleFamilyFromTitle(headline);

  if (!candidateFamily) return 0.3; // unknown — slight penalty
  if (candidateFamily === targetRoleFamily) return 1.0;

  // Fullstack is adjacent to both frontend and backend
  if (
    (candidateFamily === 'fullstack' && (targetRoleFamily === 'frontend' || targetRoleFamily === 'backend')) ||
    ((candidateFamily === 'frontend' || candidateFamily === 'backend') && targetRoleFamily === 'fullstack')
  ) {
    return 0.7;
  }

  return 0.1; // mismatch
}

function computeFreshnessScore(candidate: CandidateForRanking): number {
  // Prefer snapshot computedAt
  const ts = candidate.snapshot?.computedAt ?? candidate.lastEnrichedAt;
  if (!ts) return 0.1;
  const daysSince = (Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 30) return 1.0;
  if (daysSince <= 90) return 0.7;
  if (daysSince <= 180) return 0.4;
  return 0.1;
}

export function rankCandidates(
  candidates: CandidateForRanking[],
  requirements: JobRequirements,
): ScoredCandidate[] {
  // Location is a tier gate, not a score component.
  // Weights sum to 1.0 regardless of location constraint.
  const weights = { skill: 0.45, role: 0.15, seniority: 0.25, freshness: 0.15 };

  return candidates
    .map((c) => {
      const skillScore = computeSkillScore(c, requirements.topSkills, requirements.domain);
      const roleScore = computeRoleScore(c, requirements.roleFamily);
      const seniorityScore = computeSeniorityScore(c, requirements.seniorityLevel);
      const activityFreshnessScore = computeFreshnessScore(c);
      const { matchTier, locationMatchType } = classifyLocationMatch(c, requirements.location);

      const fitScore =
        weights.skill * skillScore +
        weights.role * roleScore +
        weights.seniority * seniorityScore +
        weights.freshness * activityFreshnessScore;

      return {
        candidateId: c.id,
        fitScore,
        fitBreakdown: { skillScore, roleScore, seniorityScore, activityFreshnessScore },
        matchTier,
        locationMatchType,
      };
    })
    .sort((a, b) => b.fitScore - a.fitScore);
}
