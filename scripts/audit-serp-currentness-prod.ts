#!/usr/bin/env npx tsx
/**
 * Prod Sanity Check — SERP Currentness Detection
 *
 * Samples candidates with timeline-heavy snippets (containing date ranges,
 * temporal markers) and runs currentness detection. Reports distributions
 * and shows samples for manual review.
 *
 * This is a probe-biased sanity sample, NOT a rate estimate.
 *
 * Key check: are there false "current" predictions on historically stale data?
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/audit-serp-currentness-prod.ts
 *   DATABASE_URL="postgresql://..." npx tsx scripts/audit-serp-currentness-prod.ts --limit 500
 *   DATABASE_URL="postgresql://..." npx tsx scripts/audit-serp-currentness-prod.ts --samples 30
 */

import {
  type Currentness,
  detectTitleCurrentness,
  detectLocationCurrentness,
} from '../src/lib/search/currentness';
import { extractLocationFromSerpResult } from '../src/lib/enrichment/hint-extraction';

// Patterns that indicate a snippet has timeline content worth auditing
const TIMELINE_PROBE = /\b(?:20\d{2}\s*[-–]|present\b|formerly|former\b|previously|ex[-–]|left\s+in|joined\s+in|currently|moved\s+to|relocated)/i;

interface CandidateRow {
  id: string;
  searchTitle: string | null;
  searchSnippet: string | null;
  headlineHint: string | null;
  locationHint: string | null;
}

interface AuditResult {
  candidateId: string;
  searchTitle: string;
  searchSnippet: string;
  headlineHint: string | null;
  locationHint: string | null;
  titleCurrentness: Currentness;
  locationCurrentness: Currentness;
  extractedLocation: string | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 500;
  let samples = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    if (args[i] === '--samples' && args[i + 1]) samples = parseInt(args[++i], 10);
  }
  return { limit, samples };
}

async function main() {
  const { limit, samples } = parseArgs();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    // Sample candidates with non-null searchSnippet. Recency-biased.
    const candidates = await prisma.candidate.findMany({
      where: {
        searchSnippet: { not: null },
        searchTitle: { not: null },
      },
      select: {
        id: true,
        searchTitle: true,
        searchSnippet: true,
        headlineHint: true,
        locationHint: true,
      },
      take: limit * 3, // over-fetch, then filter for timeline content
      orderBy: { updatedAt: 'desc' },
    }) as CandidateRow[];

    // Filter to timeline-heavy snippets
    const timelineCandidates = candidates.filter(c =>
      c.searchSnippet && TIMELINE_PROBE.test(c.searchSnippet)
    ).slice(0, limit);

    console.log(`Fetched ${candidates.length} candidates, ${timelineCandidates.length} have timeline markers (probe-biased sanity sample)\n`);

    if (timelineCandidates.length === 0) {
      console.log('No timeline-heavy snippets found.');
      return;
    }

    const results: AuditResult[] = [];
    const titleDist: Record<Currentness, number> = { current: 0, historical: 0, unknown: 0 };
    const locDist: Record<Currentness, number> = { current: 0, historical: 0, unknown: 0 };

    for (const c of timelineCandidates) {
      const searchTitle = c.searchTitle ?? '';
      const searchSnippet = c.searchSnippet ?? '';

      const titleCurrentness = detectTitleCurrentness(searchTitle, searchSnippet);
      const locationCurrentness = detectLocationCurrentness(searchTitle, searchSnippet);
      const extractedLocation = extractLocationFromSerpResult(searchTitle, searchSnippet);

      titleDist[titleCurrentness]++;
      locDist[locationCurrentness]++;

      results.push({
        candidateId: c.id,
        searchTitle,
        searchSnippet,
        headlineHint: c.headlineHint,
        locationHint: c.locationHint,
        titleCurrentness,
        locationCurrentness,
        extractedLocation,
      });
    }

    // Distribution
    const n = timelineCandidates.length;
    console.log('--- Title Currentness Distribution (probe-biased, not a rate estimate) ---');
    console.log(`  current:    ${titleDist.current} (${(titleDist.current / n * 100).toFixed(1)}%)`);
    console.log(`  historical: ${titleDist.historical} (${(titleDist.historical / n * 100).toFixed(1)}%)`);
    console.log(`  unknown:    ${titleDist.unknown} (${(titleDist.unknown / n * 100).toFixed(1)}%)`);

    console.log('\n--- Location Currentness Distribution (probe-biased, not a rate estimate) ---');
    console.log(`  current:    ${locDist.current} (${(locDist.current / n * 100).toFixed(1)}%)`);
    console.log(`  historical: ${locDist.historical} (${(locDist.historical / n * 100).toFixed(1)}%)`);
    console.log(`  unknown:    ${locDist.unknown} (${(locDist.unknown / n * 100).toFixed(1)}%)`);

    // Samples of each classification for manual review
    const titleCurrent = results.filter(r => r.titleCurrentness === 'current');
    const titleHistorical = results.filter(r => r.titleCurrentness === 'historical');
    const locCurrent = results.filter(r => r.locationCurrentness === 'current');
    const locHistorical = results.filter(r => r.locationCurrentness === 'historical');

    function printSamples(label: string, items: AuditResult[], count: number, showLocation: boolean) {
      const sampled = items.slice(0, count);
      if (sampled.length === 0) return;
      console.log(`\n--- ${label} (${sampled.length} of ${items.length}) ---`);
      for (const r of sampled) {
        const title = r.searchTitle.slice(0, 80);
        const snippet = r.searchSnippet.slice(0, 150).replace(/\n/g, ' ');
        console.log(`  [${r.candidateId.slice(0, 8)}] ${title}`);
        console.log(`    snippet: ${snippet}`);
        if (showLocation && r.extractedLocation) {
          console.log(`    extracted_loc: ${r.extractedLocation}  locationHint: ${r.locationHint ?? '(null)'}`);
        }
        console.log();
      }
    }

    // Title: "current" predictions — verify these aren't stale (most important check)
    printSamples('Title → CURRENT (verify not stale)', titleCurrent, samples, false);

    // Title: "historical" predictions — verify these are genuinely stale
    printSamples('Title → HISTORICAL (verify genuinely stale)', titleHistorical, samples, false);

    // Location: "current" predictions — verify not stale
    printSamples('Location → CURRENT (verify not stale)', locCurrent, samples, true);

    // Location: "historical" predictions — verify genuinely stale
    printSamples('Location → HISTORICAL (verify genuinely stale)', locHistorical, samples, true);

    // Cross-check: cases where title is historical but location is current (or vice versa)
    const mixed = results.filter(r =>
      (r.titleCurrentness === 'historical' && r.locationCurrentness === 'current') ||
      (r.titleCurrentness === 'current' && r.locationCurrentness === 'historical')
    );
    if (mixed.length > 0) {
      console.log(`\n--- Mixed Signals (title/location disagree, ${mixed.length} total) ---`);
      for (const r of mixed.slice(0, 10)) {
        console.log(`  [${r.candidateId.slice(0, 8)}] title=${r.titleCurrentness} loc=${r.locationCurrentness}`);
        console.log(`    ${r.searchTitle.slice(0, 80)}`);
        console.log(`    ${r.searchSnippet.slice(0, 150).replace(/\n/g, ' ')}`);
        console.log();
      }
    }

  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
