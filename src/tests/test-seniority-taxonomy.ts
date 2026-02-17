/**
 * Regression tests for seniority taxonomy normalization.
 *
 * Run with: npx tsx src/tests/test-seniority-taxonomy.ts
 */

import { normalizeSeniorityFromText, seniorityDistance } from '@/lib/taxonomy/seniority';

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

console.log('\n--- Headline Normalization ---');

assert(normalizeSeniorityFromText('Senior Software Engineer') === 'senior', '"Senior Software Engineer" → senior');
assert(normalizeSeniorityFromText('Engineering Manager') === 'manager', '"Engineering Manager" → manager');
assert(normalizeSeniorityFromText('Director of Sales') === 'director', '"Director of Sales" → director');
assert(normalizeSeniorityFromText('VP Marketing') === 'vp', '"VP Marketing" → vp');
assert(normalizeSeniorityFromText('Staff Engineer') === 'staff', '"Staff Engineer" → staff');
assert(normalizeSeniorityFromText('Junior Developer') === 'junior', '"Junior Developer" → junior');
assert(normalizeSeniorityFromText('Software Engineer') === null, '"Software Engineer" (no seniority) → null');
assert(normalizeSeniorityFromText('Principal Architect') === 'principal', '"Principal Architect" → principal');
assert(normalizeSeniorityFromText('Lead Backend Developer') === 'lead', '"Lead Backend Developer" → lead');
assert(normalizeSeniorityFromText(null) === null, 'null → null');
assert(normalizeSeniorityFromText('') === null, 'empty string → null');

console.log('\n--- Seniority Distance ---');

assert(seniorityDistance('senior', 'senior') === 0, 'senior↔senior = 0');
assert(seniorityDistance('senior', 'staff') === 1, 'senior↔staff = 1');
assert(seniorityDistance('intern', 'cxo') === 10, 'intern↔cxo = 10');
assert(seniorityDistance('junior', 'mid') === 1, 'junior↔mid = 1');

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed.');
}
