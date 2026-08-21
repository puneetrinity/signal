import { PrismaClient } from '@prisma/client';
import {
  PRISMA_SCHEMA_PATH,
  datasourceEnvironment,
  runPrisma,
  validateBaselineManifest,
} from './lib/database-bootstrap.mjs';

const BOOTSTRAP_OPT_IN = 'SIGNAL_BOOTSTRAP_EMPTY_DATABASE';
const targetUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (process.env[BOOTSTRAP_OPT_IN] !== '1') {
  throw new Error(`${BOOTSTRAP_OPT_IN}=1 is required`);
}
if (!targetUrl) throw new Error('DIRECT_URL or DATABASE_URL is required');
if (
  process.env.SIGNAL_SCHEMA_ENVIRONMENT !== 'development' ||
  process.env.SIGNAL_SCHEMA_DISPOSABLE_SINGLE_CREDENTIAL !== '1'
) {
  throw new Error(
    'Empty bootstrap requires an explicitly disposable development environment',
  );
}
const parsedTarget = new URL(targetUrl);
const databaseName = parsedTarget.pathname.replace(/^\//, '');
if (
  !['', 'localhost', '127.0.0.1', '[::1]', '::1'].includes(parsedTarget.hostname) ||
  !/(?:^|[_-])(?:test|disposable)(?:[_-]|$)/i.test(databaseName)
) {
  throw new Error('Empty bootstrap requires a loopback/socket *_test or *_disposable database');
}

const { manifest, baselinePath } = await validateBaselineManifest();
const prismaEnvironment = datasourceEnvironment(targetUrl);
const prisma = new PrismaClient({ datasourceUrl: targetUrl });

try {
  await prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended('signal-empty-bootstrap:' || current_database(), 0))",
      );

      const [{ schemaName }] = await transaction.$queryRawUnsafe(
        'SELECT current_schema() AS "schemaName"',
      );
      if (schemaName !== 'public') {
        throw new Error(`Signal bootstrap requires the public schema, got ${schemaName}`);
      }

      const objects = await transaction.$queryRawUnsafe(`
        SELECT object_kind AS "kind", object_name AS "name"
        FROM (
          SELECT 'relation'::TEXT AS object_kind, relation.relname::TEXT AS object_name
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = current_schema()
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          UNION ALL
          SELECT 'function', procedure.proname
          FROM pg_proc procedure
          JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = current_schema()
          UNION ALL
          SELECT 'type', type.typname
          FROM pg_type type
          JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
          WHERE namespace.nspname = current_schema()
            AND type.typtype IN ('d', 'e')
          UNION ALL
          SELECT 'trigger', trigger.tgname
          FROM pg_trigger trigger
          JOIN pg_class relation ON relation.oid = trigger.tgrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = current_schema()
            AND NOT trigger.tgisinternal
        ) existing_objects
        ORDER BY object_kind, object_name
        LIMIT 20
      `);
      if (objects.length > 0) {
        const summary = objects
          .map((object) => `${object.kind}:${object.name}`)
          .join(', ');
        throw new Error(
          `Refusing to bootstrap a non-empty database (${summary})`,
        );
      }

      console.log('[Bootstrap] Empty database verified under advisory lock');
      await runPrisma(
        ['db', 'execute', '--file', baselinePath, '--schema', PRISMA_SCHEMA_PATH],
        { env: prismaEnvironment },
      );

      for (const migration of manifest.migrations) {
        await runPrisma(
          [
            'migrate',
            'resolve',
            '--applied',
            migration.name,
            '--schema',
            PRISMA_SCHEMA_PATH,
          ],
          { env: prismaEnvironment },
        );
      }

      await runPrisma(
        ['migrate', 'deploy', '--schema', PRISMA_SCHEMA_PATH],
        { env: prismaEnvironment },
      );
      await runPrisma(
        [
          'migrate',
          'diff',
          '--from-schema-datasource',
          PRISMA_SCHEMA_PATH,
          '--to-schema-datamodel',
          PRISMA_SCHEMA_PATH,
          '--exit-code',
        ],
        { env: prismaEnvironment },
      );
    },
    { maxWait: 30_000, timeout: 900_000 },
  );
  console.log('[Bootstrap] Signal database bootstrap completed');
} finally {
  await prisma.$disconnect();
}
