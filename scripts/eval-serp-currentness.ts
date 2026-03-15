#!/usr/bin/env npx tsx
/**
 * SERP Currentness Evaluator
 *
 * Tests whether we can determine if SERP-extracted title and location
 * evidence is current vs historical.
 *
 * Gold labels: current, historical, unknown
 *
 * Metrics:
 *   current_title_accuracy    — % correct on title currentness
 *   current_location_accuracy — % correct on location currentness
 *   stale_title_fp_rate       — % of historical titles classified as current
 *   stale_location_fp_rate    — % of historical locations classified as current
 *   unknown_rate              — % classified as unknown (coverage measure)
 *
 * Usage:
 *   npx tsx scripts/eval-serp-currentness.ts
 *   npx tsx scripts/eval-serp-currentness.ts --verbose
 *   npx tsx scripts/eval-serp-currentness.ts --file research/datasets/serp-currentness-adversarial.jsonl
 */

import { readFileSync } from 'fs';
import { type Currentness, detectCurrentness } from '../src/lib/search/currentness';

// ---------------------------------------------------------------------------
// Evaluator framework
// ---------------------------------------------------------------------------

interface Fixture {
  id: string;
  searchTitle: string;
  searchSnippet: string;
  evaluated_location?: string;
  gold: {
    title_currentness?: Currentness;
    location_currentness?: Currentness;
  };
  note?: string;
}

interface CheckResult {
  fixtureId: string;
  field: 'title' | 'location';
  gold: Currentness;
  predicted: Currentness;
  correct: boolean;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let verbose = false;
  let file: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verbose') verbose = true;
    else if (args[i] === '--file' && args[i + 1]) file = args[++i];
  }
  return { verbose, file };
}

function loadFixtures(path: string): Fixture[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function main() {
  const { verbose, file } = parseArgs();
  const files = file
    ? [file]
    : [
        'research/datasets/serp-currentness-title-core.jsonl',
        'research/datasets/serp-currentness-location-core.jsonl',
        'research/datasets/serp-currentness-adversarial.jsonl',
      ];

  const allResults: CheckResult[] = [];

  for (const filepath of files) {
    const fixtures = loadFixtures(filepath);
    console.log(`\n=== ${filepath} (${fixtures.length} fixtures) ===\n`);

    for (const fx of fixtures) {
      const result = detectCurrentness(fx.searchTitle, fx.searchSnippet, fx.evaluated_location);

      // Check title if gold label exists
      if (fx.gold.title_currentness) {
        const correct = result.title === fx.gold.title_currentness;
        allResults.push({
          fixtureId: fx.id,
          field: 'title',
          gold: fx.gold.title_currentness,
          predicted: result.title,
          correct,
        });
        if (verbose || !correct) {
          const icon = correct ? 'OK' : 'MISS';
          console.log(`  ${icon.padEnd(4)} ${fx.id} title: predicted=${result.title} gold=${fx.gold.title_currentness}${fx.note ? ` [${fx.note}]` : ''}`);
        }
      }

      // Check location if gold label exists
      if (fx.gold.location_currentness) {
        const correct = result.location === fx.gold.location_currentness;
        allResults.push({
          fixtureId: fx.id,
          field: 'location',
          gold: fx.gold.location_currentness,
          predicted: result.location,
          correct,
        });
        if (verbose || !correct) {
          const icon = correct ? 'OK' : 'MISS';
          console.log(`  ${icon.padEnd(4)} ${fx.id} location: predicted=${result.location} gold=${fx.gold.location_currentness}${fx.note ? ` [${fx.note}]` : ''}`);
        }
      }
    }
  }

  // Aggregate by field
  const titleResults = allResults.filter(r => r.field === 'title');
  const locationResults = allResults.filter(r => r.field === 'location');

  const titleCorrect = titleResults.filter(r => r.correct).length;
  const locationCorrect = locationResults.filter(r => r.correct).length;
  const totalCorrect = allResults.filter(r => r.correct).length;

  // Stale FP: gold=historical but predicted=current
  const staleTitleFP = titleResults.filter(r => r.gold === 'historical' && r.predicted === 'current').length;
  const staleTitleTotal = titleResults.filter(r => r.gold === 'historical').length;
  const staleLocFP = locationResults.filter(r => r.gold === 'historical' && r.predicted === 'current').length;
  const staleLocTotal = locationResults.filter(r => r.gold === 'historical').length;

  // Unknown rate
  const titleUnknown = titleResults.filter(r => r.predicted === 'unknown').length;
  const locUnknown = locationResults.filter(r => r.predicted === 'unknown').length;

  console.log('\n--- Aggregate Results ---');
  console.log(`  Total checks:              ${allResults.length}`);
  console.log(`  Correct:                   ${totalCorrect} (${(totalCorrect / allResults.length * 100).toFixed(1)}%)`);
  console.log(`  Title accuracy:            ${titleResults.length > 0 ? (titleCorrect / titleResults.length * 100).toFixed(1) : 'N/A'}% (${titleCorrect}/${titleResults.length})`);
  console.log(`  Location accuracy:         ${locationResults.length > 0 ? (locationCorrect / locationResults.length * 100).toFixed(1) : 'N/A'}% (${locationCorrect}/${locationResults.length})`);
  console.log(`  Stale title FP rate:       ${staleTitleTotal > 0 ? (staleTitleFP / staleTitleTotal * 100).toFixed(1) : 'N/A'}% (${staleTitleFP}/${staleTitleTotal} historical→current)`);
  console.log(`  Stale location FP rate:    ${staleLocTotal > 0 ? (staleLocFP / staleLocTotal * 100).toFixed(1) : 'N/A'}% (${staleLocFP}/${staleLocTotal} historical→current)`);
  console.log(`  Title unknown rate:        ${(titleUnknown / titleResults.length * 100).toFixed(1)}% (${titleUnknown}/${titleResults.length})`);
  console.log(`  Location unknown rate:     ${(locUnknown / locationResults.length * 100).toFixed(1)}% (${locUnknown}/${locationResults.length})`);

  // Per-gold-label breakdown
  console.log('\n--- Per Gold Label (Title) ---');
  for (const label of ['current', 'historical', 'unknown'] as Currentness[]) {
    const subset = titleResults.filter(r => r.gold === label);
    if (subset.length === 0) continue;
    const correct = subset.filter(r => r.correct).length;
    const asCurrent = subset.filter(r => r.predicted === 'current').length;
    const asHistorical = subset.filter(r => r.predicted === 'historical').length;
    const asUnknown = subset.filter(r => r.predicted === 'unknown').length;
    console.log(`  ${label.padEnd(12)} total=${subset.length} correct=${correct} (${(correct / subset.length * 100).toFixed(0)}%) → current=${asCurrent} historical=${asHistorical} unknown=${asUnknown}`);
  }

  console.log('\n--- Per Gold Label (Location) ---');
  for (const label of ['current', 'historical', 'unknown'] as Currentness[]) {
    const subset = locationResults.filter(r => r.gold === label);
    if (subset.length === 0) continue;
    const correct = subset.filter(r => r.correct).length;
    const asCurrent = subset.filter(r => r.predicted === 'current').length;
    const asHistorical = subset.filter(r => r.predicted === 'historical').length;
    const asUnknown = subset.filter(r => r.predicted === 'unknown').length;
    console.log(`  ${label.padEnd(12)} total=${subset.length} correct=${correct} (${(correct / subset.length * 100).toFixed(0)}%) → current=${asCurrent} historical=${asHistorical} unknown=${asUnknown}`);
  }

  // Misses
  const misses = allResults.filter(r => !r.correct);
  if (misses.length > 0) {
    console.log(`\n--- Misses (${misses.length}) ---`);
    for (const m of misses) {
      console.log(`  ${m.fixtureId} ${m.field}: predicted=${m.predicted} gold=${m.gold}`);
    }
  }
}

main();
