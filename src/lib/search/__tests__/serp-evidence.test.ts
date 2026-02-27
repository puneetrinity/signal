/**
 * Unit tests for computeSerpEvidence.
 *
 * Run with: npx tsx src/lib/search/__tests__/serp-evidence.test.ts
 */

import { computeSerpEvidence, type SerpEvidence } from '../serp-signals';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function assertApprox(label: string, actual: number, expected: number, tolerance = 0.01): void {
  assert(`${label} (${actual} ≈ ${expected})`, Math.abs(actual - expected) < tolerance);
}

console.log('computeSerpEvidence tests\n');

// Test 1: No meta → confidence 0, no signals
{
  const result = computeSerpEvidence(null);
  assertApprox('no meta: confidence 0', result.confidence, 0);
  assert('no meta: hasResultDate false', result.hasResultDate === false);
  assert('no meta: hasLocale false', result.hasLocale === false);
  assert('no meta: resultDateDays null', result.resultDateDays === null);
  assert('no meta: localeCountryCode null', result.localeCountryCode === null);
}

// Test 2: Stale date only (> 90 days) → 0.4
{
  const staleDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  const result = computeSerpEvidence({ serper: { resultDate: staleDate } });
  assertApprox('stale date only: confidence 0.4', result.confidence, 0.4);
  assert('stale date only: hasResultDate true', result.hasResultDate === true);
  assert('stale date only: hasLocale false', result.hasLocale === false);
}

// Test 3: Fresh date (≤ 30 days) → 0.4 + 0.3 = 0.7
{
  const freshDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const result = computeSerpEvidence({ serper: { resultDate: freshDate } });
  assertApprox('fresh date only: confidence 0.7', result.confidence, 0.7);
  assert('fresh date only: hasResultDate true', result.hasResultDate === true);
  assert('fresh date only: resultDateDays ≤ 30', result.resultDateDays !== null && result.resultDateDays <= 30);
}

// Test 4: Fresh date + locale → 0.4 + 0.3 + 0.3 = 1.0
{
  const freshDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const result = computeSerpEvidence({
    serper: { resultDate: freshDate, linkedinLocale: 'in' },
  });
  assertApprox('fresh date + locale: confidence 1.0', result.confidence, 1.0);
  assert('fresh date + locale: hasResultDate true', result.hasResultDate === true);
  assert('fresh date + locale: hasLocale true', result.hasLocale === true);
  assert('fresh date + locale: localeCountryCode IN', result.localeCountryCode === 'IN');
}

// Test 5: Locale only (no date) → 0.3
{
  const result = computeSerpEvidence({ serper: { linkedinLocale: 'us' } });
  assertApprox('locale only: confidence 0.3', result.confidence, 0.3);
  assert('locale only: hasResultDate false', result.hasResultDate === false);
  assert('locale only: hasLocale true', result.hasLocale === true);
  assert('locale only: localeCountryCode US', result.localeCountryCode === 'US');
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
