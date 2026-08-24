import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT_DIR } from '../lib/database-bootstrap.mjs';
import { CONTROL_SCHEMA, RUNTIME_ROLE } from './constants.mjs';
import { beginBoundedTransaction, createPrisma } from './database.mjs';

if (process.env.RUN_SIGNAL_SCHEMA_CONTROL_POSTGRES !== '1') {
  throw new Error('RUN_SIGNAL_SCHEMA_CONTROL_POSTGRES=1 is required');
}
const adminUrl = process.env.SIGNAL_SCHEMA_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('SIGNAL_SCHEMA_TEST_DATABASE_URL is required');
const parsed = new URL(adminUrl);
const databaseName = parsed.pathname.replace(/^\//, '');
if (
  !/(?:^|[_-])schema_control_test(?:[_-]|$)/i.test(databaseName) ||
  decodeURIComponent(parsed.username) !== 'signal_schema_control_test_runner'
) {
  throw new Error('Refusing schema-control integration: disposable database/role markers do not match');
}

const targetId = '11111111-1111-4111-8111-111111111111';
const runtimePassword = 'runtime-test-only';
const runtimeParsed = new URL(adminUrl);
runtimeParsed.username = RUNTIME_ROLE;
runtimeParsed.password = runtimePassword;
const runtimeUrl = runtimeParsed.toString();
const admin = createPrisma(adminUrl);
let temporaryRoot;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(relativeScript, env = {}, options = {}) {
  const script = resolve(ROOT_DIR, relativeScript);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? 180_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function requireSuccess(result, label) {
  if (result.code !== 0) {
    throw new Error(`${label} failed (stdout/stderr intentionally omitted; inspect the disposable run locally)`);
  }
}

async function safetyProof() {
  await admin.$transaction(async (tx) => {
    await beginBoundedTransaction(tx, { readOnly: true });
    const [row] = await tx.$queryRawUnsafe(`
      SELECT current_database() AS database_name,
             current_user AS role_name,
             host(inet_server_addr()) AS server_addr,
             current_setting('server_version_num')::INTEGER AS server_version_num
    `);
    if (
      row.database_name !== databaseName ||
      row.role_name !== 'signal_schema_control_test_runner' ||
      ![null, '127.0.0.1', '::1'].includes(row.server_addr) ||
      Math.floor(row.server_version_num / 10000) !== 16
    ) {
      throw new Error('Refusing schema-control integration: local PostgreSQL 16 safety proof failed');
    }
  });
}

async function resetDatabase() {
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${CONTROL_SCHEMA} CASCADE`);
  await admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await admin.$executeRawUnsafe('CREATE SCHEMA public AUTHORIZATION CURRENT_USER');
  await admin.$executeRawUnsafe('GRANT ALL ON SCHEMA public TO CURRENT_USER');
  const [{ role_exists: roleExists }] = await admin.$queryRawUnsafe(`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') AS role_exists
  `);
  if (roleExists) {
    await admin.$executeRawUnsafe(`DROP OWNED BY ${RUNTIME_ROLE}`);
    await admin.$executeRawUnsafe(`DROP ROLE ${RUNTIME_ROLE}`);
  }
}

async function provisioningFootprint() {
  const [row] = await admin.$queryRawUnsafe(`
    SELECT
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') AS runtime_role_exists,
      to_regnamespace('${CONTROL_SCHEMA}')::TEXT AS control_schema,
      (SELECT COALESCE(nspacl::TEXT, '') FROM pg_namespace WHERE nspname = 'public') AS public_acl,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'role', defaclrole::TEXT,
          'namespace', defaclnamespace::TEXT,
          'type', defaclobjtype,
          'acl', COALESCE(defaclacl::TEXT, '')
        ) ORDER BY defaclrole, defaclnamespace, defaclobjtype)::TEXT
        FROM pg_default_acl
      ), '[]') AS default_acls
  `);
  return row;
}

const commonIdentity = {
  SIGNAL_SCHEMA_TARGET_ID: targetId,
  SIGNAL_SCHEMA_ENVIRONMENT: 'development',
  SIGNAL_CANDIDATE_PRIVACY_RUNTIME: 'web',
  ACTIVEGRAPH_URL: 'http://127.0.0.1:18000',
};
const bootstrapEnvironment = {
  DATABASE_URL: adminUrl,
  DIRECT_URL: adminUrl,
  SIGNAL_BOOTSTRAP_EMPTY_DATABASE: '1',
  SIGNAL_SCHEMA_ENVIRONMENT: 'development',
  SIGNAL_SCHEMA_DISPOSABLE_SINGLE_CREDENTIAL: '1',
};
const adoptionEnvironment = {
  ...commonIdentity,
  DIRECT_URL: adminUrl,
  SIGNAL_SCHEMA_ADOPT_EXISTING: '1',
};
const releaseEnvironment = {
  ...commonIdentity,
  DIRECT_URL: adminUrl,
  SIGNAL_MIGRATION_APPLY: '1',
};
const disposableOwnerReadiness = {
  ...commonIdentity,
  DATABASE_URL: adminUrl,
  SIGNAL_SCHEMA_DISPOSABLE_SINGLE_CREDENTIAL: '1',
};

async function appendTemporaryMigration(root, name, sql) {
  const directory = resolve(root, 'prisma/migrations', name);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'migration.sql'), sql);
  const lockPath = resolve(root, 'prisma/migrations.lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.migrations.push({
    name,
    sha256: createHash('sha256').update(sql).digest('hex'),
  });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

try {
  await safetyProof();
  await resetDatabase();

  const beforeWrongTargetProvision = await provisioningFootprint();
  const wrongTargetProvision = await runNode('scripts/schema-control/provision-runtime-role.mjs', {
    ...commonIdentity,
    DIRECT_URL: adminUrl,
    SIGNAL_RUNTIME_DATABASE_URL: runtimeUrl,
    SIGNAL_RUNTIME_ROLE_PASSWORD: runtimePassword,
  });
  assert(wrongTargetProvision.code !== 0, 'Non-Discover target provisioning unexpectedly succeeded');
  const afterWrongTargetProvision = await provisioningFootprint();
  assert(
    JSON.stringify(afterWrongTargetProvision) === JSON.stringify(beforeWrongTargetProvision),
    'Non-Discover target refusal left role, schema, ACL or default-privilege residue',
  );

  await requireSuccess(
    await runNode('scripts/bootstrap-empty-db.mjs', bootstrapEnvironment),
    'guarded empty bootstrap',
  );
  const beforeAdoption = await admin.$queryRawUnsafe(`
    SELECT COUNT(*)::INTEGER AS count FROM public.tenant_settings
  `);
  assert(beforeAdoption[0].count === 0, 'Disposable product table was not empty before adoption');

  await requireSuccess(
    await runNode('scripts/schema-control/provision-runtime-role.mjs', {
      ...commonIdentity,
      DIRECT_URL: adminUrl,
      SIGNAL_RUNTIME_DATABASE_URL: runtimeUrl,
      SIGNAL_RUNTIME_ROLE_PASSWORD: runtimePassword,
    }),
    'pre-adoption runtime-role provision',
  );

  await requireSuccess(
    await runNode('scripts/schema-control/adopt-existing.mjs', adoptionEnvironment),
    'metadata-only adoption',
  );
  const secondAdoption = await runNode('scripts/schema-control/adopt-existing.mjs', adoptionEnvironment);
  assert(secondAdoption.code !== 0, 'Second target-identity adoption unexpectedly succeeded');
  const afterAdoption = await admin.$queryRawUnsafe(`
    SELECT COUNT(*)::INTEGER AS count FROM public.tenant_settings
  `);
  assert(afterAdoption[0].count === 0, 'Adoption changed a product row');

  // Reproduce the production 21 -> 22 release boundary. Empty bootstrap has
  // already proven the full 22-migration fresh-install path; this disposable
  // rollback removes only the new empty privacy objects and their Prisma
  // ledger row so the real release wrapper must apply migration 22.
  await admin.$executeRawUnsafe('DROP TABLE public.candidate_privacy_projection');
  await admin.$executeRawUnsafe('DROP TABLE public.candidate_privacy_sync_state');
  await admin.$executeRawUnsafe(`
    DELETE FROM public."_prisma_migrations"
    WHERE migration_name = '20260823000000_add_candidate_privacy_projection'
  `);
  await requireSuccess(
    await runNode('scripts/schema-control/migrate-release.mjs', releaseEnvironment),
    '21-to-22 privacy release',
  );
  const [privacyUpgrade] = await admin.$queryRawUnsafe(`
    SELECT
      to_regclass('public.candidate_privacy_projection') IS NOT NULL AS projection_exists,
      to_regclass('public.candidate_privacy_sync_state') IS NOT NULL AS sync_exists,
      COUNT(*) FILTER (
        WHERE migration_name = '20260823000000_add_candidate_privacy_projection'
          AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL
      )::INTEGER AS successful_rows
    FROM public."_prisma_migrations"
  `);
  assert(
    privacyUpgrade.projection_exists &&
      privacyUpgrade.sync_exists &&
      privacyUpgrade.successful_rows === 1,
    'Release wrapper did not apply migration 22 exactly once',
  );

  await requireSuccess(
    await runNode('scripts/schema-control/migrate-release.mjs', releaseEnvironment),
    'release no-op',
  );
  const [beforeOwnerReadiness] = await admin.$queryRawUnsafe(`
    SELECT COUNT(*)::INTEGER AS attempts FROM ${CONTROL_SCHEMA}.release_attempts
  `);
  await requireSuccess(
    await runNode('scripts/schema-control/schema-ready.mjs', disposableOwnerReadiness),
    'owner-mode disposable readiness',
  );
  const [afterOwnerReadiness] = await admin.$queryRawUnsafe(`
    SELECT COUNT(*)::INTEGER AS attempts FROM ${CONTROL_SCHEMA}.release_attempts
  `);
  assert(
    afterOwnerReadiness.attempts === beforeOwnerReadiness.attempts,
    'Read-only startup created a release attempt',
  );

  const attemptsBeforeWrongTarget = await admin.$queryRawUnsafe(`
    SELECT COUNT(*)::INTEGER AS count FROM ${CONTROL_SCHEMA}.release_attempts
  `);
  const wrongTarget = await runNode('scripts/schema-control/migrate-release.mjs', {
    ...releaseEnvironment,
    SIGNAL_SCHEMA_TARGET_ID: '22222222-2222-4222-8222-222222222222',
  });
  assert(wrongTarget.code !== 0, 'Wrong-target release unexpectedly succeeded');
  const attemptsAfterWrongTarget = await admin.$queryRawUnsafe(`
    SELECT COUNT(*)::INTEGER AS count FROM ${CONTROL_SCHEMA}.release_attempts
  `);
  assert(
    attemptsAfterWrongTarget[0].count === attemptsBeforeWrongTarget[0].count,
    'Wrong-target refusal wrote a release attempt',
  );

  const runtime = createPrisma(runtimeUrl);
  try {
    await runtime.$executeRawUnsafe(`
      INSERT INTO public.tenant_settings (id, "tenantId", "updatedAt")
      VALUES ('schema-control-runtime-dml', 'schema-control-runtime-dml', clock_timestamp())
    `);
    await runtime.$executeRawUnsafe(`
      DELETE FROM public.tenant_settings WHERE id = 'schema-control-runtime-dml'
    `);
    let ddlDenied = false;
    try {
      await runtime.$executeRawUnsafe('CREATE TABLE public.schema_control_ddl_escape (id INTEGER)');
    } catch (error) {
      ddlDenied = String(error).includes('42501') || String(error).includes('permission denied');
    }
    if (!ddlDenied) {
      await admin.$executeRawUnsafe('DROP TABLE IF EXISTS public.schema_control_ddl_escape');
      throw new Error('Restricted runtime role was not denied DDL with SQLSTATE 42501');
    }
    let controlWriteDenied = false;
    try {
      await runtime.$executeRawUnsafe(`UPDATE ${CONTROL_SCHEMA}.target_identity SET environment = environment`);
    } catch (error) {
      controlWriteDenied = String(error).includes('42501') || String(error).includes('permission denied');
    }
    assert(controlWriteDenied, 'Restricted runtime role wrote schema-control metadata');
  } finally {
    await runtime.$disconnect();
  }
  await requireSuccess(
    await runNode('scripts/schema-control/schema-ready.mjs', {
      ...commonIdentity,
      DATABASE_URL: runtimeUrl,
    }),
    'restricted-runtime readiness',
  );

  temporaryRoot = await mkdtemp(join(tmpdir(), 'signal-schema-forward-'));
  await mkdir(resolve(temporaryRoot, 'prisma'), { recursive: true });
  await cp(resolve(ROOT_DIR, 'prisma/schema.prisma'), resolve(temporaryRoot, 'prisma/schema.prisma'));
  await cp(resolve(ROOT_DIR, 'prisma/migrations'), resolve(temporaryRoot, 'prisma/migrations'), { recursive: true });
  await cp(resolve(ROOT_DIR, 'prisma/migrations.lock.json'), resolve(temporaryRoot, 'prisma/migrations.lock.json'));
  const forwardName = '20990101000000_schema_control_forward_probe';
  await appendTemporaryMigration(
    temporaryRoot,
    forwardName,
    'ALTER TABLE public.tenant_settings ADD COLUMN schema_control_forward_probe TEXT;\n',
  );
  const concurrentEnvironment = {
    ...releaseEnvironment,
    SIGNAL_SCHEMA_CONTROL_TEST_ROOT: temporaryRoot,
    SIGNAL_SCHEMA_DISPOSABLE_SINGLE_CREDENTIAL: '1',
  };
  const concurrent = await Promise.all([
    runNode('scripts/schema-control/migrate-release.mjs', concurrentEnvironment),
    runNode('scripts/schema-control/migrate-release.mjs', concurrentEnvironment),
  ]);
  await requireSuccess(concurrent[0], 'concurrent release A');
  await requireSuccess(concurrent[1], 'concurrent release B');
  const [forwardState] = await admin.$queryRawUnsafe(`
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tenant_settings'
          AND column_name = 'schema_control_forward_probe'
      ) AS column_exists,
      COUNT(*) FILTER (
        WHERE migration_name = '${forwardName}' AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL
      )::INTEGER AS successful_rows
    FROM public."_prisma_migrations"
  `);
  assert(forwardState.column_exists, 'Concurrent release did not apply the forward migration');
  assert(forwardState.successful_rows === 1, 'Concurrent release applied the migration more than once');
  await requireSuccess(
    await runNode('scripts/schema-control/schema-ready.mjs', {
      ...commonIdentity,
      DATABASE_URL: runtimeUrl,
      SIGNAL_SCHEMA_CONTROL_TEST_ROOT: temporaryRoot,
      SIGNAL_SCHEMA_DISPOSABLE_SINGLE_CREDENTIAL: '1',
    }),
    'forward-root readiness',
  );

  const failedRoot = await mkdtemp(join(tmpdir(), 'signal-schema-failure-'));
  await mkdir(resolve(failedRoot, 'prisma'), { recursive: true });
  await cp(resolve(temporaryRoot, 'prisma'), resolve(failedRoot, 'prisma'), { recursive: true });
  const failedName = '20990102000000_schema_control_expected_failure';
  await appendTemporaryMigration(failedRoot, failedName, 'THIS IS NOT VALID POSTGRESQL;\n');
  const failedRelease = await runNode('scripts/schema-control/migrate-release.mjs', {
    ...releaseEnvironment,
    SIGNAL_SCHEMA_CONTROL_TEST_ROOT: failedRoot,
    SIGNAL_SCHEMA_DISPOSABLE_SINGLE_CREDENTIAL: '1',
  });
  assert(failedRelease.code !== 0, 'Invalid forward migration unexpectedly succeeded');
  const [failedAttempt] = await admin.$queryRawUnsafe(`
    SELECT outcome FROM ${CONTROL_SCHEMA}.release_attempts ORDER BY id DESC LIMIT 1
  `);
  assert(failedAttempt.outcome === 'failure', 'Failed release attempt was not retained');
  const dirtyReadiness = await runNode('scripts/schema-control/schema-ready.mjs', {
    ...commonIdentity,
    DATABASE_URL: runtimeUrl,
    SIGNAL_SCHEMA_CONTROL_TEST_ROOT: failedRoot,
    SIGNAL_SCHEMA_DISPOSABLE_SINGLE_CREDENTIAL: '1',
  });
  assert(dirtyReadiness.code !== 0, 'Readiness accepted a failed/dirty migration ledger');
  await rm(failedRoot, { recursive: true, force: true });

  console.log('[Schema control PostgreSQL] adoption, no-op, target, runtime, concurrency and failure proofs passed');
} finally {
  await admin.$disconnect();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}
