#!/usr/bin/env npx tsx
/**
 * Title/Headline Backfill Audit
 *
 * Queries prod DB directly, reruns extractHeadlineFromTitle() +
 * extractCompanyFromHeadline() on stored searchTitle, and compares
 * against stored headlineHint / companyHint.
 *
 * Categories:
 *   NEW          — no stored hint, parser now extracts one
 *   FIXED        — stored hint is garbage, parser produces better or null
 *   IMPROVED     — stored hint ok, parser produces different (better) result
 *   REGRESSED    — stored hint ok, parser produces worse result
 *   UNCHANGED    — same output
 *
 * Usage:
 *   npx tsx scripts/audit-title-backfill.ts
 *   npx tsx scripts/audit-title-backfill.ts --limit 500 --verbose
 *   npx tsx scripts/audit-title-backfill.ts --limit 500 --seed 42
 *   npx tsx scripts/audit-title-backfill.ts --missing-only --limit 200
 *   npx tsx scripts/audit-title-backfill.ts --ids /tmp/title-backfill-ids.txt
 */

import {
  extractHeadlineFromTitle,
  extractCompanyFromHeadline,
} from '../src/lib/enrichment/hint-extraction';
import { writeFileSync } from 'fs';

// ---------- Types ----------

interface CandidateRow {
  id: string;
  linkedinId: string;
  headlineHint: string | null;
  companyHint: string | null;
  searchTitle: string | null;
}

type Verdict = 'NEW' | 'FIXED' | 'IMPROVED' | 'REGRESSED' | 'UNCHANGED';

interface AuditRow {
  id: string;
  linkedinId: string;
  storedHeadline: string | null;
  extractedHeadline: string | null;
  storedCompany: string | null;
  extractedCompany: string | null;
  headlineVerdict: Verdict;
  companyVerdict: Verdict;
}

// ---------- DB query ----------

async function queryCandidates(
  opts: { limit: number; missingOnly: boolean; seed: number | null },
): Promise<CandidateRow[]> {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const whereClause = opts.missingOnly
      ? `AND ("headlineHint" IS NULL OR "headlineHint" = '')`
      : '';

    const orderClause = opts.seed !== null
      ? `ORDER BY md5("id" || '${opts.seed}')`
      : 'ORDER BY RANDOM()';

    const rows = await prisma.$queryRawUnsafe<CandidateRow[]>(`
      SELECT
        "id",
        "linkedinId",
        "headlineHint",
        "companyHint",
        "searchTitle"
      FROM "candidates"
      WHERE "searchTitle" IS NOT NULL
        AND "searchTitle" != ''
        ${whereClause}
      ${orderClause}
      LIMIT ${opts.limit}
    `);
    return rows;
  } finally {
    await prisma.$disconnect();
  }
}

// ---------- Verdict logic ----------

function isGarbage(hint: string | null): boolean {
  if (!hint) return false;
  // Garbage: very short, or looks like a snippet fragment, or contains boilerplate
  if (hint.length > 200) return true;
  if (/\bView\b.*\bprofile\b/i.test(hint)) return true;
  if (/\bLinkedIn\b.*\bprofessional community\b/i.test(hint)) return true;
  if (/^\d{4}\s*[-–]/.test(hint)) return true; // Date range like "2016 - 2020"
  return false;
}

function fieldVerdict(stored: string | null, extracted: string | null): Verdict {
  const normStored = stored?.toLowerCase().trim() || null;
  const normExtracted = extracted?.toLowerCase().trim() || null;

  if (normStored === normExtracted) return 'UNCHANGED';
  if (!normStored && normExtracted) return 'NEW';
  if (normStored && isGarbage(stored) && normStored !== normExtracted) return 'FIXED';
  if (normStored && !normExtracted) return 'REGRESSED';
  if (normStored && normExtracted && normStored !== normExtracted) return 'IMPROVED';
  return 'UNCHANGED';
}

// ---------- Audit logic ----------

function auditRow(row: CandidateRow): AuditRow {
  const storedHeadline = row.headlineHint || null;
  const storedCompany = row.companyHint || null;

  const extractedHeadline = extractHeadlineFromTitle(row.searchTitle || '');
  const extractedCompany = extractCompanyFromHeadline(extractedHeadline);

  return {
    id: row.id,
    linkedinId: row.linkedinId,
    storedHeadline,
    extractedHeadline,
    storedCompany,
    extractedCompany,
    headlineVerdict: fieldVerdict(storedHeadline, extractedHeadline),
    companyVerdict: fieldVerdict(storedCompany, extractedCompany),
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
  console.log(`Querying up to ${limit} candidates${missingOnly ? ' (missing headlineHint only)' : ''}${seedLabel}...`);
  const rows = await queryCandidates({ limit, missingOnly, seed });
  console.log(`Got ${rows.length} rows\n`);

  if (rows.length === 0) return;

  const results = rows.map(auditRow);

  // Tally headlines
  const hCounts: Record<Verdict, number> = { NEW: 0, FIXED: 0, IMPROVED: 0, REGRESSED: 0, UNCHANGED: 0 };
  for (const r of results) hCounts[r.headlineVerdict]++;

  // Tally companies
  const cCounts: Record<Verdict, number> = { NEW: 0, FIXED: 0, IMPROVED: 0, REGRESSED: 0, UNCHANGED: 0 };
  for (const r of results) cCounts[r.companyVerdict]++;

  const hActionable = hCounts.NEW + hCounts.FIXED + hCounts.IMPROVED;
  const cActionable = cCounts.NEW + cCounts.FIXED + cCounts.IMPROVED;

  console.log('=== Title Backfill Audit ===\n');
  console.log(`Total sampled:  ${results.length}\n`);

  console.log('--- Headline ---');
  console.log(`Actionable:     ${hActionable} (${(hActionable / results.length * 100).toFixed(1)}%)`);
  console.log(`  NEW:            ${hCounts.NEW}`);
  console.log(`  FIXED:          ${hCounts.FIXED}`);
  console.log(`  IMPROVED:       ${hCounts.IMPROVED}`);
  console.log(`Regressions:    ${hCounts.REGRESSED}`);
  console.log(`Unchanged:      ${hCounts.UNCHANGED}`);

  console.log('\n--- Company ---');
  console.log(`Actionable:     ${cActionable} (${(cActionable / results.length * 100).toFixed(1)}%)`);
  console.log(`  NEW:            ${cCounts.NEW}`);
  console.log(`  FIXED:          ${cCounts.FIXED}`);
  console.log(`  IMPROVED:       ${cCounts.IMPROVED}`);
  console.log(`Regressions:    ${cCounts.REGRESSED}`);
  console.log(`Unchanged:      ${cCounts.UNCHANGED}`);

  // Verbose: non-UNCHANGED results
  if (verbose) {
    const interesting = results.filter(r => r.headlineVerdict !== 'UNCHANGED' || r.companyVerdict !== 'UNCHANGED');
    if (interesting.length > 0) {
      console.log(`\n--- Changes (${interesting.length}) ---`);
      for (const r of interesting) {
        if (r.headlineVerdict !== 'UNCHANGED') {
          console.log(
            `  [H:${r.headlineVerdict.padEnd(9)}] ${r.linkedinId}` +
            ` | "${r.storedHeadline ?? 'null'}" → "${r.extractedHeadline ?? 'null'}"`,
          );
        }
        if (r.companyVerdict !== 'UNCHANGED') {
          console.log(
            `  [C:${r.companyVerdict.padEnd(9)}] ${r.linkedinId}` +
            ` | "${r.storedCompany ?? 'null'}" → "${r.extractedCompany ?? 'null'}"`,
          );
        }
      }
    }

    // Show regressions explicitly
    const hRegs = results.filter(r => r.headlineVerdict === 'REGRESSED');
    if (hRegs.length > 0) {
      console.log(`\n--- Headline Regressions (${hRegs.length}) ---`);
      for (const r of hRegs) {
        console.log(`  ${r.linkedinId}: "${r.storedHeadline}" → "${r.extractedHeadline ?? 'null'}"`);
      }
    }
    const cRegs = results.filter(r => r.companyVerdict === 'REGRESSED');
    if (cRegs.length > 0) {
      console.log(`\n--- Company Regressions (${cRegs.length}) ---`);
      for (const r of cRegs) {
        console.log(`  ${r.linkedinId}: "${r.storedCompany}" → "${r.extractedCompany ?? 'null'}"`);
      }
    }
  }

  // Emit IDs for backfill (rows where headline or company improved)
  if (idsOutput) {
    const backfillIds = results
      .filter(r =>
        r.headlineVerdict === 'NEW' || r.headlineVerdict === 'FIXED' || r.headlineVerdict === 'IMPROVED' ||
        r.companyVerdict === 'NEW' || r.companyVerdict === 'FIXED' || r.companyVerdict === 'IMPROVED',
      )
      .map(r => r.id);
    writeFileSync(idsOutput, backfillIds.join('\n') + '\n');
    console.log(`\nBackfill IDs (${backfillIds.length}) written to: ${idsOutput}`);
  }
}

main().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
