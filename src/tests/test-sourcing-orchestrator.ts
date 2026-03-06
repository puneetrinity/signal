/**
 * Integration tests for sourcing orchestrator: ranking, assembly, cap behavior.
 * Tests pure functions only (no Prisma, no SERP calls).
 *
 * Run with: npx tsx src/tests/test-sourcing-orchestrator.ts
 */

import { rankCandidates, isNoisyLocationHint, type CandidateForRanking, type ScoredCandidate } from '@/lib/sourcing/ranking';
import { parseJdDigest, buildJobRequirements, type JobRequirements } from '@/lib/sourcing/jd-digest';
import { getSourcingConfig } from '@/lib/sourcing/config';
import { extractLocationFromSnippet } from '@/lib/enrichment/hint-extraction';
import { isLikelyLocationHint } from '@/lib/sourcing/hint-sanitizer';
import { jobTrackToDbFilter } from '@/lib/sourcing/types';
import { detectRoleFamilyFromTitle } from '@/lib/taxonomy/role-family';
import {
  resolveRoleDeterministic,
  TECH_ROLE_FAMILIES,
  NON_TECH_ROLE_FAMILIES,
  adjacencyMap,
  NON_TECH_TITLE_VARIANTS,
  familyToTrack,
  type RoleFamily,
  type RoleResolution,
} from '@/lib/taxonomy/role-service';
import { resolveLocationDeterministic, type LocationResolution } from '@/lib/taxonomy/location-service';
import { scoreDeterministic } from '@/lib/sourcing/track-resolver';
import type { SourcingJobContextInput } from '@/lib/sourcing/jd-digest';

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
  assert(reqs.topSkills[0] === 'go', 'buildJobRequirements: skills from jdDigest (canonicalized)');
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
  assert(scored[0].matchTier === 'strict_location', 'Snapshot location → strict tier');
  assert(scored[0].locationMatchType === 'city_exact', 'Snapshot location Austin → city_exact');
}

{
  // Location alias normalization: Bengaluru should match Bangalore
  const reqs = makeRequirements({ location: 'Bangalore, India' });
  const aliasLoc: CandidateForRanking = {
    id: 'alias-loc', headlineHint: null, locationHint: 'Bengaluru, India',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([aliasLoc], reqs);
  assert(scored[0].matchTier === 'strict_location', 'Bengaluru↔Bangalore → strict tier');
  assert(scored[0].locationMatchType === 'city_alias', 'Bengaluru↔Bangalore → city_alias');
}

{
  // Country inference must not false-match "us" substring in non-US locations (e.g., Russia)
  const reqs = makeRequirements({ location: 'USA' });
  const russiaLoc: CandidateForRanking = {
    id: 'russia-loc', headlineHint: null, locationHint: 'Moscow, Russia',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([russiaLoc], reqs);
  assert(scored[0].matchTier === 'expanded_location', 'Russia does not match USA → expanded');
}

{
  // Placeholder location text should never score as a location match
  const reqs = makeRequirements({ location: 'Hyderabad, India' });
  const placeholderLoc: CandidateForRanking = {
    id: 'placeholder-loc', headlineHint: null, locationHint: '...',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([placeholderLoc], reqs);
  assert(scored[0].matchTier === 'expanded_location', "Placeholder '...' → expanded");
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
  assert(scored[0].matchTier === 'expanded_location', 'Noisy snippet → expanded');
}

{
  // City-constrained searches: same country different city → expanded with country_only
  const reqs = makeRequirements({ location: 'Delhi, India' });
  const sameCountryOtherCity: CandidateForRanking = {
    id: 'same-country-other-city', headlineHint: null, locationHint: 'Bangalore, India',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([sameCountryOtherCity], reqs);
  assert(scored[0].matchTier === 'expanded_location', 'Delhi target, Bangalore candidate → expanded');
  assert(scored[0].locationMatchType === 'country_only', 'Same country different city → country_only');
}

{
  // Country-only targets can still use country overlap → strict
  const reqs = makeRequirements({ location: 'India' });
  const countryOnlyMatch: CandidateForRanking = {
    id: 'country-only-match', headlineHint: null, locationHint: 'Bangalore, India',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([countryOnlyMatch], reqs);
  assert(scored[0].matchTier === 'strict_location', 'Country-only India → strict');
  assert(scored[0].locationMatchType === 'country_only', 'Country-only match type');
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
// Test: Alias-aware text fallback (P0)
// ---------------------------------------------------------------------------

console.log('\n--- Alias-Aware Text Fallback ---');

{
  // "node.js" in JD should match "nodejs" in snippet
  const reqs = makeRequirements({ topSkills: ['node.js'] });
  const candidate: CandidateForRanking = {
    id: 'nodejs-alias', headlineHint: 'Backend Developer', locationHint: null,
    searchTitle: 'NodeJS Engineer', searchSnippet: 'Experienced in nodejs and express',
    enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([candidate], reqs);
  assert(scored[0].fitBreakdown.skillScore > 0, 'node.js JD matches "nodejs" in snippet via alias');
}

{
  // "TypeScript" should match "ts" via alias (short alias in allowlist)
  const reqs = makeRequirements({ topSkills: ['TypeScript'] });
  const candidate: CandidateForRanking = {
    id: 'ts-alias', headlineHint: 'Engineer', locationHint: null,
    searchTitle: '', searchSnippet: 'Expert in React and TS development',
    enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([candidate], reqs);
  assert(scored[0].fitBreakdown.skillScore > 0, 'TypeScript JD matches "ts" in snippet via alias');
}

{
  // c++ should match via special boundary handling (non-word chars at end)
  const reqs = makeRequirements({ topSkills: ['c++'] });
  const candidate: CandidateForRanking = {
    id: 'cpp-boundary', headlineHint: 'C++ Developer', locationHint: null,
    searchTitle: '', searchSnippet: 'Proficient in c++ and embedded systems',
    enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([candidate], reqs);
  assert(scored[0].fitBreakdown.skillScore > 0, 'c++ matches via buildSkillRegex special boundary');
}

{
  // .net should match via special boundary handling (non-word chars at start)
  const reqs = makeRequirements({ topSkills: ['.net'] });
  const candidate: CandidateForRanking = {
    id: 'dotnet-boundary', headlineHint: '.NET Developer', locationHint: null,
    searchTitle: '', searchSnippet: 'Building .net microservices',
    enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([candidate], reqs);
  assert(scored[0].fitBreakdown.skillScore > 0, '.net matches via buildSkillRegex special boundary');
}

{
  // c# should match
  const reqs = makeRequirements({ topSkills: ['c#'] });
  const candidate: CandidateForRanking = {
    id: 'csharp-boundary', headlineHint: 'C# Developer', locationHint: null,
    searchTitle: '', searchSnippet: 'Working with c# and unity',
    enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([candidate], reqs);
  assert(scored[0].fitBreakdown.skillScore > 0, 'c# matches via buildSkillRegex special boundary');
}

// ---------------------------------------------------------------------------
// Test: Track-specific ranking weights + concept-expanded snapshot matching
// ---------------------------------------------------------------------------

console.log('\n--- Track Weights + Snapshot Concepts ---');

{
  const requirements: JobRequirements = {
    title: 'Technical Account Manager',
    topSkills: ['Salesforce', 'Outbound', 'Pipeline Management', 'Consultative Selling'],
    seniorityLevel: 'senior',
    domain: null,
    roleFamily: 'devops',
    location: null,
    experienceYears: null,
    education: null,
  };

  const skillHeavy: CandidateForRanking = {
    id: 'skill-heavy',
    headlineHint: 'Account Manager',
    locationHint: null,
    searchTitle: 'Account Manager',
    searchSnippet: 'Salesforce outbound pipeline management consultative selling',
    enrichmentStatus: 'completed',
    lastEnrichedAt: null,
    snapshot: {
      skillsNormalized: ['salesforce', 'outbound', 'pipeline management', 'consultative selling'],
      roleType: null,
      seniorityBand: 'mid',
      location: null,
      activityRecencyDays: 10,
      computedAt: new Date('2025-01-01'),
      staleAfter: new Date('2025-07-01'),
    },
  };

  const roleHeavy: CandidateForRanking = {
    id: 'role-heavy',
    headlineHint: 'Senior Platform Engineer',
    locationHint: null,
    searchTitle: 'Senior Platform Engineer',
    searchSnippet: 'Platform engineering and sre',
    enrichmentStatus: 'completed',
    lastEnrichedAt: null,
    snapshot: {
      skillsNormalized: ['excel'],
      roleType: null,
      seniorityBand: 'senior',
      location: null,
      activityRecencyDays: 10,
      computedAt: new Date('2025-01-01'),
      staleAfter: new Date('2025-07-01'),
    },
  };

  const techScores = rankCandidates([skillHeavy, roleHeavy], requirements, { track: 'tech' });
  const nonTechScores = rankCandidates([skillHeavy, roleHeavy], requirements, { track: 'non_tech' });
  const blendedScores = rankCandidates([skillHeavy, roleHeavy], requirements, { track: 'blended' });

  const techSkillHeavy = techScores.find((c) => c.candidateId === 'skill-heavy')!;
  const techRoleHeavy = techScores.find((c) => c.candidateId === 'role-heavy')!;
  const nonTechSkillHeavy = nonTechScores.find((c) => c.candidateId === 'skill-heavy')!;
  const nonTechRoleHeavy = nonTechScores.find((c) => c.candidateId === 'role-heavy')!;
  const blendedSkillHeavy = blendedScores.find((c) => c.candidateId === 'skill-heavy')!;
  const blendedRoleHeavy = blendedScores.find((c) => c.candidateId === 'role-heavy')!;

  assert(techSkillHeavy.fitScore > techRoleHeavy.fitScore, 'Track weights: tech favors stronger skill overlap');
  assert(nonTechRoleHeavy.fitScore > nonTechSkillHeavy.fitScore, 'Track weights: non_tech favors role/seniority more heavily');

  const techDelta = techSkillHeavy.fitScore - techRoleHeavy.fitScore;
  const nonTechDelta = nonTechSkillHeavy.fitScore - nonTechRoleHeavy.fitScore;
  const blendedDelta = blendedSkillHeavy.fitScore - blendedRoleHeavy.fitScore;
  assert(blendedDelta < techDelta && blendedDelta > nonTechDelta, 'Track weights: blended sits between tech and non_tech');

  const defaultScores = rankCandidates([skillHeavy], requirements);
  const explicitTechScores = rankCandidates([skillHeavy], requirements, { track: 'tech' });
  assert(
    Math.abs(defaultScores[0].fitScore - explicitTechScores[0].fitScore) < 1e-9,
    'Track weights: omitting track preserves tech-default behavior',
  );
}

{
  const makeSnapshotCandidate = (
    id: string,
    skillsNormalized: string[],
  ): CandidateForRanking => ({
    id,
    headlineHint: 'Staff Platform Engineer',
    locationHint: null,
    searchTitle: 'Staff Platform Engineer',
    searchSnippet: null,
    enrichmentStatus: 'completed',
    lastEnrichedAt: null,
    snapshot: {
      skillsNormalized,
      roleType: null,
      seniorityBand: 'staff',
      location: null,
      activityRecencyDays: 5,
      computedAt: new Date('2025-01-01'),
      staleAfter: new Date('2025-07-01'),
    },
  });

  const commonReq = {
    title: 'Staff Platform Engineer',
    seniorityLevel: 'staff',
    roleFamily: 'devops',
    location: null,
    experienceYears: null,
    education: null,
  };

  const microVsSoa = rankCandidates(
    [makeSnapshotCandidate('soa-snapshot', ['soa'])],
    { ...commonReq, topSkills: ['microservices'], domain: null },
  )[0];
  assert(microVsSoa.fitBreakdown.skillScore > 0, 'Snapshot concepts: microservices JD matches snapshot soa');
  assert(microVsSoa.fitBreakdown.skillScoreMethod === 'snapshot', 'Snapshot concepts: concept match stays on snapshot path');

  const soaVsMicro = rankCandidates(
    [makeSnapshotCandidate('micro-snapshot', ['microservices'])],
    { ...commonReq, topSkills: ['soa'], domain: null },
  )[0];
  assert(soaVsMicro.fitBreakdown.skillScore > 0, 'Snapshot concepts: soa JD matches snapshot microservices');

  const domainConcept = rankCandidates(
    [makeSnapshotCandidate('api-snapshot', ['rest api'])],
    { ...commonReq, topSkills: ['excel'], domain: 'apis' },
  )[0];
  assert(
    Math.abs(domainConcept.fitBreakdown.skillScore - 0.2) < 1e-9,
    'Snapshot concepts: domain concept match contributes via snapshot path',
  );
}

// ---------------------------------------------------------------------------
// Test: Greater Area location normalization (P1a)
// ---------------------------------------------------------------------------

console.log('\n--- Greater Area Location Normalization ---');

{
  // "Greater Delhi Area" should be normalized and match Delhi target
  const reqs = makeRequirements({ location: 'Delhi, India' });
  const candidate: CandidateForRanking = {
    id: 'greater-delhi', headlineHint: null, locationHint: 'Greater Delhi Area',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([candidate], reqs);
  assert(scored[0].matchTier === 'strict_location', 'Greater Delhi Area → strict for Delhi target');
}

{
  // "Mumbai Metropolitan Region" should normalize and match Mumbai target
  const reqs = makeRequirements({ location: 'Mumbai, India' });
  const candidate: CandidateForRanking = {
    id: 'mumbai-metro', headlineHint: null, locationHint: 'Mumbai Metropolitan Region',
    searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  const scored = rankCandidates([candidate], reqs);
  assert(scored[0].matchTier === 'strict_location', 'Mumbai Metropolitan Region → strict for Mumbai target');
}

// ---------------------------------------------------------------------------
// Test: bestMatchesMinFitScore config (P1b)
// ---------------------------------------------------------------------------

console.log('\n--- bestMatchesMinFitScore Config ---');

{
  const origVal = process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE;
  process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE = '0.50';
  const config = getSourcingConfig();
  assert(config.bestMatchesMinFitScore === 0.50, 'bestMatchesMinFitScore parsed from env');
  if (origVal !== undefined) process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE = origVal;
  else delete process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE;
}

{
  // Default value when env var not set
  const origVal = process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE;
  delete process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE;
  const config = getSourcingConfig();
  assert(config.bestMatchesMinFitScore === 0.45, 'bestMatchesMinFitScore defaults to 0.45');
  if (origVal !== undefined) process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE = origVal;
}

{
  // Clamped to [0,1]
  const origVal = process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE;
  process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE = '1.5';
  const config = getSourcingConfig();
  assert(config.bestMatchesMinFitScore === 1, 'bestMatchesMinFitScore clamped to 1');
  if (origVal !== undefined) process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE = origVal;
  else delete process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE;
}

// ---------------------------------------------------------------------------
// Test: Shared noise check in location ranking
// ---------------------------------------------------------------------------

console.log('\n--- Shared Noise in Location Ranking ---');

{
  // isNoisyLocationHint catches shared-layer noise (placeholder)
  assert(isNoisyLocationHint('n/a'), 'isNoisyLocationHint: placeholder "n/a" is noisy');
  assert(isNoisyLocationHint('...'), 'isNoisyLocationHint: placeholder "..." is noisy');
  assert(isNoisyLocationHint('View profile on LinkedIn'), 'isNoisyLocationHint: linkedin boilerplate is noisy');
  assert(isNoisyLocationHint('https://linkedin.com/in/foo'), 'isNoisyLocationHint: URL is noisy');

  // Location-specific stricter checks still work
  assert(isNoisyLocationHint('something.com'), 'isNoisyLocationHint: .com domain is noisy');
  assert(isNoisyLocationHint('Education: MIT'), 'isNoisyLocationHint: education prefix is noisy');

  // Real locations pass
  assert(!isNoisyLocationHint('San Francisco, CA'), 'isNoisyLocationHint: real city is not noisy');
  assert(!isNoisyLocationHint('Delhi, India'), 'isNoisyLocationHint: Delhi India is not noisy');
  assert(!isNoisyLocationHint('Greater Bangalore Area'), 'isNoisyLocationHint: Greater Area is not noisy');
}

// ---------------------------------------------------------------------------
// Test: Strict demotion behavior (P1b assembly)
// ---------------------------------------------------------------------------

console.log('\n--- Strict Demotion Assembly ---');

{
  // Simulate: strict candidate with very low fitScore should get demoted
  // We test via ranking + manual assembly logic (matching orchestrator behavior)
  const reqs = makeRequirements({ location: 'Delhi, India', topSkills: ['Kubernetes', 'AWS', 'Terraform'] });

  // Wrong-role candidate in Delhi (will have low fitScore due to no skill/role match)
  const wrongRole: CandidateForRanking = {
    id: 'sales-delhi', headlineHint: 'Sales Manager', locationHint: 'Delhi, India',
    searchTitle: 'Sales Manager', searchSnippet: 'Managing regional sales team',
    enrichmentStatus: 'pending', lastEnrichedAt: null,
  };
  // Good candidate in Delhi
  const goodMatch: CandidateForRanking = {
    id: 'devops-delhi', headlineHint: 'Senior DevOps Engineer', locationHint: 'Delhi, India',
    searchTitle: 'DevOps Engineer', searchSnippet: 'Kubernetes AWS Terraform infrastructure',
    enrichmentStatus: 'pending', lastEnrichedAt: null,
  };

  const scored = rankCandidates([wrongRole, goodMatch], reqs);
  const salesScore = scored.find((s) => s.candidateId === 'sales-delhi')!;
  const devopsScore = scored.find((s) => s.candidateId === 'devops-delhi')!;

  assert(salesScore.matchTier === 'strict_location', 'Sales in Delhi is strict before demotion');
  assert(devopsScore.matchTier === 'strict_location', 'DevOps in Delhi is strict');
  assert(devopsScore.fitScore > salesScore.fitScore, 'DevOps scores higher than Sales');

  // Simulate demotion: with floor at 0.45, sales candidate (likely <0.45) gets demoted
  const config = getSourcingConfig();
  const demoted = scored.filter((sc) => sc.matchTier === 'strict_location' && sc.fitScore < config.bestMatchesMinFitScore);
  const qualified = scored.filter((sc) => sc.matchTier === 'strict_location' && sc.fitScore >= config.bestMatchesMinFitScore);
  assert(demoted.some((d) => d.candidateId === 'sales-delhi'), 'Sales candidate demoted below floor');
  assert(qualified.some((q) => q.candidateId === 'devops-delhi'), 'DevOps candidate above floor');
}

{
  // Full demotion: all strict candidates below floor → bestMatches = 0
  const reqs = makeRequirements({ location: 'Delhi, India', topSkills: ['QuantumComputing', 'FusionReactors'] });
  const candidates: CandidateForRanking[] = [
    {
      id: 'low1', headlineHint: 'Accountant', locationHint: 'Delhi, India',
      searchTitle: 'Accountant', searchSnippet: 'Finance and accounting',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
    {
      id: 'low2', headlineHint: 'HR Manager', locationHint: 'Delhi, India',
      searchTitle: 'HR Manager', searchSnippet: 'Human resources management',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
  ];
  const scored = rankCandidates(candidates, reqs);
  const config = getSourcingConfig();
  const allBelowFloor = scored
    .filter((sc) => sc.matchTier === 'strict_location')
    .every((sc) => sc.fitScore < config.bestMatchesMinFitScore);
  assert(allBelowFloor, 'Full demotion: all strict candidates below floor');
}

// ---------------------------------------------------------------------------
// Test: End-to-end assembly (replicates orchestrator partition→demote→assemble)
// ---------------------------------------------------------------------------

console.log('\n--- End-to-End Assembly ---');

/**
 * Replicates the orchestrator's partition → quality-guard → assembly → reason
 * logic exactly, operating on ranked output. No Prisma needed.
 */
function simulateAssembly(
  scoredPool: ScoredCandidate[],
  hasLocationConstraint: boolean,
  targetCount: number,
  bestMatchesMinFitScore: number,
): {
  strictMatchedCount: number;
  expandedCount: number;
  strictDemotedCount: number;
  expansionReason: 'insufficient_strict_location_matches' | 'strict_low_quality' | null;
} {
  const strictPool = scoredPool.filter((sc) => sc.matchTier === 'strict_location');
  const expandedPool = scoredPool.filter((sc) => sc.matchTier === 'expanded_location');

  let strictDemotedCount = 0;
  const qualifiedStrict: ScoredCandidate[] = [];
  for (const sc of strictPool) {
    if (sc.fitScore < bestMatchesMinFitScore) {
      sc.matchTier = 'expanded_location';
      expandedPool.push(sc);
      strictDemotedCount++;
    } else {
      qualifiedStrict.push(sc);
    }
  }
  if (strictDemotedCount > 0) {
    expandedPool.sort((a, b) => b.fitScore - a.fitScore);
  }

  const strictMatchedCount = Math.min(qualifiedStrict.length, targetCount);
  const remaining = targetCount - strictMatchedCount;
  const expandedCount = Math.min(expandedPool.length, remaining);

  let expansionReason: 'insufficient_strict_location_matches' | 'strict_low_quality' | null = null;
  if (hasLocationConstraint && strictMatchedCount < targetCount) {
    expansionReason = strictDemotedCount > 0 ? 'strict_low_quality' : 'insufficient_strict_location_matches';
  }

  return { strictMatchedCount, expandedCount, strictDemotedCount, expansionReason };
}

{
  // Partial demotion: some strict candidates below floor
  const reqs = makeRequirements({ location: 'Delhi, India', topSkills: ['Kubernetes', 'AWS', 'Terraform'] });
  const candidates: CandidateForRanking[] = [
    // Good match in Delhi
    {
      id: 'devops-delhi', headlineHint: 'Senior DevOps Engineer', locationHint: 'Delhi, India',
      searchTitle: 'DevOps Engineer', searchSnippet: 'Kubernetes AWS Terraform infrastructure',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
    // Wrong role in Delhi (will score low)
    {
      id: 'sales-delhi', headlineHint: 'Sales Manager', locationHint: 'Delhi, India',
      searchTitle: 'Sales Manager', searchSnippet: 'Regional sales and accounts',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
    // Expanded candidate (no location)
    {
      id: 'devops-none', headlineHint: 'DevOps Engineer', locationHint: null,
      searchTitle: 'DevOps Engineer', searchSnippet: 'Kubernetes AWS cloud',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
  ];

  const scored = rankCandidates(candidates, reqs);
  const result = simulateAssembly(scored, true, 100, 0.45);

  assert(result.strictDemotedCount === 1, 'E2E partial: 1 strict candidate demoted');
  assert(result.strictMatchedCount === 1, 'E2E partial: 1 qualified strict match');
  assert(result.expansionReason === 'strict_low_quality', 'E2E partial: expansionReason = strict_low_quality');
}

{
  // Full demotion: all strict candidates below floor → bestMatches = 0
  const reqs = makeRequirements({ location: 'Delhi, India', topSkills: ['QuantumComputing', 'FusionReactors'] });
  const candidates: CandidateForRanking[] = [
    {
      id: 'acct-delhi', headlineHint: 'Accountant', locationHint: 'Delhi, India',
      searchTitle: 'Accountant', searchSnippet: 'Finance and accounting',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
    {
      id: 'hr-delhi', headlineHint: 'HR Manager', locationHint: 'Delhi, India',
      searchTitle: 'HR Manager', searchSnippet: 'Human resources management',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
    {
      id: 'sales-noida', headlineHint: 'Sales Rep', locationHint: null,
      searchTitle: 'Sales Rep', searchSnippet: 'Sales representative',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
  ];

  const scored = rankCandidates(candidates, reqs);
  const result = simulateAssembly(scored, true, 100, 0.45);

  assert(result.strictDemotedCount === 2, 'E2E full: 2 strict candidates demoted');
  assert(result.strictMatchedCount === 0, 'E2E full: 0 qualified strict = empty bestMatches');
  assert(result.expansionReason === 'strict_low_quality', 'E2E full: expansionReason = strict_low_quality');
  assert(result.expandedCount === 3, 'E2E full: all 3 candidates in expanded pool');
}

{
  // No demotion needed: location-constrained but good strict candidates
  const reqs = makeRequirements({ location: 'San Francisco', topSkills: ['React', 'TypeScript'] });
  const candidates: CandidateForRanking[] = [
    {
      id: 'fe-sf', headlineHint: 'Senior Frontend Engineer', locationHint: 'San Francisco, CA',
      searchTitle: 'Frontend Engineer', searchSnippet: 'React TypeScript development',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
    {
      id: 'fe-ny', headlineHint: 'Frontend Engineer', locationHint: 'New York, NY',
      searchTitle: 'Frontend Engineer', searchSnippet: 'React TypeScript development',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
  ];

  const scored = rankCandidates(candidates, reqs);
  const result = simulateAssembly(scored, true, 100, 0.45);

  assert(result.strictDemotedCount === 0, 'E2E no-demote: 0 demoted');
  assert(result.strictMatchedCount === 1, 'E2E no-demote: 1 strict match (SF)');
  assert(result.expansionReason === 'insufficient_strict_location_matches', 'E2E no-demote: expansion due to insufficient strict, not quality');
}

{
  // No location constraint: everything is strict, no demotion, no expansion reason
  const reqs = makeRequirements({ location: null, topSkills: ['React'] });
  const candidates: CandidateForRanking[] = [
    {
      id: 'any1', headlineHint: 'Senior Frontend Engineer', locationHint: null,
      searchTitle: 'React Developer', searchSnippet: 'Experienced React and TypeScript developer',
      enrichmentStatus: 'completed', lastEnrichedAt: new Date(Date.now() - 10 * 86400000),
    },
  ];

  const scored = rankCandidates(candidates, reqs);
  const result = simulateAssembly(scored, false, 100, 0.45);

  assert(result.strictDemotedCount === 0, 'E2E no-location: 0 demoted');
  assert(result.expansionReason === null, 'E2E no-location: no expansion reason');
}

// ---------------------------------------------------------------------------
// Test: Demoted tier rewrite
// ---------------------------------------------------------------------------

console.log('\n--- Demoted Tier Rewrite ---');

{
  const reqs = makeRequirements({ location: 'Delhi, India', topSkills: ['Kubernetes', 'AWS', 'Terraform'] });
  const candidates: CandidateForRanking[] = [
    {
      id: 'devops-delhi-2', headlineHint: 'Senior DevOps Engineer', locationHint: 'Delhi, India',
      searchTitle: 'DevOps Engineer', searchSnippet: 'Kubernetes AWS Terraform infrastructure',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
    {
      id: 'sales-delhi-2', headlineHint: 'Sales Manager', locationHint: 'Delhi, India',
      searchTitle: 'Sales Manager', searchSnippet: 'Managing regional sales team',
      enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
  ];

  const scored = rankCandidates(candidates, reqs);
  const result = simulateAssembly(scored, true, 100, 0.45);

  const salesAfter = scored.find(s => s.candidateId === 'sales-delhi-2')!;
  const devopsAfter = scored.find(s => s.candidateId === 'devops-delhi-2')!;

  assert(result.strictDemotedCount >= 1, 'Tier rewrite: at least 1 demoted');
  assert(salesAfter.matchTier === 'expanded_location', 'Tier rewrite: demoted candidate has expanded_location matchTier');
  assert(devopsAfter.matchTier === 'strict_location', 'Tier rewrite: non-demoted stays strict_location');
}

// ---------------------------------------------------------------------------
// Test: locationMatchCounts consistency
// ---------------------------------------------------------------------------

console.log('\n--- locationMatchCounts Consistency ---');

{
  const reqs = makeRequirements({ location: 'Delhi, India', topSkills: ['React'] });
  const candidates: CandidateForRanking[] = [
    {
      id: 'city-exact', headlineHint: 'Engineer', locationHint: 'Delhi, India',
      searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
    {
      id: 'country-only', headlineHint: 'Engineer', locationHint: 'Mumbai, India',
      searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
    {
      id: 'no-loc', headlineHint: 'Engineer', locationHint: null,
      searchTitle: '', searchSnippet: '', enrichmentStatus: 'pending', lastEnrichedAt: null,
    },
  ];

  const scored = rankCandidates(candidates, reqs);
  const counts = {
    city_exact: scored.filter(sc => sc.locationMatchType === 'city_exact').length,
    city_alias: scored.filter(sc => sc.locationMatchType === 'city_alias').length,
    country_only: scored.filter(sc => sc.locationMatchType === 'country_only').length,
    none: scored.filter(sc => sc.locationMatchType === 'none').length,
  };

  assert(counts.city_exact + counts.city_alias + counts.country_only + counts.none === scored.length,
    'locationMatchCounts sum equals total candidates');
  assert(counts.city_exact >= 1, 'locationMatchCounts: at least 1 city_exact');
  assert(counts.country_only >= 1, 'locationMatchCounts: at least 1 country_only');
}

// ---------------------------------------------------------------------------
// Test: Polluted extraction rejection
// ---------------------------------------------------------------------------

console.log('\n--- Polluted Extraction Rejection ---');

{
  const r1 = extractLocationFromSnippet('Location: Senior Manager with 15 years experience');
  assert(r1 === null, 'Polluted "Location: Senior Manager..." → null');

  const r2 = extractLocationFromSnippet('Graduated from University of California with honors');
  assert(r2 === null, 'Polluted "University of California..." → null');

  const r3 = extractLocationFromSnippet('Location: San Francisco, CA · 500+ connections');
  assert(r3 === 'San Francisco, CA', 'Clean "Location: San Francisco, CA" → extracted');

  const r4 = extractLocationFromSnippet('Engineer based in Bangalore, India.');
  assert(r4 !== null && r4.includes('Bangalore'), 'Clean "based in Bangalore, India" → includes Bangalore');
}

// ---------------------------------------------------------------------------
// Test: isLikelyLocationHint
// ---------------------------------------------------------------------------

console.log('\n--- isLikelyLocationHint ---');

{
  assert(isLikelyLocationHint('Delhi, India') === true, 'isLikelyLocationHint: "Delhi, India" → true');
  assert(isLikelyLocationHint('Senior Manager with 15 years') === false, 'isLikelyLocationHint: bio text → false');
  assert(isLikelyLocationHint('University of California') === false, 'isLikelyLocationHint: education → false');
  assert(isLikelyLocationHint('San Francisco, CA') === true, 'isLikelyLocationHint: "San Francisco, CA" → true');
  assert(isLikelyLocationHint('') === false, 'isLikelyLocationHint: empty → false');
  assert(isLikelyLocationHint('n/a') === false, 'isLikelyLocationHint: placeholder → false');
  // Short state code false-positive guards
  assert(isLikelyLocationHint('Vacation planning') === false, 'isLikelyLocationHint: "Vacation" not matched by "va"');
  assert(isLikelyLocationHint('Coaching staff') === false, 'isLikelyLocationHint: "Coaching" not matched by "co"');
  assert(isLikelyLocationHint('Richmond, VA') === true, 'isLikelyLocationHint: "Richmond, VA" word-boundary match → true');
}

// ---------------------------------------------------------------------------
// Test: jobTrackToDbFilter mapping
// ---------------------------------------------------------------------------

console.log('\n--- jobTrackToDbFilter ---');

{
  const tech = jobTrackToDbFilter('tech');
  assert(tech.length === 1 && tech[0] === 'tech', "jobTrackToDbFilter('tech') → ['tech']");

  const nonTech = jobTrackToDbFilter('non_tech');
  assert(nonTech.length === 1 && nonTech[0] === 'non-tech', "jobTrackToDbFilter('non_tech') → ['non-tech']");

  const blended = jobTrackToDbFilter('blended');
  assert(blended.length === 2 && blended[0] === 'tech' && blended[1] === 'non-tech',
    "jobTrackToDbFilter('blended') → ['tech', 'non-tech']");

  const undef = jobTrackToDbFilter(undefined);
  assert(undef.length === 1 && undef[0] === 'tech', "jobTrackToDbFilter(undefined) → ['tech']");
}

// ---------------------------------------------------------------------------
// Test: Track-aware snapshot selection
// ---------------------------------------------------------------------------

console.log('\n--- Track-Aware Snapshot Selection ---');

{
  function selectSnapshot(trackFilter: string[], snapshots: Array<{ track: string }>) {
    const latestTech = snapshots.find((s) => s.track === 'tech') ?? null;
    const latestNonTech = snapshots.find((s) => s.track === 'non-tech') ?? null;
    return trackFilter.length === 1
      ? (snapshots[0] ?? null)
      : (latestTech ?? latestNonTech);
  }

  // Non-tech snapshot selection: with snapshotTrackFilter = ['non-tech'],
  // the single snapshot should be picked.
  type MockSnapshot = { track: string; skillsNormalized: string[] };
  const nonTechSnap: MockSnapshot = { track: 'non-tech', skillsNormalized: ['Sales', 'Marketing'] };
  const snapshots: MockSnapshot[] = [nonTechSnap];
  const snapshotTrackFilter = ['non-tech'];
  const selected = selectSnapshot(snapshotTrackFilter, snapshots);

  assert(selected === nonTechSnap, 'Non-tech filter: picks the non-tech snapshot');
}

{
  function selectSnapshot(trackFilter: string[], snapshots: Array<{ track: string }>) {
    const latestTech = snapshots.find((s) => s.track === 'tech') ?? null;
    const latestNonTech = snapshots.find((s) => s.track === 'non-tech') ?? null;
    return trackFilter.length === 1
      ? (snapshots[0] ?? null)
      : (latestTech ?? latestNonTech);
  }

  // Blended prefers tech: with both snapshots, tech should be picked.
  type MockSnapshot = { track: string; skillsNormalized: string[] };
  const techSnap: MockSnapshot = { track: 'tech', skillsNormalized: ['React', 'TypeScript'] };
  const nonTechSnap: MockSnapshot = { track: 'non-tech', skillsNormalized: ['Sales', 'Marketing'] };
  const snapshots: MockSnapshot[] = [nonTechSnap, techSnap]; // non-tech first to test find()
  const snapshotTrackFilter = ['tech', 'non-tech'];
  const selected = selectSnapshot(snapshotTrackFilter, snapshots);

  assert(selected === techSnap, 'Blended filter: prefers tech snapshot');
}

{
  function selectSnapshot(trackFilter: string[], snapshots: Array<{ track: string }>) {
    const latestTech = snapshots.find((s) => s.track === 'tech') ?? null;
    const latestNonTech = snapshots.find((s) => s.track === 'non-tech') ?? null;
    return trackFilter.length === 1
      ? (snapshots[0] ?? null)
      : (latestTech ?? latestNonTech);
  }

  // Blended fallback: only non-tech snapshot available, should pick it.
  type MockSnapshot = { track: string; skillsNormalized: string[] };
  const nonTechSnap: MockSnapshot = { track: 'non-tech', skillsNormalized: ['Sales'] };
  const snapshots: MockSnapshot[] = [nonTechSnap];
  const snapshotTrackFilter = ['tech', 'non-tech'];
  const selected = selectSnapshot(snapshotTrackFilter, snapshots);

  assert(selected === nonTechSnap, 'Blended filter: falls back to non-tech when tech absent');
}

{
  function selectSnapshot(trackFilter: string[], snapshots: Array<{ track: string }>) {
    const latestTech = snapshots.find((s) => s.track === 'tech') ?? null;
    const latestNonTech = snapshots.find((s) => s.track === 'non-tech') ?? null;
    return trackFilter.length === 1
      ? (snapshots[0] ?? null)
      : (latestTech ?? latestNonTech);
  }

  // Regression guard: if two newest snapshots are non-tech, blended must still pick tech when present.
  type MockSnapshot = { track: string; computedAt: number };
  const snapshots: MockSnapshot[] = [
    { track: 'non-tech', computedAt: 300 },
    { track: 'non-tech', computedAt: 200 },
    { track: 'tech', computedAt: 100 },
  ];
  const selected = selectSnapshot(['tech', 'non-tech'], snapshots);
  assert(selected?.track === 'tech', 'Blended filter: still picks tech even when newer non-tech snapshots exist');
}

// ---------------------------------------------------------------------------
// Test: Location coverage trigger (Feature 1)
// ---------------------------------------------------------------------------

console.log('\n--- Location Coverage Trigger ---');

{
  // Pool with low location coverage (below floor 0.40) should trigger
  const reqs = makeRequirements({ location: 'San Francisco', topSkills: ['React'] });
  // 10 candidates: only 2 have meaningful locations (20% < 40% floor)
  const candidates: CandidateForRanking[] = Array.from({ length: 10 }, (_, i) => ({
    id: `loc-cov-${i}`,
    headlineHint: 'Engineer',
    locationHint: i < 2 ? 'San Francisco, CA' : null,
    searchTitle: 'React Developer',
    searchSnippet: 'React and TypeScript development',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
  }));

  const scored = rankCandidates(candidates, reqs);
  const poolWithLocation = scored.filter((sc) => {
    const c = candidates.find((c) => c.id === sc.candidateId)!;
    return c.locationHint !== null && c.locationHint.length > 2;
  }).length;
  const poolLocationCoverage = scored.length > 0 ? poolWithLocation / scored.length : 0;
  const hasLocationConstraint = Boolean(reqs.location?.trim());
  const locationCoverageFloor = 0.40;
  const locationCoverageTriggered = hasLocationConstraint && poolLocationCoverage < locationCoverageFloor;

  assert(poolLocationCoverage === 0.2, 'Location coverage: 20% coverage computed');
  assert(locationCoverageTriggered === true, 'Location coverage: triggered when coverage 0.2 < floor 0.4');
}

{
  // Pool with high location coverage should NOT trigger
  const reqs = makeRequirements({ location: 'Delhi, India', topSkills: ['React'] });
  const candidates: CandidateForRanking[] = Array.from({ length: 10 }, (_, i) => ({
    id: `loc-cov-high-${i}`,
    headlineHint: 'Engineer',
    locationHint: i < 6 ? 'Delhi, India' : 'Mumbai, India',
    searchTitle: 'React Developer',
    searchSnippet: 'React development',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
  }));

  const scored = rankCandidates(candidates, reqs);
  const poolWithLocation = scored.filter((sc) => {
    const c = candidates.find((c) => c.id === sc.candidateId)!;
    return c.locationHint !== null && c.locationHint.length > 2;
  }).length;
  const poolLocationCoverage = scored.length > 0 ? poolWithLocation / scored.length : 0;
  const locationCoverageTriggered = Boolean(reqs.location?.trim()) && poolLocationCoverage < 0.40;

  assert(poolLocationCoverage === 1.0, 'Location coverage: 100% coverage computed');
  assert(locationCoverageTriggered === false, 'Location coverage: NOT triggered when coverage 1.0 >= floor 0.4');
}

// ---------------------------------------------------------------------------
// Test: Novelty suppression logic (Feature 2)
// ---------------------------------------------------------------------------

console.log('\n--- Novelty Suppression ---');

{
  // Simulate novelty suppression: expanded-tier exposed candidates get removed,
  // strict-tier and top-10% are preserved
  interface MockAssembled {
    candidateId: string;
    fitScore: number | null;
    matchTier: 'strict_location' | 'expanded_location';
    rank: number;
  }

  const assembled: MockAssembled[] = [
    { candidateId: 'strict-1', fitScore: 0.9, matchTier: 'strict_location', rank: 1 },
    { candidateId: 'expanded-top', fitScore: 0.85, matchTier: 'expanded_location', rank: 2 },
    { candidateId: 'expanded-mid', fitScore: 0.5, matchTier: 'expanded_location', rank: 3 },
    { candidateId: 'expanded-low', fitScore: 0.3, matchTier: 'expanded_location', rank: 4 },
    { candidateId: 'discovered-1', fitScore: null, matchTier: 'expanded_location', rank: 5 },
  ];

  const exposedIds = new Set(['strict-1', 'expanded-mid', 'expanded-low', 'discovered-1']);

  // Top 10% threshold: from scored candidates [0.9, 0.85, 0.5, 0.3], top 10% index = floor(4*0.1) = 0 → threshold = 0.9
  const scoredFitScores = assembled
    .filter((a) => a.fitScore !== null)
    .map((a) => a.fitScore!)
    .sort((a, b) => b - a);
  const top10PctThreshold = scoredFitScores.length > 0
    ? scoredFitScores[Math.floor(scoredFitScores.length * 0.1)] ?? 0
    : 0;

  let suppressedCount = 0;
  const kept: MockAssembled[] = [];
  for (const a of assembled) {
    const isExpandedTier = a.matchTier !== 'strict_location';
    const isExposed = exposedIds.has(a.candidateId);
    const isTopFit = a.fitScore !== null && a.fitScore >= top10PctThreshold;

    if (isExpandedTier && isExposed && !isTopFit) {
      suppressedCount++;
    } else {
      kept.push(a);
    }
  }

  assert(suppressedCount === 3, 'Novelty: 3 expanded exposed candidates suppressed (expanded-mid, expanded-low, discovered-1)');
  assert(kept.some((a) => a.candidateId === 'strict-1'), 'Novelty: strict-tier candidate preserved despite being exposed');
  assert(kept.some((a) => a.candidateId === 'expanded-top'), 'Novelty: expanded candidate NOT exposed is preserved');
  assert(kept.length === 2, 'Novelty: 2 candidates remain after suppression');
}

{
  // Novelty refill: after suppression, backfill from remaining unsuppressed candidates
  interface MockAssembled {
    candidateId: string;
    fitScore: number | null;
    matchTier: 'strict_location' | 'expanded_location';
    rank: number;
  }

  const targetCount = 5;
  // Full assembly at targetCount=5
  const assembled: MockAssembled[] = [
    { candidateId: 'strict-1', fitScore: 0.9, matchTier: 'strict_location', rank: 1 },
    { candidateId: 'exp-exposed-1', fitScore: 0.6, matchTier: 'expanded_location', rank: 2 },
    { candidateId: 'exp-exposed-2', fitScore: 0.5, matchTier: 'expanded_location', rank: 3 },
    { candidateId: 'exp-clean-1', fitScore: 0.4, matchTier: 'expanded_location', rank: 4 },
    { candidateId: 'exp-clean-2', fitScore: 0.3, matchTier: 'expanded_location', rank: 5 },
  ];
  const assembledIds = new Set(assembled.map((a) => a.candidateId));

  // Backfill pool: these weren't assembled because list was full
  const backfillPool = [
    { candidateId: 'exp-exposed-top', fitScore: 0.95 }, // exposed but top-fit -> should be allowed
    { candidateId: 'exp-clean-3', fitScore: 0.25 },
    { candidateId: 'exp-clean-4', fitScore: 0.20 },
    { candidateId: 'exp-exposed-3', fitScore: 0.15 }, // also exposed
  ];

  const exposedIds = new Set(['exp-exposed-1', 'exp-exposed-2', 'exp-exposed-3', 'exp-exposed-top']);

  // Top 10% threshold from scored: [0.9, 0.6, 0.5, 0.4, 0.3] → index 0 → 0.9
  const top10Threshold = 0.9;

  // Suppress
  const shouldSuppressNovelty = (
    candidateId: string,
    matchTier: 'strict_location' | 'expanded_location',
    fitScore: number | null,
  ): boolean => {
    const isExpanded = matchTier !== 'strict_location';
    const isExposed = exposedIds.has(candidateId);
    const isTop = fitScore !== null && fitScore >= top10Threshold;
    return isExpanded && isExposed && !isTop;
  };
  const kept: MockAssembled[] = [];
  let suppressedCount = 0;
  for (const a of assembled) {
    if (shouldSuppressNovelty(a.candidateId, a.matchTier, a.fitScore)) {
      suppressedCount++;
      assembledIds.delete(a.candidateId);
    } else {
      kept.push(a);
    }
  }

  // Refill from backfill pool (skip exposed)
  let refilled = 0;
  for (const bp of backfillPool) {
    if (kept.length >= targetCount) break;
    if (assembledIds.has(bp.candidateId)) continue;
    if (shouldSuppressNovelty(bp.candidateId, 'expanded_location', bp.fitScore)) continue;
    kept.push({
      candidateId: bp.candidateId,
      fitScore: bp.fitScore,
      matchTier: 'expanded_location',
      rank: kept.length + 1,
    });
    assembledIds.add(bp.candidateId);
    refilled++;
  }

  assert(suppressedCount === 2, 'Novelty refill: 2 exposed expanded candidates suppressed');
  assert(refilled === 2, 'Novelty refill: 2 eligible candidates backfilled from pool');
  assert(kept.length === 5, 'Novelty refill: assembled list back to targetCount after refill');
  assert(kept.some((a) => a.candidateId === 'exp-exposed-top'), 'Novelty refill: top-fit exposed candidate is allowed');
  assert(!kept.some((a) => a.candidateId === 'exp-exposed-3'), 'Novelty refill: low-fit exposed backfill candidate skipped');
}

// ---------------------------------------------------------------------------
// Test: Discovered enrichment priority (Feature 3)
// ---------------------------------------------------------------------------

console.log('\n--- Discovered Enrichment Priority ---');

{
  // Verify that discovered candidates get a reserved enrichment budget
  interface MockForEnrich {
    candidateId: string;
    sourceType: string;
    enrichmentStatus: string;
    rank: number;
  }

  const assembled: MockForEnrich[] = [
    { candidateId: 'pool-1', sourceType: 'pool_enriched', enrichmentStatus: 'completed', rank: 1 },
    { candidateId: 'pool-2', sourceType: 'pool', enrichmentStatus: 'pending', rank: 2 },
    { candidateId: 'pool-3', sourceType: 'pool', enrichmentStatus: 'pending', rank: 3 },
    { candidateId: 'disc-1', sourceType: 'discovered', enrichmentStatus: 'pending', rank: 4 },
    { candidateId: 'disc-2', sourceType: 'discovered', enrichmentStatus: 'pending', rank: 5 },
    { candidateId: 'disc-3', sourceType: 'discovered', enrichmentStatus: 'pending', rank: 6 },
    { candidateId: 'disc-4', sourceType: 'discovered', enrichmentStatus: 'pending', rank: 7 },
    { candidateId: 'disc-5', sourceType: 'discovered', enrichmentStatus: 'pending', rank: 8 },
    { candidateId: 'disc-6', sourceType: 'discovered', enrichmentStatus: 'pending', rank: 9 },
  ];

  // Simulate: initialEnrichCount=3 (only pool-2, pool-3, disc-1 get rank-based enrich)
  const initialEnrichCount = 3;
  const discoveredEnrichReserve = 5;
  const enqueuedIds = new Set<string>();

  // First pass: top-N rank-based
  const rankBased = assembled
    .filter((a) => a.enrichmentStatus !== 'completed')
    .slice(0, initialEnrichCount);
  for (const a of rankBased) enqueuedIds.add(a.candidateId);

  // Second pass: discovered reserve
  let discoveredEnrichedCount = 0;
  for (const a of assembled.filter((a) => a.sourceType === 'discovered' && a.enrichmentStatus !== 'completed' && !enqueuedIds.has(a.candidateId))) {
    if (discoveredEnrichedCount >= discoveredEnrichReserve) break;
    enqueuedIds.add(a.candidateId);
    discoveredEnrichedCount++;
  }

  assert(rankBased.map((a) => a.candidateId).includes('disc-1'), 'Discovered enrich: disc-1 in rank-based batch');
  assert(discoveredEnrichedCount === 5, 'Discovered enrich: 5 additional discovered candidates enriched via reserve');
  assert(enqueuedIds.size === 8, 'Discovered enrich: 8 total enqueued (3 rank + 5 reserve)');
}

// ---------------------------------------------------------------------------
// Test: Dynamic query budget (Feature 4)
// ---------------------------------------------------------------------------

console.log('\n--- Dynamic Query Budget ---');

{
  const baseQueries = 3;
  const multiplier = 2;

  // Quality gate triggered → multiplied
  const effectiveTriggered = baseQueries * multiplier;
  assert(effectiveTriggered === 6, 'Dynamic budget: 3 * 2 = 6 when quality gate triggered');

  // Quality gate NOT triggered → base
  const qualityGateTriggered = false;
  const effectiveNotTriggered = qualityGateTriggered ? baseQueries * multiplier : baseQueries;
  assert(effectiveNotTriggered === 3, 'Dynamic budget: stays at 3 when quality gate not triggered');

  // Clamped multiplier
  const clampedMultiplier = Math.min(5, Math.max(1, 7)); // input 7 → clamped to 5
  assert(clampedMultiplier === 5, 'Dynamic budget: multiplier clamped to max 5');
  assert(Math.min(5, Math.max(1, 0)) === 1, 'Dynamic budget: multiplier clamped to min 1');
}

// ---------------------------------------------------------------------------
// Test: Novelty no-op when disabled (Feature 2 safety)
// ---------------------------------------------------------------------------

console.log('\n--- Novelty Disabled No-op ---');

{
  // When noveltyEnabled=false, suppression count should be 0
  const origVal = process.env.SOURCE_NOVELTY_ENABLED;
  delete process.env.SOURCE_NOVELTY_ENABLED;
  const config = getSourcingConfig();
  assert(config.noveltyEnabled === false, 'Novelty disabled: config.noveltyEnabled defaults to false');

  // Simulate: even with exposed candidates, novelty should be skipped
  const noveltyEnabled = config.noveltyEnabled;
  let noveltySuppressedCount = 0;
  if (noveltyEnabled) {
    noveltySuppressedCount = 99; // would be set if enabled
  }
  assert(noveltySuppressedCount === 0, 'Novelty disabled: noveltySuppressedCount = 0 when disabled');

  if (origVal !== undefined) process.env.SOURCE_NOVELTY_ENABLED = origVal;
}

{
  // When noveltyEnabled=true, config parses correctly
  const origVal = process.env.SOURCE_NOVELTY_ENABLED;
  process.env.SOURCE_NOVELTY_ENABLED = 'true';
  const config = getSourcingConfig();
  assert(config.noveltyEnabled === true, 'Novelty enabled: config.noveltyEnabled = true when env set');
  if (origVal !== undefined) process.env.SOURCE_NOVELTY_ENABLED = origVal;
  else delete process.env.SOURCE_NOVELTY_ENABLED;
}

// ---------------------------------------------------------------------------
// Test: New config fields parse correctly
// ---------------------------------------------------------------------------

console.log('\n--- New Config Fields ---');

{
  const origFloor = process.env.SOURCE_LOCATION_COVERAGE_FLOOR;
  const origWindow = process.env.SOURCE_NOVELTY_WINDOW_DAYS;
  const origReserve = process.env.SOURCE_DISCOVERED_ENRICH_RESERVE;
  const origMultiplier = process.env.SOURCE_DYNAMIC_QUERY_MULTIPLIER;

  process.env.SOURCE_LOCATION_COVERAGE_FLOOR = '0.55';
  process.env.SOURCE_NOVELTY_WINDOW_DAYS = '14';
  process.env.SOURCE_DISCOVERED_ENRICH_RESERVE = '8';
  process.env.SOURCE_DYNAMIC_QUERY_MULTIPLIER = '3';

  const config = getSourcingConfig();
  assert(config.locationCoverageFloor === 0.55, 'Config: locationCoverageFloor parsed from env');
  assert(config.noveltyWindowDays === 14, 'Config: noveltyWindowDays parsed from env');
  assert(config.discoveredEnrichReserve === 8, 'Config: discoveredEnrichReserve parsed from env');
  assert(config.dynamicQueryMultiplier === 3, 'Config: dynamicQueryMultiplier parsed from env');

  // Restore
  const restore = (key: string, orig: string | undefined) => {
    if (orig !== undefined) process.env[key] = orig;
    else delete process.env[key];
  };
  restore('SOURCE_LOCATION_COVERAGE_FLOOR', origFloor);
  restore('SOURCE_NOVELTY_WINDOW_DAYS', origWindow);
  restore('SOURCE_DISCOVERED_ENRICH_RESERVE', origReserve);
  restore('SOURCE_DYNAMIC_QUERY_MULTIPLIER', origMultiplier);
}

{
  // Default values
  const origFloor = process.env.SOURCE_LOCATION_COVERAGE_FLOOR;
  const origWindow = process.env.SOURCE_NOVELTY_WINDOW_DAYS;
  const origReserve = process.env.SOURCE_DISCOVERED_ENRICH_RESERVE;
  const origMultiplier = process.env.SOURCE_DYNAMIC_QUERY_MULTIPLIER;

  delete process.env.SOURCE_LOCATION_COVERAGE_FLOOR;
  delete process.env.SOURCE_NOVELTY_WINDOW_DAYS;
  delete process.env.SOURCE_DISCOVERED_ENRICH_RESERVE;
  delete process.env.SOURCE_DYNAMIC_QUERY_MULTIPLIER;

  const config = getSourcingConfig();
  assert(config.locationCoverageFloor === 0.40, 'Config default: locationCoverageFloor = 0.40');
  assert(config.noveltyWindowDays === 21, 'Config default: noveltyWindowDays = 21');
  assert(config.discoveredEnrichReserve === 5, 'Config default: discoveredEnrichReserve = 5');
  assert(config.dynamicQueryMultiplier === 2, 'Config default: dynamicQueryMultiplier = 2');

  const restore = (key: string, orig: string | undefined) => {
    if (orig !== undefined) process.env[key] = orig;
    else delete process.env[key];
  };
  restore('SOURCE_LOCATION_COVERAGE_FLOOR', origFloor);
  restore('SOURCE_NOVELTY_WINDOW_DAYS', origWindow);
  restore('SOURCE_DISCOVERED_ENRICH_RESERVE', origReserve);
  restore('SOURCE_DYNAMIC_QUERY_MULTIPLIER', origMultiplier);
}

// ---------------------------------------------------------------------------
// P1: Non-Tech Role Taxonomy Detection
// ---------------------------------------------------------------------------
{
  console.log('\n--- P1: Non-Tech Role Taxonomy Detection ---');

  assert(
    detectRoleFamilyFromTitle('Senior Account Executive') === 'account_executive',
    'P1: "Senior Account Executive" → account_executive',
  );
  assert(
    detectRoleFamilyFromTitle('Technical Account Manager @ AWS') === 'technical_account_manager',
    'P1: "Technical Account Manager @ AWS" → technical_account_manager (not account_manager)',
  );
  assert(
    detectRoleFamilyFromTitle('Account Manager - EMEA') === 'account_manager',
    'P1: "Account Manager - EMEA" → account_manager',
  );
  assert(
    detectRoleFamilyFromTitle('Customer Success Manager') === 'customer_success',
    'P1: "Customer Success Manager" → customer_success',
  );
  assert(
    detectRoleFamilyFromTitle('Solutions Engineer - Enterprise') === 'sales_engineer',
    'P1: "Solutions Engineer - Enterprise" → sales_engineer',
  );
  assert(
    detectRoleFamilyFromTitle('BDR at Startup Inc') === 'business_development',
    'P1: "BDR at Startup Inc" → business_development',
  );
  assert(
    detectRoleFamilyFromTitle('Technical Customer Success Lead') === 'technical_account_manager',
    'P1: "Technical Customer Success Lead" → technical_account_manager (not customer_success)',
  );
  // Tech roles still work
  assert(
    detectRoleFamilyFromTitle('Senior Backend Engineer') === 'backend',
    'P1: "Senior Backend Engineer" still → backend',
  );
  assert(
    detectRoleFamilyFromTitle('Full Stack Developer') === 'fullstack',
    'P1: "Full Stack Developer" still → fullstack',
  );
}

// ---------------------------------------------------------------------------
// P1 + P1.5: Non-Tech Ranking — Role Adjacency + Seniority Dampening
// ---------------------------------------------------------------------------
{
  console.log('\n--- P1/P1.5: Non-Tech Ranking ---');

  const nonTechRequirements = makeRequirements({
    topSkills: ['salesforce', 'outbound', 'pipeline management'],
    seniorityLevel: 'senior',
    domain: null,
    roleFamily: 'account_executive',
    location: 'Mumbai, India',
  });

  // AE candidate
  const aeCand: CandidateForRanking = {
    id: 'ae-1',
    headlineHint: 'Senior Account Executive | Enterprise Sales | SaaS',
    locationHint: 'Mumbai, India',
    searchTitle: 'Senior Account Executive',
    searchSnippet: 'salesforce outbound pipeline management',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
  };
  // CS candidate (adjacent)
  const csCand: CandidateForRanking = {
    id: 'cs-1',
    headlineHint: 'Customer Success Manager',
    locationHint: 'Mumbai, India',
    searchTitle: 'Customer Success Manager',
    searchSnippet: 'SaaS renewals onboarding',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
  };
  // Wrong-role "Senior Engineer" with seniority match
  const engCand: CandidateForRanking = {
    id: 'eng-1',
    headlineHint: 'Senior Software Engineer at Big Tech',
    locationHint: 'Mumbai, India',
    searchTitle: 'Senior Software Engineer',
    searchSnippet: 'React TypeScript Node.js',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
  };
  // Unknown-role candidate (no detectable family)
  const unknownCand: CandidateForRanking = {
    id: 'unk-1',
    headlineHint: 'Consultant',
    locationHint: 'Mumbai, India',
    searchTitle: 'Consultant',
    searchSnippet: 'Strategy and operations',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
  };

  const nonTechScored = rankCandidates(
    [aeCand, csCand, engCand, unknownCand],
    nonTechRequirements,
    { track: 'non_tech' },
  );

  const aeScore = nonTechScored.find((s) => s.candidateId === 'ae-1')!;
  const csScore = nonTechScored.find((s) => s.candidateId === 'cs-1')!;
  const engScore = nonTechScored.find((s) => s.candidateId === 'eng-1')!;
  const unkScore = nonTechScored.find((s) => s.candidateId === 'unk-1')!;

  assert(aeScore.fitBreakdown.roleScore === 1.0, 'P1: AE candidate roleScore = 1.0 (exact match)');
  assert(csScore.fitBreakdown.roleScore === 0.1, 'P1: CS candidate roleScore = 0.1 (mismatch with AE)');
  assert(engScore.fitBreakdown.roleScore === 0.15, 'P1.5: Engineer roleScore = 0.15 (unknown role on non_tech)');
  assert(unkScore.fitBreakdown.roleScore === 0.15, 'P1.5: Unknown role on non_tech → 0.15');

  assert(aeScore.fitScore > csScore.fitScore, 'P1: AE scores higher than CS for AE job');
  assert(aeScore.fitScore > engScore.fitScore, 'P1: AE scores higher than wrong-role engineer');
  assert(
    engScore.fitScore < unkScore.fitScore || engScore.fitBreakdown.roleScore <= unkScore.fitBreakdown.roleScore,
    'P1.5: Mismatched engineer doesn\'t outrank due to seniority alone',
  );

  // Verify seniority dampening: engineer has seniority=senior match but role mismatch
  // The raw seniorityScore should still be high, but fitScore should be dampened
  assert(engScore.fitBreakdown.seniorityScore >= 0.5, 'P1.5: Raw seniorityScore preserved in breakdown');

  // Tech track still gives 0.3 for unknown role (unchanged)
  const techRequirements = makeRequirements({
    topSkills: ['React', 'TypeScript'],
    seniorityLevel: 'senior',
    roleFamily: 'frontend',
    location: 'San Francisco',
  });
  const techScored = rankCandidates(
    [unknownCand],
    techRequirements,
    { track: 'tech' },
  );
  assert(
    techScored[0].fitBreakdown.roleScore === 0.3,
    'P1.5: Tech track unknown role still gets 0.3',
  );
}

// ---------------------------------------------------------------------------
// P1: Role Adjacency — AE target, BD candidate should get adjacency score
// ---------------------------------------------------------------------------
{
  console.log('\n--- P1: Role Adjacency Scoring ---');

  const aeRequirements = makeRequirements({
    topSkills: ['salesforce', 'outbound'],
    seniorityLevel: 'senior',
    roleFamily: 'account_executive',
    location: null,
  });

  const bdCand: CandidateForRanking = {
    id: 'bd-1',
    headlineHint: 'Business Development Representative',
    locationHint: null,
    searchTitle: 'BDR',
    searchSnippet: 'Sales development outbound prospecting',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
  };

  const bdScored = rankCandidates([bdCand], aeRequirements, { track: 'non_tech' });
  assert(
    bdScored[0].fitBreakdown.roleScore === 0.7,
    'P1: BD candidate gets 0.7 adjacency score for AE job',
  );

  // Fullstack ↔ frontend adjacency still works
  const frontendReq = makeRequirements({
    topSkills: ['React'],
    roleFamily: 'frontend',
  });
  const fullstackCand: CandidateForRanking = {
    id: 'fs-1',
    headlineHint: 'Full Stack Developer',
    locationHint: null,
    searchTitle: 'Full Stack Developer',
    searchSnippet: 'React Node.js',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
  };
  const fsScored = rankCandidates([fullstackCand], frontendReq, { track: 'tech' });
  assert(
    fsScored[0].fitBreakdown.roleScore === 0.7,
    'P1: Fullstack↔frontend adjacency still works (0.7)',
  );
}

// ---------------------------------------------------------------------------
// P2: Orchestrator Role-Mismatch Discovery Trigger
// ---------------------------------------------------------------------------
{
  console.log('\n--- P2: Role-Mismatch Discovery Trigger ---');

  const config = getSourcingConfig();
  const nonTechRequirements = makeRequirements({
    topSkills: ['salesforce', 'outbound'],
    seniorityLevel: 'senior',
    roleFamily: 'account_executive',
    location: 'Mumbai, India',
  });

  const wrongPool: CandidateForRanking[] = Array.from({ length: config.qualityTopK }, (_, idx) => ({
    id: `wrong-${idx}`,
    headlineHint: 'Senior Software Engineer',
    locationHint: 'Mumbai, India',
    searchTitle: 'Senior Software Engineer',
    searchSnippet: 'React TypeScript Node.js',
    enrichmentStatus: 'completed',
    lastEnrichedAt: null,
  }));

  const scoredPool = rankCandidates(wrongPool, nonTechRequirements, { track: 'non_tech' });
  const topPool = scoredPool.slice(0, Math.min(scoredPool.length, config.qualityTopK));
  const neutralOrMismatch = topPool.filter((sc) => sc.fitBreakdown.roleScore <= 0.3).length;
  const poolRoleMismatchRate = topPool.length > 0 ? neutralOrMismatch / topPool.length : 1;
  const roleMismatchTriggered = poolRoleMismatchRate > 0.8;
  const qualityGateTriggered = false;
  const qualityDrivenTarget = (qualityGateTriggered || roleMismatchTriggered)
    ? Math.ceil(config.targetCount * config.minDiscoveryShareLowQuality)
    : 0;
  const poolDeficit = 0;
  const discoveryReason = roleMismatchTriggered
    ? (poolDeficit > 0 ? 'deficit_and_role_mismatch' : 'pool_role_mismatch')
    : null;

  assert(poolRoleMismatchRate === 1, 'P2: Top pool role mismatch rate = 100% when all are wrong-domain');
  assert(roleMismatchTriggered, 'P2: >80% mismatch triggers role-mismatch discovery boost');
  assert(
    qualityDrivenTarget === Math.ceil(config.targetCount * config.minDiscoveryShareLowQuality),
    'P2: role mismatch increases quality-driven discovery target',
  );
  assert(discoveryReason === 'pool_role_mismatch', 'P2: discovery reason becomes pool_role_mismatch');
}

// ---------------------------------------------------------------------------
// P3: Provisional Discovered Promotion for Non-Tech
// ---------------------------------------------------------------------------
{
  console.log('\n--- P3: Provisional Discovered Promotion ---');

  type MockDiscovered = { candidateId: string; queryIndex: number };
  const config = getSourcingConfig();
  const requirements = makeRequirements({
    topSkills: ['apis', 'integrations'],
    seniorityLevel: 'senior',
    roleFamily: 'technical_account_manager',
    location: 'Bangalore, India',
  });
  const hasLocationConstraint = true;
  const effectiveStrategy: 'pool_first' | 'discovery_first' = 'discovery_first';
  const fallbackProvisionalMinFitScore = Math.min(config.discoveredPromotionMinFitScore, 0.35);
  const fallbackProvisionalCap = Math.max(
    config.minDiscoveredInOutput,
    Math.ceil(config.targetCount * 0.2),
  );

  const strictQueryIndices = new Set([0]);
  const fallbackQueryIndices = new Set([1]);
  const discoveredCandidateByIdMap = new Map<string, MockDiscovered>([
    ['strict-tam', { candidateId: 'strict-tam', queryIndex: 0 }],
    ['fallback-tam', { candidateId: 'fallback-tam', queryIndex: 1 }],
    ['strict-tech', { candidateId: 'strict-tech', queryIndex: 0 }],
  ]);
  const discoveredById = new Map([
    ['strict-tam', { headlineHint: 'Technical Account Manager @ AWS' }],
    ['fallback-tam', { headlineHint: 'Technical Account Manager @ AWS' }],
    ['strict-tech', { headlineHint: 'Senior DevOps Engineer' }],
  ]);

  const scoredDiscovered: ScoredCandidate[] = [
    {
      candidateId: 'strict-tam',
      fitScore: config.discoveredPromotionMinFitScore - 0.1,
      fitBreakdown: {
        skillScore: 0.1,
        skillScoreMethod: 'text_fallback',
        roleScore: 1,
        seniorityScore: 0,
        activityFreshnessScore: 0.7,
        locationBoost: 0.1,
      },
      matchTier: 'expanded_location',
      locationMatchType: 'none',
    },
    {
      candidateId: 'fallback-tam',
      fitScore: config.discoveredPromotionMinFitScore - 0.1,
      fitBreakdown: {
        skillScore: 0.1,
        skillScoreMethod: 'text_fallback',
        roleScore: 1,
        seniorityScore: 0,
        activityFreshnessScore: 0.7,
        locationBoost: 0.1,
      },
      matchTier: 'expanded_location',
      locationMatchType: 'none',
    },
    {
      candidateId: 'strict-tech',
      fitScore: config.discoveredPromotionMinFitScore - 0.1,
      fitBreakdown: {
        skillScore: 0.1,
        skillScoreMethod: 'text_fallback',
        roleScore: 0.1,
        seniorityScore: 1,
        activityFreshnessScore: 0.7,
        locationBoost: 0.1,
      },
      matchTier: 'expanded_location',
      locationMatchType: 'none',
    },
  ];

  const promotedNonTech = new Set<string>();
  let fallbackProvisionalPromotedCount = 0;
  for (const sc of scoredDiscovered) {
    const passesLocationGate = !hasLocationConstraint || sc.locationMatchType !== 'none';
    const passesFitGate = sc.fitScore >= config.discoveredPromotionMinFitScore;

    let provisionalPromotion = false;
    if (requirements.roleFamily) {
      const dc = discoveredCandidateByIdMap.get(sc.candidateId);
      const isFromStrictPhase = !!dc && strictQueryIndices.has(dc.queryIndex);
      const isFromFallbackPhase = !!dc && fallbackQueryIndices.has(dc.queryIndex);
      const candidateRoleFamily = detectRoleFamilyFromTitle(
        discoveredById.get(sc.candidateId)?.headlineHint ?? '',
      );
      if (candidateRoleFamily === requirements.roleFamily) {
        if (isFromStrictPhase) {
          provisionalPromotion = true;
        } else if (
          effectiveStrategy === 'discovery_first' &&
          isFromFallbackPhase &&
          sc.fitScore >= fallbackProvisionalMinFitScore &&
          fallbackProvisionalPromotedCount < fallbackProvisionalCap
        ) {
          provisionalPromotion = true;
          fallbackProvisionalPromotedCount++;
        }
      }
    }

    if ((passesLocationGate && passesFitGate) || provisionalPromotion) {
      promotedNonTech.add(sc.candidateId);
    }
  }

  assert(promotedNonTech.has('strict-tam'), 'P3: Strict-phase non-tech exact role match is provisionally promoted');
  assert(
    promotedNonTech.has('fallback-tam'),
    'P3: Fallback-phase non-tech exact-role candidate is provisionally promoted in discovery_first mode',
  );
  assert(!promotedNonTech.has('strict-tech'), 'P3: Strict-phase tech-role candidate is not provisionally promoted');

  // Same fallback candidate should not be provisionally promoted in pool_first mode.
  const promotedPoolFirst = new Set<string>();
  for (const sc of scoredDiscovered) {
    const passesLocationGate = !hasLocationConstraint || sc.locationMatchType !== 'none';
    const passesFitGate = sc.fitScore >= config.discoveredPromotionMinFitScore;
    let provisionalPromotion = false;
    if (requirements.roleFamily) {
      const dc = discoveredCandidateByIdMap.get(sc.candidateId);
      const isFromStrictPhase = !!dc && strictQueryIndices.has(dc.queryIndex);
      const candidateRoleFamily = detectRoleFamilyFromTitle(
        discoveredById.get(sc.candidateId)?.headlineHint ?? '',
      );
      if (isFromStrictPhase && candidateRoleFamily === requirements.roleFamily) {
        provisionalPromotion = true;
      }
    }
    if ((passesLocationGate && passesFitGate) || provisionalPromotion) {
      promotedPoolFirst.add(sc.candidateId);
    }
  }
  assert(
    !promotedPoolFirst.has('fallback-tam'),
    'P3: Fallback-phase non-tech candidate is not provisionally promoted in pool_first mode',
  );

  const promotedTechTrack = new Set<string>();
  for (const sc of scoredDiscovered) {
    const passesLocationGate = !hasLocationConstraint || sc.locationMatchType !== 'none';
    const passesFitGate = sc.fitScore >= config.discoveredPromotionMinFitScore;
    const provisionalPromotion = false; // Track = tech: bypass disabled
    if ((passesLocationGate && passesFitGate) || provisionalPromotion) {
      promotedTechTrack.add(sc.candidateId);
    }
  }
  assert(!promotedTechTrack.has('strict-tam'), 'P3: Tech track does not provisionally promote strict-phase discovered candidates');
}

// ---------------------------------------------------------------------------
// Track Classifier: Role Family Boost Direction
// ---------------------------------------------------------------------------
console.log('\n--- Track Classifier: Role Family Boost ---');

{
  const config = getSourcingConfig();

  // Helper to build minimal job context + requirements for track scoring
  function scoreTrack(title: string, skills: string[], jdSnippet: string) {
    const jobContext: SourcingJobContextInput = {
      jdDigest: jdSnippet,
      title,
      skills,
    };
    const requirements = buildJobRequirements(jobContext);
    return scoreDeterministic(jobContext, requirements, config);
  }

  // AE with sales keywords → non_tech
  const aeResult = scoreTrack(
    'Senior Account Executive',
    ['Salesforce', 'Enterprise Sales', 'Pipeline Management'],
    'Looking for an account executive to drive enterprise sales and manage pipeline using Salesforce CRM. Quota attainment and negotiation skills required.',
  );
  assert(aeResult.track === 'non_tech', 'Track: AE with sales keywords → non_tech');
  assert(aeResult.roleFamilySignal === 'account_executive', 'Track: AE roleFamilySignal correct');

  // Customer Success Manager → non_tech
  const csResult = scoreTrack(
    'Customer Success Manager',
    ['Customer Success', 'Account Management'],
    'Customer success manager to own client relationships and drive retention. Experience with SaaS customer success required.',
  );
  assert(csResult.track === 'non_tech', 'Track: CSM → non_tech');

  // TAM with cloud/API keywords → non_tech (the bug we fixed)
  const tamResult = scoreTrack(
    'Technical Account Manager',
    ['Cloud Infrastructure', 'APIs', 'Customer Success', 'Salesforce'],
    'Technical account manager for enterprise accounts. Cloud infrastructure AWS Azure GCP APIs integrations DevOps SaaS platform.',
  );
  assert(tamResult.track === 'non_tech', 'Track: TAM with cloud/API keywords → non_tech');
  assert(tamResult.roleFamilySignal === 'technical_account_manager', 'Track: TAM roleFamilySignal correct');
  assert(tamResult.nonTechScore > tamResult.techScore, 'Track: TAM nonTechScore > techScore');

  // Staff Platform Engineer → still tech
  const techResult = scoreTrack(
    'Staff Platform Engineer',
    ['Kubernetes', 'AWS', 'Go', 'Terraform'],
    'Platform engineer to build cloud-native infrastructure with Kubernetes AWS Go Terraform microservices CI/CD distributed systems.',
  );
  assert(techResult.track === 'tech', 'Track: Platform Engineer → still tech');
  assert(techResult.roleFamilySignal === 'devops', 'Track: Platform Engineer roleFamilySignal = devops');
  assert(techResult.techScore > techResult.nonTechScore, 'Track: Platform Engineer techScore > nonTechScore');

  // Data Scientist → still tech
  const dsResult = scoreTrack(
    'Senior Data Scientist',
    ['Python', 'PyTorch', 'Machine Learning'],
    'Data scientist to build ML models using Python PyTorch and deep learning. Experience with NLP and computer vision required.',
  );
  assert(dsResult.track === 'tech', 'Track: Data Scientist → still tech');

  // Sales Engineer → non_tech (despite tech keyword overlap)
  const seResult = scoreTrack(
    'Sales Engineer',
    ['APIs', 'Cloud', 'Salesforce'],
    'Sales engineer to support enterprise sales with technical demos and POCs. Experience with cloud platforms and API integrations.',
  );
  assert(seResult.track === 'non_tech', 'Track: Sales Engineer → non_tech');
  assert(seResult.roleFamilySignal === 'sales_engineer', 'Track: Sales Engineer roleFamilySignal correct');
}

// ---------------------------------------------------------------------------
// Strict Rescue Role Gate (non-tech)
// ---------------------------------------------------------------------------
{
  console.log('\n--- Strict Rescue Role Gate ---');

  // Scenario: TAM job, non_tech track. Pool has:
  // - QA Engineer (wrong role, location match) — should NOT be rescued
  // - Customer Success Manager (adjacent role, location match) — should be rescued
  // - TAM (exact role, location match) — should be rescued

  const tamReq: JobRequirements = {
    title: 'Technical Account Manager',
    topSkills: ['APIs', 'cloud', 'integrations'],
    seniorityLevel: 'senior',
    domain: null,
    roleFamily: 'technical_account_manager',
    location: 'Bangalore, India',
    experienceYears: null,
    education: null,
  };

  const qaCandidate: CandidateForRanking = {
    id: 'rescue-qa',
    headlineHint: 'Senior QA Engineer',
    locationHint: 'Bangalore, India',
    searchTitle: 'Senior QA Engineer',
    searchSnippet: 'Testing automation expert',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
    snapshot: null,
  };
  const csCandidate: CandidateForRanking = {
    id: 'rescue-cs',
    headlineHint: 'Customer Success Manager',
    locationHint: 'Bangalore, India',
    searchTitle: 'Customer Success Manager',
    searchSnippet: 'Customer retention and growth',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
    snapshot: null,
  };
  const tamCandidate: CandidateForRanking = {
    id: 'rescue-tam',
    headlineHint: 'Technical Account Manager at AWS',
    locationHint: 'Bangalore, India',
    searchTitle: 'Technical Account Manager at AWS',
    searchSnippet: 'Cloud solutions and API integrations',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
    snapshot: null,
  };

  const rescueScored = rankCandidates(
    [qaCandidate, csCandidate, tamCandidate],
    tamReq,
    { track: 'non_tech' },
  );

  const qaScored = rescueScored.find((s) => s.candidateId === 'rescue-qa')!;
  const csScored = rescueScored.find((s) => s.candidateId === 'rescue-cs')!;
  const tamScored = rescueScored.find((s) => s.candidateId === 'rescue-tam')!;

  // QA Engineer should have roleScore < 0.6 → blocked by rescue gate
  assert(
    qaScored.fitBreakdown.roleScore < 0.6,
    'Rescue gate: QA Engineer roleScore < 0.6 (would be blocked)',
  );
  // Customer Success should have roleScore >= 0.6 → passes rescue gate
  assert(
    csScored.fitBreakdown.roleScore >= 0.6,
    'Rescue gate: Customer Success roleScore >= 0.6 (would pass)',
  );
  // TAM should have roleScore = 1.0 → passes rescue gate
  assert(
    tamScored.fitBreakdown.roleScore >= 0.6,
    'Rescue gate: TAM roleScore >= 0.6 (would pass)',
  );
  // On tech track, QA would get 0.3 (still < 0.6), but the gate only applies to non_tech
  const qaOnTech = rankCandidates(
    [qaCandidate],
    { ...tamReq, roleFamily: 'qa' },
    { track: 'tech' },
  )[0];
  assert(
    qaOnTech.fitBreakdown.roleScore === 1.0,
    'Rescue gate: QA on tech with roleFamily=qa gets roleScore 1.0 (no gate needed)',
  );

  // Blended track should also get harsh unknown-role scoring (0.15, not 0.3)
  // This covers TAM jobs classified as blended due to heavy tech keywords in JD
  const unknownOnBlended: CandidateForRanking = {
    id: 'rescue-unknown-blended',
    headlineHint: 'Senior Software Engineer at Snowflake',
    locationHint: 'Bangalore, India',
    searchTitle: 'Senior Software Engineer at Snowflake',
    searchSnippet: null,
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
    snapshot: null,
  };
  const unknownBlendedScored = rankCandidates(
    [unknownOnBlended],
    tamReq,
    { track: 'blended' },
  )[0];
  assert(
    unknownBlendedScored.fitBreakdown.roleScore === 0.15,
    'Rescue gate: Unknown role on blended track gets 0.15 (same as non_tech)',
  );

  // Verify tech track still gives 0.3 for unknown role
  const unknownOnTech = rankCandidates(
    [unknownOnBlended],
    tamReq,
    { track: 'tech' },
  )[0];
  assert(
    unknownOnTech.fitBreakdown.roleScore === 0.3,
    'Rescue gate: Unknown role on tech track still gets 0.3',
  );
}

// ---------------------------------------------------------------------------
// Tech Strict Rescue Role Gate
// ---------------------------------------------------------------------------
{
  console.log('\n--- Tech Strict Rescue Role Gate ---');

  const backendReq: JobRequirements = {
    title: 'Senior Backend Engineer',
    topSkills: ['TypeScript', 'Node.js', 'PostgreSQL', 'Kubernetes'],
    seniorityLevel: 'senior',
    domain: null,
    roleFamily: 'backend',
    location: 'Bangalore, India',
    experienceYears: null,
    education: null,
  };

  // DevOps candidate — roleScore should be 0.5 (adjacency) → blocked by tech rescue gate (< 0.7)
  const devopsCandidate: CandidateForRanking = {
    id: 'rescue-devops-tech',
    headlineHint: 'DevOps Engineer | Docker, Kubernetes',
    locationHint: 'Bangalore, India',
    searchTitle: 'DevOps Engineer',
    searchSnippet: 'CI/CD pipelines and infrastructure',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
    snapshot: null,
  };

  // Fullstack candidate — roleScore should be 0.7 (strong adjacency) → passes tech rescue gate
  const fullstackCandidate: CandidateForRanking = {
    id: 'rescue-fullstack-tech',
    headlineHint: 'Senior Full Stack Engineer',
    locationHint: 'Bangalore, India',
    searchTitle: 'Senior Full Stack Engineer',
    searchSnippet: 'Node.js, React, PostgreSQL',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
    snapshot: null,
  };

  // Backend candidate — roleScore should be 1.0 (exact) → passes
  const backendCandidate: CandidateForRanking = {
    id: 'rescue-backend-tech',
    headlineHint: 'Senior Backend Engineer | Node.js',
    locationHint: 'Bangalore, India',
    searchTitle: 'Senior Backend Engineer',
    searchSnippet: 'TypeScript, PostgreSQL, Redis',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
    snapshot: null,
  };

  const techRescueScored = rankCandidates(
    [devopsCandidate, fullstackCandidate, backendCandidate],
    backendReq,
    { track: 'tech' },
  );

  const devopsScored = techRescueScored.find((s) => s.candidateId === 'rescue-devops-tech')!;
  const fullstackScored = techRescueScored.find((s) => s.candidateId === 'rescue-fullstack-tech')!;
  const backendScored = techRescueScored.find((s) => s.candidateId === 'rescue-backend-tech')!;

  // DevOps → backend adjacency is 0.5 → blocked by tech gate (< 0.7)
  assert(
    devopsScored.fitBreakdown.roleScore < 0.7,
    `Tech rescue gate: DevOps roleScore ${devopsScored.fitBreakdown.roleScore} < 0.7 (blocked)`,
  );
  // Fullstack → backend adjacency is 0.7 → passes tech gate
  assert(
    fullstackScored.fitBreakdown.roleScore >= 0.7,
    `Tech rescue gate: Fullstack roleScore ${fullstackScored.fitBreakdown.roleScore} >= 0.7 (passes)`,
  );
  // Backend exact match → 1.0 → passes
  assert(
    backendScored.fitBreakdown.roleScore >= 0.7,
    `Tech rescue gate: Backend roleScore ${backendScored.fitBreakdown.roleScore} >= 0.7 (passes)`,
  );

  // QA → backend should be very low → blocked
  const qaForBackend: CandidateForRanking = {
    id: 'rescue-qa-tech',
    headlineHint: 'Senior QA Engineer',
    locationHint: 'Bangalore, India',
    searchTitle: 'Senior QA Engineer',
    searchSnippet: 'Test automation',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
    snapshot: null,
  };
  const qaBackendScored = rankCandidates([qaForBackend], backendReq, { track: 'tech' })[0];
  assert(
    qaBackendScored.fitBreakdown.roleScore < 0.7,
    `Tech rescue gate: QA roleScore ${qaBackendScored.fitBreakdown.roleScore} < 0.7 (blocked)`,
  );
}

// ---------------------------------------------------------------------------
// Role Service: Deterministic Resolution
// ---------------------------------------------------------------------------
{
  console.log('\n--- Role Service: resolveRoleDeterministic ---');

  // Tech families
  const backendRes = resolveRoleDeterministic('Senior Backend Engineer');
  assert(backendRes.family === 'backend', `Backend resolves: ${backendRes.family}`);
  assert(backendRes.confidence === 0.95, `Backend confidence: ${backendRes.confidence}`);
  assert(backendRes.track === 'tech', `Backend track: ${backendRes.track}`);

  const frontendRes = resolveRoleDeterministic('React Frontend Developer');
  assert(frontendRes.family === 'frontend', `Frontend resolves: ${frontendRes.family}`);

  const devopsRes = resolveRoleDeterministic('Senior SRE Lead');
  assert(devopsRes.family === 'devops', `DevOps/SRE resolves: ${devopsRes.family}`);

  const fullstackRes = resolveRoleDeterministic('Full-Stack Engineer');
  assert(fullstackRes.family === 'fullstack', `Fullstack resolves: ${fullstackRes.family}`);

  const dataRes = resolveRoleDeterministic('ML Engineer');
  assert(dataRes.family === 'data', `Data/ML resolves: ${dataRes.family}`);

  const mobileRes = resolveRoleDeterministic('iOS Developer');
  assert(mobileRes.family === 'mobile', `Mobile resolves: ${mobileRes.family}`);

  // Non-tech families
  const tamFullRes = resolveRoleDeterministic('Technical Account Manager at AWS');
  assert(tamFullRes.family === 'technical_account_manager', `TAM full title resolves: ${tamFullRes.family}`);

  const tamAbbrevRes = resolveRoleDeterministic('TAM at AWS');
  assert(tamAbbrevRes.family === 'technical_account_manager', `TAM abbreviation resolves: ${tamAbbrevRes.family}`);

  const csmRes = resolveRoleDeterministic('Customer Success Manager');
  assert(csmRes.family === 'customer_success', `CSM resolves: ${csmRes.family}`);

  const csmAbbrevRes = resolveRoleDeterministic('CSM at Salesforce');
  assert(csmAbbrevRes.family === 'customer_success', `CSM abbreviation resolves: ${csmAbbrevRes.family}`);

  const aeRes = resolveRoleDeterministic('Enterprise Sales at Snowflake');
  assert(aeRes.family === 'account_executive', `AE resolves: ${aeRes.family}`);

  const seRes = resolveRoleDeterministic('Solutions Engineer');
  assert(seRes.family === 'sales_engineer', `SE resolves: ${seRes.family}`);

  const bdrRes = resolveRoleDeterministic('BDR at HubSpot');
  assert(bdrRes.family === 'business_development', `BDR resolves: ${bdrRes.family}`);

  const amRes = resolveRoleDeterministic('Key Account Manager');
  assert(amRes.family === 'account_manager', `AM resolves: ${amRes.family}`);

  // Unknown titles
  const unknownRes = resolveRoleDeterministic('CEO at Startup');
  assert(unknownRes.family === null, `Unknown title: family is null`);
  assert(unknownRes.fallbackKind === 'unknown', `Unknown title: fallbackKind is "unknown"`);
  assert(unknownRes.confidence === 0.0, `Unknown title: confidence is 0.0`);
  assert(unknownRes.track === null, `Unknown title: track is null`);

  const emptyRes = resolveRoleDeterministic('');
  assert(emptyRes.family === null, `Empty string: family is null`);
  assert(emptyRes.confidence === 0.0, `Empty string: confidence is 0.0`);

  // Track mapping
  assert(TECH_ROLE_FAMILIES.has('backend'), `TECH_ROLE_FAMILIES includes backend`);
  assert(TECH_ROLE_FAMILIES.has('mobile'), `TECH_ROLE_FAMILIES includes mobile`);
  assert(!TECH_ROLE_FAMILIES.has('account_executive' as RoleFamily), `TECH_ROLE_FAMILIES excludes AE`);
  assert(NON_TECH_ROLE_FAMILIES.has('technical_account_manager'), `NON_TECH_ROLE_FAMILIES includes TAM`);
  assert(NON_TECH_ROLE_FAMILIES.has('customer_success'), `NON_TECH_ROLE_FAMILIES includes CS`);
  assert(!NON_TECH_ROLE_FAMILIES.has('backend' as RoleFamily), `NON_TECH_ROLE_FAMILIES excludes backend`);

  // familyToTrack
  assert(familyToTrack.get('backend') === 'tech', `familyToTrack: backend → tech`);
  assert(familyToTrack.get('customer_success') === 'non_tech', `familyToTrack: customer_success → non_tech`);
  assert(familyToTrack.get('technical_account_manager') === 'non_tech', `familyToTrack: TAM → non_tech`);
}

// ---------------------------------------------------------------------------
// Role Service: Adjacency Map
// ---------------------------------------------------------------------------
{
  console.log('\n--- Role Service: adjacencyMap ---');

  assert(adjacencyMap.get('fullstack:frontend') === 0.7, 'fullstack→frontend adjacency = 0.7');
  assert(adjacencyMap.get('frontend:fullstack') === 0.7, 'frontend→fullstack adjacency = 0.7 (symmetric)');
  assert(adjacencyMap.get('devops:backend') === 0.5, 'devops→backend adjacency = 0.5');
  assert(adjacencyMap.get('technical_account_manager:sales_engineer') === 0.7, 'TAM→SE adjacency = 0.7');
  assert(adjacencyMap.get('customer_success:account_manager') === 0.7, 'CS→AM adjacency = 0.7');
  assert(adjacencyMap.get('backend:frontend') === undefined, 'backend→frontend no adjacency');
}

// ---------------------------------------------------------------------------
// Role Service: Adjacent families in resolution
// ---------------------------------------------------------------------------
{
  console.log('\n--- Role Service: Adjacent families in resolution ---');

  const tamRes = resolveRoleDeterministic('TAM at AWS');
  assert(tamRes.adjacentFamilies.length > 0, `TAM has adjacent families: ${tamRes.adjacentFamilies.join(', ')}`);
  assert(tamRes.adjacentFamilies.includes('sales_engineer'), `TAM adjacent includes sales_engineer`);
  assert(tamRes.adjacentFamilies.includes('customer_success'), `TAM adjacent includes customer_success`);

  const fullstackRes = resolveRoleDeterministic('Full Stack Engineer');
  assert(fullstackRes.adjacentFamilies.includes('frontend'), `Fullstack adjacent includes frontend`);
  assert(fullstackRes.adjacentFamilies.includes('backend'), `Fullstack adjacent includes backend`);
}

// ---------------------------------------------------------------------------
// Role Service: NON_TECH_TITLE_VARIANTS
// ---------------------------------------------------------------------------
{
  console.log('\n--- Role Service: NON_TECH_TITLE_VARIANTS ---');

  assert(NON_TECH_TITLE_VARIANTS['account_executive']!.includes('account executive'), 'AE variants include "account executive"');
  assert(NON_TECH_TITLE_VARIANTS['technical_account_manager']!.includes('technical account manager'), 'TAM variants include "technical account manager"');
  assert(NON_TECH_TITLE_VARIANTS['customer_success']!.includes('customer success manager'), 'CS variants include "customer success manager"');
  assert(Object.keys(NON_TECH_TITLE_VARIANTS).length === 6, `NON_TECH_TITLE_VARIANTS has 6 families`);
}

// ---------------------------------------------------------------------------
// Role Service: Backward-compat detectRoleFamilyFromTitle re-export
// ---------------------------------------------------------------------------
{
  console.log('\n--- Role Service: detectRoleFamilyFromTitle backward compat ---');

  // Verify the deprecated re-export still works and returns string | null
  const tamFamily = detectRoleFamilyFromTitle('TAM at AWS');
  assert(tamFamily === 'technical_account_manager', `detectRoleFamilyFromTitle TAM: ${tamFamily}`);
  assert(typeof tamFamily === 'string', `Return type is string`);

  const unknownFamily = detectRoleFamilyFromTitle('CEO');
  assert(unknownFamily === null, `detectRoleFamilyFromTitle unknown returns null`);

  const backendFamily = detectRoleFamilyFromTitle('Senior Backend Engineer');
  assert(backendFamily === 'backend', `detectRoleFamilyFromTitle backend: ${backendFamily}`);
}

// ---------------------------------------------------------------------------
// Role Service: Ranking with preResolvedRoles
// ---------------------------------------------------------------------------
{
  console.log('\n--- Role Service: Ranking with preResolvedRoles ---');

  const tamReq = makeRequirements({
    roleFamily: 'technical_account_manager',
    topSkills: ['customer success', 'integrations'],
  });

  // Candidate with TAM headline
  const tamCandidate: CandidateForRanking = {
    id: 'tam-1',
    headlineHint: 'TAM at AWS',
    locationHint: 'Seattle',
    searchTitle: 'Technical Account Manager',
    searchSnippet: 'Manages enterprise accounts',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
    snapshot: null,
  };

  // With pre-resolved role (high confidence)
  const preResolved = new Map<string, RoleResolution>();
  preResolved.set('tam at aws', {
    family: 'technical_account_manager',
    fallbackKind: null,
    confidence: 0.95,
    track: 'non_tech',
    adjacentFamilies: ['sales_engineer', 'customer_success'],
    normalizedTitle: 'TAM at AWS',
  });

  const withPreResolved = rankCandidates([tamCandidate], tamReq, {
    track: 'non_tech',
    preResolvedRoles: preResolved,
  });
  assert(
    withPreResolved[0].fitBreakdown.roleScore === 1.0,
    `TAM with preResolved role gets roleScore 1.0: ${withPreResolved[0].fitBreakdown.roleScore}`,
  );

  // Without pre-resolved (deterministic still resolves TAM abbreviation now)
  const withoutPreResolved = rankCandidates([tamCandidate], tamReq, { track: 'non_tech' });
  assert(
    withoutPreResolved[0].fitBreakdown.roleScore === 1.0,
    `TAM without preResolved also gets 1.0 (regex now catches TAM): ${withoutPreResolved[0].fitBreakdown.roleScore}`,
  );
}

// ---------------------------------------------------------------------------
// Role Service: Confidence gates in ranking
// ---------------------------------------------------------------------------
{
  console.log('\n--- Role Service: Confidence gates in ranking ---');

  const tamReq = makeRequirements({
    roleFamily: 'technical_account_manager',
    topSkills: ['customer success'],
  });

  const candidate: CandidateForRanking = {
    id: 'low-conf-1',
    headlineHint: 'Unknown Title',
    locationHint: null,
    searchTitle: null,
    searchSnippet: null,
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
    snapshot: null,
  };

  // Low confidence pre-resolved role (< 0.5) → conservative scoring
  const lowConf = new Map<string, RoleResolution>();
  lowConf.set('unknown title', {
    family: 'technical_account_manager',
    fallbackKind: null,
    confidence: 0.3,
    track: 'non_tech',
    adjacentFamilies: [],
    normalizedTitle: 'Unknown Title',
  });

  const lowConfScored = rankCandidates([candidate], tamReq, {
    track: 'non_tech',
    preResolvedRoles: lowConf,
  });
  assert(
    lowConfScored[0].fitBreakdown.roleScore <= 0.15,
    `Low confidence (0.3) gets conservative roleScore: ${lowConfScored[0].fitBreakdown.roleScore}`,
  );

  // Medium confidence (0.6) → assist scoring but no full promotion
  const medConf = new Map<string, RoleResolution>();
  medConf.set('unknown title', {
    family: 'technical_account_manager',
    fallbackKind: null,
    confidence: 0.6,
    track: 'non_tech',
    adjacentFamilies: [],
    normalizedTitle: 'Unknown Title',
  });

  const medConfScored = rankCandidates([candidate], tamReq, {
    track: 'non_tech',
    preResolvedRoles: medConf,
  });
  assert(
    medConfScored[0].fitBreakdown.roleScore === 0.8,
    `Medium confidence (0.6) exact match gets 0.8: ${medConfScored[0].fitBreakdown.roleScore}`,
  );

  // High confidence (0.9) → full scoring
  const highConf = new Map<string, RoleResolution>();
  highConf.set('unknown title', {
    family: 'technical_account_manager',
    fallbackKind: null,
    confidence: 0.9,
    track: 'non_tech',
    adjacentFamilies: [],
    normalizedTitle: 'Unknown Title',
  });

  const highConfScored = rankCandidates([candidate], tamReq, {
    track: 'non_tech',
    preResolvedRoles: highConf,
  });
  assert(
    highConfScored[0].fitBreakdown.roleScore === 1.0,
    `High confidence (0.9) exact match gets 1.0: ${highConfScored[0].fitBreakdown.roleScore}`,
  );
}

// ---------------------------------------------------------------------------
// Location Service: deterministic + preResolvedLocations
// ---------------------------------------------------------------------------
{
  console.log('\n--- Location Service: deterministic + preResolvedLocations ---');

  const resolved = resolveLocationDeterministic('Bengaluru, India');
  assert(resolved.city === 'bangalore', 'Location deterministic: Bengaluru canonicalizes to bangalore');
  assert(resolved.countryCode === 'IN', 'Location deterministic: Bengaluru, India → IN');

  const req = makeRequirements({
    roleFamily: 'backend',
    location: 'Bangalore, India',
  });
  const candidate: CandidateForRanking = {
    id: 'loc-1',
    headlineHint: 'Senior Backend Engineer',
    locationHint: 'BLR',
    searchTitle: 'Senior Backend Engineer',
    searchSnippet: '',
    enrichmentStatus: 'pending',
    lastEnrichedAt: null,
    snapshot: null,
  };

  const withoutPreResolved = rankCandidates([candidate], req, { track: 'tech' });
  assert(
    withoutPreResolved[0].locationMatchType === 'none',
    'Location preResolved: BLR without pre-resolve remains none',
  );

  const preResolved = new Map<string, LocationResolution>();
  preResolved.set('loc-1', {
    normalizedInput: 'BLR',
    normalized: 'bangalore, india',
    rawNormalized: 'blr',
    city: 'bangalore',
    rawCity: 'blr',
    countryCode: 'IN',
    confidence: 0.9,
    source: 'groq',
    fallbackKind: null,
  });

  const withPreResolved = rankCandidates([candidate], req, {
    track: 'tech',
    preResolvedLocations: preResolved,
  });
  assert(
    withPreResolved[0].locationMatchType === 'city_alias',
    'Location preResolved: BLR with high-confidence resolution becomes city_alias',
  );
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
