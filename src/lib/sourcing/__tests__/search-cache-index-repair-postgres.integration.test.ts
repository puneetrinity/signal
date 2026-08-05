import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';

const postgresEnabled = process.env.RUN_SIGNAL_POSTGRES_INTEGRATION === '1';
const describePostgres = postgresEnabled ? describe : describe.skip;
const migrationUrl = new URL(
  '../../../../prisma/migrations/20260805010000_drop_legacy_global_search_cache_index/migration.sql',
  import.meta.url,
);
const LEGACY_INDEX = 'search_cache_v2_queryHash_key';
const TENANT_INDEX = 'search_cache_v2_tenantId_queryHash_key';

interface IndexRow {
  indexname: string;
}

async function indexNames(): Promise<string[]> {
  const rows = await prisma.$queryRaw<IndexRow[]>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'search_cache_v2'
    ORDER BY indexname
  `;
  return rows.map((row) => row.indexname);
}

describePostgres('search cache index repair (PostgreSQL)', () => {
  const tenantIds = [
    `cache_repair_a_${randomUUID()}`,
    `cache_repair_b_${randomUUID()}`,
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
    await prisma.searchCacheV2.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${LEGACY_INDEX}"`);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${TENANT_INDEX}" ON "search_cache_v2"("tenantId", "queryHash")`,
    );
    await prisma.$disconnect();
  });

  it('fails closed without the tenant index, then drops only the legacy index', async () => {
    const migrationSql = await readFile(migrationUrl, 'utf8');
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX "${LEGACY_INDEX}" ON "search_cache_v2"("queryHash") WHERE "provider" = 'legacy'`,
    );
    await expect(prisma.$executeRawUnsafe(migrationSql)).rejects.toThrow(
      /refusing to drop unexpected index object/,
    );
    expect(await indexNames()).toContain(LEGACY_INDEX);
    await prisma.$executeRawUnsafe(`DROP INDEX "${LEGACY_INDEX}"`);

    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX "${LEGACY_INDEX}" ON "search_cache_v2"("queryHash")`,
    );
    const before = await indexNames();
    expect(before).toContain(LEGACY_INDEX);
    expect(before).toContain(TENANT_INDEX);

    await prisma.$executeRawUnsafe(`DROP INDEX "${TENANT_INDEX}"`);
    await expect(prisma.$executeRawUnsafe(migrationSql)).rejects.toThrow(
      /required tenant-scoped search cache index is missing or invalid/,
    );
    expect(await indexNames()).toContain(LEGACY_INDEX);

    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX "${TENANT_INDEX}" ON "search_cache_v2"("tenantId", "queryHash")`,
    );
    await prisma.$executeRawUnsafe(migrationSql);
    const after = await indexNames();
    expect(after).not.toContain(LEGACY_INDEX);
    expect(after).toContain(TENANT_INDEX);
    expect(after).toEqual(before.filter((name) => name !== LEGACY_INDEX));
  });

  it('persists the same query hash independently for two tenants', async () => {
    const query = `senior backend engineer bengaluru ${randomUUID()}`;
    const queryHash = createHash('sha256')
      .update(query.trim().toLowerCase())
      .digest('hex')
      .slice(0, 32);
    const expiresAt = new Date(Date.now() + 60_000);

    for (const tenantId of tenantIds) {
      await prisma.searchCacheV2.upsert({
        where: { tenantId_queryHash: { tenantId, queryHash } },
        update: {
          parsedQuery: {},
          results: [],
          resultCount: 0,
          provider: 'test',
          expiresAt,
        },
        create: {
          tenantId,
          queryHash,
          queryText: query,
          parsedQuery: {},
          results: [],
          resultCount: 0,
          provider: 'test',
          expiresAt,
        },
      });
    }

    const rows = await prisma.searchCacheV2.findMany({
      where: { tenantId: { in: tenantIds }, queryHash },
      orderBy: { tenantId: 'asc' },
      select: { tenantId: true, queryHash: true },
    });
    expect(rows).toEqual(
      [...tenantIds]
        .sort()
        .map((tenantId) => ({ tenantId, queryHash })),
    );
  });
});
