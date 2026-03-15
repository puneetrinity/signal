#!/usr/bin/env npx tsx
/**
 * Generate the list of candidate IDs eligible for headline backfill.
 * Scans all candidates with searchTitle, reruns extractHeadlineFromTitle(),
 * emits IDs where extracted differs from stored (and extracted is non-null).
 *
 * Output: /tmp/headline-backfill-ids.txt (one ID per line)
 */

import { extractHeadlineFromTitle } from '../src/lib/enrichment/hint-extraction';
import { writeFileSync } from 'fs';

function normalizeHeadline(value: string | null | undefined): string | null {
  const normalized = value?.toLowerCase().trim().replace(/\s+/g, ' ') ?? '';
  return normalized.length > 0 ? normalized : null;
}

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string;
      headlineHint: string | null;
      searchTitle: string | null;
    }>>(`
      SELECT "id", "headlineHint", "searchTitle"
      FROM "candidates"
      WHERE "searchTitle" IS NOT NULL
        AND "searchTitle" != ''
    `);

    const ids: string[] = [];
    for (const row of rows) {
      const extracted = extractHeadlineFromTitle(row.searchTitle || '');
      const normStored = normalizeHeadline(row.headlineHint);
      const normExtracted = normalizeHeadline(extracted);
      if (normStored === normExtracted) continue;
      if (normExtracted === null) continue;
      ids.push(row.id);
    }

    const outPath = '/tmp/headline-backfill-ids.txt';
    writeFileSync(outPath, ids.join('\n') + '\n');
    console.log(`Headline backfill candidates: ${ids.length} / ${rows.length}`);
    console.log(`Written to: ${outPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
