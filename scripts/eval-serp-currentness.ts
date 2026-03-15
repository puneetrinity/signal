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
import { extractCompanyFromHeadline, extractHeadlineFromTitle, extractLocationFromSerpResult } from '../src/lib/enrichment/hint-extraction';

type Currentness = 'current' | 'historical' | 'unknown';

// ---------------------------------------------------------------------------
// Temporal marker detection — narrow deterministic rules
// ---------------------------------------------------------------------------

const CURRENT_PATTERNS = [
  // Date range ending in Present (English + common translations)
  /\b\d{4}\s*[-–]\s*(?:present|atual|presente|actuellement|gegenwärtig)\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}\s*[-–]\s*(?:present|atual|presente)\b/i,
  // CJK date formats: 2020年4月 - 現在 (\b doesn't work with CJK characters)
  /\d{4}年\d{1,2}月?\s*[-–]\s*現在/,
  /\d{4}\s*[-–]\s*現在/,
  // Open-ended date range: "2022-" or "2022 -" (no end date)
  /\b(20\d{2})\s*[-–]\s*(?:\.|,|$|\s+(?:working|building|leading|focused))/i,
  // Explicit current markers
  /\b(?:currently|current(?:ly)?)\b/i,
  /\bnow\s+(?:at|based\s+in|in|leading|working|building)\b/i,
  /\b(?:joined|joining)\s+(?:in\s+)?\d{4}\b/i,
  /\b(?:i'?ve\s+been\s+(?:at|here|with))\b/i,
  /\bpresent\s+at\s+the\s+company\b/i,
  /\bpromoted\s+(?:from|to|in)\b/i,
];

const HISTORICAL_PATTERNS = [
  // Explicit historical markers
  /\b(?:formerly|former)\b/i,
  /\b(?:previously|previous)\b/i,
  /\bex[-–](?!\w*\s*(?:pert|peri|ecut|pand|plor|press|tract|tend|change))/i, // ex- prefix but not expert, experience, etc.
  /\bleft\s+(?:in\s+)?\d{4}\b/i,
  /\b(?:departed|resigned|transitioned\s+to|moved\s+to\s+\w+\s+(?:role|position))\b/i,
  // Date range with end date (not Present)
  /\b\d{4}\s*[-–]\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}\s*[-–]\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}\b/i,
  /\b(20\d{2})\s*[-–]\s*(20\d{2})\b/,
  // Relocation markers (for location) — direction-agnostic, used as general signal
  // Direction-aware logic lives in detectLocationCurrentness
  /\bpreviously\s+in\b/i,
  /\bformerly\s+in\b/i,
];

// Patterns that look like temporal markers but aren't
const FALSE_TEMPORAL_PATTERNS = [
  /\bpresent(?:er|ation|ing|ed)\b/i,  // presenter, presentation
  /\bformer'?s\b/i,                     // possessive or company name
];

function hasFalseTemporalMatch(text: string): boolean {
  return FALSE_TEMPORAL_PATTERNS.some(p => p.test(text));
}

function hasCurrentMarker(text: string): boolean {
  if (!text) return false;
  return CURRENT_PATTERNS.some((p) => p.test(text));
}

function hasHistoricalMarker(text: string): boolean {
  if (!text) return false;
  return HISTORICAL_PATTERNS.some((p) => p.test(text));
}

function normalizeText(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().trim();
}

function splitClauses(text: string): string[] {
  return text
    .split(/\s*[·|]\s*|\.\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clauseMentions(clause: string, phrases: string[]): boolean {
  const normalized = normalizeText(clause);
  return phrases.some((phrase) => {
    const trimmed = normalizeText(phrase);
    if (!trimmed || trimmed.length < 3) return false;
    return new RegExp(`\\b${escapeRegex(trimmed)}\\b`, 'i').test(normalized);
  });
}

function nextNonEmptyClause(clauses: string[], index: number): string | null {
  for (let i = index + 1; i < clauses.length; i++) {
    if (clauses[i]) return clauses[i];
  }
  return null;
}

function titleMentions(searchTitle: string): string[] {
  const headline = extractHeadlineFromTitle(searchTitle);
  const company = extractCompanyFromHeadline(headline);
  const phrases = new Set<string>();
  if (headline) phrases.add(headline);
  if (company) phrases.add(company);
  if (headline) {
    const shortened = headline.replace(/\bat\s+.+$/i, '').trim();
    if (shortened.length >= 4) phrases.add(shortened);
  }
  return [...phrases];
}

function detectTitleCurrentness(searchTitle: string, searchSnippet: string): Currentness {
  if (!searchTitle.trim() && !searchSnippet.trim()) return 'unknown';

  if ((/\bformer\b/i.test(searchTitle) || /\bex[-–]/i.test(searchTitle)) && !hasFalseTemporalMatch(searchTitle)) {
    return 'historical';
  }

  const mentions = titleMentions(searchTitle);
  const clauses = splitClauses(searchSnippet);
  const mentionClauseIndexes: number[] = [];

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    if (!clauseMentions(clause, mentions)) continue;
    mentionClauseIndexes.push(i);

    const nextClause = nextNonEmptyClause(clauses, i) ?? '';
    const local = `${clause} ${nextClause}`.trim();

    // Skip clause if false-positive pattern detected (e.g. "Former's Brewing")
    if (hasFalseTemporalMatch(local)) continue;

    if (hasHistoricalMarker(local) && !hasCurrentMarker(local)) return 'historical';
    if (hasCurrentMarker(local) && !hasHistoricalMarker(local)) return 'current';
    if (hasCurrentMarker(local) && hasHistoricalMarker(local)) return 'historical';
  }

  const normalizedSnippet = normalizeText(searchSnippet);

  if (
    mentionClauseIndexes.includes(0) &&
    /\b(?:previously|former|formerly|ex[-–])\b/i.test(searchSnippet) &&
    !hasFalseTemporalMatch(searchSnippet) &&
    !/\b(?:currently|present|now at|now leading|now working)\b/i.test(searchSnippet)
  ) {
    return 'current';
  }

  // If the snippet clearly says the person is now elsewhere and the title mention
  // is not reaffirmed with a current marker, treat the SERP title as stale.
  if (/\b(?:currently|now)\b/.test(normalizedSnippet) && /\b(?:consulting|advisor|advising|independent|freelance|founder|cto|ceo|vp|lead)\b/.test(normalizedSnippet)) {
    return 'historical';
  }

  if (hasCurrentMarker(searchSnippet) && !hasHistoricalMarker(searchSnippet)) return 'current';
  if (hasHistoricalMarker(searchSnippet) && !hasCurrentMarker(searchSnippet) && !hasFalseTemporalMatch(searchSnippet)) return 'historical';
  return 'unknown';
}

function detectLocationCurrentness(searchTitle: string, searchSnippet: string, overrideLocation?: string): Currentness {
  const extractedLocation = overrideLocation ?? extractLocationFromSerpResult(searchTitle, searchSnippet);
  if (!extractedLocation) return 'unknown';

  const clauses = splitClauses(searchSnippet);
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    if (!clauseMentions(clause, [extractedLocation])) continue;

    const nextClause = nextNonEmptyClause(clauses, i) ?? '';
    const local = clause.trim();

    if (/\b(?:previously|formerly)\s+in\b/i.test(local)) return 'historical';
    if (hasHistoricalMarker(local) && !hasCurrentMarker(local)) return 'historical';
    if (hasCurrentMarker(local) && !hasHistoricalMarker(local)) return 'current';

    // Date-only next clause often belongs to the immediately preceding location.
    if (nextClause) {
      const nextHasCurrentDate = /\b(?:present|atual|presente)\b/i.test(nextClause) || /現在/.test(nextClause) || /\b(20\d{2})\s*[-–]\s*(?:\.|,|$)/.test(nextClause);
      const nextHasHistoricalDate = /\b(20\d{2})\s*[-–]\s*(20\d{2})\b/.test(nextClause);
      if (nextHasCurrentDate && !nextHasHistoricalDate) return 'current';
      if (nextHasHistoricalDate && !nextHasCurrentDate) return 'historical';
    }
  }

  const normalizedSnippet = normalizeText(searchSnippet);
  const normalizedLocation = normalizeText(extractedLocation);

  // Direction-aware relocation: "to X" means X is current, "from X" means X is historical
  const toPattern = /\b(?:now\s+(?:based\s+)?in|moved\s+to|relocated\s+to)\s+([a-z][a-z\s,.-]+)/i;
  const toMatch = searchSnippet.match(toPattern);
  if (toMatch) {
    const destination = normalizeText(toMatch[1]);
    if (destination) {
      if (destination.includes(normalizedLocation)) return 'current';
      return 'historical';
    }
  }

  const fromPattern = /\b(?:moved\s+from|relocated\s+from)\s+([a-z][a-z\s,.-]+)/i;
  const fromMatch = searchSnippet.match(fromPattern);
  if (fromMatch) {
    const origin = normalizeText(fromMatch[1]);
    if (origin) {
      if (origin.includes(normalizedLocation)) return 'historical';
      if (normalizedSnippet.includes(normalizedLocation)) return 'current';
    }
  }

  if (normalizedSnippet.includes(normalizedLocation) && hasCurrentMarker(searchSnippet) && !hasHistoricalMarker(searchSnippet)) {
    return 'current';
  }

  return 'unknown';
}

function detectCurrentness(searchTitle: string, searchSnippet: string, overrideLocation?: string): {
  title: Currentness;
  location: Currentness;
} {
  const textBag = [searchTitle, searchSnippet].filter(Boolean).join(' ');
  if (!textBag.trim()) {
    return { title: 'unknown', location: 'unknown' };
  }
  return {
    title: detectTitleCurrentness(searchTitle, searchSnippet),
    location: detectLocationCurrentness(searchTitle, searchSnippet, overrideLocation),
  };
}

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
