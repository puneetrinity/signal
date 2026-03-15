/**
 * Targeted Location Hint Backfill
 *
 * Re-runs current extraction on stored searchTitle/searchSnippet and updates
 * locationHint in the database. Two modes:
 *
 *   --ids <file>     Process specific candidate IDs from audit output
 *   --tenant <id>    Process all candidates for a tenant (legacy mode)
 *
 * Safety:
 *   - Dry-run by default (--apply to write)
 *   - Only upgrades: skips rows where new extraction is worse than stored
 *   - Logs every change for audit
 *
 * Usage:
 *   npx tsx scripts/backfill-location-hints.ts --ids /tmp/backfill-ids.txt
 *   npx tsx scripts/backfill-location-hints.ts --ids /tmp/backfill-ids.txt --apply
 *   npx tsx scripts/backfill-location-hints.ts --tenant <id> --limit 500
 *   npx tsx scripts/backfill-location-hints.ts --tenant <id> --limit 500 --apply
 */

import { readFileSync } from 'fs';
import { extractLocationFromSerpResult } from '../src/lib/enrichment/hint-extraction';
import { locationHintQualityScore, normalizeHint, isNoisyHint, isLikelyLocationHint, containsGeoToken } from '../src/lib/sourcing/hint-sanitizer';
import { resolveLocationDeterministic } from '../src/lib/taxonomy/location-service';

// ---------- Types ----------

interface CandidateRow {
  id: string;
  linkedinId: string;
  locationHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  let idsPath: string | null = null;
  let tenantId: string | null = null;
  let apply = false;
  let limit = 1000;
  let batchSize = 100;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ids' && args[i + 1]) idsPath = args[++i];
    else if (args[i] === '--tenant' && args[i + 1]) tenantId = args[++i];
    else if (args[i] === '--apply' || args[i] === '--commit') apply = true;
    else if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === '--batch' && args[i + 1]) batchSize = parseInt(args[++i], 10);
    // Legacy compat
    else if (args[i] === '--dry-run') apply = false;
  }

  if (!idsPath && !tenantId) {
    console.error('Usage:');
    console.error('  npx tsx scripts/backfill-location-hints.ts --ids <path> [--apply]');
    console.error('  npx tsx scripts/backfill-location-hints.ts --tenant <id> [--limit N] [--apply]');
    process.exit(1);
  }

  return { idsPath, tenantId, apply, limit, batchSize };
}

// ---------- Main ----------

async function main() {
  const { idsPath, tenantId, apply, limit, batchSize } = parseArgs();

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  let ids: string[] | null = null;
  if (idsPath) {
    ids = readFileSync(idsPath, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    console.log(`Loaded ${ids.length} candidate IDs from ${idsPath}`);
  } else {
    console.log(`Tenant: ${tenantId}, limit: ${limit}`);
  }
  console.log(`Mode: ${apply ? 'APPLY (writing to DB)' : 'DRY RUN (no writes)'}\n`);

  let updated = 0;
  let skipped = 0;
  let cleaned = 0;
  let errors = 0;

  try {
    // Fetch rows
    let rows: CandidateRow[];

    if (ids) {
      // ID-targeted mode: process in batches
      rows = [];
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        const batchRows = await prisma.$queryRawUnsafe<CandidateRow[]>(`
          SELECT "id", "linkedinId", "locationHint", "searchTitle", "searchSnippet"
          FROM "candidates"
          WHERE "id" = ANY(ARRAY[${batch.map(id => `'${id}'`).join(',')}]::text[])
        `);
        rows.push(...batchRows);
      }
    } else {
      // Tenant mode
      rows = await prisma.$queryRawUnsafe<CandidateRow[]>(`
        SELECT "id", "linkedinId", "locationHint", "searchTitle", "searchSnippet"
        FROM "candidates"
        WHERE "tenantId" = '${tenantId}'
          AND ("searchSnippet" IS NOT NULL AND "searchSnippet" != '')
        ORDER BY "updatedAt" DESC
        LIMIT ${limit}
      `);
    }

    console.log(`Processing ${rows.length} candidates...\n`);

    for (const row of rows) {
      const stored = row.locationHint || null;
      const storedScore = locationHintQualityScore(stored);

      // Re-validate: if stored hint is now considered bad, null it
      if (stored && !isLikelyLocationHint(stored)) {
        if (apply) {
          await prisma.$executeRawUnsafe(
            `UPDATE "candidates" SET "locationHint" = NULL, "updatedAt" = NOW() WHERE "id" = $1`,
            row.id,
          );
        }
        console.log(`  CLEAN ${row.linkedinId}: "${stored}" → null (failed validation)`);
        cleaned++;
        // Continue to try re-extraction below with storedScore=0
      }

      // Re-extract
      const raw = extractLocationFromSerpResult(
        row.searchTitle || '',
        row.searchSnippet || '',
      );
      const normalized = normalizeHint(raw ?? undefined) ?? null;
      const extractedScore = locationHintQualityScore(normalized);
      const extracted = extractedScore > 0 ? normalized : null;

      // Skip if no improvement
      if (!extracted || extractedScore <= storedScore) {
        skipped++;
        continue;
      }

      const resolution = resolveLocationDeterministic(extracted);

      // Quality gate: no-comma multi-word extraction that resolved to no country
      // is strongly indicative of garbage ("Gainsight Arizona State" → country=null).
      // Valid multi-word locations like "San Francisco Bay Area" always resolve a country.
      if (extracted && !extracted.includes(',') &&
          extracted.split(/\s+/).length >= 3 &&
          !resolution.countryCode) {
        console.log(
          `  SKIP ${row.linkedinId}: "${extracted}" — no country resolved, suspected noise`,
        );
        skipped++;
        continue;
      }

      console.log(
        `  UPDATE ${row.linkedinId}: "${stored ?? 'null'}" (${storedScore})` +
        ` → "${extracted}" (${extractedScore})` +
        ` → city=${resolution.city ?? 'null'}, country=${resolution.countryCode ?? 'null'}`,
      );

      if (apply) {
        try {
          await prisma.$executeRawUnsafe(
            `UPDATE "candidates" SET "locationHint" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
            extracted,
            row.id,
          );
          updated++;
        } catch (err) {
          console.error(`  ERROR updating ${row.id}:`, err);
          errors++;
        }
      } else {
        updated++;
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n=== Backfill ${apply ? 'Complete' : 'Dry Run'} ===`);
  console.log(`Total candidates: ${rows?.length ?? 0}`);
  console.log(`${apply ? 'Updated' : 'Would update'}: ${updated}`);
  console.log(`Cleaned (bad stored): ${cleaned}`);
  console.log(`Skipped (no improvement): ${skipped}`);
  if (errors > 0) console.log(`Errors: ${errors}`);
  if (!apply) console.log(`\nRe-run with --apply to write changes.`);
}

// Variable for finally block
let rows: CandidateRow[] | undefined;

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
