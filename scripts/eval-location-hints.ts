#!/usr/bin/env npx tsx
/**
 * Location Hint Extraction Evaluator
 *
 * Evaluates the accuracy of location extraction from SERP data.
 * Runs the full pipeline: extractAllHintsWithConfidence() → mergeHintsFromSerpMeta()
 * → resolveLocationDeterministic() and compares against gold labels.
 *
 * Reports per-source attribution breakdown to answer:
 *   - Is Serper metadata wrong?
 *   - Is our parser wrong?
 *   - Is our trust policy wrong?
 *
 * Usage:
 *   npx tsx scripts/eval-location-hints.ts
 *   npx tsx scripts/eval-location-hints.ts --verbose
 *   npx tsx scripts/eval-location-hints.ts --fixtures research/datasets/location-fixtures-core.jsonl
 */

import * as fs from 'fs';
import * as readline from 'readline';

import {
  extractAllHintsWithConfidence,
  mergeHintsFromSerpMeta,
} from '../src/lib/enrichment/hint-extraction';
import { resolveLocationDeterministic } from '../src/lib/taxonomy/location-service';

// ---------- Types ----------

interface LocationFixture {
  id: string;
  linkedinId: string;
  serp: {
    title: string;
    snippet: string;
    meta?: Record<string, unknown>;
  };
  gold: {
    locationText: string | null;
    city: string | null;
    countryCode: string | null;
    source?: string;
  };
}

export interface EvalResult {
  objective: number;
  metrics: Record<string, number>;
  artifacts?: Record<string, unknown>;
}

interface FixtureResult {
  id: string;
  rawExtracted: {
    locationText: string | null;
    confidence: number;
    source: string;
  };
  mergedExtracted: {
    locationText: string | null;
    confidence: number;
    source: string;
  };
  resolved: {
    city: string | null;
    countryCode: string | null;
    confidence: number;
  };
  gold: LocationFixture['gold'];
  countryCorrect: boolean;
  cityCorrect: boolean;
  falsePositive: boolean;
  wrongCountry: boolean;
  wrongCity: boolean;
}

// ---------- Fixture loading ----------

async function loadLocationFixtures(fixturePath: string): Promise<LocationFixture[]> {
  const fixtures: LocationFixture[] = [];
  const fileStream = fs.createReadStream(fixturePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) fixtures.push(JSON.parse(line));
  }
  return fixtures;
}

// ---------- Single fixture evaluation ----------

function evaluateFixture(fixture: LocationFixture): FixtureResult {
  const linkedinUrl = `https://www.linkedin.com/in/${fixture.linkedinId}`;

  // Step 1: Extract hints from SERP title + snippet
  const hints = extractAllHintsWithConfidence(
    fixture.linkedinId,
    linkedinUrl,
    fixture.serp.title,
    fixture.serp.snippet,
  );
  const rawExtracted = {
    locationText: hints.locationHint.value,
    confidence: hints.locationHint.confidence,
    source: hints.locationHint.source,
  };

  // Step 2: Merge with KG/answerBox metadata (may upgrade source + confidence)
  const merged = mergeHintsFromSerpMeta(hints, fixture.serp.meta);
  const mergedExtracted = {
    locationText: merged.locationHint.value,
    confidence: merged.locationHint.confidence,
    source: merged.locationHint.source,
  };

  // Step 3: Resolve extracted text to city + country code
  const resolution = resolveLocationDeterministic(merged.locationHint.value);

  // Step 4: Compare against gold
  const goldCountry = fixture.gold.countryCode?.toUpperCase() ?? null;
  const resolvedCountry = resolution.countryCode?.toUpperCase() ?? null;
  const goldCity = fixture.gold.city?.toLowerCase().trim() ?? null;
  const resolvedCity = resolution.city?.toLowerCase().trim() ?? null;

  const countryCorrect = goldCountry === resolvedCountry;
  const cityCorrect = goldCity === resolvedCity;
  const falsePositive = goldCountry === null && resolvedCountry !== null;
  const wrongCountry =
    goldCountry !== null &&
    resolvedCountry !== null &&
    goldCountry !== resolvedCountry;
  const wrongCity =
    goldCity !== null &&
    resolvedCity !== null &&
    goldCity !== resolvedCity;

  return {
    id: fixture.id,
    rawExtracted,
    mergedExtracted,
    resolved: {
      city: resolution.city,
      countryCode: resolution.countryCode,
      confidence: resolution.confidence,
    },
    gold: fixture.gold,
    countryCorrect,
    cityCorrect,
    falsePositive,
    wrongCountry,
    wrongCity,
  };
}

// ---------- Aggregate metrics ----------

interface SourceStats {
  total: number;
  countryTotal: number;
  countryCorrect: number;
  cityTotal: number;
  cityCorrect: number;
  falsePositives: number;
  wrongCountry: number;
  wrongCity: number;
}

function computeMetrics(results: FixtureResult[]) {
  const total = results.length;
  const withGoldCountry = results.filter(r => r.gold.countryCode !== null);
  const withGoldCity = results.filter(r => r.gold.city !== null);

  const countryCorrectCount = withGoldCountry.filter(r => r.countryCorrect).length;
  const cityCorrectCount = withGoldCity.filter(r => r.cityCorrect).length;
  const falsePositiveCount = results.filter(r => r.falsePositive).length;
  const wrongCountryCount = results.filter(r => r.wrongCountry).length;
  const wrongCityCount = results.filter(r => r.wrongCity).length;
  const unknownCount = results.filter(
    r => r.resolved.countryCode === null && r.gold.countryCode !== null,
  ).length;

  // Per-source breakdown
  const sourceBreakdown: Record<string, SourceStats> = {};
  for (const r of results) {
    const source = r.mergedExtracted.source || 'none';
    if (!sourceBreakdown[source]) {
      sourceBreakdown[source] = {
        total: 0,
        countryTotal: 0,
        countryCorrect: 0,
        cityTotal: 0,
        cityCorrect: 0,
        falsePositives: 0,
        wrongCountry: 0,
        wrongCity: 0,
      };
    }
    sourceBreakdown[source].total++;
    if (r.gold.countryCode !== null) {
      sourceBreakdown[source].countryTotal++;
      if (r.countryCorrect) sourceBreakdown[source].countryCorrect++;
    }
    if (r.gold.city !== null) {
      sourceBreakdown[source].cityTotal++;
      if (r.cityCorrect) sourceBreakdown[source].cityCorrect++;
    }
    if (r.falsePositive) sourceBreakdown[source].falsePositives++;
    if (r.wrongCountry) sourceBreakdown[source].wrongCountry++;
    if (r.wrongCity) sourceBreakdown[source].wrongCity++;
  }

  const countryFailures = results.filter(r =>
    r.gold.countryCode !== null && !r.countryCorrect,
  );
  const cityFailures = results.filter(r =>
    r.gold.city !== null && !r.cityCorrect,
  );

  const metrics: Record<string, number> = {
    total,
    city_accuracy: withGoldCity.length > 0 ? cityCorrectCount / withGoldCity.length : 1,
    country_accuracy: withGoldCountry.length > 0 ? countryCorrectCount / withGoldCountry.length : 1,
    false_positive_rate: total > 0 ? falsePositiveCount / total : 0,
    wrong_city_rate: withGoldCity.length > 0 ? wrongCityCount / withGoldCity.length : 0,
    wrong_country_rate: withGoldCountry.length > 0 ? wrongCountryCount / withGoldCountry.length : 0,
    unknown_rate: total > 0 ? unknownCount / total : 0,
    city_correct: cityCorrectCount,
    city_total: withGoldCity.length,
    country_correct: countryCorrectCount,
    country_total: withGoldCountry.length,
    false_positives: falsePositiveCount,
    wrong_city: wrongCityCount,
    wrong_country: wrongCountryCount,
    unknowns: unknownCount,
  };

  return { metrics, sourceBreakdown, countryFailures, cityFailures };
}

// ---------- Evaluator entry point (called by research-runner) ----------

export async function run(config: Record<string, unknown> = {}): Promise<EvalResult> {
  const fixturePath = (config.fixturePath as string) || 'research/datasets/location-fixtures-core.jsonl';
  const fixtures = await loadLocationFixtures(fixturePath);
  const results = fixtures.map(evaluateFixture);
  const { metrics, sourceBreakdown, countryFailures, cityFailures } = computeMetrics(results);

  return {
    objective: metrics.city_accuracy - metrics.false_positive_rate - metrics.wrong_city_rate,
    metrics,
    artifacts: {
      sourceBreakdown,
      countryFailures: countryFailures.map(f => ({
        id: f.id,
        rawExtracted: f.rawExtracted,
        mergedExtracted: f.mergedExtracted,
        resolved: f.resolved,
        gold: f.gold,
        wrongCountry: f.wrongCountry,
      })),
      cityFailures: cityFailures.map(f => ({
        id: f.id,
        rawExtracted: f.rawExtracted,
        mergedExtracted: f.mergedExtracted,
        resolved: f.resolved,
        gold: f.gold,
        wrongCity: f.wrongCity,
      })),
      allResults: results.map(r => ({
        id: r.id,
        rawExtracted: r.rawExtracted,
        mergedExtracted: r.mergedExtracted,
        resolved: r.resolved,
        gold: r.gold,
        countryCorrect: r.countryCorrect,
        cityCorrect: r.cityCorrect,
        falsePositive: r.falsePositive,
        wrongCountry: r.wrongCountry,
      })),
    },
  };
}

// ---------- CLI mode ----------

async function main() {
  const args = process.argv.slice(2);
  let fixturePath = 'research/datasets/location-fixtures-core.jsonl';
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--fixtures' || args[i] === '--fixture') && args[i + 1]) {
      fixturePath = args[++i];
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    }
  }

  const result = await run({ fixturePath });

  console.log('\n=== Location Hint Evaluation ===\n');
  console.log(`Objective: ${result.objective.toFixed(4)}`);
  console.log(
    `City accuracy: ${(result.metrics.city_accuracy * 100).toFixed(1)}%` +
    ` (${result.metrics.city_correct}/${result.metrics.city_total})`,
  );
  console.log(
    `Country accuracy: ${(result.metrics.country_accuracy * 100).toFixed(1)}%` +
    ` (${result.metrics.country_correct}/${result.metrics.country_total})`,
  );
  console.log(`False positive rate: ${(result.metrics.false_positive_rate * 100).toFixed(1)}%`);
  console.log(`Wrong city rate: ${(result.metrics.wrong_city_rate * 100).toFixed(1)}%`);
  console.log(`Wrong country rate: ${(result.metrics.wrong_country_rate * 100).toFixed(1)}%`);
  console.log(`Unknown rate: ${(result.metrics.unknown_rate * 100).toFixed(1)}%`);

  // Source breakdown
  const sb = result.artifacts?.sourceBreakdown as Record<string, SourceStats>;
  console.log('\n--- Source Breakdown ---');
  for (const [source, stats] of Object.entries(sb)) {
    const countryAcc = stats.countryTotal > 0
      ? ((stats.countryCorrect / stats.countryTotal) * 100).toFixed(1)
      : 'N/A';
    const cityAcc = stats.cityTotal > 0
      ? ((stats.cityCorrect / stats.cityTotal) * 100).toFixed(1)
      : 'N/A';
    console.log(
      `  ${source}: ${stats.total} total, ` +
      `country=${stats.countryCorrect}/${stats.countryTotal} (${countryAcc}%), ` +
      `city=${stats.cityCorrect}/${stats.cityTotal} (${cityAcc}%), ` +
      `fp=${stats.falsePositives}, wrong_country=${stats.wrongCountry}`,
    );
  }

  const countryFailures = result.artifacts?.countryFailures as Array<{
    id: string;
    rawExtracted: FixtureResult['rawExtracted'];
    mergedExtracted: FixtureResult['mergedExtracted'];
    resolved: FixtureResult['resolved'];
    gold: LocationFixture['gold'];
    wrongCountry: boolean;
  }>;
  if (countryFailures.length > 0) {
    console.log(`\n--- Country Failures (${countryFailures.length}) ---`);
    for (const f of countryFailures) {
      console.log(
        `  ${f.id}: raw="${f.rawExtracted.locationText}" (${f.rawExtracted.source})` +
        ` → merged="${f.mergedExtracted.locationText}" (${f.mergedExtracted.source})` +
        ` → city=${f.resolved.city}, country=${f.resolved.countryCode}` +
        ` | gold: city=${f.gold.city}, country=${f.gold.countryCode}` +
        (f.wrongCountry ? ' [WRONG_COUNTRY]' : ''),
      );
    }
  }

  const cityFailures = result.artifacts?.cityFailures as Array<{
    id: string;
    rawExtracted: FixtureResult['rawExtracted'];
    mergedExtracted: FixtureResult['mergedExtracted'];
    resolved: FixtureResult['resolved'];
    gold: LocationFixture['gold'];
  }>;
  if (cityFailures.length > 0) {
    console.log(`\n--- City Failures (${cityFailures.length}) ---`);
    for (const f of cityFailures) {
      console.log(
        `  ${f.id}: raw="${f.rawExtracted.locationText}" (${f.rawExtracted.source})` +
        ` → merged="${f.mergedExtracted.locationText}" (${f.mergedExtracted.source})` +
        ` → city=${f.resolved.city}, country=${f.resolved.countryCode}` +
        ` | gold: city=${f.gold.city}, country=${f.gold.countryCode}`,
      );
    }
  }

  // Verbose: all results
  if (verbose) {
    const allResults = result.artifacts?.allResults as Array<{
      id: string;
      rawExtracted: FixtureResult['rawExtracted'];
      mergedExtracted: FixtureResult['mergedExtracted'];
      resolved: FixtureResult['resolved'];
      gold: LocationFixture['gold'];
      countryCorrect: boolean;
      cityCorrect: boolean;
      falsePositive: boolean;
      wrongCountry: boolean;
    }>;
    console.log('\n--- All Results ---');
    for (const r of allResults) {
      const ok = r.countryCorrect && r.cityCorrect;
      const mark = ok ? 'OK' : 'FAIL';
      console.log(
        `  [${mark}] ${r.id}: raw="${r.rawExtracted.locationText}" ` +
        `(${r.rawExtracted.source}, conf=${r.rawExtracted.confidence.toFixed(2)})` +
        ` merged="${r.mergedExtracted.locationText}" ` +
        `(${r.mergedExtracted.source}, conf=${r.mergedExtracted.confidence.toFixed(2)})` +
        ` → city=${r.resolved.city}, country=${r.resolved.countryCode}` +
        ` | gold: city=${r.gold.city}, country=${r.gold.countryCode}` +
        (r.falsePositive ? ' [FP]' : '') +
        (r.wrongCountry ? ' [WRONG_COUNTRY]' : ''),
      );
    }
  }
}

if (process.argv[1]?.includes('eval-location-hints')) {
  main().catch(err => {
    console.error('Eval failed:', err);
    process.exit(1);
  });
}
