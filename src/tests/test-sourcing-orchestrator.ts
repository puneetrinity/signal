/**
 * Integration tests for sourcing orchestrator: ranking, assembly, cap behavior.
 * Tests pure functions only (no Prisma, no SERP calls).
 *
 * Run with: npx tsx src/tests/test-sourcing-orchestrator.ts
 */

import { rankCandidates, type CandidateForRanking } from '@/lib/sourcing/ranking';
import { parseJdDigest, buildJobRequirements, type JobRequirements } from '@/lib/sourcing/jd-digest';
import { getSourcingConfig } from '@/lib/sourcing/config';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidates(count: number, opts?: {
  enriched?: number;
  skills?: string[];
  seniority?: string;
  location?: string;
}): CandidateForRanking[] {
  const enriched = opts?.enriched ?? 0;
  const skills = opts?.skills ?? ['React', 'TypeScript'];
  const seniority = opts?.seniority ?? 'senior';
  const location = opts?.location ?? 'San Francisco';

  return Array.from({ length: count }, (_, i) => ({
    id: `cand-${i}`,
    headlineHint: i < enriched
      ? `${seniority} Software Engineer · ${skills.join(', ')}`
      : `Engineer`,
    locationHint: i % 2 === 0 ? location : 'New York',
    searchTitle: `${seniority} ${skills[0]} Developer`,
    searchSnippet: `Experienced in ${skills.join(' and ')} development`,
    enrichmentStatus: i < enriched ? 'completed' : 'pending',
    lastEnrichedAt: i < enriched ? new Date(Date.now() - 15 * 86400000) : null,
  }));
}

function makeRequirements(overrides?: Partial<JobRequirements>): JobRequirements {
  return {
    topSkills: ['React', 'TypeScript', 'Node.js'],
    seniorityLevel: 'senior',
    domain: 'web development',
    roleFamily: 'Software Engineer',
    location: 'San Francisco',
    experienceYears: 5,
    education: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test: JD Digest parsing
// ---------------------------------------------------------------------------

console.log('\n--- JD Digest Parsing ---');

{
  const parsed = parseJdDigest(JSON.stringify({
    topSkills: ['React', 'TypeScript'],
    seniorityLevel: 'senior',
    domain: 'fintech',
    roleFamily: 'Frontend Engineer',
  }));
  assert(parsed.topSkills.length === 2, 'JSON parse: 2 skills');
  assert(parsed.seniorityLevel === 'senior', 'JSON parse: seniority');
  assert(parsed.domain === 'fintech', 'JSON parse: domain');
  assert(parsed.roleFamily === 'Frontend Engineer', 'JSON parse: roleFamily');
}

{
  const parsed = parseJdDigest('React; TypeScript; Node.js');
  assert(parsed.topSkills.length === 3, 'Semicolon fallback: 3 skills');
  assert(parsed.topSkills[0] === 'React', 'Semicolon fallback: first skill');
  assert(parsed.seniorityLevel === null, 'Semicolon fallback: no seniority');
}

{
  const parsed = parseJdDigest('React, TypeScript, Node.js');
  assert(parsed.topSkills.length === 3, 'Comma fallback: 3 skills');
}

{
  const reqs = buildJobRequirements({
    jdDigest: JSON.stringify({ topSkills: ['Go'], seniorityLevel: 'staff' }),
    location: 'Austin',
    experienceYears: 8,
  });
  assert(reqs.location === 'Austin', 'buildJobRequirements: location from context');
  assert(reqs.experienceYears === 8, 'buildJobRequirements: experienceYears');
  assert(reqs.topSkills[0] === 'Go', 'buildJobRequirements: skills from jdDigest');
}

{
  // Empty jdDigest fallback: use structured fields from Vanta jobContext
  const reqs = buildJobRequirements({
    jdDigest: '',
    title: 'Senior DevOps Engineer',
    skills: ['AWS', 'Terraform', 'Kubernetes'],
    location: 'Hyderabad',
  });
  assert(reqs.topSkills.length === 3, 'Fallback: skills come from structured context');
  assert(reqs.seniorityLevel === 'senior', 'Fallback: seniority parsed from title');
  assert(reqs.roleFamily === 'devops', 'Fallback: role family parsed from title');
}

{
  // Case-insensitive skill dedupe across required + good-to-have
  const reqs = buildJobRequirements({
    jdDigest: '',
    skills: ['React', 'TypeScript'],
    goodToHaveSkills: ['react', 'typescript', 'GraphQL'],
  });
  assert(reqs.topSkills.length === 3, 'Fallback: skills dedupe is case-insensitive');
}

// ---------------------------------------------------------------------------
// Test: Ranking
// ---------------------------------------------------------------------------

console.log('\n--- Ranking ---');

{
  const reqs = makeRequirements();
  const candidates = makeCandidates(5, { enriched: 3, skills: ['React', 'TypeScript'] });
  const scored = rankCandidates(candidates, reqs);

  assert(scored.length === 5, 'All candidates scored');
  assert(scored[0].fitScore >= scored[1].fitScore, 'Sorted descending');
  assert(scored[0].fitBreakdown.skillScore > 0, 'Skill score > 0 for matching candidate');
}

{
  // Word boundary: "Java" should NOT match "JavaScript"
  const reqs = makeRequirements({ topSkills: ['Java'] });
  const candidates: CandidateForRanking[] = [{
    id: 'js-dev',
    headlineHint: 'JavaScript Developer',
    locationHint: null,
    searchTitle: 'JavaScript Engineer',
    searchSnippet: 'Expert in JavaScript and React',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
  }, {
    id: 'java-dev',
    headlineHint: 'Java Developer',
    locationHint: null,
    searchTitle: 'Java Engineer',
    searchSnippet: 'Expert in Java and Spring Boot',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
  }];
  const scored = rankCandidates(candidates, reqs);
  const jsScore = scored.find((s) => s.candidateId === 'js-dev')!.fitBreakdown.skillScore;
  const javaScore = scored.find((s) => s.candidateId === 'java-dev')!.fitBreakdown.skillScore;
  assert(javaScore > jsScore, 'Word boundary: Java matches Java, not JavaScript');
}

{
  // Seniority: exact match scores higher than ±1
  const reqs = makeRequirements({ seniorityLevel: 'senior' });
  const exact: CandidateForRanking = {
    id: 'exact', headlineHint: 'Senior Engineer', locationHint: null,
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const close: CandidateForRanking = {
    id: 'close', headlineHint: 'Staff Engineer', locationHint: null,
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const far: CandidateForRanking = {
    id: 'far', headlineHint: 'Intern', locationHint: null,
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([exact, close, far], reqs);
  const exactS = scored.find((s) => s.candidateId === 'exact')!.fitBreakdown.seniorityScore;
  const closeS = scored.find((s) => s.candidateId === 'close')!.fitBreakdown.seniorityScore;
  const farS = scored.find((s) => s.candidateId === 'far')!.fitBreakdown.seniorityScore;
  assert(exactS === 1, 'Seniority exact match = 1');
  assert(closeS === 0.5, 'Seniority ±1 = 0.5');
  assert(farS === 0, 'Seniority far = 0');
}

{
  // Freshness tiers
  const reqs = makeRequirements();
  const fresh: CandidateForRanking = {
    id: 'fresh', headlineHint: '', locationHint: null,
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'completed',
    lastEnrichedAt: new Date(Date.now() - 10 * 86400000), // 10d
  };
  const stale: CandidateForRanking = {
    id: 'stale', headlineHint: '', locationHint: null,
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'completed',
    lastEnrichedAt: new Date(Date.now() - 200 * 86400000), // 200d
  };
  const never: CandidateForRanking = {
    id: 'never', headlineHint: '', locationHint: null,
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending',
    lastEnrichedAt: null,
  };
  const scored = rankCandidates([fresh, stale, never], reqs);
  const freshF = scored.find((s) => s.candidateId === 'fresh')!.fitBreakdown.activityFreshnessScore;
  const staleF = scored.find((s) => s.candidateId === 'stale')!.fitBreakdown.activityFreshnessScore;
  const neverF = scored.find((s) => s.candidateId === 'never')!.fitBreakdown.activityFreshnessScore;
  assert(freshF === 1.0, 'Freshness <=30d = 1.0');
  assert(staleF === 0.1, 'Freshness >180d = 0.1');
  assert(neverF === 0.1, 'Freshness never = 0.1');
}

// ---------------------------------------------------------------------------
// Test: Pool cap behavior (simulates orchestrator assembly logic)
// ---------------------------------------------------------------------------

console.log('\n--- Pool Cap Behavior ---');

function simulateOrchestrator(poolSize: number, enrichedCount: number, discoveryYield: number) {
  const config = { targetCount: 100, minGoodEnough: 30, jobMaxEnrich: 50, maxSerpQueries: 3 };

  // Simulate deficit assessment (mirrors orchestrator.ts conditional cap)
  const poolDeficit = config.targetCount - poolSize;
  let discoveredCount = 0;
  let discoveryTarget = 0;

  if (poolDeficit > 0) {
    const aggressive = enrichedCount < config.minGoodEnough;
    discoveryTarget = aggressive
      ? Math.min(poolDeficit, config.jobMaxEnrich)
      : poolDeficit;
    discoveredCount = Math.min(discoveryTarget, discoveryYield);
  }

  // Simulate assembly
  const assembled = Math.min(poolSize + discoveredCount, config.targetCount);

  const discoveryShortfallRate = discoveryTarget > 0
    ? (discoveryTarget - discoveredCount) / discoveryTarget
    : 0;

  return { assembled, discoveredCount, discoveryTarget, discoveryShortfallRate, discoveryFired: poolDeficit > 0, aggressive: enrichedCount < config.minGoodEnough };
}

{
  // Pool=120 enriched → no discovery
  const r = simulateOrchestrator(120, 100, 0);
  assert(!r.discoveryFired, 'Pool=120: no discovery fired');
  assert(r.assembled === 100, 'Pool=120: capped at 100');
  assert(r.discoveryShortfallRate === 0, 'Pool=120: shortfall = 0');
}

{
  // Pool=60, enriched=20 (< minGoodEnough=30) → aggressive, capped at jobMaxEnrich
  const r = simulateOrchestrator(60, 20, 40);
  assert(r.discoveryFired, 'Pool=60 weak: discovery fired');
  assert(r.aggressive, 'Pool=60 weak: aggressive=true');
  assert(r.discoveryTarget === 40, 'Pool=60 weak: target = min(40, 50) = 40');
  assert(r.discoveredCount === 40, 'Pool=60 weak: discovered 40');
  assert(r.assembled === 100, 'Pool=60 weak: total = 100 (top-off)');
  assert(r.discoveryShortfallRate === 0, 'Pool=60 weak: shortfall = 0');
}

{
  // Pool=60, enriched=35 (>= minGoodEnough=30) → decent pool, full top-off (no jobMaxEnrich cap)
  const r = simulateOrchestrator(60, 35, 40);
  assert(r.discoveryFired, 'Pool=60 decent: discovery fired');
  assert(!r.aggressive, 'Pool=60 decent: aggressive=false');
  assert(r.discoveryTarget === 40, 'Pool=60 decent: target = full deficit = 40');
  assert(r.discoveredCount === 40, 'Pool=60 decent: discovered 40');
  assert(r.assembled === 100, 'Pool=60 decent: total = 100 (top-off)');
}

{
  // Decent pool with deficit > jobMaxEnrich → full deficit, NOT capped
  const r = simulateOrchestrator(30, 30, 80);
  assert(!r.aggressive, 'Pool=30 decent: aggressive=false (enriched >= minGoodEnough)');
  assert(r.discoveryTarget === 70, 'Pool=30 decent: target = full deficit 70 (no cap)');
  assert(r.discoveredCount === 70, 'Pool=30 decent: discovered 70');
  assert(r.assembled === 100, 'Pool=30 decent: total = 100');
}

{
  // Pool=10 → deficit=90, capped at jobMaxEnrich=50
  const r = simulateOrchestrator(10, 5, 50);
  assert(r.discoveryFired, 'Pool=10: discovery fired');
  assert(r.discoveryTarget === 50, 'Pool=10: target capped at jobMaxEnrich=50');
  assert(r.discoveredCount === 50, 'Pool=10: discovered 50');
  assert(r.assembled === 60, 'Pool=10: total = 60 (10 pool + 50 discovered)');
}

{
  // Pool=10, low SERP yield → shortfall measured
  const r = simulateOrchestrator(10, 5, 15);
  assert(r.discoveredCount === 15, 'Pool=10 low-yield: discovered 15');
  assert(r.discoveryTarget === 50, 'Pool=10 low-yield: target was 50');
  assert(r.discoveryShortfallRate === 0.7, 'Pool=10 low-yield: shortfall rate = 0.7');
}

{
  // Pool=0 → deficit=100, capped at 50
  const r = simulateOrchestrator(0, 0, 30);
  assert(r.discoveryTarget === 50, 'Pool=0: target capped at 50');
  assert(r.discoveredCount === 30, 'Pool=0: discovered 30');
  assert(r.assembled === 30, 'Pool=0: total = 30');
  assert(r.discoveryShortfallRate === 0.4, 'Pool=0: shortfall rate = 0.4');
}

// ---------------------------------------------------------------------------
// Test: Snapshot-aware ranking
// ---------------------------------------------------------------------------

console.log('\n--- Snapshot-Aware Ranking ---');

{
  // Candidate with snapshot skills should score higher than textBag-only
  const reqs = makeRequirements({ topSkills: ['React', 'TypeScript', 'Node.js'] });
  const withSnapshot: CandidateForRanking = {
    id: 'snap', headlineHint: 'Engineer', locationHint: null,
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'completed',
    lastEnrichedAt: new Date(Date.now() - 5 * 86400000),
    snapshot: {
      skillsNormalized: ['React', 'TypeScript', 'Node.js', 'PostgreSQL'],
      roleType: 'engineer',
      seniorityBand: 'senior',
      location: 'San Francisco',
      computedAt: new Date(Date.now() - 5 * 86400000),
      staleAfter: new Date(Date.now() + 25 * 86400000),
    },
  };
  const withoutSnapshot: CandidateForRanking = {
    id: 'no-snap', headlineHint: 'Engineer', locationHint: null,
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'completed',
    lastEnrichedAt: new Date(Date.now() - 5 * 86400000),
  };
  const scored = rankCandidates([withSnapshot, withoutSnapshot], reqs);
  const snapScore = scored.find((s) => s.candidateId === 'snap')!.fitScore;
  const noSnapScore = scored.find((s) => s.candidateId === 'no-snap')!.fitScore;
  assert(snapScore > noSnapScore, 'Snapshot candidate scores higher than no-snapshot');
}

{
  // Snapshot seniority used directly (no headline parsing needed)
  const reqs = makeRequirements({ seniorityLevel: 'director' });
  const snapDirector: CandidateForRanking = {
    id: 'snap-dir', headlineHint: 'Some Generic Title', locationHint: null,
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'completed',
    lastEnrichedAt: new Date(),
    snapshot: {
      skillsNormalized: [],
      roleType: null,
      seniorityBand: 'director',
      location: null,
      computedAt: new Date(),
      staleAfter: new Date(Date.now() + 30 * 86400000),
    },
  };
  const scored = rankCandidates([snapDirector], reqs);
  assert(scored[0].fitBreakdown.seniorityScore === 1, 'Snapshot seniority band exact match = 1');
}

{
  // Snapshot location used for scoring
  const reqs = makeRequirements({ location: 'Austin' });
  const snapLoc: CandidateForRanking = {
    id: 'snap-loc', headlineHint: null, locationHint: null,
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'completed',
    lastEnrichedAt: new Date(),
    snapshot: {
      skillsNormalized: [],
      roleType: null,
      seniorityBand: null,
      location: 'Austin, TX',
      computedAt: new Date(),
      staleAfter: new Date(Date.now() + 30 * 86400000),
    },
  };
  const scored = rankCandidates([snapLoc], reqs);
  assert(scored[0].fitBreakdown.locationScore === 1, 'Snapshot location match = 1');
}

{
  // Location alias normalization: Bengaluru should match Bangalore
  const reqs = makeRequirements({ location: 'Bangalore, India' });
  const aliasLoc: CandidateForRanking = {
    id: 'alias-loc', headlineHint: null, locationHint: 'Bengaluru, India',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([aliasLoc], reqs);
  assert(scored[0].fitBreakdown.locationScore === 1, 'Location alias Bengaluru↔Bangalore match = 1');
}

{
  // Country inference must not false-match "us" substring in non-US locations (e.g., Russia)
  const reqs = makeRequirements({ location: 'USA' });
  const russiaLoc: CandidateForRanking = {
    id: 'russia-loc', headlineHint: null, locationHint: 'Moscow, Russia',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([russiaLoc], reqs);
  assert(scored[0].fitBreakdown.locationScore === 0, 'Country inference: Russia does not match USA');
}

{
  // Placeholder location text should never score as a location match
  const reqs = makeRequirements({ location: 'Hyderabad, India' });
  const placeholderLoc: CandidateForRanking = {
    id: 'placeholder-loc', headlineHint: null, locationHint: '...',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([placeholderLoc], reqs);
  assert(scored[0].fitBreakdown.locationScore === 0, "Placeholder location '...' scores 0");
}

{
  // Noisy SERP snippets should be ignored as location evidence
  const reqs = makeRequirements({ location: 'Bangalore, India' });
  const noisyLoc: CandidateForRanking = {
    id: 'noisy-loc', headlineHint: null,
    locationHint: "India. View Example Person's profile on LinkedIn",
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([noisyLoc], reqs);
  assert(scored[0].fitBreakdown.locationScore === 0, 'Noisy LinkedIn snippet location scores 0');
}

{
  // City-constrained searches should not pass on country-only overlap
  const reqs = makeRequirements({ location: 'Delhi, India' });
  const sameCountryOtherCity: CandidateForRanking = {
    id: 'same-country-other-city', headlineHint: null, locationHint: 'Bangalore, India',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([sameCountryOtherCity], reqs);
  assert(scored[0].fitBreakdown.locationScore === 0, 'Delhi target does not match Bangalore by country fallback');
}

{
  // Country-only targets can still use country overlap
  const reqs = makeRequirements({ location: 'India' });
  const countryOnlyMatch: CandidateForRanking = {
    id: 'country-only-match', headlineHint: null, locationHint: 'Bangalore, India',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([countryOnlyMatch], reqs);
  assert(scored[0].fitBreakdown.locationScore === 1, 'Country-only target India matches Bangalore, India');
}

{
  // Snapshot computedAt used for freshness
  const reqs = makeRequirements();
  const snapFresh: CandidateForRanking = {
    id: 'snap-fresh', headlineHint: '', locationHint: null,
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'completed',
    lastEnrichedAt: null, // no lastEnrichedAt
    snapshot: {
      skillsNormalized: [],
      roleType: null,
      seniorityBand: null,
      location: null,
      computedAt: new Date(Date.now() - 10 * 86400000), // 10d ago
      staleAfter: new Date(Date.now() + 20 * 86400000),
    },
  };
  const scored = rankCandidates([snapFresh], reqs);
  assert(scored[0].fitBreakdown.activityFreshnessScore === 1.0,
    'Snapshot computedAt <=30d = 1.0 (even without lastEnrichedAt)');
}

// ---------------------------------------------------------------------------
// Test: Config parsing safety
// ---------------------------------------------------------------------------

console.log('\n--- Config Safety ---');

{
  // Simulate bad env values
  const origTarget = process.env.TARGET_COUNT;
  const origMin = process.env.MIN_GOOD_ENOUGH;
  const origQualityMinAvg = process.env.SOURCE_QUALITY_MIN_AVG_FIT;
  const origQualityThreshold = process.env.SOURCE_QUALITY_THRESHOLD;

  process.env.TARGET_COUNT = 'banana';
  process.env.MIN_GOOD_ENOUGH = '-5';
  process.env.SOURCE_QUALITY_MIN_AVG_FIT = 'not-a-number';
  process.env.SOURCE_QUALITY_THRESHOLD = '2.5'; // clamped to 1
  const config = getSourcingConfig();
  assert(config.targetCount === 100, 'NaN env → fallback 100');
  assert(config.minGoodEnough === 30, 'Negative env → fallback 30');
  assert(config.qualityMinAvgFit === 0.45, 'Invalid quality avg fit → fallback 0.45');
  assert(config.qualityThreshold === 1, 'Quality threshold >1 → clamped to 1');

  // Restore
  if (origTarget !== undefined) process.env.TARGET_COUNT = origTarget;
  else delete process.env.TARGET_COUNT;
  if (origMin !== undefined) process.env.MIN_GOOD_ENOUGH = origMin;
  else delete process.env.MIN_GOOD_ENOUGH;
  if (origQualityMinAvg !== undefined) process.env.SOURCE_QUALITY_MIN_AVG_FIT = origQualityMinAvg;
  else delete process.env.SOURCE_QUALITY_MIN_AVG_FIT;
  if (origQualityThreshold !== undefined) process.env.SOURCE_QUALITY_THRESHOLD = origQualityThreshold;
  else delete process.env.SOURCE_QUALITY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed.');
}
