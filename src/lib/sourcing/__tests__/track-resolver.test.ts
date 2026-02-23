/**
 * Manual test script for deterministic track resolver.
 *
 * Run with: npx tsx src/lib/sourcing/__tests__/track-resolver.test.ts
 */

import { scoreDeterministic, resolveTrack } from '../track-resolver';
import { buildJobRequirements, type SourcingJobContextInput } from '../jd-digest';
import { getSourcingConfig } from '../config';

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

async function main() {
  const config = getSourcingConfig();

  // ---------------------------------------------------------------------------
  // scoreDeterministic tests
  // ---------------------------------------------------------------------------

  console.log('\n--- Known Tech JD ---');
  {
    const ctx: SourcingJobContextInput = {
      jdDigest: 'Build and maintain scalable web applications',
      title: 'Senior React Engineer',
      skills: ['react', 'typescript', 'node.js', 'graphql', 'kubernetes'],
    };
    const reqs = buildJobRequirements(ctx);
    const result = scoreDeterministic(ctx, reqs, config);
    assert(result.track === 'tech', `track = ${result.track} (expected tech)`);
    assert(result.confidence >= 0.85, `confidence = ${result.confidence} (expected >= 0.85)`);
    assert(result.matchedTechKeywords.length >= 3, `matched ${result.matchedTechKeywords.length} tech keywords`);
    console.log('  signals:', JSON.stringify(result, null, 2));
  }

  console.log('\n--- Known Non-Tech JD ---');
  {
    const ctx: SourcingJobContextInput = {
      jdDigest: 'Manage enterprise accounts and drive revenue growth',
      title: 'Account Executive - Enterprise Sales',
      skills: ['crm', 'salesforce', 'pipeline management', 'quota', 'negotiation'],
    };
    const reqs = buildJobRequirements(ctx);
    const result = scoreDeterministic(ctx, reqs, config);
    assert(result.track === 'non_tech', `track = ${result.track} (expected non_tech)`);
    assert(result.confidence >= 0.85, `confidence = ${result.confidence} (expected >= 0.85)`);
    assert(result.matchedNonTechKeywords.length >= 3, `matched ${result.matchedNonTechKeywords.length} non-tech keywords`);
    console.log('  signals:', JSON.stringify(result, null, 2));
  }

  console.log('\n--- Ambiguous JD ---');
  {
    // Balanced mix: 2 tech moderate + 1 strong non-tech + 1 moderate non-tech
    const ctx: SourcingJobContextInput = {
      jdDigest: 'Work with engineering teams on integration projects',
      title: 'Technical Program Manager',
      skills: ['api', 'agile', 'stakeholder management', 'budget'],
    };
    const reqs = buildJobRequirements(ctx);
    const result = scoreDeterministic(ctx, reqs, config);
    const isAmbiguous = result.track === 'blended' || result.confidence < 0.75;
    assert(isAmbiguous, `track=${result.track}, confidence=${result.confidence} (expected blended or low confidence)`);
    console.log('  signals:', JSON.stringify(result, null, 2));
  }

  console.log('\n--- Zero Signals ---');
  {
    const ctx: SourcingJobContextInput = {
      jdDigest: '',
      title: '',
    };
    const reqs = buildJobRequirements(ctx);
    const result = scoreDeterministic(ctx, reqs, config);
    assert(result.track === 'tech', `track = ${result.track} (expected tech)`);
    assert(result.confidence === 0.30, `confidence = ${result.confidence} (expected 0.30)`);
    console.log('  signals:', JSON.stringify(result, null, 2));
  }

  console.log('\n--- Role Family Boost ---');
  {
    const ctx: SourcingJobContextInput = {
      jdDigest: 'Infrastructure and deployment pipelines',
      title: 'DevOps Engineer',
      skills: ['linux'],
    };
    const reqs = buildJobRequirements(ctx);
    const result = scoreDeterministic(ctx, reqs, config);
    assert(result.track === 'tech', `track = ${result.track} (expected tech)`);
    assert(result.roleFamilySignal !== null, `roleFamilySignal = ${result.roleFamilySignal} (expected non-null)`);
    assert(result.confidence >= 0.80, `confidence = ${result.confidence} (expected >= 0.80)`);
    console.log('  signals:', JSON.stringify(result, null, 2));
  }

  // ---------------------------------------------------------------------------
  // resolveTrack tests
  // ---------------------------------------------------------------------------

  console.log('\n--- Hint Override: non_tech ---');
  {
    const ctx: SourcingJobContextInput = {
      jdDigest: 'Build React applications',
      title: 'Software Engineer',
      skills: ['react', 'typescript'],
    };
    const reqs = buildJobRequirements(ctx);
    const decision = await resolveTrack(ctx, reqs, {
      jobTrackHint: 'non_tech',
      jobTrackHintSource: 'user',
      jobTrackHintReason: 'User override for testing',
    });
    assert(decision.track === 'non_tech', `track = ${decision.track} (expected non_tech from hint)`);
    assert(decision.confidence === 1.0, `confidence = ${decision.confidence} (expected 1.0)`);
    assert(decision.method === 'deterministic', `method = ${decision.method} (expected deterministic)`);
    assert(decision.hintUsed?.hint === 'non_tech', `hintUsed.hint = ${decision.hintUsed?.hint}`);
  }

  console.log('\n--- Hint Override: tech ---');
  {
    const ctx: SourcingJobContextInput = {
      jdDigest: 'Manage sales pipeline',
      title: 'Account Executive',
      skills: ['salesforce', 'quota'],
    };
    const reqs = buildJobRequirements(ctx);
    const decision = await resolveTrack(ctx, reqs, { jobTrackHint: 'tech' });
    assert(decision.track === 'tech', `track = ${decision.track} (expected tech from hint)`);
    assert(decision.confidence === 1.0, `confidence = ${decision.confidence} (expected 1.0)`);
  }

  console.log('\n--- Hint: auto (should not override) ---');
  {
    const ctx: SourcingJobContextInput = {
      jdDigest: 'Manage enterprise accounts',
      title: 'Account Executive - Enterprise Sales',
      skills: ['crm', 'salesforce', 'pipeline management', 'quota', 'negotiation'],
    };
    const reqs = buildJobRequirements(ctx);
    const decision = await resolveTrack(ctx, reqs, { jobTrackHint: 'auto' });
    assert(decision.track === 'non_tech', `track = ${decision.track} (expected non_tech, auto should not override)`);
    assert(decision.hintUsed === undefined, `hintUsed = ${JSON.stringify(decision.hintUsed)} (expected undefined)`);
  }

  console.log('\n--- resolveTrack never throws ---');
  {
    const ctx = { jdDigest: '' } as SourcingJobContextInput;
    const reqs = buildJobRequirements(ctx);
    try {
      const decision = await resolveTrack(ctx, reqs);
      assert(decision.track === 'tech', `track = ${decision.track} (expected tech fallback)`);
      assert(typeof decision.confidence === 'number', `confidence is a number: ${decision.confidence}`);
      assert(typeof decision.resolvedAt === 'string', `resolvedAt is a string: ${decision.resolvedAt}`);
    } catch (err) {
      assert(false, `resolveTrack threw: ${err}`);
    }
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
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
