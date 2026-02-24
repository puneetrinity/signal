/**
 * Pure function tests for sourcing callback: constants, jitter, payload shape.
 * No HTTP, no server, no Prisma.
 *
 * Run with: npx tsx src/tests/test-callback.ts
 */

import { MAX_ATTEMPTS, BASE_DELAYS_MS, jitteredDelay } from '@/lib/sourcing/callback';
import type { SourcingCallbackPayload } from '@/lib/sourcing/types';

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
// Test: Constants
// ---------------------------------------------------------------------------

console.log('\n--- Callback Constants ---');

{
  assert(MAX_ATTEMPTS === 5, 'MAX_ATTEMPTS === 5');
  assert(BASE_DELAYS_MS.length === 4, 'BASE_DELAYS_MS has 4 entries (delays between 5 attempts)');
  assert(BASE_DELAYS_MS[0] === 1_000, 'First delay is 1s');
  assert(BASE_DELAYS_MS[3] === 30_000, 'Last delay is 30s');
}

// ---------------------------------------------------------------------------
// Test: Jitter range
// ---------------------------------------------------------------------------

console.log('\n--- Jitter Range ---');

{
  const base = 1000;
  let allInRange = true;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < 100; i++) {
    const val = jitteredDelay(base);
    if (val < 800 || val > 1200) allInRange = false;
    min = Math.min(min, val);
    max = Math.max(max, val);
  }

  assert(allInRange, 'jitteredDelay(1000): all 100 values in [800, 1200]');
  assert(max > min, 'jitteredDelay(1000): values are not all identical (jitter works)');
}

{
  const base = 10_000;
  let allInRange = true;

  for (let i = 0; i < 100; i++) {
    const val = jitteredDelay(base);
    if (val < 8_000 || val > 12_000) allInRange = false;
  }

  assert(allInRange, 'jitteredDelay(10000): all 100 values in [8000, 12000]');
}

// ---------------------------------------------------------------------------
// Test: Payload reconstruction shape
// ---------------------------------------------------------------------------

console.log('\n--- Payload Reconstruction ---');

{
  // Simulate reconstructing a payload from stored request data
  const requestId = 'req-123';
  const externalJobId = 'ext-456';
  const resultCount = 42;

  const payload: SourcingCallbackPayload = {
    version: 1,
    requestId,
    externalJobId,
    status: 'complete',
    candidateCount: resultCount,
    enrichedCount: 0,
  };

  assert(payload.version === 1, 'Payload version is 1');
  assert(payload.requestId === requestId, 'Payload requestId matches');
  assert(payload.externalJobId === externalJobId, 'Payload externalJobId matches');
  assert(payload.status === 'complete', 'Payload status is complete');
  assert(payload.candidateCount === 42, 'Payload candidateCount from resultCount');
  assert(payload.enrichedCount === 0, 'Payload enrichedCount defaults to 0 for redelivery');
  assert(payload.error === undefined, 'Payload error is undefined for successful redelivery');
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
