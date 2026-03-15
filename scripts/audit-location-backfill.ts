#!/usr/bin/env npx tsx
/**
 * Location Backfill Audit
 *
 * Queries prod DB directly, reruns current extraction + resolution on stored
 * searchTitle/searchSnippet, and reports backfill opportunities.
 *
 * Categories:
 *   NEW        — no stored hint, parser now extracts one
 *   FIXED      — stored hint is garbage (score 0), parser produces better or null
 *   IMPROVED   — stored hint ok, parser produces higher-scoring result
 *   REGRESSED  — stored hint ok, parser produces lower-scoring result
 *   UNCHANGED  — same output
 *
 * Usage:
 *   npx tsx scripts/audit-location-backfill.ts
 *   npx tsx scripts/audit-location-backfill.ts --limit 500
 *   npx tsx scripts/audit-location-backfill.ts --limit 500 --verbose
 *   npx tsx scripts/audit-location-backfill.ts --missing-only --limit 200
 *   npx tsx scripts/audit-location-backfill.ts --ids /tmp/backfill-ids.txt
 */

import { extractLocationFromSerpResult } from '../src/lib/enrichment/hint-extraction';
import { locationHintQualityScore, normalizeHint } from '../src/lib/sourcing/hint-sanitizer';
import { resolveLocationDeterministic } from '../src/lib/taxonomy/location-service';
import { writeFileSync } from 'fs';

// ---------- Types ----------

interface CandidateRow {
  id: string;
  linkedinId: string;
  locationHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
}

type Verdict = 'NEW' | 'FIXED_TO_VALID' | 'FIXED_TO_NULL' | 'IMPROVED' | 'REGRESSED' | 'UNCHANGED';

interface AuditRow {
  id: string;
  linkedinId: string;
  stored: string | null;
  storedScore: number;
  extracted: string | null;
  extractedScore: number;
  resolvedCity: string | null;
  resolvedCountry: string | null;
  verdict: Verdict;
}

// ---------- DB query ----------

async function queryCandidates(
  opts: { limit: number; missingOnly: boolean; seed: number | null },
): Promise<CandidateRow[]> {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const whereClause = opts.missingOnly
      ? `AND ("locationHint" IS NULL OR "locationHint" = '')`
      : '';

    // --seed gives reproducible ordering via md5(id || seed)
    const orderClause = opts.seed !== null
      ? `ORDER BY md5("id" || '${opts.seed}')`
      : 'ORDER BY RANDOM()';

    const rows = await prisma.$queryRawUnsafe<CandidateRow[]>(`
      SELECT
        "id",
        "linkedinId",
        "locationHint",
        "searchTitle",
        "searchSnippet"
      FROM "candidates"
      WHERE "searchSnippet" IS NOT NULL
        AND "searchSnippet" != ''
        ${whereClause}
      ${orderClause}
      LIMIT ${opts.limit}
    `);
    return rows;
  } finally {
    await prisma.$disconnect();
  }
}

// ---------- Audit logic ----------

function auditRow(row: CandidateRow): AuditRow {
  const stored = row.locationHint || null;
  const storedScore = locationHintQualityScore(stored);

  const raw = extractLocationFromSerpResult(
    row.searchTitle || '',
    row.searchSnippet || '',
  );
  const normalized = normalizeHint(raw ?? undefined) ?? null;
  const extractedScore = locationHintQualityScore(normalized);
  const extracted = extractedScore > 0 ? normalized : null;

  const resolution = resolveLocationDeterministic(extracted);

  let verdict: Verdict;
  if (stored === extracted) {
    verdict = 'UNCHANGED';
  } else if (!stored && extracted) {
    verdict = 'NEW';
  } else if (storedScore === 0 && stored) {
    verdict = extracted ? 'FIXED_TO_VALID' : 'FIXED_TO_NULL';
  } else if (extractedScore > storedScore) {
    verdict = 'IMPROVED';
  } else if (extractedScore < storedScore) {
    verdict = 'REGRESSED';
  } else {
    verdict = 'UNCHANGED';
  }

  return {
    id: row.id,
    linkedinId: row.linkedinId,
    stored,
    storedScore,
    extracted,
    extractedScore,
    resolvedCity: resolution.city,
    resolvedCountry: resolution.countryCode,
    verdict,
  };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 200;
  let verbose = false;
  let missingOnly = false;
  let idsOutput: string | null = null;
  let seed: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === '--verbose' || args[i] === '-v') verbose = true;
    else if (args[i] === '--missing-only') missingOnly = true;
    else if (args[i] === '--ids' && args[i + 1]) idsOutput = args[++i];
    else if (args[i] === '--seed' && args[i + 1]) seed = parseInt(args[++i], 10);
  }

  return { limit, verbose, missingOnly, idsOutput, seed };
}

// ---------- Main ----------

async function main() {
  const { limit, verbose, missingOnly, idsOutput, seed } = parseArgs();

  const seedLabel = seed !== null ? ` (seed ${seed})` : '';
  console.log(`Querying up to ${limit} candidates${missingOnly ? ' (missing locationHint only)' : ''}${seedLabel}...`);
  const rows = await queryCandidates({ limit, missingOnly, seed });
  console.log(`Got ${rows.length} rows\n`);

  if (rows.length === 0) return;

  const results = rows.map(auditRow);

  // Tally
  const counts: Record<Verdict, number> = {
    NEW: 0, FIXED_TO_VALID: 0, FIXED_TO_NULL: 0, IMPROVED: 0, REGRESSED: 0, UNCHANGED: 0,
  };
  for (const r of results) counts[r.verdict]++;

  // Summary
  const actionable = counts.NEW + counts.FIXED_TO_VALID + counts.FIXED_TO_NULL + counts.IMPROVED;
  console.log('=== Backfill Audit ===\n');
  console.log(`Total sampled:  ${results.length}`);
  console.log(`Actionable:     ${actionable} (${(actionable / results.length * 100).toFixed(1)}%)`);
  console.log(`  NEW:            ${counts.NEW} — no stored hint, parser now extracts one`);
  console.log(`  FIXED_TO_VALID: ${counts.FIXED_TO_VALID} — garbage replaced with valid hint`);
  console.log(`  FIXED_TO_NULL:  ${counts.FIXED_TO_NULL} — garbage correctly nulled`);
  console.log(`  IMPROVED:       ${counts.IMPROVED} — parser produces higher-scoring result`);
  console.log(`Regressions:    ${counts.REGRESSED}`);
  console.log(`Unchanged:      ${counts.UNCHANGED}`);

  // Top failure patterns: what does the parser still miss?
  const stillMissing = results.filter(r => !r.extracted && !r.stored);
  const stillMissingWithSnippet = rows.filter(
    (row, i) => !results[i].extracted && !results[i].stored,
  );
  if (stillMissing.length > 0) {
    console.log(`\nStill no location: ${stillMissing.length} rows`);
    if (verbose && stillMissingWithSnippet.length > 0) {
      console.log('--- Sample snippets (still missing) ---');
      for (const row of stillMissingWithSnippet.slice(0, 10)) {
        const snip = (row.searchSnippet || '').slice(0, 120);
        console.log(`  ${row.linkedinId}: "${snip}"`);
      }
    }
  }

  // Verbose: show all non-UNCHANGED
  if (verbose) {
    const interesting = results.filter(r => r.verdict !== 'UNCHANGED');
    if (interesting.length > 0) {
      console.log(`\n--- Changes (${interesting.length}) ---`);
      for (const r of interesting) {
        console.log(
          `  [${r.verdict.padEnd(8)}] ${r.linkedinId}` +
          ` | stored="${r.stored ?? 'null'}"` +
          ` → extracted="${r.extracted ?? 'null'}"` +
          ` → city=${r.resolvedCity ?? 'null'}, country=${r.resolvedCountry ?? 'null'}`,
        );
      }
    }

    // Show regressions explicitly
    const regressions = results.filter(r => r.verdict === 'REGRESSED');
    if (regressions.length > 0) {
      console.log(`\n--- Regressions (${regressions.length}) ---`);
      for (const r of regressions) {
        console.log(
          `  ${r.linkedinId}` +
          ` | stored="${r.stored}" (score ${r.storedScore})` +
          ` → "${r.extracted ?? 'null'}" (score ${r.extractedScore})`,
        );
      }
    }
  }

  // Emit IDs for backfill
  if (idsOutput) {
    const backfillIds = results
      .filter(r => r.verdict === 'NEW' || r.verdict === 'FIXED_TO_VALID' || r.verdict === 'FIXED_TO_NULL' || r.verdict === 'IMPROVED')
      .map(r => r.id);
    writeFileSync(idsOutput, backfillIds.join('\n') + '\n');
    console.log(`\nBackfill IDs (${backfillIds.length}) written to: ${idsOutput}`);
  }
}

main().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
