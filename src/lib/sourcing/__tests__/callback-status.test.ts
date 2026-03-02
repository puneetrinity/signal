/**
 * Unit tests for decoupled callback status.
 *
 * Validates that:
 * 1. SourcingRequestStatus no longer includes 'callback_sent' or 'callback_failed'
 * 2. CallbackDeliveryStatus type exists with correct values
 * 3. Ranking modules (rerank, rescore, novelty) have zero references to callbackStatus
 * 4. callback.ts no longer writes 'callback_sent' or 'callback_failed' to status field
 *
 * Run with: npx tsx src/lib/sourcing/__tests__/callback-status.test.ts
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';

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

const srcRoot = join(dirname(new URL(import.meta.url).pathname), '..');

function readSrc(relPath: string): string {
  return readFileSync(join(srcRoot, relPath), 'utf-8');
}

console.log('Decoupled callback status tests\n');

// --- Type checks ---
console.log('1. Type definitions');
{
  const types = readSrc('types.ts');
  assert(
    'SourcingRequestStatus does NOT include callback_sent',
    !types.includes("'callback_sent'"),
  );
  assert(
    'SourcingRequestStatus does NOT include callback_failed',
    !types.includes("'callback_failed'"),
  );
  assert(
    'CallbackDeliveryStatus type exists',
    types.includes('CallbackDeliveryStatus'),
  );
  assert(
    "CallbackDeliveryStatus includes 'pending'",
    /CallbackDeliveryStatus[\s\S]*'pending'/.test(types),
  );
  assert(
    "CallbackDeliveryStatus includes 'delivered'",
    /CallbackDeliveryStatus[\s\S]*'delivered'/.test(types),
  );
  assert(
    "CallbackDeliveryStatus includes 'failed'",
    /CallbackDeliveryStatus[\s\S]*'failed'/.test(types),
  );
}

// --- callback.ts no longer mutates status to callback values ---
console.log('\n2. callback.ts status mutations');
{
  const callback = readSrc('callback.ts');
  assert(
    'callback.ts does NOT set status to callback_sent',
    !callback.includes("status: 'callback_sent'"),
  );
  assert(
    'callback.ts does NOT set status to callback_failed',
    !callback.includes("status: 'callback_failed'"),
  );
  assert(
    'callback.ts sets callbackStatus to delivered on success',
    callback.includes("callbackStatus: 'delivered'"),
  );
  assert(
    'callback.ts sets callbackSentAt on success',
    callback.includes('callbackSentAt:'),
  );
  assert(
    'callback.ts clears lastCallbackError on success',
    /callbackStatus: 'delivered'[\s\S]*?lastCallbackError: null/.test(callback),
  );
  assert(
    'callback.ts sets callbackStatus to failed on exhaustion',
    callback.includes("callbackStatus: 'failed'"),
  );
}

// --- redeliverStaleCallbacks uses callbackStatus ---
console.log('\n3. redeliverStaleCallbacks query');
{
  const callback = readSrc('callback.ts');
  // The findMany where clause should include callbackStatus: 'failed' and status: 'complete'
  const redeliverSection = callback.slice(callback.indexOf('redeliverStaleCallbacks'));
  assert(
    "redeliverStaleCallbacks queries callbackStatus: 'failed'",
    redeliverSection.includes("callbackStatus: 'failed'"),
  );
  assert(
    "redeliverStaleCallbacks queries status: 'complete'",
    redeliverSection.includes("status: 'complete'"),
  );
}

// --- queue/index.ts sets callbackStatus at complete time ---
console.log('\n4. queue/index.ts sets callbackStatus at complete time');
{
  const queue = readSrc('queue/index.ts');
  // After status: 'complete', should set callbackStatus: 'pending'
  const completeSection = queue.slice(queue.indexOf("status: 'complete'"));
  assert(
    "queue sets callbackStatus: 'pending' alongside status: 'complete'",
    completeSection.includes("callbackStatus: 'pending'"),
  );
  assert(
    'queue sets callbackSentAt: null alongside status complete',
    completeSection.includes('callbackSentAt: null'),
  );
}

// --- Ranking modules have zero callback status references ---
console.log('\n5. Ranking modules have no callback status references');
{
  for (const mod of ['rerank.ts', 'rescore.ts', 'novelty.ts']) {
    const content = readSrc(mod);
    assert(
      `${mod} has no 'callbackStatus' reference`,
      !content.includes('callbackStatus'),
    );
    assert(
      `${mod} has no 'callback_sent' reference`,
      !content.includes('callback_sent'),
    );
    assert(
      `${mod} has no 'callback_failed' reference`,
      !content.includes('callback_failed'),
    );
  }
}

// --- source/route.ts retry logic ---
console.log('\n6. source/route.ts retry logic');
{
  const appRoot = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'app', 'api', 'v3', 'jobs', '[id]', 'source');
  const sourceRoute = readFileSync(join(appRoot, 'route.ts'), 'utf-8');
  assert(
    'source route does NOT check callback_failed for retryable',
    !sourceRoute.includes("callback_failed"),
  );
  assert(
    'source route resets callbackStatus on retry',
    sourceRoute.includes('callbackStatus: null'),
  );
  assert(
    'source route resets callbackSentAt on retry',
    sourceRoute.includes('callbackSentAt: null'),
  );
}

// --- results/route.ts includes callback fields ---
console.log('\n7. results/route.ts includes callback fields');
{
  const resultsRoot = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'app', 'api', 'v3', 'jobs', '[id]', 'results');
  const resultsRoute = readFileSync(join(resultsRoot, 'route.ts'), 'utf-8');
  assert(
    'results route includes callbackStatus in response',
    resultsRoute.includes('callbackStatus:'),
  );
  assert(
    'results route includes callbackSentAt in response',
    resultsRoute.includes('callbackSentAt:'),
  );
}

// --- Summary ---
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
