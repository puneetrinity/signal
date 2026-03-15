#!/usr/bin/env npx tsx
/**
 * Seniority Hint Backfill Audit
 *
 * Queries prod DB, runs normalizeSeniorityFromText() on stored headlineHint,
 * and compares against stored seniorityHint.
 *
 * Categories:
 *   NEW        — no stored seniorityHint, parser extracts one
 *   UNCHANGED  — stored matches extracted
 *   CHANGED    — stored differs from extracted (overwrite candidate)
 *   REGRESSED  — stored has value, parser returns null
 *   NULL_BOTH  — both null (no headline or no keyword match)
 *
 * Usage:
 *   npx tsx scripts/audit-seniority-backfill.ts
 *   npx tsx scripts/audit-seniority-backfill.ts --limit 500 --seed 42
 *   npx tsx scripts/audit-seniority-backfill.ts --missing-only
 */

import { normalizeSeniorityFromText } from '../src/lib/taxonomy/seniority';

interface CandidateRow {
  id: string;
  linkedinId: string;
  headlineHint: string | null;
  seniorityHint: string | null;
}

type Verdict = 'NEW' | 'UNCHANGED' | 'CHANGED' | 'REGRESSED' | 'NULL_BOTH';

function norm(value: string | null | undefined): string | null {
  const normalized = value?.toLowerCase().trim().replace(/\s+/g, ' ') ?? '';
  return normalized.length > 0 ? normalized : null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 0; // 0 = all
  let seed: number | null = null;
  let missingOnly = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === '--seed' && args[i + 1]) seed = parseInt(args[++i], 10);
    else if (args[i] === '--missing-only') missingOnly = true;
    else if (args[i] === '--verbose') verbose = true;
  }

  return { limit, seed, missingOnly, verbose };
}

function classify(stored: string | null, extracted: string | null): Verdict {
  const s = norm(stored);
  const e = norm(extracted);

  if (!s && !e) return 'NULL_BOTH';
  if (!s && e) return 'NEW';
  if (s && !e) return 'REGRESSED';
  if (s === e) return 'UNCHANGED';
  return 'CHANGED';
}

async function main() {
  const { limit, seed, missingOnly, verbose } = parseArgs();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const whereClause = missingOnly
      ? `AND ("seniorityHint" IS NULL OR "seniorityHint" = '')`
      : '';

    const orderClause = seed !== null
      ? `ORDER BY md5("id" || '${seed}')`
      : 'ORDER BY "id"';

    const limitClause = limit > 0 ? `LIMIT ${limit}` : '';

    const rows = await prisma.$queryRawUnsafe<CandidateRow[]>(`
      SELECT "id", "linkedinId", "headlineHint", "seniorityHint"
      FROM "candidates"
      WHERE "headlineHint" IS NOT NULL
        AND "headlineHint" != ''
        ${whereClause}
      ${orderClause}
      ${limitClause}
    `);

    console.log(`Fetched ${rows.length} candidates${missingOnly ? ' (missing seniorityHint only)' : ''}`);
    if (seed !== null) console.log(`Seed: ${seed}`);
    console.log();

    const counts: Record<Verdict, number> = { NEW: 0, UNCHANGED: 0, CHANGED: 0, REGRESSED: 0, NULL_BOTH: 0 };
    const bandCounts: Record<string, number> = {};
    const newIds: string[] = [];
    const changedSamples: Array<{ linkedinId: string; headline: string; stored: string; extracted: string }> = [];

    for (const row of rows) {
      const extracted = normalizeSeniorityFromText(row.headlineHint);
      const verdict = classify(row.seniorityHint, extracted);
      counts[verdict]++;

      if (extracted) {
        bandCounts[extracted] = (bandCounts[extracted] ?? 0) + 1;
      }

      if (verdict === 'NEW') {
        newIds.push(row.id);
        if (verbose && newIds.length <= 20) {
          console.log(`  NEW  ${row.linkedinId}: "${row.headlineHint}" → ${extracted}`);
        }
      }

      if (verdict === 'CHANGED' && changedSamples.length < 20) {
        changedSamples.push({
          linkedinId: row.linkedinId,
          headline: row.headlineHint!,
          stored: row.seniorityHint!,
          extracted: extracted!,
        });
      }

      if (verdict === 'REGRESSED' && verbose) {
        console.log(`  REGRESSED  ${row.linkedinId}: stored="${row.seniorityHint}" headline="${row.headlineHint}"`);
      }
    }

    // Summary
    console.log('\n--- Verdict Summary ---');
    console.log(`  NEW (safe backfill): ${counts.NEW}`);
    console.log(`  UNCHANGED:           ${counts.UNCHANGED}`);
    console.log(`  CHANGED (review):    ${counts.CHANGED}`);
    console.log(`  REGRESSED:           ${counts.REGRESSED}`);
    console.log(`  NULL_BOTH:           ${counts.NULL_BOTH}`);
    console.log(`  Total:               ${rows.length}`);

    const backfillable = counts.NEW;
    const backfillPct = rows.length > 0 ? ((backfillable / rows.length) * 100).toFixed(1) : '0';
    console.log(`\n  Safe backfill set:  ${backfillable}/${rows.length} (${backfillPct}%)`);
    console.log(`  Manual review set:  ${counts.CHANGED} (CHANGED stored≠extracted, not auto-backfilled)`);

    // Band distribution
    console.log('\n--- Extracted Band Distribution ---');
    const sortedBands = Object.entries(bandCounts).sort((a, b) => b[1] - a[1]);
    for (const [band, count] of sortedBands) {
      console.log(`  ${band.padEnd(12)} ${count}`);
    }

    // Changed samples
    if (changedSamples.length > 0) {
      console.log('\n--- Changed Samples (stored → extracted) ---');
      for (const s of changedSamples) {
        console.log(`  ${s.linkedinId}: "${s.headline}" stored=${s.stored} → extracted=${s.extracted}`);
      }
    }

    // Write backfillable IDs
    if (newIds.length > 0) {
      const outPath = '/tmp/seniority-backfill-ids.txt';
      const { writeFileSync } = await import('fs');
      writeFileSync(outPath, newIds.join('\n') + '\n');
      console.log(`\nWrote ${newIds.length} backfillable IDs to ${outPath}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
