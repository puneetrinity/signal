#!/usr/bin/env npx tsx
/**
 * Headline-Only Backfill
 *
 * Updates headlineHint for candidates where the new extraction
 * produces a different (better) result. Does NOT touch companyHint.
 *
 * Modes:
 *   --dry-run   (default) Show what would change, don't write
 *   --apply     Actually update rows
 *   --ids       Newline-delimited candidate IDs to backfill (required for --apply)
 *
 * Usage:
 *   npx tsx scripts/backfill-headline-hints.ts --limit 500 --seed 42
 *   npx tsx scripts/backfill-headline-hints.ts --ids /tmp/headline-backfill-ids.txt
 *   npx tsx scripts/backfill-headline-hints.ts --ids /tmp/headline-backfill-ids.txt --apply
 */

import { extractHeadlineFromTitle } from '../src/lib/enrichment/hint-extraction';
import { readFileSync } from 'fs';

interface CandidateRow {
  id: string;
  linkedinId: string;
  headlineHint: string | null;
  searchTitle: string | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 200;
  let seed: number | null = 42;
  let apply = false;
  let idsPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === '--seed' && args[i + 1]) seed = parseInt(args[++i], 10);
    else if (args[i] === '--apply') apply = true;
    else if (args[i] === '--ids' && args[i + 1]) idsPath = args[++i];
  }

  if (apply && !idsPath) {
    console.error('--apply requires --ids /path/to/approved-ids.txt');
    process.exit(1);
  }

  return { limit, seed, apply, idsPath };
}

function isHeadlineImproved(stored: string | null, extracted: string | null): boolean {
  const normStored = stored?.toLowerCase().trim() || null;
  const normExtracted = extracted?.toLowerCase().trim() || null;
  if (normStored === normExtracted) return false;
  if (!normExtracted) return false; // don't null out existing values
  return true;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function main() {
  const { limit, seed, apply, idsPath } = parseArgs();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    let rows: CandidateRow[];

    if (idsPath) {
      const ids = readFileSync(idsPath, 'utf-8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      if (ids.length === 0) {
        console.error(`No IDs found in ${idsPath}`);
        process.exit(1);
      }

      const quotedIds = ids.map((id) => `'${escapeSqlLiteral(id)}'`).join(', ');
      rows = await prisma.$queryRawUnsafe<CandidateRow[]>(`
        SELECT "id", "linkedinId", "headlineHint", "searchTitle"
        FROM "candidates"
        WHERE "id" IN (${quotedIds})
          AND "searchTitle" IS NOT NULL
          AND "searchTitle" != ''
        ORDER BY "id"
      `);
    } else {
      const orderClause = seed !== null
        ? `ORDER BY md5("id" || '${seed}')`
        : 'ORDER BY RANDOM()';

      rows = await prisma.$queryRawUnsafe<CandidateRow[]>(`
        SELECT "id", "linkedinId", "headlineHint", "searchTitle"
        FROM "candidates"
        WHERE "searchTitle" IS NOT NULL
          AND "searchTitle" != ''
        ${orderClause}
        LIMIT ${limit}
      `);
    }

    const sourceLabel = idsPath
      ? `approved ids from ${idsPath}`
      : `seed=${seed}, limit=${limit}`;
    console.log(`Fetched ${rows.length} candidates (${sourceLabel})`);
    console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

    let updated = 0;
    let skipped = 0;
    const updates: Array<{ id: string; headline: string }> = [];

    for (const row of rows) {
      const extracted = extractHeadlineFromTitle(row.searchTitle || '');
      if (!isHeadlineImproved(row.headlineHint, extracted)) {
        skipped++;
        continue;
      }

      console.log(`  ${row.linkedinId}: "${row.headlineHint ?? 'null'}" → "${extracted}"`);
      updates.push({ id: row.id, headline: extracted! });
      updated++;
    }

    if (apply && updates.length > 0) {
      // Batch update using a VALUES list to minimize round-trips
      const batchSize = 500;
      for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);
        const values = batch
          .map((u) => `('${escapeSqlLiteral(u.id)}', '${escapeSqlLiteral(u.headline)}')`)
          .join(', ');
        await prisma.$executeRawUnsafe(`
          UPDATE "candidates" AS c
          SET "headlineHint" = v.headline
          FROM (VALUES ${values}) AS v(id, headline)
          WHERE c."id" = v.id
        `);
        console.log(`  Batch ${Math.floor(i / batchSize) + 1}: updated ${batch.length} rows`);
      }
    }

    console.log(`\n${apply ? 'Updated' : 'Would update'}: ${updated}`);
    console.log(`Skipped (unchanged): ${skipped}`);
    console.log(`Total: ${rows.length}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
