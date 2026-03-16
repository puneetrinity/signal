#!/usr/bin/env npx tsx
/**
 * Backfill non-tech CandidateIntelligenceSnapshot rows from existing DB data.
 *
 * This is DB-only. It does not enqueue workers or require Redis.
 * It recomputes the non-tech snapshot using:
 * - latest stored summaryStructured (if present)
 * - candidate hints (headline/searchTitle/searchSnippet/location)
 * - existing identity rows
 * - existing tech snapshot freshness reference
 *
 * Usage:
 *   npx tsx scripts/backfill-nontech-snapshots.ts --tenant <id> --limit 500
 *   npx tsx scripts/backfill-nontech-snapshots.ts --tenant <id> --limit 500 --apply
 *   npx tsx scripts/backfill-nontech-snapshots.ts --ids /tmp/candidate-ids.txt --apply
 *   npx tsx scripts/backfill-nontech-snapshots.ts --tenant <id> --all --apply
 *
 * Notes:
 * - Dry-run by default
 * - By default processes only candidates whose non-tech snapshot is missing or has 0 skills
 * - `--all` recomputes all eligible candidates in scope
 * - This does NOT regenerate summaries with the new non-tech prompt; it uses stored
 *   summaryStructured plus deterministic extraction from candidate hints
 */

import { readFileSync } from 'fs';
import { prisma } from '../src/lib/prisma';
import { toJsonValue } from '../src/lib/prisma/json';
import { getNonTechConfig } from '../src/lib/enrichment/config';
import {
  extractCompanyAlignment,
  extractContradictions,
  extractFreshness,
  extractSeniorityValidation,
  extractSerpContext,
} from '../src/lib/enrichment/non-tech/extractors';
import { scoreNonTech } from '../src/lib/enrichment/non-tech/scoring';
import { extractNonTechSkills } from '../src/lib/enrichment/non-tech/skills';
import { getSourcingConfig } from '../src/lib/sourcing/config';
import { isLikelyLocationHint } from '../src/lib/sourcing/hint-sanitizer';

interface CandidateRow {
  id: string;
  tenantId: string;
  linkedinId: string;
  companyHint: string | null;
  headlineHint: string | null;
  locationHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
  searchMeta: unknown;
  lastEnrichedAt: Date | null;
  candidateRoleType: string | null;
  sessionId: string | null;
  sessionRoleType: string | null;
  summaryStructured: Record<string, unknown> | null;
  techComputedAt: Date | null;
  techStaleAfter: Date | null;
  nonTechComputedAt: Date | null;
  existingSkillCount: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let tenantId: string | null = null;
  let idsPath: string | null = null;
  let limit = 500;
  let batchSize = 100;
  let apply = false;
  let all = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tenant' && args[i + 1]) tenantId = args[++i];
    else if (args[i] === '--ids' && args[i + 1]) idsPath = args[++i];
    else if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === '--batch' && args[i + 1]) batchSize = parseInt(args[++i], 10);
    else if (args[i] === '--apply' || args[i] === '--commit') apply = true;
    else if (args[i] === '--all') all = true;
  }

  if (!tenantId && !idsPath) {
    console.error('Usage:');
    console.error('  npx tsx scripts/backfill-nontech-snapshots.ts --tenant <id> [--limit N] [--apply] [--all]');
    console.error('  npx tsx scripts/backfill-nontech-snapshots.ts --ids <path> [--apply] [--all]');
    process.exit(1);
  }

  return { tenantId, idsPath, limit, batchSize, apply, all };
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function fetchRowsByIds(ids: string[], all: boolean): Promise<CandidateRow[]> {
  const idArray = ids.map(sqlLiteral).join(',');
  const missingFilter = all ? '' : 'AND (nt."id" IS NULL OR cardinality(nt."skillsNormalized") = 0)';

  return prisma.$queryRawUnsafe<CandidateRow[]>(`
    SELECT
      c."id",
      c."tenantId",
      c."linkedinId",
      c."companyHint",
      c."headlineHint",
      c."locationHint",
      c."searchTitle",
      c."searchSnippet",
      c."searchMeta",
      c."lastEnrichedAt",
      c."roleType" AS "candidateRoleType",
      es."id" AS "sessionId",
      es."roleType" AS "sessionRoleType",
      es."summaryStructured",
      tech."computedAt" AS "techComputedAt",
      tech."staleAfter" AS "techStaleAfter",
      nt."computedAt" AS "nonTechComputedAt",
      COALESCE(cardinality(nt."skillsNormalized"), 0) AS "existingSkillCount"
    FROM "candidates" c
    LEFT JOIN LATERAL (
      SELECT es2."id", es2."roleType", es2."summaryStructured"
      FROM "enrichment_sessions" es2
      WHERE es2."candidateId" = c."id"
        AND es2."tenantId" = c."tenantId"
        AND es2."status" = 'completed'
        AND es2."summaryStructured" IS NOT NULL
      ORDER BY COALESCE(es2."summaryGeneratedAt", es2."completedAt", es2."updatedAt") DESC
      LIMIT 1
    ) es ON TRUE
    LEFT JOIN "candidate_intelligence_snapshots" tech
      ON tech."candidateId" = c."id"
     AND tech."tenantId" = c."tenantId"
     AND tech."track" = 'tech'
    LEFT JOIN "candidate_intelligence_snapshots" nt
      ON nt."candidateId" = c."id"
     AND nt."tenantId" = c."tenantId"
     AND nt."track" = 'non-tech'
    WHERE c."id" = ANY(ARRAY[${idArray}]::text[])
      AND es."id" IS NOT NULL
      ${missingFilter}
    ORDER BY c."updatedAt" DESC
  `);
}

async function fetchRowsByTenant(tenantId: string, limit: number, all: boolean): Promise<CandidateRow[]> {
  const missingFilter = all ? '' : 'AND (nt."id" IS NULL OR cardinality(nt."skillsNormalized") = 0)';

  return prisma.$queryRawUnsafe<CandidateRow[]>(`
    SELECT
      c."id",
      c."tenantId",
      c."linkedinId",
      c."companyHint",
      c."headlineHint",
      c."locationHint",
      c."searchTitle",
      c."searchSnippet",
      c."searchMeta",
      c."lastEnrichedAt",
      c."roleType" AS "candidateRoleType",
      es."id" AS "sessionId",
      es."roleType" AS "sessionRoleType",
      es."summaryStructured",
      tech."computedAt" AS "techComputedAt",
      tech."staleAfter" AS "techStaleAfter",
      nt."computedAt" AS "nonTechComputedAt",
      COALESCE(cardinality(nt."skillsNormalized"), 0) AS "existingSkillCount"
    FROM "candidates" c
    LEFT JOIN LATERAL (
      SELECT es2."id", es2."roleType", es2."summaryStructured"
      FROM "enrichment_sessions" es2
      WHERE es2."candidateId" = c."id"
        AND es2."tenantId" = c."tenantId"
        AND es2."status" = 'completed'
        AND es2."summaryStructured" IS NOT NULL
      ORDER BY COALESCE(es2."summaryGeneratedAt", es2."completedAt", es2."updatedAt") DESC
      LIMIT 1
    ) es ON TRUE
    LEFT JOIN "candidate_intelligence_snapshots" tech
      ON tech."candidateId" = c."id"
     AND tech."tenantId" = c."tenantId"
     AND tech."track" = 'tech'
    LEFT JOIN "candidate_intelligence_snapshots" nt
      ON nt."candidateId" = c."id"
     AND nt."tenantId" = c."tenantId"
     AND nt."track" = 'non-tech'
    WHERE c."tenantId" = ${sqlLiteral(tenantId)}
      AND es."id" IS NOT NULL
      ${missingFilter}
    ORDER BY c."updatedAt" DESC
    LIMIT ${limit}
  `);
}

async function main() {
  const { tenantId, idsPath, limit, batchSize, apply, all } = parseArgs();
  const nonTechConfig = getNonTechConfig();
  const sourcingConfig = getSourcingConfig();

  let rows: CandidateRow[] = [];
  if (idsPath) {
    const ids = readFileSync(idsPath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    console.log(`Loaded ${ids.length} candidate IDs from ${idsPath}`);
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const batchRows = await fetchRowsByIds(batch, all);
      rows.push(...batchRows);
    }
  } else if (tenantId) {
    console.log(`Tenant: ${tenantId}, limit: ${limit}`);
    rows = await fetchRowsByTenant(tenantId, limit, all);
  }

  console.log(`Mode: ${apply ? 'APPLY (writing to DB)' : 'DRY RUN (no writes)'}`);
  console.log(`Scope: ${all ? 'all eligible candidates with summaries' : 'missing/empty non-tech snapshots only'}`);
  console.log(`Candidates selected: ${rows.length}\n`);

  const candidateIds = rows.map((row) => row.id);
  const identities = candidateIds.length > 0
    ? await prisma.identityCandidate.findMany({
        where: { candidateId: { in: candidateIds } },
        select: {
          candidateId: true,
          platform: true,
          confidence: true,
          hasContradiction: true,
          contradictionNote: true,
          updatedAt: true,
        },
      })
    : [];

  const identitiesByCandidate = new Map<string, typeof identities>();
  for (const identity of identities) {
    const bucket = identitiesByCandidate.get(identity.candidateId) ?? [];
    bucket.push(identity);
    identitiesByCandidate.set(identity.candidateId, bucket);
  }

  let processed = 0;
  let written = 0;
  let skippedNoSkills = 0;

  for (const row of rows) {
    processed++;
    const rowIdentities = identitiesByCandidate.get(row.id) ?? [];
    const techSnapshot = row.techComputedAt && row.techStaleAfter
      ? { computedAt: row.techComputedAt, staleAfter: row.techStaleAfter }
      : null;

    const candidateData = {
      companyHint: row.companyHint,
      headlineHint: row.headlineHint,
      locationHint: row.locationHint,
      searchTitle: row.searchTitle,
      searchSnippet: row.searchSnippet,
      searchMeta: row.searchMeta,
      lastEnrichedAt: row.lastEnrichedAt,
    };

    const skillsNormalized = extractNonTechSkills({
      summaryStructured: row.summaryStructured,
      headlineHint: row.headlineHint,
      searchTitle: row.searchTitle,
      searchSnippet: row.searchSnippet,
    });
    const companyAlignment = extractCompanyAlignment(candidateData, rowIdentities);
    const seniorityValidation = extractSeniorityValidation(candidateData);
    const freshness = extractFreshness(candidateData, techSnapshot, nonTechConfig);
    const serpContext = extractSerpContext(candidateData);
    const contradictions = extractContradictions(rowIdentities);
    const signals = {
      companyAlignment,
      seniorityValidation,
      freshness,
      serpContext,
      contradictions,
    };
    const score = scoreNonTech(signals, nonTechConfig);

    const now = new Date();
    const staleAfter = new Date(now.getTime() + sourcingConfig.snapshotStaleDays * 24 * 60 * 60 * 1000);
    const rawLocation = row.locationHint?.trim() ?? null;
    const snapshotLocation = rawLocation && isLikelyLocationHint(rawLocation) ? rawLocation : null;
    const roleType = row.sessionRoleType ?? row.candidateRoleType ?? 'general';

    if (skillsNormalized.length === 0) skippedNoSkills++;

    console.log(
      [
        `${apply ? 'WRITE' : 'DRY'} ${row.linkedinId}`,
        `existingSkills=${row.existingSkillCount}`,
        `newSkills=${skillsNormalized.length}`,
        `roleType=${roleType}`,
        `location=${snapshotLocation ?? 'null'}`,
        `session=${row.sessionId ?? 'null'}`,
      ].join(' | '),
    );

    if (!apply) continue;

    await prisma.candidateIntelligenceSnapshot.upsert({
      where: {
        candidateId_tenantId_track: {
          candidateId: row.id,
          tenantId: row.tenantId,
          track: 'non-tech',
        },
      },
      create: {
        candidateId: row.id,
        tenantId: row.tenantId,
        track: 'non-tech',
        skillsNormalized,
        roleType,
        seniorityBand: seniorityValidation.normalizedBand,
        location: snapshotLocation,
        activityRecencyDays: freshness.ageDays,
        computedAt: now,
        staleAfter,
        sourceSessionId: row.sessionId,
        sourceFingerprint: null,
        signalsJson: toJsonValue({
          signals,
          score,
          config: {
            minCorroboration: nonTechConfig.minCorroboration,
            maxSourceAgeDays: nonTechConfig.maxSourceAgeDays,
            seniorityMinConf: nonTechConfig.seniorityMinConf,
            scoreFloor: nonTechConfig.scoreFloor,
            backfilledAt: now.toISOString(),
          },
        }),
      },
      update: {
        skillsNormalized,
        roleType,
        seniorityBand: seniorityValidation.normalizedBand,
        location: snapshotLocation,
        activityRecencyDays: freshness.ageDays,
        computedAt: now,
        staleAfter,
        sourceSessionId: row.sessionId,
        signalsJson: toJsonValue({
          signals,
          score,
          config: {
            minCorroboration: nonTechConfig.minCorroboration,
            maxSourceAgeDays: nonTechConfig.maxSourceAgeDays,
            seniorityMinConf: nonTechConfig.seniorityMinConf,
            scoreFloor: nonTechConfig.scoreFloor,
            backfilledAt: now.toISOString(),
          },
        }),
      },
    });
    written++;
  }

  await prisma.$disconnect();

  console.log('\n=== Non-tech Snapshot Backfill ===');
  console.log(`Processed: ${processed}`);
  console.log(`${apply ? 'Written' : 'Would write'}: ${apply ? written : processed}`);
  console.log(`Rows with 0 extracted skills: ${skippedNoSkills}`);
  if (!apply) {
    console.log('\nRe-run with --apply to write changes.');
    console.log('This script is DB-only and can be run locally against any reachable DB via DATABASE_URL.');
  }
}

main().catch(async (error) => {
  console.error('Backfill failed:', error);
  await prisma.$disconnect();
  process.exit(1);
});
