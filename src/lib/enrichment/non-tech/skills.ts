import { canonicalizeSkill, detectNontechConcept, getSkillSurfaceForms } from '@/lib/sourcing/jd-digest';

interface NonTechSkillExtractionInput {
  summaryStructured?: Record<string, unknown> | null;
  headlineHint?: string | null;
  searchTitle?: string | null;
  searchSnippet?: string | null;
}

const NONTECH_SKILL_CATALOG = [
  'enterprise sales',
  'outbound',
  'pipeline management',
  'salesforce',
  'consultative selling',
  'customer success',
  'stakeholder management',
  'integrations',
  'apis',
  'account management',
  'renewals',
  'expansion',
  'sales enablement',
  'territory planning',
  'negotiation',
  'hubspot',
  'outreach',
  'gong',
  'meddic',
];

function buildSkillRegex(form: string): RegExp {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const needsLeadingBoundary = /^\w/.test(form);
  const needsTrailingBoundary = /\w$/.test(form);
  const prefix = needsLeadingBoundary ? '\\b' : '(?:^|[^a-z0-9])';
  const suffix = needsTrailingBoundary ? '\\b' : '(?=$|[^a-z0-9])';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'i');
}

function extractStructuredSkills(summaryStructured?: Record<string, unknown> | null): string[] {
  const rawSkills = summaryStructured?.skills;
  if (!Array.isArray(rawSkills)) return [];
  return rawSkills
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((skill) => canonicalizeSkill(skill))
    .filter((skill) => skill.length > 1);
}

export function extractNonTechSkills(input: NonTechSkillExtractionInput): string[] {
  const textBag = [
    input.headlineHint,
    input.searchTitle,
    input.searchSnippet,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  const extracted = new Set<string>(extractStructuredSkills(input.summaryStructured));

  if (!textBag) {
    return [...extracted].slice(0, 20);
  }

  for (const skill of NONTECH_SKILL_CATALOG) {
    const canonical = canonicalizeSkill(skill);
    const conceptResult = detectNontechConcept(canonical, textBag);
    if (conceptResult === 'match') {
      extracted.add(canonical);
      continue;
    }
    if (conceptResult === 'exclude') continue;

    const forms = getSkillSurfaceForms(skill);
    if (forms.some((form) => buildSkillRegex(form).test(textBag))) {
      extracted.add(canonical);
    }
  }

  return [...extracted].slice(0, 20);
}
