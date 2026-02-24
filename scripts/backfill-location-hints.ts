/**
 * One-time backfill: re-extract locationHint and headlineHint for candidates
 * with null hints but stored searchSnippet/searchTitle.
 *
 * Uses the improved extractLocationFromSnippet (Indian cities, boilerplate rejects)
 * and extractHeadlineFromTitle extractors.
 *
 * Usage:
 *   npx tsx scripts/backfill-location-hints.ts --tenant <id> --limit 500 --dry-run
 *   npx tsx scripts/backfill-location-hints.ts --tenant <id> --limit 500 --commit
 *
 * Idempotent: only fills null fields, never overwrites existing data.
 */

import { prisma } from '@/lib/prisma';
import { extractLocationFromSnippet, extractHeadlineFromTitle } from '@/lib/enrichment/hint-extraction';
import { isNoisyHint } from '@/lib/sourcing/hint-sanitizer';

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const tenantId = getArg('tenant');
const limit = parseInt(getArg('limit') ?? '1000', 10);
const commitMode = args.includes('--commit');

if (!tenantId) {
  console.error('Error: --tenant <id> is required');
  process.exit(1);
}

console.log(`Backfill location/headline hints`);
console.log(`  tenant:  ${tenantId}`);
console.log(`  limit:   ${limit}`);
console.log(`  mode:    ${commitMode ? 'COMMIT' : 'DRY-RUN'}`);
console.log();

async function main() {
  const candidates = await prisma.$queryRaw<Array<{
    id: string;
    searchSnippet: string | null;
    searchTitle: string | null;
    locationHint: string | null;
    headlineHint: string | null;
  }>>`
    SELECT
      "id",
      "searchSnippet",
      "searchTitle",
      "locationHint",
      "headlineHint"
    FROM "candidates"
    WHERE "tenantId" = ${tenantId}
      AND (
        (("locationHint" IS NULL OR btrim("locationHint") = '') AND "searchSnippet" IS NOT NULL)
        OR
        (("headlineHint" IS NULL OR btrim("headlineHint") = '') AND "searchTitle" IS NOT NULL)
      )
    ORDER BY "updatedAt" DESC
    LIMIT ${limit}
  `;

  console.log(`Scanned: ${candidates.length} candidates`);

  let updatedLocation = 0;
  let updatedHeadline = 0;
  let skippedNoisy = 0;
  let skippedNoResult = 0;

  const BATCH_SIZE = 100;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const updates: Promise<unknown>[] = [];

    for (const c of batch) {
      const data: Record<string, string> = {};

      // Re-extract location
      if ((!c.locationHint || c.locationHint.trim() === '') && c.searchSnippet) {
        const extracted = extractLocationFromSnippet(c.searchSnippet);
        if (extracted) {
          if (isNoisyHint(extracted)) {
            skippedNoisy++;
          } else {
            data.locationHint = extracted;
            updatedLocation++;
          }
        } else {
          skippedNoResult++;
        }
      }

      // Re-extract headline
      if ((!c.headlineHint || c.headlineHint.trim() === '') && c.searchTitle) {
        const extracted = extractHeadlineFromTitle(c.searchTitle);
        if (extracted && !isNoisyHint(extracted)) {
          data.headlineHint = extracted;
          updatedHeadline++;
        }
      }

      if (Object.keys(data).length > 0) {
        if (commitMode) {
          updates.push(
            prisma.candidate.update({
              where: { id: c.id },
              data,
            }),
          );
        } else {
          console.log(`  [dry-run] ${c.id}: ${JSON.stringify(data)}`);
        }
      }
    }

    if (updates.length > 0) {
      await Promise.all(updates);
    }
  }

  console.log();
  console.log(`Results:`);
  console.log(`  Updated locationHint:  ${updatedLocation}`);
  console.log(`  Updated headlineHint:  ${updatedHeadline}`);
  console.log(`  Skipped (noisy):       ${skippedNoisy}`);
  console.log(`  Skipped (no result):   ${skippedNoResult}`);
  console.log(`  Mode: ${commitMode ? 'COMMITTED' : 'DRY-RUN (no writes)'}`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
