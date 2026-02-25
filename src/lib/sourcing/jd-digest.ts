import { normalizeSeniorityFromText } from '@/lib/taxonomy/seniority';
import { detectRoleFamilyFromTitle } from '@/lib/taxonomy/role-family';

/**
 * Canonical skill aliases — maps common abbreviations/variants to a single
 * canonical form so both JD skills and snapshot skills compare consistently.
 */
const SKILL_ALIASES: Record<string, string> = {
  'nodejs': 'node.js',
  'node': 'node.js',
  'reactjs': 'react',
  'react.js': 'react',
  'vuejs': 'vue',
  'vue.js': 'vue',
  'angularjs': 'angular',
  'angular.js': 'angular',
  'golang': 'go',
  'postgres': 'postgresql',
  'pg': 'postgresql',
  'mongo': 'mongodb',
  'k8s': 'kubernetes',
  'ts': 'typescript',
  'js': 'javascript',
  'cpp': 'c++',
  'dotnet': '.net',
  'dot net': '.net',
  'csharp': 'c#',
  'c sharp': 'c#',
  'micro-service': 'microservices',
  'micro services': 'microservices',
  'event driven': 'event-driven architecture',
  'event-driven': 'event-driven architecture',
  'event streaming': 'event-driven architecture',
  'event driven architecture': 'event-driven architecture',
  'distributed system': 'distributed systems',
  'distributed architectures': 'distributed systems',
  'message queue': 'message queues',
  'msg queue': 'message queues',
  'pub/sub': 'message queues',
  'pubsub': 'message queues',
};

const SKILL_CONCEPT_SURFACE_FORMS: Record<string, string[]> = {
  'microservices': ['microservices', 'microservice', 'service oriented', 'soa'],
  'event-driven architecture': ['event-driven architecture', 'event driven architecture', 'event-driven', 'event driven', 'event streaming'],
  'distributed systems': ['distributed systems', 'distributed system', 'distributed architecture', 'scalable systems'],
  'message queues': ['message queues', 'message queue', 'pubsub', 'pub sub'],
};

export function canonicalizeSkill(skill: string): string {
  const lower = skill.toLowerCase().trim();
  return SKILL_ALIASES[lower] ?? lower;
}

/**
 * Returns all known surface forms (aliases + canonical) for a given skill.
 * Used by ranking text fallback to broaden regex matching.
 */
export function getSkillSurfaceForms(skill: string): string[] {
  const canonical = canonicalizeSkill(skill);
  const forms = new Set<string>([canonical, skill.toLowerCase().trim()]);
  for (const [alias, target] of Object.entries(SKILL_ALIASES)) {
    if (target === canonical) forms.add(alias);
  }
  for (const form of SKILL_CONCEPT_SURFACE_FORMS[canonical] ?? []) {
    forms.add(form);
  }
  return [...forms];
}

export function getDiscoverySkillTerms(skills: string[], maxTerms: number = 6): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const raw of skills) {
    if (terms.length >= maxTerms) break;
    const canonical = canonicalizeSkill(raw);
    if (!seen.has(canonical)) {
      terms.push(canonical);
      seen.add(canonical);
    }

    const conceptForms = (SKILL_CONCEPT_SURFACE_FORMS[canonical] ?? [])
      .filter((form) => !seen.has(form));
    if (conceptForms.length > 0 && terms.length < maxTerms) {
      terms.push(conceptForms[0]);
      seen.add(conceptForms[0]);
    }
  }

  return terms.slice(0, maxTerms);
}

export interface JdDigestParsed {
  topSkills: string[];
  seniorityLevel: string | null;
  domain: string | null;
  roleFamily: string | null;
}

export interface JobRequirements {
  title?: string | null;
  topSkills: string[];
  seniorityLevel: string | null;
  domain: string | null;
  roleFamily: string | null;
  location: string | null;
  experienceYears: number | null;
  education: string | null;
}

export interface SourcingJobContextInput {
  jdDigest: string;
  title?: string;
  skills?: string[];
  goodToHaveSkills?: string[];
  location?: string;
  experienceYears?: number;
  education?: string;
}

function normalizeSkills(skills: string[]): string[] {
  const deduped = new Map<string, string>();
  for (const raw of skills) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    const key = canonicalizeSkill(cleaned);
    if (!deduped.has(key)) deduped.set(key, key);
  }
  return [...deduped.values()];
}

export function parseJdDigest(jdDigest: string): JdDigestParsed {
  if (!jdDigest.trim()) {
    return {
      topSkills: [],
      seniorityLevel: null,
      domain: null,
      roleFamily: null,
    };
  }

  // Try JSON first (VantaHire generates JSON via AI)
  try {
    const parsed = JSON.parse(jdDigest);
    return {
      topSkills: Array.isArray(parsed?.topSkills)
        ? parsed.topSkills.map((s: unknown) => String(s).trim()).filter(Boolean)
        : [],
      seniorityLevel: parsed.seniorityLevel ? String(parsed.seniorityLevel) : null,
      domain: parsed.domain ? String(parsed.domain) : null,
      roleFamily: parsed.roleFamily ? String(parsed.roleFamily) : null,
    };
  } catch {
    // Fallback: semicolon/comma-delimited keywords
    const tokens = jdDigest
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter(Boolean);
    return {
      topSkills: tokens,
      seniorityLevel: null,
      domain: null,
      roleFamily: null,
    };
  }
}

export function buildJobRequirements(jobContext: SourcingJobContextInput): JobRequirements {
  const parsed = parseJdDigest(jobContext.jdDigest);
  // Merge all skill sources: parsed JD first (highest signal), then structured
  // skills, then good-to-have. Canonicalization dedupes aliases (e.g. node/nodejs).
  const mergedSkills = normalizeSkills([
    ...parsed.topSkills,
    ...(jobContext.skills ?? []),
    ...(jobContext.goodToHaveSkills ?? []),
  ]);
  const title = jobContext.title?.trim() ?? null;
  const parsedTitleSeniority = title ? normalizeSeniorityFromText(title) : null;
  const parsedTitleRoleFamily = title ? detectRoleFamilyFromTitle(title) : null;

  return {
    title,
    topSkills: mergedSkills.slice(0, 12),
    seniorityLevel: parsed.seniorityLevel ?? parsedTitleSeniority,
    domain: parsed.domain,
    roleFamily: parsed.roleFamily ?? parsedTitleRoleFamily,
    location: jobContext.location ?? null,
    experienceYears: jobContext.experienceYears ?? null,
    education: jobContext.education ?? null,
  };
}
