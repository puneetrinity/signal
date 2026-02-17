import type { JobRequirements } from './jd-digest';
import { SENIORITY_LADDER, normalizeSeniorityFromText, seniorityDistance, type SeniorityBand } from '@/lib/taxonomy/seniority';

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

export interface FitBreakdown {
  skillScore: number;
  seniorityScore: number;
  locationScore: number;
  activityFreshnessScore: number;
}

export interface ScoredCandidate {
  candidateId: string;
  fitScore: number;
  fitBreakdown: FitBreakdown;
}

function computeSkillScore(
  candidate: CandidateForRanking,
  topSkills: string[],
  domain: string | null,
): number {
  if (topSkills.length === 0) return 0;

  // Prefer snapshot skills (set intersection, no regex needed)
  if (candidate.snapshot?.skillsNormalized?.length) {
    const snapshotSet = new Set(candidate.snapshot.skillsNormalized.map((s) => s.toLowerCase()));
    let matchCount = 0;
    for (const skill of topSkills) {
      if (snapshotSet.has(skill.toLowerCase())) matchCount++;
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

function computeLocationScore(candidate: CandidateForRanking, targetLocation: string | null): number {
  if (!targetLocation) return 0.5; // neutral
  // Prefer snapshot location
  const loc = candidate.snapshot?.location ?? candidate.locationHint;
  if (loc && loc.toLowerCase().includes(targetLocation.toLowerCase())) return 1;
  if (candidate.headlineHint && /\bremote\b/i.test(candidate.headlineHint)) return 0.5;
  return 0;
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
  return candidates
    .map((c) => {
      const skillScore = computeSkillScore(c, requirements.topSkills, requirements.domain);
      const seniorityScore = computeSeniorityScore(c, requirements.seniorityLevel);
      const locationScore = computeLocationScore(c, requirements.location);
      const activityFreshnessScore = computeFreshnessScore(c);

      const fitScore =
        0.5 * skillScore +
        0.3 * seniorityScore +
        0.1 * locationScore +
        0.1 * activityFreshnessScore;

      return {
        candidateId: c.id,
        fitScore,
        fitBreakdown: { skillScore, seniorityScore, locationScore, activityFreshnessScore },
      };
    })
    .sort((a, b) => b.fitScore - a.fitScore);
}
