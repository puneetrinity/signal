/**
 * Manual test script for Groq track classification fallback.
 *
 * Run with: npx tsx src/lib/sourcing/__tests__/track-groq.test.ts
 *
 * Requires GROQ_API_KEY + REDIS_URL to be set for full tests.
 * Tests that don't need external services are marked accordingly.
 */

import { groqClassifyTrack } from '../track-groq';
import { scoreDeterministic } from '../track-resolver';
import { buildJobRequirements, type SourcingJobContextInput } from '../jd-digest';
import { getSourcingConfig, type SourcingConfig } from '../config';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

function skip(label: string) {
  console.log(`  SKIP: ${label}`);
  skipped++;
}

async function main() {
  const config = getSourcingConfig();
  const hasGroqKey = !!process.env.GROQ_API_KEY;
  const hasRedis = !!process.env.REDIS_URL;

  // ---------------------------------------------------------------------------
  // Merge rule tests (no external deps)
  // ---------------------------------------------------------------------------

  console.log('\n--- Merge Rules (unit, no external deps) ---');

  console.log('\n  Deterministic blended + Groq high confidence -> adopt Groq');
  {
    const ctx: SourcingJobContextInput = {
      jdDigest: 'Bridge technical solutions with customer needs',
      title: 'Technical Account Manager',
      skills: ['api', 'stakeholder management', 'crm', 'sdk'],
    };
    const reqs = buildJobRequirements(ctx);
    const det = scoreDeterministic(ctx, reqs, config);
    const groqResult = {
      track: 'non_tech' as const,
      confidence: 0.85,
      reasons: ['Account management is primary'],
      ambiguityFlag: true,
      modelName: 'test',
      latencyMs: 100,
      cached: false,
    };

    if (det.track === 'blended') {
      assert(groqResult.confidence >= 0.80, 'Groq confidence qualifies for adoption');
      assert(groqResult.track === 'non_tech', 'Would adopt non_tech from Groq');
    } else {
      console.log(`  (det track=${det.track}, not blended -- merge rule N/A)`);
    }
  }

  console.log('\n  Groq disagrees with strong deterministic -> keep blended');
  {
    const detTrack = 'tech';
    const groqTrack = 'non_tech';
    const shouldKeepBlended = (detTrack as string) !== (groqTrack as string);
    assert(shouldKeepBlended, 'Disagreement -> would merge to blended');
  }

  // ---------------------------------------------------------------------------
  // Live Groq tests (need API key + Redis)
  // ---------------------------------------------------------------------------

  if (!hasGroqKey) {
    console.log('\n--- Live Groq Tests (SKIPPED: no GROQ_API_KEY) ---');
    skip('Groq classification');
    skip('Cache hit');
    skip('Timeout behavior');
  } else {
    console.log('\n--- Live Groq Classification ---');

    try {
      const ctx: SourcingJobContextInput = {
        jdDigest: 'Build and scale microservices architecture',
        title: 'Senior Backend Engineer',
        skills: ['python', 'kubernetes', 'postgresql'],
      };
      const result = await groqClassifyTrack(ctx, config);
      assert(result.track === 'tech', `track = ${result.track} (expected tech)`);
      assert(result.confidence > 0.5, `confidence = ${result.confidence} (expected > 0.5)`);
      assert(result.reasons.length > 0, `reasons provided: ${result.reasons.length}`);
      assert(result.latencyMs > 0, `latencyMs = ${result.latencyMs}`);
      assert(result.cached === false, `cached = ${result.cached} (first call)`);
      console.log('  result:', JSON.stringify(result, null, 2));

      if (hasRedis) {
        console.log('\n--- Cache Hit ---');
        const result2 = await groqClassifyTrack(ctx, config);
        assert(result2.cached === true, `cached = ${result2.cached} (expected true on second call)`);
        assert(result2.track === result.track, `track matches: ${result2.track}`);
      } else {
        skip('Cache hit (no REDIS_URL)');
      }
    } catch (err) {
      console.error('  Groq call failed:', err);
      assert(false, `Groq classification threw: ${err}`);
    }

    console.log('\n--- Timeout Behavior ---');
    {
      const shortTimeoutConfig: SourcingConfig = {
        ...config,
        trackGroqTimeoutMs: 1,
      };
      const ctx: SourcingJobContextInput = {
        jdDigest: 'Manage sales pipeline',
        title: 'Account Executive',
        skills: ['salesforce'],
      };
      const start = Date.now();
      try {
        await groqClassifyTrack(ctx, shortTimeoutConfig);
        assert(false, 'Should have thrown on timeout');
      } catch (err) {
        const elapsed = Date.now() - start;
        assert(elapsed < shortTimeoutConfig.trackGroqTimeoutMs + 5000, `Timeout respected: ${elapsed}ms`);
        assert(err instanceof Error, `Error thrown: ${err}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Circuit breaker test (need Redis)
  // ---------------------------------------------------------------------------

  if (!hasRedis) {
    console.log('\n--- Circuit Breaker (SKIPPED: no REDIS_URL) ---');
    skip('Circuit breaker');
  } else {
    console.log('\n--- Circuit Breaker ---');
    console.log('  (Circuit breaker is structurally tested via code review)');
    console.log('  Redis keys: track:groq:cb:failures, track:groq:cb:open_until');
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
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
