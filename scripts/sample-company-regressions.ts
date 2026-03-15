#!/usr/bin/env npx tsx
/**
 * Sample and classify company regressions from the title backfill audit.
 *
 * Pulls candidate rows from prod DB where a stored companyHint exists, reruns
 * extractHeadlineFromTitle() + extractCompanyFromHeadline() on stored searchTitle,
 * and shows why the new extraction differs.
 *
 * Default mode samples likely regressions from DB directly.
 * Optional --ids takes a newline-delimited list of linkedinIds to inspect.
 */

import { readFileSync } from 'fs';
import {
  extractHeadlineFromTitle,
  extractCompanyFromHeadline,
} from '../src/lib/enrichment/hint-extraction';

interface CandidateRow {
  id: string;
  linkedinId: string;
  searchTitle: string | null;
  headlineHint: string | null;
  companyHint: string | null;
}

type RegressionBucket =
  | 'stored_not_in_title'
  | 'stored_looks_garbage'
  | 'clean_title_miss'
  | 'changed_company'
  | 'not_a_regression';

function norm(value: string | null | undefined): string | null {
  const out = value?.toLowerCase().trim().replace(/\s+/g, ' ') ?? '';
  return out.length > 0 ? out : null;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function looksGarbageCompany(value: string | null): boolean {
  if (!value) return false;
  const lower = value.toLowerCase().trim();
  if (lower === 'linkedin') return true;
  if (lower.length > 120) return true;
  if (/\b(view|connections?|followers?|profile)\b/i.test(value)) return true;
  if (/\b(engineer|developer|manager|architect|consultant|director|analyst|designer|specialist|lead|founder|cto|ceo|vp)\b/i.test(value) && !/\b(at|@)\b/i.test(value)) return true;
  if (/\b(ai\/ml|machine learning|ruby on rails|elixir|phoenix|customer success|product strategy|account executive|sales)\b/i.test(value)) return true;
  return false;
}

function classifyRow(row: CandidateRow) {
  const storedCompany = row.companyHint ?? null;
  const extractedHeadline = extractHeadlineFromTitle(row.searchTitle || '');
  const extractedCompany = extractCompanyFromHeadline(extractedHeadline);

  const storedNorm = norm(storedCompany);
  const extractedNorm = norm(extractedCompany);
  const titleNorm = norm(row.searchTitle);

  const same = storedNorm === extractedNorm;
  const storedInTitle = Boolean(storedNorm && titleNorm && titleNorm.includes(storedNorm));
  const storedLooksGarbage = looksGarbageCompany(storedCompany);
  const cleanTitlePattern = Boolean(extractedHeadline && /\b(at|@)\b/i.test(extractedHeadline));

  let bucket: RegressionBucket;
  if (same) {
    bucket = 'not_a_regression';
  } else if (!storedInTitle) {
    bucket = 'stored_not_in_title';
  } else if (storedLooksGarbage) {
    bucket = 'stored_looks_garbage';
  } else if (!extractedNorm && cleanTitlePattern) {
    bucket = 'clean_title_miss';
  } else {
    bucket = 'changed_company';
  }

  return {
    ...row,
    extractedHeadline,
    extractedCompany,
    storedNorm,
    extractedNorm,
    storedInTitle,
    storedLooksGarbage,
    cleanTitlePattern,
    same,
    bucket,
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 50;
  let seed: number | null = 42;
  let idsPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === '--seed' && args[i + 1]) seed = parseInt(args[++i], 10);
    else if (args[i] === '--ids' && args[i + 1]) idsPath = args[++i];
  }

  return { limit, seed, idsPath };
}

async function fetchRows(limit: number, seed: number | null, ids: string[] | null): Promise<CandidateRow[]> {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    if (ids && ids.length > 0) {
      const quoted = ids.map((id) => `'${escapeSqlLiteral(id)}'`).join(', ');
      return await prisma.$queryRawUnsafe<CandidateRow[]>(`
        SELECT "id", "linkedinId", "searchTitle", "headlineHint", "companyHint"
        FROM "candidates"
        WHERE "linkedinId" IN (${quoted})
        ORDER BY "linkedinId"
      `);
    }

    const orderClause = seed !== null
      ? `ORDER BY md5("id" || '${seed}')`
      : 'ORDER BY RANDOM()';

    return await prisma.$queryRawUnsafe<CandidateRow[]>(`
      SELECT "id", "linkedinId", "searchTitle", "headlineHint", "companyHint"
      FROM "candidates"
      WHERE "searchTitle" IS NOT NULL
        AND "searchTitle" != ''
        AND "companyHint" IS NOT NULL
        AND "companyHint" != ''
      ${orderClause}
      LIMIT ${limit * 10}
    `);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const { limit, seed, idsPath } = parseArgs();
  const ids = idsPath
    ? readFileSync(idsPath, 'utf-8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : null;

  const rows = await fetchRows(limit, seed, ids);
  const classified = rows.map(classifyRow).filter((r) => !r.same);
  const sampled = ids ? classified : classified.slice(0, limit);

  const byBucket = new Map<RegressionBucket, typeof sampled>();
  for (const row of sampled) {
    if (!byBucket.has(row.bucket)) byBucket.set(row.bucket, []);
    byBucket.get(row.bucket)!.push(row);
  }

  console.log(`Sampled regressions: ${sampled.length}`);
  console.log('');
  for (const bucket of [
    'clean_title_miss',
    'changed_company',
    'stored_not_in_title',
    'stored_looks_garbage',
    'not_a_regression',
  ] as const) {
    const items = byBucket.get(bucket) ?? [];
    if (items.length === 0) continue;
    console.log(`--- ${bucket} (${items.length}) ---`);
    for (const r of items) {
      console.log(`  ${r.linkedinId}`);
      console.log(`    searchTitle:      ${r.searchTitle}`);
      console.log(`    stored headline:  ${r.headlineHint}`);
      console.log(`    stored company:   ${r.companyHint}`);
      console.log(`    new headline:     ${r.extractedHeadline}`);
      console.log(`    new company:      ${r.extractedCompany}`);
      console.log(`    stored in title:  ${r.storedInTitle ? 'YES' : 'NO'}`);
      console.log(`    title has at/@:   ${r.cleanTitlePattern ? 'YES' : 'NO'}`);
      console.log(`    garbage stored:   ${r.storedLooksGarbage ? 'YES' : 'NO'}`);
      console.log('');
    }
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
