#!/usr/bin/env npx tsx
/**
 * Regenerate non-tech summaries from existing DB data.
 *
 * This is DB-only. It does not enqueue workers.
 * It rewrites the latest completed enrichment session per candidate using the
 * new non-tech summary prompt, then you can run:
 *
 *   npx tsx scripts/backfill-nontech-snapshots.ts ...
 *
 * Usage:
 *   GROQ_API_KEY=... DATABASE_URL=... npx tsx scripts/regenerate-nontech-summaries.ts --tenant <id> --limit 200
 *   GROQ_API_KEY=... DATABASE_URL=... npx tsx scripts/regenerate-nontech-summaries.ts --tenant <id> --limit 200 --apply
 *   GROQ_API_KEY=... DATABASE_URL=... npx tsx scripts/regenerate-nontech-summaries.ts --ids /tmp/candidate-ids.txt --apply
 *
 * Notes:
 * - Dry-run by default
 * - Recommended scope is targeted candidate IDs from a recent non-tech request
 * - Requires GROQ_API_KEY
 */

import { readFileSync } from 'fs';
import { prisma } from '../src/lib/prisma';
import { toJsonValue } from '../src/lib/prisma/json';
import { generateCandidateSummary } from '../src/lib/enrichment/summary/generate';
import type { DiscoveredIdentity, EvidencePointer, EnrichmentPlatform } from '../src/lib/enrichment/sources/types';

interface CandidateSummaryTarget {
  id: string;
  tenantId: string;
  linkedinId: string;
  linkedinUrl: string | null;
  nameHint: string | null;
  headlineHint: string | null;
  locationHint: string | null;
  companyHint: string | null;
  candidateRoleType: string | null;
  sessionId: string;
  sessionRoleType: string | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let tenantId: string | null = null;
  let idsPath: string | null = null;
  let limit = 200;
  let batchSize = 50;
  let apply = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tenant' && args[i + 1]) tenantId = args[++i];
    else if (args[i] === '--ids' && args[i + 1]) idsPath = args[++i];
    else if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === '--batch' && args[i + 1]) batchSize = parseInt(args[++i], 10);
    else if (args[i] === '--apply' || args[i] === '--commit') apply = true;
  }

  if (!tenantId && !idsPath) {
    console.error('Usage:');
    console.error('  GROQ_API_KEY=... npx tsx scripts/regenerate-nontech-summaries.ts --tenant <id> [--limit N] [--apply]');
    console.error('  GROQ_API_KEY=... npx tsx scripts/regenerate-nontech-summaries.ts --ids <path> [--apply]');
    process.exit(1);
  }

  if (!process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY is required');
    process.exit(1);
  }

  return { tenantId, idsPath, limit, batchSize, apply };
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function fetchTargetsByIds(ids: string[]): Promise<CandidateSummaryTarget[]> {
  const idArray = ids.map(sqlLiteral).join(',');
  return prisma.$queryRawUnsafe<CandidateSummaryTarget[]>(`
    SELECT
      c."id",
      c."tenantId",
      c."linkedinId",
      c."linkedinUrl",
      c."nameHint",
      c."headlineHint",
      c."locationHint",
      c."companyHint",
      c."roleType" AS "candidateRoleType",
      es."id" AS "sessionId",
      es."roleType" AS "sessionRoleType"
    FROM "candidates" c
    JOIN LATERAL (
      SELECT es2."id", es2."roleType"
      FROM "enrichment_sessions" es2
      WHERE es2."candidateId" = c."id"
        AND es2."tenantId" = c."tenantId"
        AND es2."status" = 'completed'
      ORDER BY COALESCE(es2."summaryGeneratedAt", es2."completedAt", es2."updatedAt") DESC
      LIMIT 1
    ) es ON TRUE
    WHERE c."id" = ANY(ARRAY[${idArray}]::text[])
    ORDER BY c."updatedAt" DESC
  `);
}

async function fetchTargetsByTenant(tenantId: string, limit: number): Promise<CandidateSummaryTarget[]> {
  return prisma.$queryRawUnsafe<CandidateSummaryTarget[]>(`
    SELECT
      c."id",
      c."tenantId",
      c."linkedinId",
      c."linkedinUrl",
      c."nameHint",
      c."headlineHint",
      c."locationHint",
      c."companyHint",
      c."roleType" AS "candidateRoleType",
      es."id" AS "sessionId",
      es."roleType" AS "sessionRoleType"
    FROM "candidates" c
    JOIN LATERAL (
      SELECT es2."id", es2."roleType"
      FROM "enrichment_sessions" es2
      WHERE es2."candidateId" = c."id"
        AND es2."tenantId" = c."tenantId"
        AND es2."status" = 'completed'
      ORDER BY COALESCE(es2."summaryGeneratedAt", es2."completedAt", es2."updatedAt") DESC
      LIMIT 1
    ) es ON TRUE
    LEFT JOIN "candidate_intelligence_snapshots" nt
      ON nt."candidateId" = c."id"
     AND nt."tenantId" = c."tenantId"
     AND nt."track" = 'non-tech'
    WHERE c."tenantId" = ${sqlLiteral(tenantId)}
      AND nt."id" IS NOT NULL
    ORDER BY c."updatedAt" DESC
    LIMIT ${limit}
  `);
}

function asEvidencePointers(value: unknown): EvidencePointer[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      type: (item.type as EvidencePointer['type']) ?? 'profile_link',
      sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : '',
      sourcePlatform: (item.sourcePlatform as EnrichmentPlatform) ?? 'github',
      description: typeof item.description === 'string' ? item.description : '',
      capturedAt: typeof item.capturedAt === 'string' ? item.capturedAt : new Date().toISOString(),
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : undefined,
    }))
    .filter((item) => item.sourceUrl.length > 0);
}

function getProfileField(profileData: unknown, key: string): string | null {
  if (!profileData || typeof profileData !== 'object') return null;
  const value = (profileData as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

async function loadIdentitiesByCandidate(candidateIds: string[]) {
  const [identityCandidates, confirmedIdentities] = await Promise.all([
    prisma.identityCandidate.findMany({
      where: { candidateId: { in: candidateIds } },
      select: {
        candidateId: true,
        platform: true,
        platformId: true,
        profileUrl: true,
        confidence: true,
        confidenceBucket: true,
        scoreBreakdown: true,
        evidence: true,
        hasContradiction: true,
        contradictionNote: true,
      },
      orderBy: { confidence: 'desc' },
    }),
    prisma.confirmedIdentity.findMany({
      where: { candidateId: { in: candidateIds } },
      select: {
        candidateId: true,
        platform: true,
        platformId: true,
        profileUrl: true,
        profileData: true,
        confirmedAt: true,
      },
      orderBy: { confirmedAt: 'desc' },
    }),
  ]);

  const byCandidate = new Map<string, DiscoveredIdentity[]>();

  for (const row of identityCandidates) {
    const bucket = byCandidate.get(row.candidateId) ?? [];
    bucket.push({
      platform: row.platform as EnrichmentPlatform,
      platformId: row.platformId,
      profileUrl: row.profileUrl,
      displayName: null,
      confidence: row.confidence,
      confidenceBucket: (row.confidenceBucket as DiscoveredIdentity['confidenceBucket']) || 'suggest',
      scoreBreakdown: {
        bridgeWeight: 0,
        nameMatch: 0,
        handleMatch: 0,
        companyMatch: 0,
        locationMatch: 0,
        profileCompleteness: 0.5,
        activityScore: 0,
        total: row.confidence,
      },
      evidence: asEvidencePointers(row.evidence),
      hasContradiction: row.hasContradiction,
      contradictionNote: row.contradictionNote,
      platformProfile: {
        name: null,
        bio: null,
        company: null,
        location: null,
      },
    });
    byCandidate.set(row.candidateId, bucket);
  }

  for (const row of confirmedIdentities) {
    const bucket = byCandidate.get(row.candidateId) ?? [];
    bucket.unshift({
      platform: row.platform as EnrichmentPlatform,
      platformId: row.platformId,
      profileUrl: row.profileUrl,
      displayName: getProfileField(row.profileData, 'name'),
      confidence: 1,
      confidenceBucket: 'auto_merge',
      scoreBreakdown: {
        bridgeWeight: 1,
        nameMatch: 1,
        handleMatch: 1,
        companyMatch: 1,
        locationMatch: 1,
        profileCompleteness: 1,
        activityScore: 1,
        total: 1,
      },
      evidence: [],
      hasContradiction: false,
      contradictionNote: null,
      platformProfile: {
        name: getProfileField(row.profileData, 'name'),
        bio: getProfileField(row.profileData, 'bio'),
        company: getProfileField(row.profileData, 'company'),
        location: getProfileField(row.profileData, 'location'),
      },
    });
    byCandidate.set(row.candidateId, bucket);
  }

  return byCandidate;
}

async function main() {
  const { tenantId, idsPath, limit, batchSize, apply } = parseArgs();

  let targets: CandidateSummaryTarget[] = [];
  if (idsPath) {
    const ids = readFileSync(idsPath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    console.log(`Loaded ${ids.length} candidate IDs from ${idsPath}`);
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const batchTargets = await fetchTargetsByIds(batch);
      targets.push(...batchTargets);
    }
  } else if (tenantId) {
    console.log(`Tenant: ${tenantId}, limit: ${limit}`);
    targets = await fetchTargetsByTenant(tenantId, limit);
  }

  console.log(`Mode: ${apply ? 'APPLY (writing to DB)' : 'DRY RUN (no writes)'}`);
  console.log(`Candidates selected: ${targets.length}\n`);

  const identityMap = await loadIdentitiesByCandidate(targets.map((t) => t.id));

  let processed = 0;
  let written = 0;
  let withConfirmed = 0;

  for (const target of targets) {
    processed++;
    const identities = identityMap.get(target.id) ?? [];
    const confirmedCount = identities.filter((identity) => identity.confidence >= 1).length;
    if (confirmedCount > 0) withConfirmed++;

    const { summary, evidence, model, tokens, meta } = await generateCandidateSummary({
      candidate: {
        linkedinId: target.linkedinId,
        linkedinUrl: target.linkedinUrl || '',
        nameHint: target.nameHint,
        headlineHint: target.headlineHint,
        locationHint: target.locationHint,
        companyHint: target.companyHint,
        roleType: null,
      },
      identities: identities.slice(0, 10),
      platformData: [],
      mode: confirmedCount > 0 ? 'verified' : 'draft',
      confirmedCount,
      track: 'non_tech',
    });

    console.log(
      [
        `${apply ? 'WRITE' : 'DRY'} ${target.linkedinId}`,
        `session=${target.sessionId}`,
        `skills=${summary.structured.skills.length}`,
        `confirmed=${confirmedCount}`,
        `model=${model}`,
      ].join(' | '),
    );

    if (!apply) continue;

    const existing = await prisma.enrichmentSession.findUnique({
      where: { id: target.sessionId },
      select: { runTrace: true },
    });
    const runTrace = existing?.runTrace && typeof existing.runTrace === 'object'
      ? JSON.parse(JSON.stringify(existing.runTrace)) as Record<string, unknown>
      : null;

    if (runTrace && runTrace.final && typeof runTrace.final === 'object') {
      (runTrace.final as Record<string, unknown>).summaryMeta = meta as unknown as Record<string, unknown>;
    }

    await prisma.enrichmentSession.update({
      where: { id: target.sessionId },
      data: {
        summary: summary.summary,
        summaryStructured: toJsonValue(summary.structured),
        summaryEvidence: toJsonValue(evidence),
        summaryModel: model,
        summaryTokens: tokens,
        summaryGeneratedAt: new Date(),
        runTrace: runTrace ? toJsonValue(runTrace) : undefined,
      },
    });
    written++;
  }

  await prisma.$disconnect();

  console.log('\n=== Non-tech Summary Regeneration ===');
  console.log(`Processed: ${processed}`);
  console.log(`${apply ? 'Written' : 'Would write'}: ${apply ? written : processed}`);
  console.log(`Candidates with confirmed identities: ${withConfirmed}`);
  if (!apply) {
    console.log('\nRe-run with --apply to write changes.');
    console.log('Then run scripts/backfill-nontech-snapshots.ts to rebuild the non-tech snapshots from the regenerated summaries.');
  }
}

main().catch(async (error) => {
  console.error('Summary regeneration failed:', error);
  await prisma.$disconnect();
  process.exit(1);
});
