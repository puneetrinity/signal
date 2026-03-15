import { getSkillSurfaceForms } from '../src/lib/sourcing/jd-digest';

const SHORT_ALIAS_ALLOWLIST = new Set(['ts', 'js', 'go', 'pg', 'k8s']);

function buildSkillRegex(form: string): RegExp {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const needsLeadingBoundary = /^\w/.test(form);
  const needsTrailingBoundary = /\w$/.test(form);
  const prefix = needsLeadingBoundary ? '\\b' : '(?:^|[^a-z0-9])';
  const suffix = needsTrailingBoundary ? '\\b' : '(?=$|[^a-z0-9])';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'i');
}

function detect(skill: string, text: string): boolean {
  const forms = getSkillSurfaceForms(skill);
  const lower = text.toLowerCase();
  for (const form of forms) {
    if (form.length <= 2 && /^[a-z]+$/.test(form) && !SHORT_ALIAS_ALLOWLIST.has(form)) continue;
    if (buildSkillRegex(form).test(lower)) return true;
  }
  return false;
}

const tests: Array<[string, string, boolean, string]> = [
  // [skill, text, expected, description]
  ['next.js', 'NextJs developer', false, 'nextjs not aliased to next.js'],
  ['next.js', 'Next.js developer', true, 'exact match'],
  ['go', "Let's go build things", true, 'go in allowlist — FP'],
  ['rust', 'Rust Belt manufacturing hub', true, 'rust as English word — FP'],
  ['swift', 'Swift response to incidents', true, 'swift as English word — FP'],
  ['spring', 'Spring cleaning and organizing', true, 'spring as English word — FP'],
  ['spark', 'Spark creativity in teams', true, 'spark as English word — FP'],
  ['express', 'Express delivery service manager', true, 'express as English word — FP'],
  ['flask', 'Flask experiments in chemistry lab', true, 'flask as English word — FP'],
  ['ruby', 'Ruby anniversary celebration', true, 'ruby as English word — FP'],
  ['dart', 'Dart tournament champion', true, 'dart as English word — FP'],
  ['nest', 'Empty nest syndrome support', true, 'nest as English word — FP'],
  ['chef', 'Executive Chef at Marriott', true, 'chef as English word — FP (config mgmt tool)'],
  ['puppet', 'Puppet show entertainment', true, 'puppet as English word — FP'],
  ['consul', 'French Consul in Mumbai', true, 'consul as English word — FP'],
  ['ansible', 'Using Ansible for config management', true, 'literal match works'],
  ['nuxt', 'Building with Nuxt.js', false, 'nuxt not aliased, nuxt.js has dot'],
  ['nuxt', 'Building with Nuxt framework', true, 'nuxt literal match'],
];

console.log('Skill match verification:');
for (const [skill, text, expected, desc] of tests) {
  const result = detect(skill, text);
  const ok = result === expected;
  const icon = ok ? 'OK' : 'FAIL';
  console.log(`  ${icon.padEnd(4)} "${skill}" in "${text.slice(0, 50)}" → ${result} (expected ${expected}) [${desc}]`);
}
