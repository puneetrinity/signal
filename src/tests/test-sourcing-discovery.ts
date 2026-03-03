import { buildDeterministicQueries, formatQueryTerm, parseQueryPlanFromText } from '@/lib/sourcing/discovery';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failed++;
    console.error(`  FAIL: ${message}`);
    return;
  }
  passed++;
  console.log(`  PASS: ${message}`);
}

console.log('\n--- Discovery Query Parsing ---');

const labeled = parseQueryPlanFromText(`
STRICT:
- site:linkedin.com/in "staff platform engineer" "Hyderabad, India" kubernetes aws
- site:linkedin.com/in "platform engineer" "Hyderabad, India" distributed systems

FALLBACK:
- site:linkedin.com/in "staff platform engineer" kubernetes aws
`);
assert(labeled.plan?.strictQueries.length === 2, 'Parses labeled STRICT queries');
assert(labeled.plan?.fallbackQueries.length === 1, 'Parses labeled FALLBACK queries');
assert(labeled.parseStage === 'labeled_sections', 'Detects labeled section parse stage');

const inlineBuckets = parseQueryPlanFromText(`
strict - site:linkedin.com/in "account executive" "Mumbai, India" salesforce outbound
fallback - site:linkedin.com/in "account executive" salesforce outbound
`);
assert(inlineBuckets.plan?.strictQueries[0]?.includes('"Mumbai, India"') === true, 'Parses inline strict bucket');
assert(inlineBuckets.plan?.fallbackQueries[0]?.includes('salesforce') === true, 'Parses inline fallback bucket');
assert(inlineBuckets.parseStage === 'inline_buckets', 'Detects inline bucket parse stage');

const jsonPlan = parseQueryPlanFromText(JSON.stringify({
  strictQueries: ['site:linkedin.com/in "tam" "Bangalore, India" apis integrations'],
  fallbackQueries: ['site:linkedin.com/in "tam" apis integrations'],
}));
assert(jsonPlan.plan?.strictQueries.length === 1, 'Parses JSON strict queries');
assert(jsonPlan.parseStage === 'json', 'Detects JSON parse stage');

console.log('\n--- Discovery Query Formatting ---');

assert(
  formatQueryTerm('staff platform engineer', 'exact') === '"staff platform engineer"',
  'Quotes exact multi-word terms',
);
assert(
  formatQueryTerm('distributed systems', 'concept') === 'distributed systems',
  'Does not quote concept multi-word terms',
);

const deterministicPlan = buildDeterministicQueries(
  {
    title: 'Staff Platform Engineer',
    topSkills: ['Kubernetes', 'distributed systems', 'microservices', 'AWS', 'Go'],
    seniorityLevel: 'staff',
    domain: null,
    roleFamily: 'devops',
    location: 'Hyderabad, India',
    experienceYears: null,
    education: null,
  },
  4,
);

assert(
  deterministicPlan.strict.some((query) => query.includes('distributed systems')),
  'Deterministic strict queries keep concept terms',
);
assert(
  deterministicPlan.strict.every((query) => !query.includes('"distributed systems"')),
  'Deterministic strict queries do not over-quote concept terms',
);
assert(
  deterministicPlan.strict.some((query) => query.includes('"Hyderabad, India"')),
  'Deterministic strict queries still quote location',
);

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('All tests passed.');
