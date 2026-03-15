#!/usr/bin/env npx tsx
/**
 * Seniority Hint Backfill
 *
 * Updates seniorityHint for candidates where normalizeSeniorityFromText()
 * extracts a value from headlineHint but seniorityHint is currently null.
 *
 * Modes:
 *   --dry-run   (default) Show what would change, don't write
 *   --apply     Actually update rows
 *   --ids       Newline-delimited candidate IDs to backfill (required for --apply)
 *
 * Usage:
 *   npx tsx scripts/backfill-seniority-hints.ts --ids /tmp/seniority-backfill-ids.txt
 *   npx tsx scripts/backfill-seniority-hints.ts --ids /tmp/seniority-backfill-ids.txt --apply
 */

import { normalizeSeniorityFromText } from '../src/lib/taxonomy/seniority';
import { readFileSync } from 'fs';

interface CandidateRow {
  id: string;
  linkedinId: string;
  headlineHint: string | null;
  seniorityHint: string | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let apply = false;
  let idsPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--ids' && args[i + 1]) idsPath = args[++i];
  }

  if (!idsPath) {
    console.error('--ids /path/to/seniority-backfill-ids.txt is required');
    process.exit(1);
  }

  if (apply && !idsPath) {
    console.error('--apply requires --ids');
    process.exit(1);
  }

  return { apply, idsPath };
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function main() {
  const { apply, idsPath } = parseArgs();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const ids = readFileSync(idsPath!, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      console.error(`No IDs found in ${idsPath}`);
      process.exit(1);
    }

    const quotedIds = ids.map((id) => `'${escapeSqlLiteral(id)}'`).join(', ');
    const rows = await prisma.$queryRawUnsafe<CandidateRow[]>(`
      SELECT "id", "linkedinId", "headlineHint", "seniorityHint"
      FROM "candidates"
      WHERE "id" IN (${quotedIds})
        AND "headlineHint" IS NOT NULL
        AND "headlineHint" != ''
      ORDER BY "id"
    `);

    console.log(`Fetched ${rows.length} candidates from ${ids.length} IDs`);
    console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

    const updates: Array<{ id: string; seniority: string }> = [];
    let skipped = 0;
    const bandCounts: Record<string, number> = {};

    for (const row of rows) {
      // Skip if already populated
      if (row.seniorityHint) {
        skipped++;
        continue;
      }

      const extracted = normalizeSeniorityFromText(row.headlineHint);
      if (!extracted) {
        skipped++;
        continue;
      }

      updates.push({ id: row.id, seniority: extracted });
      bandCounts[extracted] = (bandCounts[extracted] ?? 0) + 1;
    }

    console.log(`Updates queued: ${updates.length}`);
    console.log(`Skipped: ${skipped}`);

    // Band distribution
    console.log('\n--- Band Distribution ---');
    const sortedBands = Object.entries(bandCounts).sort((a, b) => b[1] - a[1]);
    for (const [band, count] of sortedBands) {
      console.log(`  ${band.padEnd(12)} ${count}`);
    }

    if (apply && updates.length > 0) {
      const batchSize = 500;
      for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);
        const values = batch
          .map((u) => `('${escapeSqlLiteral(u.id)}', '${escapeSqlLiteral(u.seniority)}')`)
          .join(', ');
        await prisma.$executeRawUnsafe(`
          UPDATE "candidates" AS c
          SET "seniorityHint" = v.seniority, "updatedAt" = NOW()
          FROM (VALUES ${values}) AS v(id, seniority)
          WHERE c."id" = v.id
        `);
        console.log(`  Batch ${Math.floor(i / batchSize) + 1}: updated ${batch.length} rows`);
      }
      console.log(`\nApplied: ${updates.length} rows updated`);
    } else if (!apply) {
      console.log(`\nDry-run complete. Use --apply to write changes.`);
    } else {
      console.log('\nNo updates to apply.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
