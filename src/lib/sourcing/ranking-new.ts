import type { JobRequirements } from './jd-digest';
import { canonicalizeSkill, getSkillSurfaceForms } from './jd-digest';
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
import type { CrustdataProfileResponse } from './crustdata-client';
import { getSchoolTier, isDegreeRelevant } from '@/lib/taxonomy/education';

export interface CandidateForRanking {
  id: string;
  headlineHint: string | null;
  locationHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
  enrichmentStatus: string;
  lastEnrichedAt: Date | null;
  crustdata?: CrustdataProfileResponse | null;
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

export const STRONG_LOCATION_TYPES = new Set<LocationMatchType>(['city_exact', 'city_alias', 'country_only']);
export type MatchTier = 'strict_location' | 'expanded_location';

export interface FitBreakdown {
  experienceScore: number;
  skillScore: number;
  roleScore: number;
  seniorityScore: number;
  domainIndustryScore: number;
  locationBoost: number;
  educationScore: number;
  dataConfidence: number;
  activityFreshnessScore?: number;
  skillScoreMethod?: 'snapshot' | 'text_fallback';
  unknownLocationPromotion?: boolean;
}

export interface ScoredCandidate {
  candidateId: string;
  fitScore: number;
  fitBreakdown: FitBreakdown;
  matchTier: MatchTier;
  locationMatchType: LocationMatchType;
}

export interface MustHaveGates {
  location?: { value: string; hard: boolean };
  seniorityMin?: SeniorityBand;
  seniorityMax?: SeniorityBand;
  function?: string;
  skills?: string[];
  industryRequired?: string;
}

export function compareFitWithConfidence(a: ScoredCandidate, b: ScoredCandidate, epsilon: number): number {
  const delta = b.fitScore - a.fitScore;
  if (Math.abs(delta) >= epsilon) return delta;

  if (a.fitBreakdown.dataConfidence !== b.fitBreakdown.dataConfidence) {
    return b.fitBreakdown.dataConfidence - a.fitBreakdown.dataConfidence;
  }

  if (a.candidateId < b.candidateId) return -1;
  if (a.candidateId > b.candidateId) return 1;
  return 0;
}

const LOCATION_NOISE_PATTERNS: RegExp[] = [
  /\bprofessional community\b/i,
  /\beducation:/i,
  /\bexperience:/i,
  /\.com\b/i,
  /\.org\b/i,
];

const LOCATION_PLACEHOLDERS = new Set([
  ...PLACEHOLDER_HINTS,
  '.',
  '..',
  'n a',
  'not specified',
]);

export function canonicalizeLocation(text: string): string {
  return canonicalizeLocationDeterministic(text);
}

export function isMeaningfulLocation(text: string | null | undefined): boolean {
  return isMeaningfulLocationDeterministic(text);
}

export function isNoisyLocationHint(text: string): boolean {
  const raw = text.trim();
  if (!raw) return true;
  if (isNoisyHint(raw)) return true;
  if (raw.length > 80) return true;
  if (LOCATION_NOISE_PATTERNS.some((pattern) => pattern.test(raw))) return true;
  const alphaNum = raw.replace(/[^a-z0-9]/gi, '').length;
  if (alphaNum < 3) return true;
  return false;
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

// ─── HELPERS ───

function getYearsDiff(start: string | null | undefined, end: string | null | undefined): number {
  if (!start) return 0;
  const s = new Date(start).getTime();
  if (isNaN(s)) return 0;
  const e = end ? new Date(end).getTime() : Date.now();
  if (isNaN(e)) return 0;
  return Math.max(0, (e - s) / (1000 * 60 * 60 * 24 * 365));
}

function isRoleMatch(
  roleTitle: string | undefined, 
  roleFunction: string | undefined, 
  targetFamily: string | null, 
  targetFunction: string | null
): 'exact' | 'adjacent' | 'none' {
  if (targetFunction && roleFunction && roleFunction.toLowerCase() === targetFunction.toLowerCase()) return 'exact';
  
  if (targetFamily && roleTitle) {
    const res = resolveRoleDeterministic(roleTitle);
    if (res.family === targetFamily) return 'exact';
    const adjacency = adjacencyMap.get(`${res.family}:${targetFamily}`);
    if (adjacency !== undefined && adjacency >= 0.5) return 'adjacent';
  }
  return 'none';
}

function getAllRoles(crustdata: CrustdataProfileResponse) {
  const current = crustdata.experience?.employment_details?.current || [];
  const past = crustdata.experience?.employment_details?.past || [];
  return [...current, ...past];
}

// ─── COMPONENT SCORING ───

function computeExperienceScore(c: CrustdataProfileResponse, req: JobRequirements): number {
  const allRoles = getAllRoles(c);
  const currentRole = c.experience?.employment_details?.current?.[0];
  
  let relevantYears = 0;
  let totalTenure = 0;
  let tenureCount = 0;
  
  const targetFamily = req.roleFamily || null;
  const targetFunction = null; // We'd pull this from requirements if available, assume null for now

  let seniorityProgressionValue = 1; // 1 = mixed
  let lastSeniorityIdx = -1;
  let upwardCount = 0;
  let downwardCount = 0;

  // Sort by start_date ascending (oldest first)
  const sortedRoles = [...allRoles].sort((a, b) => {
    const timeA = a.start_date ? new Date(a.start_date).getTime() : 0;
    const timeB = b.start_date ? new Date(b.start_date).getTime() : 0;
    return timeA - timeB;
  });

  for (const role of sortedRoles) {
    const years = role.years_at_company_raw ?? getYearsDiff(role.start_date, role.end_date);
    if (years > 0) {
      totalTenure += years;
      tenureCount++;
    }
    
    const match = isRoleMatch(role.title, role.function_category, targetFamily, targetFunction);
    if (match === 'exact' || match === 'adjacent') {
      relevantYears += years;
    }

    if (role.seniority_level) {
      const b = role.seniority_level.toLowerCase() as SeniorityBand;
      const idx = SENIORITY_LADDER.indexOf(b);
      if (idx !== -1) {
        if (lastSeniorityIdx !== -1) {
          if (idx > lastSeniorityIdx) upwardCount++;
          else if (idx < lastSeniorityIdx) downwardCount++;
        }
        lastSeniorityIdx = idx;
      }
    }
  }

  // 1. Total relevant years curve
  let yearsPts = 1;
  if (relevantYears >= 10) yearsPts = 8;
  else if (relevantYears >= 6) yearsPts = 7;
  else if (relevantYears >= 3) yearsPts = 5;
  else if (relevantYears >= 1) yearsPts = 3;

  // 2. Current role relevance
  let currentRelevancePts = 0;
  if (currentRole) {
    const curMatch = isRoleMatch(currentRole.title, currentRole.function_category, targetFamily, targetFunction);
    if (curMatch === 'exact') currentRelevancePts = 7;
    else if (curMatch === 'adjacent') currentRelevancePts = 4;
  }

  // 3. Recent past relevance
  let pastRelevancePts = 0;
  const pastRoles = [...(c.experience?.employment_details?.past || [])].sort((a, b) => {
    const endA = a.end_date ? new Date(a.end_date).getTime() : 0;
    const endB = b.end_date ? new Date(b.end_date).getTime() : 0;
    return endB - endA;
  }).slice(0, 2);

  for (const pr of pastRoles) {
    const prMatch = isRoleMatch(pr.title, pr.function_category, targetFamily, targetFunction);
    let pts = 0;
    if (prMatch === 'exact') pts = 2.5;
    else if (prMatch === 'adjacent') pts = 1.5;

    if (pr.end_date) {
      const endedYearsAgo = (Date.now() - new Date(pr.end_date).getTime()) / (1000 * 60 * 60 * 24 * 365);
      if (endedYearsAgo > 5) pts *= 0.5;
    }
    pastRelevancePts += pts;
  }

  // 4. Career progression
  if (upwardCount > 0 && downwardCount === 0) seniorityProgressionValue = 3;
  else if (upwardCount === 0 && downwardCount === 0 && tenureCount > 1) seniorityProgressionValue = 2; // lateral
  else if (downwardCount > upwardCount) seniorityProgressionValue = 0;
  else seniorityProgressionValue = 1;

  // 5. Tenure stability
  let tenurePts = 1;
  const avgTenure = tenureCount > 0 ? totalTenure / tenureCount : 0;
  if (avgTenure >= 2) tenurePts = 2;
  else if (avgTenure < 1 && tenureCount > 0) tenurePts = 0;

  return yearsPts + currentRelevancePts + pastRelevancePts + seniorityProgressionValue + tenurePts;
}

function computeSkillFunctionFit(c: CrustdataProfileResponse, req: JobRequirements): number {
  if (!req.topSkills || req.topSkills.length === 0) return 0;
  
  let matchScore = 0;
  let maxPossible = 0;

  const currentRole = c.experience?.employment_details?.current?.[0];
  const targetFunction = null; // Replace if available

  // Function match (8pts)
  let functionPts = 0;
  if (currentRole && targetFunction && currentRole.function_category?.toLowerCase() === targetFunction) {
    functionPts = 8;
  } else if (currentRole?.function_category) {
    functionPts = 3; // some adjacent function
  }

  // Skills in text (12pts max)
  let textMatchTotal = 0;
  const allRoles = getAllRoles(c);
  const headline = c.basic_profile?.headline || '';

  for (const skill of req.topSkills) {
    const forms = getSkillSurfaceForms(skill);
    let bestSkillScore = 0;

    for (const role of allRoles) {
      const isCurrent = !role.end_date;
      const endedYearsAgo = role.end_date ? (Date.now() - new Date(role.end_date).getTime()) / (1000 * 60 * 60 * 24 * 365) : 0;
      let weight = 0.1;
      if (isCurrent) weight = 1.0;
      else if (endedYearsAgo < 3) weight = 0.7;
      else if (endedYearsAgo < 6) weight = 0.4;

      const bag = [role.title, role.description, headline].filter(Boolean).join(' ').toLowerCase();
      
      let matched = false;
      for (const form of forms) {
        if (form.length <= 2 && /^[a-z]+$/.test(form) && !SHORT_ALIAS_ALLOWLIST.has(form)) continue;
        if (buildSkillRegex(form).test(bag)) { matched = true; break; }
      }
      
      if (matched && weight > bestSkillScore) {
        bestSkillScore = weight;
      }
    }
    textMatchTotal += bestSkillScore;
  }

  const skillCoveragePts = (textMatchTotal / req.topSkills.length) * 12;

  // Adjacent/transferable (5pts) - implicit in regex for now
  const adjacentPts = 5 * (skillCoveragePts / 12); 

  return functionPts + skillCoveragePts + adjacentPts;
}

function computeRoleTitleScore(c: CrustdataProfileResponse, targetRoleFamily: string | null): number {
  if (!targetRoleFamily) return 7.5; // Neutral
  
  let currentTitlePts = 0;
  const currentRole = c.experience?.employment_details?.current?.[0];
  if (currentRole?.title) {
    const res = resolveRoleDeterministic(currentRole.title);
    if (res.family === targetRoleFamily) {
      currentTitlePts = 10;
    } else {
      const adj = adjacencyMap.get(`${res.family}:${targetRoleFamily}`);
      if (adj) currentTitlePts = 10 * 0.6 * adj; // adjacent cap
      else currentTitlePts = 2; // mismatch
    }
  }

  let pastTitlePts = 0;
  const pastRoles = c.experience?.employment_details?.past || [];
  for (const pr of pastRoles) {
    if (!pr.title) continue;
    const endedYearsAgo = pr.end_date ? (Date.now() - new Date(pr.end_date).getTime()) / (1000 * 60 * 60 * 24 * 365) : 10;
    let weight = 1.0;
    if (endedYearsAgo > 5) weight = 0.5;

    let pts = 0;
    const res = resolveRoleDeterministic(pr.title);
    if (res.family === targetRoleFamily) pts = 5 * weight;
    else {
      const adj = adjacencyMap.get(`${res.family}:${targetRoleFamily}`);
      if (adj) pts = 5 * 0.6 * adj * weight;
    }
    if (pts > pastTitlePts) pastTitlePts = pts;
  }

  const total = currentTitlePts + pastTitlePts;
  
  // Apply cap if current role is totally mismatched
  if (currentTitlePts <= 2) {
    return Math.min(total, 3);
  }
  return total;
}

function computeDomainIndustryScore(c: CrustdataProfileResponse, req: JobRequirements, isTech: boolean): number {
  if (!req.domain) return isTech ? 5 : 10; // neutral

  const target = req.domain.toLowerCase();
  
  const currentRole = c.experience?.employment_details?.current?.[0];
  let curPts = 0;
  const curMax = isTech ? 4 : 9;
  
  if (currentRole?.company_industries?.some(ind => ind.toLowerCase().includes(target)) || 
      currentRole?.company_professional_network_industry?.toLowerCase().includes(target)) {
    curPts = curMax;
  }

  let pastPts = 0;
  const pastMax = isTech ? 3 : 6;
  for (const pr of (c.experience?.employment_details?.past || [])) {
    if (pr.company_industries?.some(ind => ind.toLowerCase().includes(target)) || 
        pr.company_professional_network_industry?.toLowerCase().includes(target)) {
      const endedYearsAgo = pr.end_date ? (Date.now() - new Date(pr.end_date).getTime()) / (1000 * 60 * 60 * 24 * 365) : 10;
      let pts = pastMax;
      if (endedYearsAgo > 5) pts *= 0.5;
      if (pts > pastPts) pastPts = pts;
    }
  }

  // Company scale/type signal 
  const scaleTypeMax = isTech ? 3 : 5;
  const scaleTypePts = scaleTypeMax * 0.5; // Assume average if we can't do exact matching yet
  
  return curPts + pastPts + scaleTypePts;
}

function computeSeniorityScore(c: CrustdataProfileResponse, targetLevel: string | null): number {
  if (!targetLevel) return 6; // neutral when no target
  
  const targetBand = targetLevel.toLowerCase() as SeniorityBand;
  const targetIdx = SENIORITY_LADDER.indexOf(targetBand);
  if (targetIdx === -1) return 6;

  let candidateBand: SeniorityBand | null = null;
  const currentRole = c.experience?.employment_details?.current?.[0];
  if (currentRole?.seniority_level) {
    candidateBand = currentRole.seniority_level.toLowerCase() as SeniorityBand;
  } else if (c.basic_profile?.headline) {
    candidateBand = normalizeSeniorityFromText(c.basic_profile.headline);
  }

  if (!candidateBand) return 4; // unknown
  
  const diff = seniorityDistance(candidateBand, targetBand);
  if (diff === 0) return 10;
  if (diff === 1) return 6;
  if (diff === 2) return 2;
  return 0;
}

function classifyLocationMatch(c: CandidateForRanking, targetLocation: string | null): { matchTier: MatchTier; locationMatchType: LocationMatchType } {
  if (!isMeaningfulLocation(targetLocation)) {
    return { matchTier: 'strict_location', locationMatchType: 'none' };
  }
  const target = targetLocation!;
  const loc = c.crustdata?.basic_profile?.location?.full_location || c.crustdata?.basic_profile?.location?.raw || c.locationHint;
  
  if (!isMeaningfulLocation(loc) || isNoisyLocationHint(loc ?? '')) {
    return { matchTier: 'expanded_location', locationMatchType: 'unknown_location' };
  }
  
  const candidateLocation = loc!;
  const targetResolution = resolveLocationDeterministic(target);
  const candidateResolution = resolveLocationDeterministic(candidateLocation);
  
  if (targetResolution.city && candidateResolution.normalized?.includes(targetResolution.city)) {
    const rawTargetCity = targetResolution.rawCity;
    const isExact = Boolean(rawTargetCity && candidateResolution.rawNormalized.includes(rawTargetCity));
    return { matchTier: 'strict_location', locationMatchType: isExact ? 'city_exact' : 'city_alias' };
  }
  
  const countryMatch = targetResolution.countryCode 
    ? targetResolution.countryCode === candidateResolution.countryCode 
    : hasCountryTokenOverlap(target, candidateLocation);
    
  if (countryMatch) {
    if (!targetResolution.city) return { matchTier: 'strict_location', locationMatchType: 'country_only' };
    return { matchTier: 'expanded_location', locationMatchType: 'country_only' };
  }
  
  return { matchTier: 'expanded_location', locationMatchType: 'none' };
}

function computeLocationBoost(locationMatchType: LocationMatchType, hasTarget: boolean, maxPts: number): number {
  if (!hasTarget) return maxPts;
  switch (locationMatchType) {
    case 'city_exact': return maxPts;
    case 'city_alias': return maxPts * 0.85;
    case 'country_only': return maxPts; // Or 0.5 depending on if city was targeted, handled below
    case 'unknown_location': return maxPts * 0.3;
    case 'none': return 0;
  }
}

function computeEducationScore(c: CrustdataProfileResponse, track: JobTrack): number {
  let score = 2; // default if missing
  const schools = c.education?.schools || [];
  if (schools.length === 0) return 2;

  let bestDegPts = 0;
  let bestSchPts = 0;
  let bestRecencyPts = 0;

  for (const edu of schools) {
    const isRel = isDegreeRelevant(edu.degree, edu.field_of_study, track);
    if (isRel) bestDegPts = 2;

    const tier = getSchoolTier(edu.school);
    if (tier === 'premium') bestSchPts = 2;
    else if (tier === 'decent' && bestSchPts < 1) bestSchPts = 1;

    if (edu.end_year) {
      if (new Date().getFullYear() - edu.end_year <= 10) bestRecencyPts = 1;
    }
  }

  return bestDegPts + bestSchPts + bestRecencyPts;
}

function applyMustHaveGates(rawScore: number, c: CandidateForRanking, gates?: MustHaveGates): number {
  if (!gates) return rawScore;
  
  let finalScore = rawScore;
  
  // Example gate enforcement:
  // if (gates.location?.hard && classifyLocationMatch(c, gates.location.value).locationMatchType === 'none') return -1;
  // if (gates.location && !gates.location.hard && classifyLocationMatch(c, gates.location.value).locationMatchType === 'none') {
  //   finalScore = Math.min(finalScore, 60);
  // }
  
  return finalScore;
}

export function rankCandidates(
  candidates: CandidateForRanking[],
  requirements: JobRequirements,
  options?: {
    fitScoreEpsilon?: number;
    track?: JobTrack;
    gates?: MustHaveGates;
  },
): ScoredCandidate[] {
  const track = options?.track ?? 'tech';
  
  return candidates.map(c => {
    // If no crustdata, fallback to a basic low score (legacy paths)
    if (!c.crustdata) {
      return {
        candidateId: c.id,
        fitScore: 10,
        fitBreakdown: { experienceScore: 0, skillScore: 10, roleScore: 0, seniorityScore: 0, domainIndustryScore: 0, locationBoost: 0, educationScore: 0, dataConfidence: 0 },
        matchTier: 'expanded_location',
        locationMatchType: 'none'
      } as ScoredCandidate;
    }

    const { matchTier, locationMatchType } = classifyLocationMatch(c, requirements.location);
    const hasLocationTarget = !!requirements.location;

    // Base Multipliers
    let expWeight = 25, skillWeight = 25, roleWeight = 15, domWeight = 10, senWeight = 10, locWeight = 10, eduWeight = 5;
    if (track === 'non_tech') {
      expWeight = 20; skillWeight = 15; roleWeight = 18; domWeight = 20; senWeight = 12; locWeight = 12; eduWeight = 3;
    } else if (track === 'blended') {
      expWeight = 22; skillWeight = 20; roleWeight = 16; domWeight = 15; senWeight = 11; locWeight = 11; eduWeight = 5;
    }

    const expScore = computeExperienceScore(c.crustdata, requirements) * (expWeight / 25);
    const sklScore = computeSkillFunctionFit(c.crustdata, requirements) * (skillWeight / 25);
    const rolScore = computeRoleTitleScore(c.crustdata, requirements.roleFamily) * (roleWeight / 15);
    const domScore = computeDomainIndustryScore(c.crustdata, requirements, track === 'tech') * (domWeight / (track === 'tech' ? 10 : 20));
    const senScore = computeSeniorityScore(c.crustdata, requirements.seniorityLevel) * (senWeight / 10);
    
    // Country only adjustment
    const isTargetCity = resolveLocationDeterministic(requirements.location || '').city !== null;
    const adjustedLocMatchType = (locationMatchType === 'country_only' && isTargetCity) ? 'country_only_50' as any : locationMatchType;
    let locScore = computeLocationBoost(adjustedLocMatchType === 'country_only_50' ? 'country_only' : locationMatchType, hasLocationTarget, locWeight);
    if (adjustedLocMatchType === 'country_only_50') locScore = locWeight * 0.5;

    const eduScore = computeEducationScore(c.crustdata, track) * (eduWeight / 5);

    let rawScore = expScore + sklScore + rolScore + domScore + senScore + locScore + eduScore;
    
    // Dampen seniority if role mismatch
    if (rolScore < (roleWeight * 0.3)) {
      rawScore -= (senScore * 0.6); // cap seniority contribution
    }

    let gatedScore = applyMustHaveGates(rawScore, c, options?.gates);

    // Confidence multiplier
    let conf = 0.75; // title/snippet only
    if (c.crustdata.basic_profile) conf = 0.85;
    if (c.crustdata.experience?.employment_details?.past?.length) conf = 0.9;
    if (c.crustdata.experience?.employment_details?.current?.length) conf = 1.0;

    let finalScore = gatedScore * conf;
    if (finalScore < 0) finalScore = 0;
    if (finalScore > 100) finalScore = 100;

    return {
      candidateId: c.id,
      fitScore: finalScore,
      fitBreakdown: { 
        experienceScore: expScore, 
        skillScore: sklScore, 
        roleScore: rolScore, 
        seniorityScore: senScore, 
        domainIndustryScore: domScore, 
        locationBoost: locScore, 
        educationScore: eduScore, 
        dataConfidence: conf 
      },
      matchTier,
      locationMatchType
    };
  }).sort((a, b) => {
    const epsilon = options?.fitScoreEpsilon ?? 0;
    return epsilon > 0 ? compareFitWithConfidence(a, b, epsilon) : b.fitScore - a.fitScore;
  });
}
