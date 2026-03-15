#!/usr/bin/env npx tsx
/**
 * Seniority Extraction Evaluator
 *
 * Evaluates the accuracy of normalizeSeniorityFromText() against
 * gold-labeled headlines.
 *
 * Metrics:
 *   - accuracy (matches / fixtures with gold != null)
 *   - false_positive_rate (FPs / all fixtures)
 *   - miss_rate (misses / fixtures with gold != null)
 *   - mismatch_rate (mismatches / fixtures with gold != null)
 *
 * Usage:
 *   npx tsx scripts/eval-seniority.ts
 *   npx tsx scripts/eval-seniority.ts --verbose
 *   npx tsx scripts/eval-seniority.ts --fixtures research/datasets/seniority-fixtures-adversarial.jsonl
 */

import * as fs from 'fs';
import * as readline from 'readline';

import { normalizeSeniorityFromText } from '../src/lib/taxonomy/seniority';

// ---------- Types ----------

interface SeniorityFixture {
  id: string;
  caseType?: string;
  headline: string;
  gold: {
    seniority: string | null;
  };
}

export interface EvalResult {
  objective: number;
  metrics: Record<string, number>;
  artifacts?: Record<string, unknown>;
}

type Verdict = 'MATCH' | 'MISMATCH' | 'FALSE_POSITIVE' | 'MISS';

interface FixtureResult {
  id: string;
  caseType: string | null;
  extracted: string | null;
  gold: string | null;
  verdict: Verdict;
}

// ---------- Verdict logic ----------

function computeVerdict(extracted: string | null, gold: string | null): Verdict {
  if (extracted === gold) return 'MATCH';
  if (gold === null && extracted !== null) return 'FALSE_POSITIVE';
  if (gold !== null && extracted === null) return 'MISS';
  return 'MISMATCH';
}

// ---------- Fixture loading ----------

async function loadFixtures(fixturePath: string): Promise<SeniorityFixture[]> {
  const fixtures: SeniorityFixture[] = [];
  const fileStream = fs.createReadStream(fixturePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) fixtures.push(JSON.parse(line));
  }
  return fixtures;
}

// ---------- Single fixture evaluation ----------

function evaluateFixture(fixture: SeniorityFixture): FixtureResult {
  const extracted = normalizeSeniorityFromText(fixture.headline);
  return {
    id: fixture.id,
    caseType: fixture.caseType ?? null,
    extracted,
    gold: fixture.gold.seniority,
    verdict: computeVerdict(extracted, fixture.gold.seniority),
  };
}

// ---------- Aggregate metrics ----------

function computeMetrics(results: FixtureResult[]) {
  const total = results.length;
  const withGold = results.filter(r => r.gold !== null);

  const matches = withGold.filter(r => r.verdict === 'MATCH').length;
  const fps = results.filter(r => r.verdict === 'FALSE_POSITIVE').length;
  const misses = results.filter(r => r.verdict === 'MISS').length;
  const mismatches = results.filter(r => r.verdict === 'MISMATCH').length;

  const accuracy = withGold.length > 0 ? matches / withGold.length : 1;
  const false_positive_rate = total > 0 ? fps / total : 0;
  const miss_rate = withGold.length > 0 ? misses / withGold.length : 0;
  const mismatch_rate = withGold.length > 0 ? mismatches / withGold.length : 0;

  const metrics: Record<string, number> = {
    total,
    accuracy,
    false_positive_rate,
    miss_rate,
    mismatch_rate,
    matches,
    with_gold: withGold.length,
    fps,
    misses,
    mismatches,
  };

  const failures = results.filter(r => r.verdict !== 'MATCH');
  return { metrics, failures };
}

// ---------- Evaluator entry point ----------

export async function run(config: Record<string, unknown> = {}): Promise<EvalResult> {
  const fixturePath = (config.fixturePath as string) || 'research/datasets/seniority-fixtures-core.jsonl';
  const fixtures = await loadFixtures(fixturePath);
  const results = fixtures.map(evaluateFixture);
  const { metrics, failures } = computeMetrics(results);

  const objective =
    metrics.accuracy -
    metrics.false_positive_rate -
    0.5 * metrics.miss_rate;

  return {
    objective,
    metrics,
    artifacts: {
      failures: failures.map(r => ({
        id: r.id,
        caseType: r.caseType,
        verdict: r.verdict,
        extracted: r.extracted,
        gold: r.gold,
      })),
      allResults: results,
    },
  };
}

// ---------- CLI mode ----------

async function main() {
  const args = process.argv.slice(2);
  let fixturePath = 'research/datasets/seniority-fixtures-core.jsonl';
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--fixtures' || args[i] === '--fixture') && args[i + 1]) {
      fixturePath = args[++i];
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    }
  }

  const result = await run({ fixturePath });

  console.log('\n=== Seniority Evaluation ===\n');
  console.log(`Objective: ${result.objective.toFixed(4)}`);
  console.log(
    `Accuracy: ${(result.metrics.accuracy * 100).toFixed(1)}%` +
    ` (${result.metrics.matches}/${result.metrics.with_gold})`,
  );
  console.log(`False positive rate: ${(result.metrics.false_positive_rate * 100).toFixed(1)}%` +
    ` (${result.metrics.fps})`);
  console.log(`Miss rate: ${(result.metrics.miss_rate * 100).toFixed(1)}%` +
    ` (${result.metrics.misses})`);
  console.log(`Mismatch rate: ${(result.metrics.mismatch_rate * 100).toFixed(1)}%` +
    ` (${result.metrics.mismatches})`);

  const failures = result.artifacts?.failures as Array<{
    id: string; caseType: string | null; verdict: Verdict; extracted: string | null; gold: string | null;
  }>;

  if (failures.length > 0) {
    const byVerdict = new Map<string, typeof failures>();
    for (const f of failures) {
      if (!byVerdict.has(f.verdict)) byVerdict.set(f.verdict, []);
      byVerdict.get(f.verdict)!.push(f);
    }
    console.log(`\n--- Failures (${failures.length}) ---`);
    for (const [verdict, items] of byVerdict) {
      console.log(`\n  ${verdict} (${items.length}):`);
      for (const f of items) {
        const caseTag = f.caseType ? ` [${f.caseType}]` : '';
        console.log(
          `    ${f.id}${caseTag}: extracted="${f.extracted}" gold="${f.gold}"`,
        );
      }
    }
  }

  if (verbose) {
    const allResults = result.artifacts?.allResults as FixtureResult[];
    console.log('\n--- All Results ---');
    for (const r of allResults) {
      const mark = r.verdict === 'MATCH' ? 'OK' : 'FAIL';
      const caseTag = r.caseType ? ` [${r.caseType}]` : '';
      console.log(
        `  [${mark}] ${r.id}${caseTag}: ${r.verdict}` +
        ` extracted="${r.extracted}" gold="${r.gold}"`,
      );
    }
  }
}

if (process.argv[1]?.includes('eval-seniority')) {
  main().catch(err => {
    console.error('Eval failed:', err);
    process.exit(1);
  });
}
