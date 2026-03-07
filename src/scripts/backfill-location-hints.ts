/**
 * One-time backfill: extract locationHint from searchTitle + searchSnippet
 * for candidates that have snippet/title data but no locationHint.
 *
 * Uses shouldReplaceLocationHint to ensure we only write when the extracted
 * value is higher quality than any existing hint.
 *
 * Run: DATABASE_URL=<url> npx tsx src/scripts/backfill-location-hints.ts [--dry-run]
 */

import { prisma } from '@/lib/prisma';
import { extractLocationFromSerpResult } from '@/lib/enrichment/hint-extraction';
import { normalizeHint, shouldReplaceLocationHint, locationHintQualityScore } from '@/lib/sourcing/hint-sanitizer';

const BATCH_SIZE = 500;
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`[backfill] Starting location hint backfill${DRY_RUN ? ' (DRY RUN)' : ''}...`);

  let cursor: string | undefined;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  while (true) {
    const candidates = await prisma.candidate.findMany({
      where: {
        OR: [
          { locationHint: null },
          { locationHint: '' },
        ],
        searchSnippet: { not: null },
      },
      select: {
        id: true,
        locationHint: true,
        searchTitle: true,
        searchSnippet: true,
      },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (candidates.length === 0) break;

    for (const c of candidates) {
      scanned++;
      const title = c.searchTitle ?? '';
      const snippet = c.searchSnippet ?? '';

      const extracted = extractLocationFromSerpResult(title, snippet);
      if (!extracted) {
        skipped++;
        continue;
      }

      const normalized = normalizeHint(extracted);
      if (!normalized) {
        skipped++;
        continue;
      }
      // Backfill only moderate/high-confidence location hints.
      if (locationHintQualityScore(normalized) < 2) {
        skipped++;
        continue;
      }

      if (!shouldReplaceLocationHint(c.locationHint, normalized)) {
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [dry] ${c.id}: "${normalized}" (from ${title ? 'title+snippet' : 'snippet'})`);
      } else {
        await prisma.candidate.update({
          where: { id: c.id },
          data: { locationHint: normalized },
        });
      }
      updated++;
    }

    cursor = candidates[candidates.length - 1].id;
    console.log(`  [backfill] scanned=${scanned} updated=${updated} skipped=${skipped}`);
  }

  console.log(`[backfill] Done. scanned=${scanned} updated=${updated} skipped=${skipped}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
