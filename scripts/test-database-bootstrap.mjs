import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  PRISMA_SCHEMA_PATH,
  ROOT_DIR,
  datasourceEnvironment,
  runPrisma,
} from './lib/database-bootstrap.mjs';

const targetUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!targetUrl) throw new Error('DIRECT_URL or DATABASE_URL is required');
const parsedTarget = new URL(targetUrl);
const databaseName = parsedTarget.pathname.replace(/^\//, '');
if (!/(?:^|[_-])test(?:[_-]|$)/i.test(databaseName)) {
  throw new Error('Bootstrap acceptance requires a disposable *_test database');
}

const databaseEnvironment = datasourceEnvironment(targetUrl);
const bootstrapEnvironment = {
  ...databaseEnvironment,
  SIGNAL_BOOTSTRAP_EMPTY_DATABASE: '1',
  SIGNAL_SCHEMA_ENVIRONMENT: 'development',
  SIGNAL_SCHEMA_DISPOSABLE_SINGLE_CREDENTIAL: '1',
};
const bootstrapScript = resolve(ROOT_DIR, 'scripts/bootstrap-empty-db.mjs');
const driftScript = resolve(ROOT_DIR, 'scripts/check-schema-drift.mjs');

function runNode(scriptPath, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function resetPublicSchema() {
  await runPrisma(
    ['db', 'execute', '--stdin', '--schema', PRISMA_SCHEMA_PATH],
    {
      env: databaseEnvironment,
      input: 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;\n',
      capture: true,
    },
  );
}

async function withPrisma(callback) {
  const prisma = new PrismaClient({ datasourceUrl: targetUrl });
  try {
    return await callback(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function assertBootstrapShape() {
  await withPrisma(async (prisma) => {
    const [{ tableCount }] = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::INTEGER AS "tableCount"
      FROM pg_tables
      WHERE schemaname = current_schema()
    `);
    const [{ migrationCount, finishedCount }] = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*)::INTEGER AS "migrationCount",
        COUNT(finished_at)::INTEGER AS "finishedCount"
      FROM "_prisma_migrations"
    `);
    assert(tableCount === 20, `Expected 20 tables, found ${tableCount}`);
    assert(migrationCount === 21, `Expected 21 migrations, found ${migrationCount}`);
    assert(finishedCount === 21, 'Every baseline migration must be finished');
  });

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
    { env: databaseEnvironment, capture: true },
  );
}

async function verifyNonEmptyRefusal() {
  await resetPublicSchema();
  await runPrisma(
    ['db', 'execute', '--stdin', '--schema', PRISMA_SCHEMA_PATH],
    {
      env: databaseEnvironment,
      input: 'CREATE TABLE bootstrap_canary (id INTEGER PRIMARY KEY);\n',
      capture: true,
    },
  );
  const result = await runNode(bootstrapScript, bootstrapEnvironment);
  assert(result.code !== 0, 'Bootstrap unexpectedly accepted a non-empty database');
  assert(
    `${result.stdout}\n${result.stderr}`.includes('Refusing to bootstrap a non-empty database'),
    'Bootstrap refusal did not identify the non-empty guard',
  );
  await withPrisma(async (prisma) => {
    const [{ canary, ledger }] = await prisma.$queryRawUnsafe(`
      SELECT
        to_regclass('public.bootstrap_canary')::TEXT AS canary,
        to_regclass('public._prisma_migrations')::TEXT AS ledger
    `);
    assert(canary === 'bootstrap_canary', 'Non-empty refusal modified the canary');
    assert(ledger === null, 'Non-empty refusal created a migration ledger');
  });
}

async function verifyConcurrentBootstrap() {
  await resetPublicSchema();
  const results = await Promise.all([
    runNode(bootstrapScript, bootstrapEnvironment),
    runNode(bootstrapScript, bootstrapEnvironment),
  ]);
  const codes = results.map((result) => result.code).sort();
  assert(
    JSON.stringify(codes) === JSON.stringify([0, 1]),
    `Expected one bootstrap success and one refusal, got ${codes.join(',')}`,
  );
  const refusal = results.find((result) => result.code !== 0);
  assert(
    `${refusal.stdout}\n${refusal.stderr}`.includes('Refusing to bootstrap a non-empty database'),
    'Concurrent loser did not recheck emptiness after acquiring the lock',
  );
  await assertBootstrapShape();
}

async function verifyFutureMigrationAndDriftFailure() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'signal-forward-migration-'));
  try {
    const temporaryPrisma = join(temporaryRoot, 'prisma');
    await mkdir(temporaryPrisma, { recursive: true });
    await cp(
      resolve(ROOT_DIR, 'prisma/migrations'),
      join(temporaryPrisma, 'migrations'),
      { recursive: true },
    );
    const temporarySchema = join(temporaryPrisma, 'schema.prisma');
    const schema = await readFile(PRISMA_SCHEMA_PATH, 'utf8');
    await writeFile(
      temporarySchema,
      schema.replace(
        '  updatedAt DateTime @default(now()) @updatedAt\n',
        '  updatedAt DateTime @default(now()) @updatedAt\n  bootstrapForwardProbe String? @map("bootstrap_forward_probe")\n',
      ),
    );
    const futureMigrationName = '20990101000000_bootstrap_forward_probe';
    const futureMigrationDirectory = join(
      temporaryPrisma,
      'migrations',
      futureMigrationName,
    );
    await mkdir(futureMigrationDirectory);
    await writeFile(
      join(futureMigrationDirectory, 'migration.sql'),
      'ALTER TABLE "tenant_settings" ADD COLUMN "bootstrap_forward_probe" TEXT;\n',
    );

    await runPrisma(
      ['migrate', 'deploy', '--schema', temporarySchema],
      { env: databaseEnvironment, capture: true },
    );
    await withPrisma(async (prisma) => {
      const [{ columnExists, migrationFinished }] = await prisma.$queryRawUnsafe(`
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'tenant_settings'
              AND column_name = 'bootstrap_forward_probe'
          ) AS "columnExists",
          EXISTS (
            SELECT 1 FROM "_prisma_migrations"
            WHERE migration_name = '${futureMigrationName}'
              AND finished_at IS NOT NULL
          ) AS "migrationFinished"
      `);
      assert(columnExists, 'Future migration did not create its column');
      assert(migrationFinished, 'Future migration did not finish in the ledger');
    });

    const driftResult = await runNode(driftScript, {
      ...databaseEnvironment,
      SIGNAL_SCHEMA_AUDIT_DATABASE_URL: targetUrl,
      SIGNAL_SCHEMA_AUDIT_ALLOW_TEST_ROLE: '1',
    });
    assert(driftResult.code !== 0, 'Drift monitor accepted a changed database');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await verifyNonEmptyRefusal();
await verifyConcurrentBootstrap();
await verifyFutureMigrationAndDriftFailure();
await resetPublicSchema();
const finalBootstrap = await runNode(bootstrapScript, bootstrapEnvironment);
if (finalBootstrap.code !== 0) {
  throw new Error(`Final bootstrap failed:\n${finalBootstrap.stdout}\n${finalBootstrap.stderr}`);
}
await assertBootstrapShape();
console.log('[Bootstrap acceptance] All empty-database guards passed');
