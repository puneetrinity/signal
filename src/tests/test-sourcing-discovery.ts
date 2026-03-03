import { buildDeterministicQueries, formatQueryTerm, parseQueryPlanFromText, isLikelyPersonProfile } from '@/lib/sourcing/discovery';
import type { ProfileSummary } from '@/types/linkedin';

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

// ---------------------------------------------------------------------------
// P0: Query Validation — Commentary Filtering
// ---------------------------------------------------------------------------
console.log('\n--- P0: Query Commentary Filtering ---');

// Mixed valid + commentary lines → only valid queries survive
const mixedPlan = parseQueryPlanFromText(`
STRICT:
- site:linkedin.com/in "account executive" "Mumbai, India" salesforce
- *Note that there were only 10 STRICT queries provided.
- site:linkedin.com/in "sales executive" "Mumbai, India" outbound

FALLBACK:
- site:linkedin.com/in "account executive" salesforce outbound
- Below the maximum query limit, reformatting complete.
`);
assert(mixedPlan.plan?.strictQueries.length === 2, 'P0: Commentary lines filtered from strict queries');
assert(mixedPlan.plan?.fallbackQueries.length === 1, 'P0: Commentary lines filtered from fallback queries');
assert(
  mixedPlan.plan?.strictQueries.every((q: string) => !q.includes('Note that')) === true,
  'P0: No commentary text in strict queries',
);

// All commentary → returns null plan
const allCommentary = parseQueryPlanFromText(`
STRICT:
- *Note that there were only 10 STRICT queries provided.
- Below the maximum query limit.
FALLBACK:
- No fallback query to reformat.
`);
assert(allCommentary.plan === null, 'P0: All commentary → null plan');
assert(allCommentary.parseStage === 'none', 'P0: All commentary → parseStage none');

// Locale subdomain queries accepted
const localePlan = parseQueryPlanFromText(`
STRICT:
- site:uk.linkedin.com/in "account manager" "London" pipeline
FALLBACK:
- site:ca.linkedin.com/in "account manager" pipeline
`);
assert(localePlan.plan?.strictQueries.length === 1, 'P0: Locale subdomain uk.linkedin.com/in accepted');
assert(localePlan.plan?.fallbackQueries.length === 1, 'P0: Locale subdomain ca.linkedin.com/in accepted');

// Missing site:linkedin.com/in → rejected
const noSitePlan = parseQueryPlanFromText(`
STRICT:
- "account executive" "Mumbai" salesforce outbound
FALLBACK:
- "sales executive" salesforce
`);
assert(noSitePlan.plan === null, 'P0: Queries without site:linkedin.com/in → null plan');

// JSON path also filtered
const jsonWithCommentary = parseQueryPlanFromText(JSON.stringify({
  strictQueries: [
    'site:linkedin.com/in "tam" "Bangalore" apis',
    'Note that maximum query limit was reached',
  ],
  fallbackQueries: ['site:linkedin.com/in "tam" apis'],
}));
assert(jsonWithCommentary.plan?.strictQueries.length === 1, 'P0: JSON path filters commentary');
assert(jsonWithCommentary.plan?.fallbackQueries.length === 1, 'P0: JSON path keeps valid queries');

// ---------------------------------------------------------------------------
// P0.5: Profile Spam Filtering
// ---------------------------------------------------------------------------
console.log('\n--- P0.5: Profile Spam Filtering ---');

function makeProfile(overrides: Partial<ProfileSummary>): ProfileSummary {
  return {
    linkedinUrl: 'https://www.linkedin.com/in/john-doe',
    linkedinId: 'john-doe',
    title: 'John Doe - Software Engineer',
    snippet: 'Experienced developer',
    ...overrides,
  };
}

assert(
  isLikelyPersonProfile(makeProfile({
    title: 'SEO Service Provider',
    snippet: 'We build backlinks and improve your reputation',
  })) === false,
  'P0.5: Rejects SEO spam profile',
);

assert(
  isLikelyPersonProfile(makeProfile({
    title: 'Assignment Help India',
    snippet: 'homework help for CS students',
  })) === false,
  'P0.5: Rejects assignment help spam',
);

assert(
  isLikelyPersonProfile(makeProfile({
    linkedinUrl: 'https://www.linkedin.com/company/acme-inc',
    title: 'Acme Inc',
    snippet: 'A leading SaaS company',
  })) === false,
  'P0.5: Rejects /company/ URL (not /in/)',
);

assert(
  isLikelyPersonProfile(makeProfile({
    title: 'Roger O. - Technical Account Manager @ AWS',
    snippet: 'Helping customers achieve cloud success',
  })) === true,
  'P0.5: Accepts real TAM profile',
);

assert(
  isLikelyPersonProfile(makeProfile({
    title: 'Priya S. - Senior Account Executive',
    snippet: 'Enterprise sales | SaaS | 150% quota attainment',
  })) === true,
  'P0.5: Accepts real AE profile',
);

assert(
  isLikelyPersonProfile(makeProfile({
    title: 'Alex M. - Full Stack Developer',
    snippet: 'React, Node.js, TypeScript',
  })) === true,
  'P0.5: Accepts real developer profile',
);

// ---------------------------------------------------------------------------
// P2: Non-Tech Title Variant Expansion
// ---------------------------------------------------------------------------
console.log('\n--- P2: Non-Tech Deterministic Query Expansion ---');

const aePlan = buildDeterministicQueries(
  {
    title: 'Senior Account Executive',
    topSkills: ['salesforce', 'outbound', 'pipeline management'],
    seniorityLevel: 'senior',
    domain: null,
    roleFamily: 'account_executive',
    location: 'Mumbai, India',
    experienceYears: null,
    education: null,
  },
  8,
  'non_tech',
);

assert(
  aePlan.strict.some((q) => q.includes('"enterprise sales"')),
  'P2: Non-tech strict includes "enterprise sales" title variant',
);
assert(
  aePlan.strict.some((q) => q.includes('"sales executive"')),
  'P2: Non-tech strict includes "sales executive" title variant',
);
assert(
  aePlan.strict.some((q) => q.includes('"account executive"') && q.includes('"Mumbai, India"')),
  'P2: Non-tech strict has location-targeted AE query',
);

const tamPlan = buildDeterministicQueries(
  {
    title: 'Technical Account Manager',
    topSkills: ['APIs', 'integrations', 'cloud'],
    seniorityLevel: 'senior',
    domain: null,
    roleFamily: 'technical_account_manager',
    location: 'Bangalore, India',
    experienceYears: null,
    education: null,
  },
  8,
  'non_tech',
);

assert(
  tamPlan.strict.some((q) => q.includes('"technical account manager"') && q.includes('"Bangalore, India"')),
  'P2: TAM plan has location-targeted strict query',
);
assert(
  tamPlan.strict.some((q) => q.includes('"technical customer success"')),
  'P2: TAM plan includes "technical customer success" variant',
);

// Tech track should NOT get variant expansion
const techPlan = buildDeterministicQueries(
  {
    title: 'Staff Platform Engineer',
    topSkills: ['Kubernetes', 'AWS', 'Go'],
    seniorityLevel: 'staff',
    domain: null,
    roleFamily: 'devops',
    location: 'Hyderabad, India',
    experienceYears: null,
    education: null,
  },
  4,
  'tech',
);

assert(
  !techPlan.strict.some((q) => q.includes('"site reliability"')),
  'P2: Tech track does NOT get title variant expansion',
);

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('All tests passed.');
