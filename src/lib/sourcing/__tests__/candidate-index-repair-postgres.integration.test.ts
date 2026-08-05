import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import type { ProfileSummary } from '@/types/linkedin';
import {
  makeGlobalTemporaryCandidateId,
  materializePublicMemoryCandidates,
  type PublicMemoryMaterializationEntry,
} from '../public-memory-materialization';

const postgresEnabled = process.env.RUN_SIGNAL_POSTGRES_INTEGRATION === '1';
const describePostgres = postgresEnabled ? describe : describe.skip;
const migrationUrl = new URL(
  '../../../../prisma/migrations/20260805000000_drop_legacy_candidate_linkedin_indexes/migration.sql',
  import.meta.url,
);
const LEGACY_INDEXES = [
  'candidates_linkedinId_key',
  'candidates_linkedinUrl_key',
] as const;
const REQUIRED_TENANT_INDEXES = [
  'candidates_tenantId_id_key',
  'candidates_tenantId_linkedinId_key',
  'candidates_tenantId_linkedinUrl_key',
] as const;

interface CandidateIndexRow {
  indexname: string;
}

async function candidateIndexNames(): Promise<string[]> {
  const rows = await prisma.$queryRaw<CandidateIndexRow[]>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'candidates'
    ORDER BY indexname
  `;
  return rows.map((row) => row.indexname);
}

function materializationEntry(input: {
  linkedinId: string;
  globalCandidateId: string;
}): PublicMemoryMaterializationEntry {
  return {
    temporaryId: makeGlobalTemporaryCandidateId(input.globalCandidateId),
    globalCandidateId: input.globalCandidateId,
    profile: {
      title: 'Backend Engineer',
      snippet: 'Public Python platform profile',
      linkedinUrl: `https://www.linkedin.com/in/${input.linkedinId}`,
      linkedinId: input.linkedinId,
      canonicalLinkedinId: input.linkedinId,
      headline: 'Backend Engineer',
      location: 'Bengaluru, India',
    } as ProfileSummary & { canonicalLinkedinId: string },
  };
}

describePostgres('candidate LinkedIn index repair (PostgreSQL)', () => {
  const tenantIds = [
    `index_repair_a_${randomUUID()}`,
    `index_repair_b_${randomUUID()}`,
    `index_repair_c_${randomUUID()}`,
    `index_repair_race_${randomUUID()}`,
  ];

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    if (!/(?:^|[_-])test(?:[_-]|$)/i.test(new URL(databaseUrl).pathname)) {
      throw new Error(
        'PostgreSQL integration tests require a disposable *_test database',
      );
    }
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS signal_test_delay_candidate_insert ON "candidates"',
    );
    await prisma.$executeRawUnsafe(
      'DROP FUNCTION IF EXISTS signal_test_delay_candidate_insert()',
    );
    await prisma.$executeRawUnsafe(
      'DROP SEQUENCE IF EXISTS signal_test_candidate_insert_attempts',
    );
    for (const indexName of LEGACY_INDEXES) {
      await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${indexName}"`);
    }
    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "candidates_tenantId_linkedinId_key" ON "candidates"("tenantId", "linkedinId")',
    );
    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "candidates_tenantId_linkedinUrl_key" ON "candidates"("tenantId", "linkedinUrl")',
    );
    await prisma.candidateGlobalLink.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await prisma.candidate.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await prisma.$disconnect();
  });

  it('fails closed when a tenant index is absent, then drops only the legacy pair', async () => {
    const migrationSql = await readFile(migrationUrl, 'utf8');
    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX "candidates_linkedinId_key" ON "candidates"("linkedinId")',
    );
    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX "candidates_linkedinUrl_key" ON "candidates"("linkedinUrl")',
    );
    const before = await candidateIndexNames();
    for (const indexName of LEGACY_INDEXES) expect(before).toContain(indexName);
    for (const indexName of REQUIRED_TENANT_INDEXES) {
      expect(before).toContain(indexName);
    }

    await prisma.$executeRawUnsafe(
      'DROP INDEX "candidates_tenantId_linkedinUrl_key"',
    );
    await expect(prisma.$executeRawUnsafe(migrationSql)).rejects.toThrow(
      /required tenant-scoped linkedinUrl index is missing or invalid/,
    );
    const afterRejectedPreflight = await candidateIndexNames();
    for (const indexName of LEGACY_INDEXES) {
      expect(afterRejectedPreflight).toContain(indexName);
    }

    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX "candidates_tenantId_linkedinUrl_key" ON "candidates"("tenantId", "linkedinUrl")',
    );
    await prisma.$executeRawUnsafe(migrationSql);
    const after = await candidateIndexNames();
    expect(after).toEqual(
      before.filter(
        (indexName) =>
          !LEGACY_INDEXES.includes(
            indexName as (typeof LEGACY_INDEXES)[number],
          ),
      ),
    );
  });

  it('materializes one public identity independently into two tenants', async () => {
    const linkedinId = `cross-tenant-${randomUUID()}`;
    const globalCandidateId = randomUUID();
    const entry = materializationEntry({ linkedinId, globalCandidateId });

    const first = await materializePublicMemoryCandidates({
      tenantId: tenantIds[0],
      entries: [entry],
    });
    const second = await materializePublicMemoryCandidates({
      tenantId: tenantIds[1],
      entries: [entry],
    });

    expect(first.failures).toEqual([]);
    expect(second.failures).toEqual([]);
    const firstId = first.materializedByTemporaryId.get(entry.temporaryId);
    const secondId = second.materializedByTemporaryId.get(entry.temporaryId);
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    expect(
      await prisma.candidate.count({
        where: {
          tenantId: { in: [tenantIds[0], tenantIds[1]] },
          linkedinId,
        },
      }),
    ).toBe(2);
    expect(
      await prisma.candidateGlobalLink.count({
        where: {
          tenantId: { in: [tenantIds[0], tenantIds[1]] },
          globalCandidateId,
        },
      }),
    ).toBe(2);

    await prisma.candidateGlobalLink.deleteMany({
      where: { tenantId: { in: [tenantIds[0], tenantIds[1]] } },
    });
    await prisma.candidate.deleteMany({
      where: { tenantId: { in: [tenantIds[0], tenantIds[1]] } },
    });
  });

  it('records a sanitized unique-conflict cause without profile data', async () => {
    const linkedinId = `diagnostic-private-${randomUUID()}`;
    const globalCandidateId = randomUUID();
    await prisma.candidate.create({
      data: {
        tenantId: tenantIds[0],
        linkedinId,
        linkedinUrl: `https://www.linkedin.com/in/${linkedinId}`,
        captureSource: 'test',
      },
    });
    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX "candidates_linkedinId_key" ON "candidates"("linkedinId")',
    );
    try {
      const result = await materializePublicMemoryCandidates({
        tenantId: tenantIds[2],
        entries: [materializationEntry({ linkedinId, globalCandidateId })],
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        globalCandidateId,
        code: 'candidate_upsert_failed',
        cause: 'unique_conflict',
        databaseCode: 'P2002',
      });
      const serialized = JSON.stringify(result.failures);
      expect(serialized).not.toContain(linkedinId);
      expect(serialized).not.toContain('linkedin.com');
      expect(serialized).not.toContain('Unique constraint failed');
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP INDEX IF EXISTS "candidates_linkedinId_key"',
      );
    }
  });

  it('retries a same-tenant P2002 only after the failed transaction rolls back', async () => {
    const linkedinId = `same-tenant-race-${randomUUID()}`;
    const globalCandidateId = randomUUID();
    const entry = materializationEntry({ linkedinId, globalCandidateId });
    const safeLinkedinId = linkedinId.replaceAll("'", "''");
    await prisma.$executeRawUnsafe(
      'CREATE SEQUENCE signal_test_candidate_insert_attempts',
    );
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION signal_test_delay_candidate_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW."linkedinId" = '${safeLinkedinId}' THEN
          PERFORM nextval('signal_test_candidate_insert_attempts');
          PERFORM pg_sleep(0.75);
        END IF;
        RETURN NEW;
      END
      $function$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER signal_test_delay_candidate_insert
      BEFORE INSERT ON "candidates"
      FOR EACH ROW EXECUTE FUNCTION signal_test_delay_candidate_insert()
    `);

    try {
      const [first, second] = await Promise.all([
        materializePublicMemoryCandidates({
          tenantId: tenantIds[3],
          entries: [entry],
        }),
        materializePublicMemoryCandidates({
          tenantId: tenantIds[3],
          entries: [entry],
        }),
      ]);
      expect(first.failures).toEqual([]);
      expect(second.failures).toEqual([]);
      expect(first.materializedByTemporaryId.get(entry.temporaryId)).toBe(
        second.materializedByTemporaryId.get(entry.temporaryId),
      );
      expect(
        await prisma.candidate.count({
          where: { tenantId: tenantIds[3], linkedinId },
        }),
      ).toBe(1);
      const attempts = await prisma.$queryRaw<Array<{ last_value: bigint }>>`
        SELECT last_value FROM signal_test_candidate_insert_attempts
      `;
      expect(Number(attempts[0]?.last_value)).toBe(2);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS signal_test_delay_candidate_insert ON "candidates"',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS signal_test_delay_candidate_insert()',
      );
      await prisma.$executeRawUnsafe(
        'DROP SEQUENCE IF EXISTS signal_test_candidate_insert_attempts',
      );
    }
  });
});
