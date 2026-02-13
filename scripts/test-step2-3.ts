#!/usr/bin/env npx tsx
/**
 * Manual test script for Step 2+3: Explicit-Link Extraction + Reverse-Link Capture
 *
 * Tests:
 * 1. detectBridgeSignals emits correct linkedin_url_in_bio vs linkedin_url_in_blog
 * 2. detectPlatformFromUrl handles multi-segment GitHub paths + expanded denylist
 *
 * Usage: npx tsx scripts/test-step2-3.ts
 */

import { detectBridgeSignals, type ScoringInput } from '../src/lib/enrichment/scoring';
import { detectPlatformFromUrl } from '../src/lib/enrichment/bridge-discovery';

let allPassed = true;

function assert(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) allPassed = false;
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}: ${name} → ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`
  );
}

// ── Suite 1: detectBridgeSignals signal emission ─────────────────────────────

console.log('=== Suite 1: detectBridgeSignals signal emission ===');

const baseInput: ScoringInput = {
  hasCommitEvidence: false,
  commitCount: 0,
  hasProfileLink: false,
  candidateName: 'Test User',
  platformName: 'Test User',
  candidateHeadline: null,
  platformCompany: null,
  candidateLocation: null,
  platformLocation: null,
};

// bio source → linkedin_url_in_bio
assert(
  'profileLinkSource=bio → linkedin_url_in_bio',
  detectBridgeSignals({ ...baseInput, hasProfileLink: true, profileLinkSource: 'bio' }),
  ['linkedin_url_in_bio']
);

// blog source → linkedin_url_in_blog
assert(
  'profileLinkSource=blog → linkedin_url_in_blog',
  detectBridgeSignals({ ...baseInput, hasProfileLink: true, profileLinkSource: 'blog' }),
  ['linkedin_url_in_blog']
);

// undefined source → linkedin_url_in_bio (default)
assert(
  'profileLinkSource=undefined → linkedin_url_in_bio',
  detectBridgeSignals({ ...baseInput, hasProfileLink: true }),
  ['linkedin_url_in_bio']
);

// no profile link → no linkedin signal
{
  const signals = detectBridgeSignals({ ...baseInput, hasProfileLink: false });
  const hasLinkedin = signals.some(s => s.startsWith('linkedin_url_in_'));
  const pass = !hasLinkedin;
  if (!pass) allPassed = false;
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}: hasProfileLink=false → no linkedin signal (got ${JSON.stringify(signals)})`
  );
}

// ── Suite 2: detectPlatformFromUrl GitHub extraction ─────────────────────────

console.log('\n=== Suite 2: detectPlatformFromUrl GitHub extraction ===');

// Valid GitHub paths (single segment, multi-segment)
assert(
  'github.com/octocat',
  detectPlatformFromUrl('https://github.com/octocat'),
  { platform: 'github', platformId: 'octocat' }
);

assert(
  'github.com/octocat/hello-world',
  detectPlatformFromUrl('https://github.com/octocat/hello-world'),
  { platform: 'github', platformId: 'octocat' }
);

assert(
  'github.com/octocat/hello-world/tree/main',
  detectPlatformFromUrl('https://github.com/octocat/hello-world/tree/main'),
  { platform: 'github', platformId: 'octocat' }
);

// Reserved paths → null
const reserved = ['login', 'signup', 'organizations', 'site', 'customer-stories', 'readme'];
for (const path of reserved) {
  assert(
    `github.com/${path} → null (reserved)`,
    detectPlatformFromUrl(`https://github.com/${path}`),
    { platform: null, platformId: null }
  );
}

// Original denylist still works
// Note: 'about' falls through to the /about path detector → companyteam
const originalDenylist = ['features', 'pricing', 'explore', 'marketplace'];
for (const path of originalDenylist) {
  assert(
    `github.com/${path} → null (original denylist)`,
    detectPlatformFromUrl(`https://github.com/${path}`),
    { platform: null, platformId: null }
  );
}
assert(
  'github.com/about → companyteam (about path detector)',
  detectPlatformFromUrl('https://github.com/about'),
  { platform: 'companyteam', platformId: null }
);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
process.exit(allPassed ? 0 : 1);
