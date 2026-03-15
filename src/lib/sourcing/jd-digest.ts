import { normalizeSeniorityFromText } from '@/lib/taxonomy/seniority';
import { resolveRoleDeterministic } from '@/lib/taxonomy/role-service';

/**
 * Canonical skill aliases — maps common abbreviations/variants to a single
 * canonical form so both JD skills and snapshot skills compare consistently.
 */
const SKILL_ALIASES: Record<string, string> = {
  // Tech
  'nodejs': 'node.js',
  'node': 'node.js',
  'reactjs': 'react',
  'react.js': 'react',
  'vuejs': 'vue',
  'vue.js': 'vue',
  'angularjs': 'angular',
  'angular.js': 'angular',
  'golang': 'go',
  'nextjs': 'next.js',
  'next js': 'next.js',
  'nuxtjs': 'nuxt',
  'nuxt.js': 'nuxt',
  'expressjs': 'express',
  'express.js': 'express',
  'fastapi': 'fastapi',
  'fast api': 'fastapi',
  'postgres': 'postgresql',
  'pg': 'postgresql',
  'postgressql': 'postgresql',
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
  // Sales / GTM
  'sfdc': 'salesforce',
  'salesforce crm': 'salesforce',
  'salesforce.com': 'salesforce',
  'enterprise selling': 'enterprise sales',
  'b2b sales': 'enterprise sales',
  'outbound sales': 'outbound',
  'outbound prospecting': 'outbound',
  'cold outreach': 'outbound',
  'pipeline mgmt': 'pipeline management',
  'deal management': 'pipeline management',
  'forecast management': 'pipeline management',
  'forecasting': 'pipeline management',
  'solution selling': 'consultative selling',
  'challenger sale': 'consultative selling',
  'meddic': 'consultative selling',
  'value selling': 'consultative selling',
  // Customer success / TAM
  'csm': 'customer success',
  'customer success management': 'customer success',
  'client success': 'customer success',
  'account management': 'stakeholder management',
  'relationship management': 'stakeholder management',
  'client management': 'stakeholder management',
  'key account management': 'stakeholder management',
  'api integration': 'integrations',
  'api integrations': 'integrations',
  'system integration': 'integrations',
  'system integrations': 'integrations',
  'rest api': 'apis',
  'rest apis': 'apis',
  'api development': 'apis',
  'web apis': 'apis',
};

const SKILL_CONCEPT_SURFACE_FORMS: Record<string, string[]> = {
  // Tech concepts
  'microservices': ['microservices', 'microservice', 'service oriented', 'soa'],
  'event-driven architecture': ['event-driven architecture', 'event driven architecture', 'event-driven', 'event driven', 'event streaming'],
  'distributed systems': ['distributed systems', 'distributed system', 'distributed architecture', 'scalable systems'],
  'message queues': ['message queues', 'message queue', 'pubsub', 'pub sub'],
  // Sales / GTM concepts
  'enterprise sales': ['enterprise sales', 'enterprise selling', 'b2b sales', 'strategic sales', 'complex sales'],
  'outbound': ['outbound', 'outbound sales', 'outbound prospecting', 'cold outreach', 'cold calling', 'business development'],
  'pipeline management': ['pipeline management', 'pipeline mgmt', 'deal management', 'forecast', 'forecasting', 'sales pipeline'],
  'salesforce': ['salesforce', 'sfdc', 'salesforce crm', 'salesforce.com'],
  'consultative selling': ['consultative selling', 'solution selling', 'challenger', 'meddic', 'value selling'],
  // Customer success / TAM concepts
  'customer success': ['customer success', 'csm', 'client success', 'customer retention', 'customer engagement'],
  'stakeholder management': ['stakeholder management', 'account management', 'relationship management', 'client management'],
  'integrations': ['integrations', 'integration', 'api integration', 'system integration', 'platform integration'],
  'apis': ['apis', 'api', 'rest api', 'api development', 'web api', 'api design'],
};

/**
 * Skills whose canonical name is a common English word.
 * These require nearby tech context in text-fallback matching to avoid FPs
 * like "spring cleaning" or "rust removal" being treated as skill evidence.
 */
export const AMBIGUOUS_SKILLS = new Set([
  'go', 'rust', 'swift', 'spring', 'spark', 'express',
  'flask', 'ruby', 'chef', 'consul', 'puppet',
]);

/**
 * Patterns that indicate the surrounding text is tech-related.
 * If an ambiguous skill is found but none of these patterns match,
 * the skill match is suppressed in text-fallback mode.
 */
const TECH_CONTEXT_PATTERNS = [
  /\b(?:engineer|developer|architect|devops|sre|backend|frontend|fullstack|full[- ]stack|programmer|coder)\b/i,
  /\b(?:software|technical|tech|development|programming|coding|api|sdk|saas|cloud|infrastructure)\b/i,
  /\b(?:python|java|typescript|javascript|node\.?js|react|angular|vue|kubernetes|docker|aws|gcp|azure|linux|sql|nosql|redis|kafka|terraform|ansible|ci\/cd|git|github|microservice)\b/i,
  /\b(?:senior|junior|staff|lead|principal)\s+(?:engineer|developer|architect)\b/i,
];

/**
 * Check if an ambiguous skill match should be accepted based on tech context.
 * Returns true if the skill is not ambiguous, or if tech context is present.
 */
export function hasRequiredContext(canonicalSkill: string, textBag: string): boolean {
  if (!AMBIGUOUS_SKILLS.has(canonicalSkill)) return true;
  return TECH_CONTEXT_PATTERNS.some(p => p.test(textBag));
}

// ---------------------------------------------------------------------------
// Non-tech concept rules — narrow combinatorial detectors for multi-word
// business skills that can't be reliably matched by single-phrase aliases.
// Each rule requires tokens from multiple buckets to co-occur in the textBag.
// Used only in the text fallback path, never for snapshot matching.
// ---------------------------------------------------------------------------

interface ConceptRule {
  /** All bucket patterns must match (AND). Each bucket is an OR of terms. */
  require: RegExp[];
  /** If any exclude pattern matches, suppress the detection. */
  exclude?: RegExp[];
}

const NONTECH_CONCEPT_RULES: Record<string, ConceptRule> = {
  'enterprise sales': {
    // Proximity rule: enterprise-bucket and sales-bucket must be within ~30 chars
    // Prevents cross-phrase co-occurrence like "new logo...strategic partnership"
    require: [
      /(?:\b(?:enterprise|strategic|complex|b2b)\b.{0,30}\b(?:sales|selling|deals|account\s+executive|new\s+logo|pipeline|AE)\b|\b(?:sales|selling|deals|account\s+executive|new\s+logo|pipeline)\b.{0,30}\b(?:enterprise|strategic|complex|b2b)\b)/i,
    ],
  },
  'stakeholder management': {
    // Two patterns (OR): either phrase-proximity "account/client/… manager/management"
    // or "key accounts" with a nearby action/ownership signal
    require: [
      /(?:\b(?:account|relationship|client|stakeholder)\s+manag(?:e|er|ement|ing)\b|\bmanag(?:e|er|ement|ing)\s+(?:account|relationship|client|stakeholder)\b|\bkey\s+accounts?\b.{0,40}\b(?:manag|own|oversee|renewal|expansion|adoption|relationship|retain)|\b(?:manag|own|oversee|renewal|expansion|adoption|relationship|retain)\w*\b.{0,40}\bkey\s+accounts?\b)/i,
    ],
  },
  'pipeline management': {
    require: [
      /\b(?:pipeline)\b/i,
      /\b(?:forecast(?:ing)?|generation|coverage|deals?)\b/i,
    ],
    exclude: [
      /\b(?:weather|oil|gas|petroleum|infrastructure|refinery)\b/i,
    ],
  },
};

export type ConceptResult = 'match' | 'exclude' | 'no_match';

/**
 * Check if a non-tech concept rule matches the text.
 * Returns:
 *   'match'    — concept detected (accept)
 *   'exclude'  — negative guard fired (reject, skip alias fallback)
 *   'no_match' — rule exists but didn't match (fall through to alias)
 *   undefined  — no concept rule registered (fall through to alias)
 */
export function detectNontechConcept(canonicalSkill: string, textBag: string): ConceptResult | undefined {
  const rule = NONTECH_CONCEPT_RULES[canonicalSkill];
  if (!rule) return undefined;
  if (rule.exclude?.some(p => p.test(textBag))) return 'exclude';
  return rule.require.every(p => p.test(textBag)) ? 'match' : 'no_match';
}

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

/**
 * Build a set of all canonical match keys for a list of skills.
 * Expands each skill to all surface forms, canonicalizes each form.
 * Used for concept-aware set intersection in snapshot matching.
 */
export function buildSkillMatchSet(skills: string[]): Set<string> {
  const keys = new Set<string>();
  for (const skill of skills) {
    for (const form of getSkillSurfaceForms(skill)) {
      keys.add(canonicalizeSkill(form));
    }
  }
  return keys;
}

export function getDiscoverySkillTerms(skills: string[], maxTerms: number = 6): string[] {
  const buckets = getDiscoverySkillBuckets(skills, maxTerms, maxTerms);
  return [...buckets.exactTerms, ...buckets.conceptTerms].slice(0, maxTerms);
}

export interface DiscoverySkillBuckets {
  exactTerms: string[];
  conceptTerms: string[];
}

export function getDiscoverySkillBuckets(
  skills: string[],
  maxExactTerms: number = 4,
  maxConceptTerms: number = 2,
): DiscoverySkillBuckets {
  const exactTerms: string[] = [];
  const conceptTerms: string[] = [];
  const seen = new Set<string>();

  for (const raw of skills) {
    const canonical = canonicalizeSkill(raw);
    const conceptForms = SKILL_CONCEPT_SURFACE_FORMS[canonical] ?? [];
    const isConcept = conceptForms.length > 0;

    if (isConcept) {
      if (!seen.has(canonical) && conceptTerms.length < maxConceptTerms) {
        conceptTerms.push(canonical);
        seen.add(canonical);
      }
      continue;
    }

    if (!seen.has(canonical) && exactTerms.length < maxExactTerms) {
      exactTerms.push(canonical);
      seen.add(canonical);
    }
  }

  // If we still have concept capacity, add one alternate surface for broadening.
  for (const raw of skills) {
    if (conceptTerms.length >= maxConceptTerms) break;
    const canonical = canonicalizeSkill(raw);
    const conceptForms = SKILL_CONCEPT_SURFACE_FORMS[canonical] ?? [];
    for (const form of conceptForms) {
      if (seen.has(form)) continue;
      conceptTerms.push(form);
      seen.add(form);
      break;
    }
  }

  return { exactTerms, conceptTerms };
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
  const parsedTitleRoleFamily = title ? resolveRoleDeterministic(title).family : null;

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
