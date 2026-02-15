#!/usr/bin/env npx tsx
/**
 * Manual test script for Tier-1 Shadow Telemetry
 *
 * Tests:
 * 1. ENRICHMENT_TIER1_SAMPLE_RATE parse guard edge cases
 * 2. Deterministic sampler stability
 * 3. aggregateTier1Shadow correctness
 *
 * Usage: npx tsx scripts/test-tier1-shadow.ts
 */

// ── Test 1: Sample rate parse guard ──────────────────────────────────────────

function parseSampleRate(raw: string | undefined): number {
  const parsed = parseFloat(raw ?? '');
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return Math.min(parsed, 1);
}

const parseTests: Array<[string | undefined, number]> = [
  [undefined, 1],
  ['', 1],
  ['NaN', 1],
  ['abc', 1],
  ['-0.5', 1],
  ['-1', 1],
  ['0', 0],
  ['0.5', 0.5],
  ['1', 1],
  ['1.5', 1],
  ['2', 1],
  ['0.001', 0.001],
  ['Infinity', 1],    // Not finite
  ['-Infinity', 1],   // Not finite
];

let allPassed = true;

console.log('=== Test 1: Sample rate parse guard ===');
for (const [input, expected] of parseTests) {
  const actual = parseSampleRate(input);
  const pass = actual === expected;
  if (!pass) allPassed = false;
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}: parseSampleRate(${JSON.stringify(input)}) = ${actual} (expected ${expected})`
  );
}

// ── Test 2: Deterministic sampler stability ──────────────────────────────────

function deterministicSample(sessionId: string, platformId: string): number {
  const key = `${sessionId}:${platformId}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100;
}

console.log('\n=== Test 2: Deterministic sampler stability ===');

const samplerTests: Array<[string, string]> = [
  ['session-abc-123', 'octocat'],
  ['session-abc-123', 'torvalds'],
  ['session-xyz-789', 'octocat'],
  ['', ''],
  ['a', 'b'],
];

for (const [sessionId, platformId] of samplerTests) {
  const results = new Set<number>();
  for (let i = 0; i < 100; i++) {
    results.add(deterministicSample(sessionId, platformId));
  }
  const pass = results.size === 1;
  if (!pass) allPassed = false;
  const value = [...results][0];
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}: deterministicSample("${sessionId}", "${platformId}") → ${value} (stable: ${results.size === 1})`
  );
}

// Verify different inputs produce different outputs (probabilistic, not guaranteed)
const val1 = deterministicSample('session-abc-123', 'octocat');
const val2 = deterministicSample('session-abc-123', 'torvalds');
const val3 = deterministicSample('session-xyz-789', 'octocat');
const hasDiversity = new Set([val1, val2, val3]).size > 1;
if (!hasDiversity) allPassed = false;
console.log(`  ${hasDiversity ? 'PASS' : 'WARN'}: Different inputs produce different samples (${val1}, ${val2}, ${val3})`);

// Range check
console.log('\n  Range check (1000 random pairs):');
let minVal = 100, maxVal = -1;
for (let i = 0; i < 1000; i++) {
  const v = deterministicSample(`session-${i}`, `platform-${i * 7}`);
  minVal = Math.min(minVal, v);
  maxVal = Math.max(maxVal, v);
}
const rangePass = minVal >= 0 && maxVal <= 99;
if (!rangePass) allPassed = false;
console.log(`  ${rangePass ? 'PASS' : 'FAIL'}: Range [${minVal}, ${maxVal}] (expected 0-99)`);

// ── Test 3: aggregateTier1Shadow ─────────────────────────────────────────────

interface Tier1ShadowSample {
  platform: string;
  platformId: string;
  signals: string[];
  blockReasons: string[];
  confidenceScore: number;
  wouldAutoMerge: boolean;
  tier1Enforced: boolean;
  enforceReason: string;
  enforceThreshold: number;
  actuallyPromoted: boolean;
  bridgeTier: number;
}

interface Tier1ShadowDiagnostics {
  enabled: boolean;
  enforce: boolean;
  enforceThreshold: number;
  sampleRate: number;
  totalEvaluated: number;
  wouldAutoMerge: number;
  tier1Enforced: number;
  actuallyPromoted: number;
  blocked: number;
  samples: Tier1ShadowSample[];
  blockReasonCounts: Record<string, number>;
  enforceReasonCounts: Record<string, number>;
}

function aggregateTier1Shadow(
  platformResults: Record<string, { tier1Shadow?: Tier1ShadowDiagnostics }>
): Tier1ShadowDiagnostics | undefined {
  const shadows = Object.values(platformResults)
    .map(r => r.tier1Shadow)
    .filter((s): s is Tier1ShadowDiagnostics => !!s && s.enabled);

  if (shadows.length === 0) return undefined;

  const first = shadows[0];
  const result: Tier1ShadowDiagnostics = {
    enabled: true,
    enforce: first.enforce,
    enforceThreshold: first.enforceThreshold,
    sampleRate: first.sampleRate,
    totalEvaluated: 0,
    wouldAutoMerge: 0,
    tier1Enforced: 0,
    actuallyPromoted: 0,
    blocked: 0,
    samples: [],
    blockReasonCounts: {
      no_bridge_signal: 0,
      low_confidence: 0,
      contradiction: 0,
      name_mismatch: 0,
      team_page: 0,
      id_mismatch: 0,
    },
    enforceReasonCounts: {
      eligible: 0,
      enforce_disabled: 0,
      not_tier1: 0,
      missing_strict_signal: 0,
      below_enforce_threshold: 0,
      contradiction: 0,
      name_mismatch: 0,
      team_page: 0,
      id_mismatch: 0,
    },
  };

  for (const shadow of shadows) {
    result.totalEvaluated += shadow.totalEvaluated;
    result.wouldAutoMerge += shadow.wouldAutoMerge;
    result.tier1Enforced += shadow.tier1Enforced;
    result.actuallyPromoted += shadow.actuallyPromoted;
    result.blocked += shadow.blocked;
    for (const [reason, count] of Object.entries(shadow.blockReasonCounts)) {
      result.blockReasonCounts[reason] = (result.blockReasonCounts[reason] || 0) + count;
    }
    for (const [reason, count] of Object.entries(shadow.enforceReasonCounts)) {
      result.enforceReasonCounts[reason] = (result.enforceReasonCounts[reason] || 0) + count;
    }
    for (const sample of shadow.samples) {
      if (result.samples.length < 50) {
        result.samples.push(sample);
      }
    }
  }

  return result;
}

console.log('\n=== Test 3: aggregateTier1Shadow ===');

// Create 3 platform shadows
const platform1: Tier1ShadowDiagnostics = {
  enabled: true, enforce: false, enforceThreshold: 0.83, sampleRate: 1,
  totalEvaluated: 5, wouldAutoMerge: 1, tier1Enforced: 0, actuallyPromoted: 0, blocked: 4,
  samples: [
    { platform: 'github', platformId: 'user1', signals: ['linkedin_url_in_bio'], blockReasons: [], confidenceScore: 0.9, wouldAutoMerge: true, tier1Enforced: false, enforceReason: 'enforce_disabled', enforceThreshold: 0.83, actuallyPromoted: false, bridgeTier: 1 },
    { platform: 'github', platformId: 'user2', signals: [], blockReasons: ['no_bridge_signal', 'low_confidence'], confidenceScore: 0.3, wouldAutoMerge: false, tier1Enforced: false, enforceReason: 'not_tier1', enforceThreshold: 0.83, actuallyPromoted: false, bridgeTier: 3 },
  ],
  blockReasonCounts: { no_bridge_signal: 2, low_confidence: 3, contradiction: 0, name_mismatch: 0, team_page: 0, id_mismatch: 0 },
  enforceReasonCounts: { eligible: 0, enforce_disabled: 1, not_tier1: 1, missing_strict_signal: 0, below_enforce_threshold: 0, contradiction: 0, name_mismatch: 0, team_page: 0, id_mismatch: 0 },
};

const platform2: Tier1ShadowDiagnostics = {
  enabled: true, enforce: false, enforceThreshold: 0.83, sampleRate: 1,
  totalEvaluated: 3, wouldAutoMerge: 0, tier1Enforced: 0, actuallyPromoted: 0, blocked: 3,
  samples: [
    { platform: 'stackoverflow', platformId: 'user3', signals: [], blockReasons: ['no_bridge_signal'], confidenceScore: 0.4, wouldAutoMerge: false, tier1Enforced: false, enforceReason: 'not_tier1', enforceThreshold: 0.83, actuallyPromoted: false, bridgeTier: 3 },
  ],
  blockReasonCounts: { no_bridge_signal: 3, low_confidence: 1, contradiction: 1, name_mismatch: 0, team_page: 0, id_mismatch: 0 },
  enforceReasonCounts: { eligible: 0, enforce_disabled: 0, not_tier1: 1, missing_strict_signal: 0, below_enforce_threshold: 0, contradiction: 0, name_mismatch: 0, team_page: 0, id_mismatch: 0 },
};

const platform3: Tier1ShadowDiagnostics = {
  enabled: true, enforce: false, enforceThreshold: 0.83, sampleRate: 1,
  totalEvaluated: 2, wouldAutoMerge: 2, tier1Enforced: 0, actuallyPromoted: 0, blocked: 0,
  samples: [
    { platform: 'medium', platformId: 'user4', signals: ['mutual_reference'], blockReasons: [], confidenceScore: 0.95, wouldAutoMerge: true, tier1Enforced: false, enforceReason: 'enforce_disabled', enforceThreshold: 0.83, actuallyPromoted: false, bridgeTier: 1 },
    { platform: 'medium', platformId: 'user5', signals: ['linkedin_url_in_page'], blockReasons: [], confidenceScore: 0.88, wouldAutoMerge: true, tier1Enforced: false, enforceReason: 'enforce_disabled', enforceThreshold: 0.83, actuallyPromoted: false, bridgeTier: 1 },
  ],
  blockReasonCounts: { no_bridge_signal: 0, low_confidence: 0, contradiction: 0, name_mismatch: 0, team_page: 0, id_mismatch: 0 },
  enforceReasonCounts: { eligible: 0, enforce_disabled: 2, not_tier1: 0, missing_strict_signal: 0, below_enforce_threshold: 0, contradiction: 0, name_mismatch: 0, team_page: 0, id_mismatch: 0 },
};

const aggregated = aggregateTier1Shadow({
  github: { tier1Shadow: platform1 },
  stackoverflow: { tier1Shadow: platform2 },
  medium: { tier1Shadow: platform3 },
});

const checks = [
  ['totalEvaluated', aggregated?.totalEvaluated === 10],
  ['wouldAutoMerge', aggregated?.wouldAutoMerge === 3],
  ['tier1Enforced', aggregated?.tier1Enforced === 0],
  ['actuallyPromoted', aggregated?.actuallyPromoted === 0],
  ['blocked', aggregated?.blocked === 7],
  ['no_bridge_signal count', aggregated?.blockReasonCounts.no_bridge_signal === 5],
  ['low_confidence count', aggregated?.blockReasonCounts.low_confidence === 4],
  ['contradiction count', aggregated?.blockReasonCounts.contradiction === 1],
  ['samples count', aggregated?.samples.length === 5],
  ['enabled', aggregated?.enabled === true],
  ['enforce', aggregated?.enforce === false],
];

for (const [name, pass] of checks) {
  if (!pass) allPassed = false;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${name}`);
}

// Test sample cap at 50
const bigPlatform: Tier1ShadowDiagnostics = {
  enabled: true, enforce: false, enforceThreshold: 0.83, sampleRate: 1,
  totalEvaluated: 60, wouldAutoMerge: 0, tier1Enforced: 0, actuallyPromoted: 0, blocked: 60,
  samples: Array.from({ length: 60 }, (_, i) => ({
    platform: 'github', platformId: `user-${i}`, signals: [] as string[], blockReasons: ['no_bridge_signal'],
    confidenceScore: 0.1, wouldAutoMerge: false, tier1Enforced: false, enforceReason: 'not_tier1', enforceThreshold: 0.83, actuallyPromoted: false, bridgeTier: 3 as number,
  })),
  blockReasonCounts: { no_bridge_signal: 60, low_confidence: 0, contradiction: 0, name_mismatch: 0, team_page: 0, id_mismatch: 0 },
  enforceReasonCounts: { eligible: 0, enforce_disabled: 0, not_tier1: 60, missing_strict_signal: 0, below_enforce_threshold: 0, contradiction: 0, name_mismatch: 0, team_page: 0, id_mismatch: 0 },
};

const cappedResult = aggregateTier1Shadow({ github: { tier1Shadow: bigPlatform } });
const capPass = cappedResult?.samples.length === 50;
if (!capPass) allPassed = false;
console.log(`  ${capPass ? 'PASS' : 'FAIL'}: Sample cap at 50 (got ${cappedResult?.samples.length})`);

// Test with no shadow data
const emptyResult = aggregateTier1Shadow({ github: {} });
const emptyPass = emptyResult === undefined;
if (!emptyPass) allPassed = false;
console.log(`  ${emptyPass ? 'PASS' : 'FAIL'}: Empty input returns undefined`);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
process.exit(allPassed ? 0 : 1);
