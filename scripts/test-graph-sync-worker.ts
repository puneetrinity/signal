#!/usr/bin/env npx tsx

/**
 * Test: candidate-graph-sync worker merge policy
 *
 * Validates identity resolution and merge decisions.
 * Run: npx tsx scripts/test-graph-sync-worker.ts
 * Exit: 0 = pass, 1 = fail
 */

// ---- Merge decision logic (extracted from worker for pure testing) ----

interface MergeDecision {
  action: 'merge' | 'create' | 'split';
  matchMethod: string;
  matchConfidence: number | null;
}

interface Anchors {
  linkedin_id?: string;
  github_id?: string;
  email_hash?: string;
}

interface ExistingRecord {
  id: string;
  linkedin_id?: string;
  github_id?: string;
  email_hash?: string;
  identity_confidence?: number;
}

function decideMerge(
  anchors: Anchors,
  existing: ExistingRecord | null,
  candidateConfidence: number | null,
): MergeDecision {
  if (!existing) {
    return {
      action: 'create',
      matchMethod: 'new',
      matchConfidence: anchors.linkedin_id ? 1.0 : null,
    };
  }

  // Conflict check: non-LinkedIn anchor matched a record with different linkedin_id
  if (anchors.linkedin_id && existing.linkedin_id && anchors.linkedin_id !== existing.linkedin_id) {
    return {
      action: 'split',
      matchMethod: 'conflict_split',
      matchConfidence: 0,
    };
  }

  // Determine match confidence
  let matchConfidence: number | null = null;
  let matchMethod: string = 'unknown';

  if (anchors.linkedin_id && existing.linkedin_id === anchors.linkedin_id) {
    matchConfidence = 1.0;
    matchMethod = 'linkedin_id_exact';
  } else if (anchors.github_id && existing.github_id === anchors.github_id) {
    matchConfidence = candidateConfidence ?? 0.85;
    matchMethod = 'github_exact';
  } else if (anchors.email_hash && existing.email_hash === anchors.email_hash) {
    matchConfidence = candidateConfidence ?? 0.85;
    matchMethod = 'email_hash_exact';
  }

  // Apply merge threshold
  if (matchMethod === 'linkedin_id_exact' || (matchConfidence !== null && matchConfidence >= 0.85)) {
    return { action: 'merge', matchMethod, matchConfidence };
  }

  return {
    action: 'split',
    matchMethod: 'low_confidence_split',
    matchConfidence,
  };
}

// ---- Test runner ----

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`  PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  FAIL: ${testName}`);
    failed++;
  }
}

function assertEqual(actual: unknown, expected: unknown, testName: string) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    console.log(`  PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  FAIL: ${testName}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ---- Tests ----

console.log('\n=== Test: Idempotent upsert (same linkedin_id twice) ===');
{
  const anchors: Anchors = { linkedin_id: 'johndoe' };
  const existing: ExistingRecord = { id: 'gc-1', linkedin_id: 'johndoe' };

  const result1 = decideMerge(anchors, existing, 0.9);
  const result2 = decideMerge(anchors, existing, 0.9);

  assertEqual(result1.action, 'merge', 'First call merges');
  assertEqual(result2.action, 'merge', 'Second call also merges (idempotent)');
  assertEqual(result1.matchMethod, 'linkedin_id_exact', 'Match method is linkedin_id_exact');
  assertEqual(result1.matchConfidence, 1.0, 'Confidence is 1.0 for linkedin_id exact');
}

console.log('\n=== Test: linkedin_id exact merge bypasses 0.85 gate ===');
{
  const anchors: Anchors = { linkedin_id: 'janedoe' };
  const existing: ExistingRecord = {
    id: 'gc-2',
    linkedin_id: 'janedoe',
    identity_confidence: 0.5, // Low existing confidence shouldn't matter
  };

  const result = decideMerge(anchors, existing, null);
  assertEqual(result.action, 'merge', 'linkedin_id exact always merges');
  assertEqual(result.matchConfidence, 1.0, 'Confidence is 1.0 regardless of existing');
}

console.log('\n=== Test: Low-confidence split (github < 0.85) ===');
{
  const anchors: Anchors = { github_id: 'ghuser123' };
  const existing: ExistingRecord = { id: 'gc-3', github_id: 'ghuser123' };

  // Candidate confidence 0.7 (below 0.85 threshold)
  const result = decideMerge(anchors, existing, 0.7);
  assertEqual(result.action, 'split', 'Low confidence creates split');
  assertEqual(result.matchMethod, 'low_confidence_split', 'Method indicates low confidence');
  assertEqual(result.matchConfidence, 0.7, 'Confidence reflects candidate score');
}

console.log('\n=== Test: github/email match with high confidence merges ===');
{
  const anchors: Anchors = { github_id: 'ghuser456' };
  const existing: ExistingRecord = { id: 'gc-4', github_id: 'ghuser456' };

  // Candidate confidence 0.92 (above 0.85)
  const result = decideMerge(anchors, existing, 0.92);
  assertEqual(result.action, 'merge', 'High confidence github match merges');
  assertEqual(result.matchMethod, 'github_exact', 'Method is github_exact');
  assertEqual(result.matchConfidence, 0.92, 'Confidence from candidate');
}

console.log('\n=== Test: Conflict — different linkedin_id ===');
{
  const anchors: Anchors = { linkedin_id: 'alice', github_id: 'ghuser789' };
  const existing: ExistingRecord = {
    id: 'gc-5',
    linkedin_id: 'bob', // Different linkedin_id!
    github_id: 'ghuser789',
  };

  const result = decideMerge(anchors, existing, 0.95);
  assertEqual(result.action, 'split', 'Conflict creates split');
  assertEqual(result.matchMethod, 'conflict_split', 'Method indicates conflict');
  assertEqual(result.matchConfidence, 0, 'Confidence is 0 for conflicts');
}

console.log('\n=== Test: New candidate (no existing record) ===');
{
  const anchors: Anchors = { linkedin_id: 'newuser' };
  const result = decideMerge(anchors, null, null);

  assertEqual(result.action, 'create', 'Creates new record');
  assertEqual(result.matchMethod, 'new', 'Method is new');
  assertEqual(result.matchConfidence, 1.0, 'linkedin_id anchor gives 1.0');
}

console.log('\n=== Test: New candidate without linkedin_id ===');
{
  const anchors: Anchors = { email_hash: 'abc123hash' };
  const result = decideMerge(anchors, null, null);

  assertEqual(result.action, 'create', 'Creates new record');
  assertEqual(result.matchConfidence, null, 'No linkedin_id means null confidence');
}

// ---- Summary ----
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed.');
  process.exit(0);
}
