/**
 * Backfill locationHint for cleaned candidates using fresh Serper results (hl=en).
 *
 * Phases:
 *   1. Sample: npx tsx scripts/backfill-location-serper.ts --sample 50
 *   2. Full:   npx tsx scripts/backfill-location-serper.ts
 *
 * Required env: SERPER_API_KEY, DATABASE_URL
 * Optional env: SERPER_HL (default "en")
 *
 * Reads candidate IDs from /tmp/location_cleanup_ids.txt (one per line).
 * Only updates rows where locationHint IS NULL (safe: won't overwrite good data).
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { extractLocationFromSerpResult } from '@/lib/enrichment/hint-extraction';
import { locationHintQualityScore, normalizeHint } from '@/lib/sourcing/hint-sanitizer';
import { prisma } from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SERPER_HL = process.env.SERPER_HL || 'en';
const SERPER_URL = 'https://google.serper.dev/search';
const IDS_FILE = '/tmp/location_cleanup_ids.txt';
const LOG_FILE = '/tmp/location_backfill_log.csv';
const THROTTLE_MS = 500; // 2 req/sec

if (!SERPER_API_KEY) {
  console.error('SERPER_API_KEY is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const sampleIdx = args.indexOf('--sample');
const sampleSize = sampleIdx >= 0 ? parseInt(args[sampleIdx + 1] || '50', 10) : null;

// ---------------------------------------------------------------------------
// Serper fetch
// ---------------------------------------------------------------------------

interface SerperOrganic {
  title?: string;
  snippet?: string;
  link?: string;
}

async function searchSerper(query: string): Promise<SerperOrganic | null> {
  const res = await fetch(SERPER_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': SERPER_API_KEY!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: 1, hl: SERPER_HL }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Serper ${res.status}: ${text}`);
  }

  const data = await res.json() as { organic?: SerperOrganic[] };
  return data.organic?.[0] ?? null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// CSV log
// ---------------------------------------------------------------------------

function initLog() {
  writeFileSync(LOG_FILE, 'candidateId,linkedinId,oldLocationHint,newLocationHint,rawTitle,rawSnippet,parseScore,action\n');
}

function escapeCSV(val: string | null): string {
  if (!val) return '';
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function logRow(row: {
  candidateId: string;
  linkedinId: string;
  oldLocation: string | null;
  newLocation: string | null;
  rawTitle: string;
  rawSnippet: string;
  parseScore: number;
  action: string;
}) {
  appendFileSync(LOG_FILE, [
    row.candidateId,
    row.linkedinId,
    escapeCSV(row.oldLocation),
    escapeCSV(row.newLocation),
    escapeCSV(row.rawTitle),
    escapeCSV(row.rawSnippet),
    row.parseScore,
    row.action,
  ].join(',') + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(IDS_FILE)) {
    console.error(`IDs file not found: ${IDS_FILE}`);
    process.exit(1);
  }

  const allIds = readFileSync(IDS_FILE, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  const ids = sampleSize ? allIds.slice(0, sampleSize) : allIds;

  console.log(`Processing ${ids.length} candidates${sampleSize ? ` (sample of ${sampleSize})` : ''}`);
  console.log(`Log: ${LOG_FILE}`);

  initLog();

  let processed = 0;
  let recovered = 0;
  let stillNull = 0;
  let skipped = 0;
  let lowScoreSkip = 0;
  let errors = 0;
  const recoveredByCity = new Map<string, number>();

  for (const id of ids) {
    processed++;

    try {
      // Load candidate
      const candidate = await prisma.candidate.findUnique({
        where: { id },
        select: { id: true, linkedinId: true, locationHint: true },
      });

      if (!candidate) {
        logRow({ candidateId: id, linkedinId: '', oldLocation: null, newLocation: null, rawTitle: '', rawSnippet: '', parseScore: 0, action: 'NOT_FOUND' });
        skipped++;
        continue;
      }

      // Safety: only fill NULL rows
      if (candidate.locationHint) {
        logRow({ candidateId: id, linkedinId: candidate.linkedinId, oldLocation: candidate.locationHint, newLocation: null, rawTitle: '', rawSnippet: '', parseScore: 0, action: 'ALREADY_SET' });
        skipped++;
        continue;
      }

      // Search Serper
      const query = `site:linkedin.com/in/${candidate.linkedinId}`;
      const result = await searchSerper(query);

      if (!result || !result.title) {
        logRow({ candidateId: id, linkedinId: candidate.linkedinId, oldLocation: null, newLocation: null, rawTitle: '', rawSnippet: '', parseScore: 0, action: 'NO_SERP_RESULT' });
        stillNull++;
        if (processed % 10 === 0) console.log(`  ${processed}/${ids.length} — recovered: ${recovered}, still null: ${stillNull}`);
        await sleep(THROTTLE_MS);
        continue;
      }

      // Extract location
      const rawTitle = result.title || '';
      const rawSnippet = result.snippet || '';
      const extracted = extractLocationFromSerpResult(rawTitle, rawSnippet);
      const normalized = normalizeHint(extracted ?? undefined) ?? null;
      const score = locationHintQualityScore(normalized);

      if (score >= 2 && normalized) {
        // Score >= 2: city, region, or city+state. Score 1 is too loose (country-only, false positives).
        await prisma.candidate.update({
          where: { id },
          data: { locationHint: normalized, updatedAt: new Date() },
        });
        logRow({ candidateId: id, linkedinId: candidate.linkedinId, oldLocation: null, newLocation: normalized, rawTitle, rawSnippet, parseScore: score, action: 'RECOVERED' });
        recovered++;
        recoveredByCity.set(normalized, (recoveredByCity.get(normalized) || 0) + 1);
      } else if (score === 1 && normalized) {
        logRow({ candidateId: id, linkedinId: candidate.linkedinId, oldLocation: null, newLocation: normalized, rawTitle, rawSnippet, parseScore: score, action: 'LOW_SCORE_SKIP' });
        lowScoreSkip++;
        stillNull++;
      } else {
        logRow({ candidateId: id, linkedinId: candidate.linkedinId, oldLocation: null, newLocation: null, rawTitle, rawSnippet, parseScore: score, action: 'NO_LOCATION' });
        stillNull++;
      }

      if (processed % 10 === 0) {
        console.log(`  ${processed}/${ids.length} — recovered: ${recovered}, still null: ${stillNull}`);
      }

      await sleep(THROTTLE_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logRow({ candidateId: id, linkedinId: '', oldLocation: null, newLocation: null, rawTitle: '', rawSnippet: '', parseScore: 0, action: `ERROR: ${msg}` });
      errors++;
      console.error(`  Error on ${id}: ${msg}`);
      // Back off on errors
      await sleep(2000);
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Processed: ${processed}`);
  console.log(`Recovered (score>=2): ${recovered} (${((recovered / processed) * 100).toFixed(1)}%)`);
  console.log(`Low-score skipped (score=1): ${lowScoreSkip}`);
  console.log(`Still null: ${stillNull}`);
  console.log(`Skipped (not found/already set): ${skipped}`);
  console.log(`Errors: ${errors}`);
  if (recoveredByCity.size > 0) {
    console.log('\n--- Recovered by location ---');
    [...recoveredByCity.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([city, count]) => console.log(`  ${city}: ${count}`));
  }
  console.log(`\nFull log: ${LOG_FILE}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
