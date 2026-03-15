#!/usr/bin/env npx tsx
/**
 * Location Resolution Evaluator
 *
 * Tests resolveLocationDeterministic() directly from known-good extracted
 * location text. Isolates resolver bugs from extraction bugs.
 *
 * Usage:
 *   npx tsx scripts/eval-location-resolution.ts
 *   npx tsx scripts/eval-location-resolution.ts --verbose
 *   npx tsx scripts/eval-location-resolution.ts --fixtures research/datasets/resolution-fixtures.jsonl
 */

import * as fs from 'fs';
import * as readline from 'readline';

import { resolveLocationDeterministic } from '../src/lib/taxonomy/location-service';

// ---------- Types ----------

interface ResolutionFixture {
  id: string;
  input: string;
  gold: {
    city: string | null;
    countryCode: string | null;
  };
}

export interface EvalResult {
  objective: number;
  metrics: Record<string, number>;
  artifacts?: Record<string, unknown>;
}

interface FixtureResult {
  id: string;
  input: string;
  resolved: {
    city: string | null;
    countryCode: string | null;
    confidence: number;
  };
  gold: ResolutionFixture['gold'];
  cityCorrect: boolean;
  countryCorrect: boolean;
  wrongCity: boolean;
  wrongCountry: boolean;
}

// ---------- Fixture loading ----------

async function loadFixtures(fixturePath: string): Promise<ResolutionFixture[]> {
  const fixtures: ResolutionFixture[] = [];
  const fileStream = fs.createReadStream(fixturePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) fixtures.push(JSON.parse(line));
  }
  return fixtures;
}

// ---------- Single fixture evaluation ----------

function evaluateFixture(fixture: ResolutionFixture): FixtureResult {
  const resolution = resolveLocationDeterministic(fixture.input);

  const goldCity = fixture.gold.city?.toLowerCase().trim() ?? null;
  const resolvedCity = resolution.city?.toLowerCase().trim() ?? null;
  const goldCountry = fixture.gold.countryCode?.toUpperCase() ?? null;
  const resolvedCountry = resolution.countryCode?.toUpperCase() ?? null;

  return {
    id: fixture.id,
    input: fixture.input,
    resolved: {
      city: resolution.city,
      countryCode: resolution.countryCode,
      confidence: resolution.confidence,
    },
    gold: fixture.gold,
    cityCorrect: goldCity === resolvedCity,
    countryCorrect: goldCountry === resolvedCountry,
    wrongCity: goldCity !== null && resolvedCity !== null && goldCity !== resolvedCity,
    wrongCountry: goldCountry !== null && resolvedCountry !== null && goldCountry !== resolvedCountry,
  };
}

// ---------- Aggregate metrics ----------

function computeMetrics(results: FixtureResult[]) {
  const total = results.length;
  const withGoldCity = results.filter(r => r.gold.city !== null);
  const withGoldCountry = results.filter(r => r.gold.countryCode !== null);

  const cityCorrectCount = withGoldCity.filter(r => r.cityCorrect).length;
  const countryCorrectCount = withGoldCountry.filter(r => r.countryCorrect).length;
  const wrongCityCount = results.filter(r => r.wrongCity).length;
  const wrongCountryCount = results.filter(r => r.wrongCountry).length;

  const cityFailures = results.filter(r => r.gold.city !== null && !r.cityCorrect);
  const countryFailures = results.filter(r => r.gold.countryCode !== null && !r.countryCorrect);

  const metrics: Record<string, number> = {
    total,
    city_accuracy: withGoldCity.length > 0 ? cityCorrectCount / withGoldCity.length : 1,
    country_accuracy: withGoldCountry.length > 0 ? countryCorrectCount / withGoldCountry.length : 1,
    wrong_city_rate: withGoldCity.length > 0 ? wrongCityCount / withGoldCity.length : 0,
    wrong_country_rate: withGoldCountry.length > 0 ? wrongCountryCount / withGoldCountry.length : 0,
    city_correct: cityCorrectCount,
    city_total: withGoldCity.length,
    country_correct: countryCorrectCount,
    country_total: withGoldCountry.length,
    wrong_city: wrongCityCount,
    wrong_country: wrongCountryCount,
  };

  return { metrics, cityFailures, countryFailures };
}

// ---------- Evaluator entry point ----------

export async function run(config: Record<string, unknown> = {}): Promise<EvalResult> {
  const fixturePath = (config.fixturePath as string) || 'research/datasets/resolution-fixtures.jsonl';
  const fixtures = await loadFixtures(fixturePath);
  const results = fixtures.map(evaluateFixture);
  const { metrics, cityFailures, countryFailures } = computeMetrics(results);

  return {
    objective: metrics.city_accuracy - metrics.wrong_city_rate,
    metrics,
    artifacts: {
      cityFailures: cityFailures.map(f => ({
        id: f.id,
        input: f.input,
        resolved: f.resolved,
        gold: f.gold,
        wrongCity: f.wrongCity,
      })),
      countryFailures: countryFailures.map(f => ({
        id: f.id,
        input: f.input,
        resolved: f.resolved,
        gold: f.gold,
        wrongCountry: f.wrongCountry,
      })),
      allResults: results.map(r => ({
        id: r.id,
        input: r.input,
        resolved: r.resolved,
        gold: r.gold,
        cityCorrect: r.cityCorrect,
        countryCorrect: r.countryCorrect,
        wrongCity: r.wrongCity,
        wrongCountry: r.wrongCountry,
      })),
    },
  };
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  let fixturePath = 'research/datasets/resolution-fixtures.jsonl';
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--fixtures' || args[i] === '--fixture') && args[i + 1]) {
      fixturePath = args[++i];
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    }
  }

  const result = await run({ fixturePath });

  console.log('\n=== Location Resolution Evaluation ===\n');
  console.log(`Objective: ${result.objective.toFixed(4)}`);
  console.log(
    `City accuracy: ${(result.metrics.city_accuracy * 100).toFixed(1)}%` +
    ` (${result.metrics.city_correct}/${result.metrics.city_total})`,
  );
  console.log(
    `Country accuracy: ${(result.metrics.country_accuracy * 100).toFixed(1)}%` +
    ` (${result.metrics.country_correct}/${result.metrics.country_total})`,
  );
  console.log(`Wrong city rate: ${(result.metrics.wrong_city_rate * 100).toFixed(1)}%`);
  console.log(`Wrong country rate: ${(result.metrics.wrong_country_rate * 100).toFixed(1)}%`);

  const cityFailures = result.artifacts?.cityFailures as Array<{
    id: string; input: string; resolved: FixtureResult['resolved']; gold: ResolutionFixture['gold']; wrongCity: boolean;
  }>;
  if (cityFailures.length > 0) {
    console.log(`\n--- City Failures (${cityFailures.length}) ---`);
    for (const f of cityFailures) {
      console.log(
        `  ${f.id}: "${f.input}" → city=${f.resolved.city}, country=${f.resolved.countryCode}` +
        ` | gold: city=${f.gold.city}, country=${f.gold.countryCode}` +
        (f.wrongCity ? ' [WRONG]' : ' [MISS]'),
      );
    }
  }

  const countryFailures = result.artifacts?.countryFailures as Array<{
    id: string; input: string; resolved: FixtureResult['resolved']; gold: ResolutionFixture['gold']; wrongCountry: boolean;
  }>;
  if (countryFailures.length > 0) {
    console.log(`\n--- Country Failures (${countryFailures.length}) ---`);
    for (const f of countryFailures) {
      console.log(
        `  ${f.id}: "${f.input}" → city=${f.resolved.city}, country=${f.resolved.countryCode}` +
        ` | gold: city=${f.gold.city}, country=${f.gold.countryCode}` +
        (f.wrongCountry ? ' [WRONG]' : ' [MISS]'),
      );
    }
  }

  if (verbose) {
    const allResults = result.artifacts?.allResults as Array<{
      id: string; input: string; resolved: FixtureResult['resolved']; gold: ResolutionFixture['gold'];
      cityCorrect: boolean; countryCorrect: boolean;
    }>;
    console.log('\n--- All Results ---');
    for (const r of allResults) {
      const ok = r.cityCorrect && r.countryCorrect;
      console.log(
        `  [${ok ? 'OK' : 'FAIL'}] ${r.id}: "${r.input}"` +
        ` → city=${r.resolved.city}, country=${r.resolved.countryCode}` +
        ` | gold: city=${r.gold.city}, country=${r.gold.countryCode}`,
      );
    }
  }
}

if (process.argv[1]?.includes('eval-location-resolution')) {
  main().catch(err => {
    console.error('Eval failed:', err);
    process.exit(1);
  });
}
