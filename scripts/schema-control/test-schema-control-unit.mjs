import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT_DIR } from '../lib/database-bootstrap.mjs';
import { assertRuntimeEnvironment, resolveReleaseEnvironment,
  safeOperationalMessage } from './constants.mjs';
import { evaluateSchemaControl } from './authority-guard.mjs';
import { assertPrismaLedger, loadMigrationLock } from './manifest.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const migrations = await loadMigrationLock();
assert(migrations.length === 22, `Expected 22 locked migrations, found ${migrations.length}`);
const validRows = migrations.map((entry, index) => ({
  migration_name: entry.name,
  checksum: entry.sha256,
  started_at: new Date(index * 1000),
  finished_at: new Date(index * 1000 + 1),
  rolled_back_at: null,
  applied_steps_count: index === 0 ? 0 : 1,
}));
assertPrismaLedger(validRows, migrations);
assertPrismaLedger(validRows.slice(0, -1), migrations, { allowPending: true });
for (const mutation of [
  () => [{ ...validRows[0], checksum: '0'.repeat(64) }, ...validRows.slice(1)],
  () => validRows.slice(0, -1),
  () => [{ ...validRows[0], finished_at: null }, ...validRows.slice(1)],
  () => [{ ...validRows[0], rolled_back_at: new Date(), checksum: '0'.repeat(64) }, ...validRows.slice(1)],
  () => [...validRows, { ...validRows[0] }],
]) {
  let rejected = false;
  try {
    assertPrismaLedger(mutation(), migrations);
  } catch {
    rejected = true;
  }
  assert(rejected, 'Ledger mutation unexpectedly passed');
}
assertPrismaLedger([
  { ...validRows[0], finished_at: null, rolled_back_at: new Date() },
  ...validRows,
], migrations);
const sanitized = safeOperationalMessage(
  new Error('postgresql://admin:secret@db.invalid/app password=hunter2 PASSWORD \'role-secret\' Datasource "db": PostgreSQL at "db.internal:5432" id=123e4567-e89b-42d3-a456-426614174000'),
);
assert(!sanitized.includes('secret'), 'DSN password leaked from safe message');
assert(!sanitized.includes('hunter2'), 'password field leaked from safe message');
assert(!sanitized.includes('role-secret'), 'SQL password literal leaked from safe message');
assert(!sanitized.includes('db.internal'), 'database hostname leaked from safe message');
assert(!sanitized.includes('123e4567'), 'target id leaked from safe message');

const identityEnvironment = {
  SIGNAL_SCHEMA_ENVIRONMENT: 'production',
  SIGNAL_SCHEMA_TARGET_ID: '123e4567-e89b-42d3-a456-426614174000',
};
assertRuntimeEnvironment({
  ...identityEnvironment,
  DATABASE_URL: 'postgresql://signal_runtime:runtime@localhost/discover',
});
for (const forbidden of [
  'DIRECT_URL',
  'SIGNAL_MIGRATION_APPLY',
  'SIGNAL_SCHEMA_ADOPT_EXISTING',
  'SIGNAL_RUNTIME_ROLE_PASSWORD',
  'SIGNAL_RUNTIME_DATABASE_URL',
  'SIGNAL_SCHEMA_CONTROL_TEST_ROOT',
]) {
  let rejected = false;
  try {
    assertRuntimeEnvironment({
      ...identityEnvironment,
      DATABASE_URL: 'postgresql://signal_runtime:runtime@localhost/discover',
      [forbidden]: 'forbidden',
    });
  } catch {
    rejected = true;
  }
  assert(rejected, `Production runtime unexpectedly accepted ${forbidden}`);
}
let releaseFallbackRejected = false;
try {
  resolveReleaseEnvironment({
    ...identityEnvironment,
    DATABASE_URL: 'postgresql://owner:owner@localhost/discover',
    SIGNAL_MIGRATION_APPLY: '1',
  });
} catch {
  releaseFallbackRejected = true;
}
assert(releaseFallbackRejected, 'Release path unexpectedly fell back from DIRECT_URL');

const baselineOffenders = await evaluateSchemaControl(ROOT_DIR);
assert(baselineOffenders.length === 0, `Baseline guard rejected:\n${baselineOffenders.join('\n')}`);

const temporaryRoot = await mkdtemp(join(tmpdir(), 'signal-schema-guard-'));
const copyRoot = join(temporaryRoot, 'repo');
try {
  await cp(ROOT_DIR, copyRoot, {
    recursive: true,
    filter: (source) => !/(?:^|\/)(?:\.git|node_modules|\.next)(?:\/|$)/.test(source),
  });
  const packagePath = resolve(copyRoot, 'package.json');
  const originalPackage = await readFile(packagePath, 'utf8');
  const legacyPath = resolve(copyRoot, 'scripts/fix-tenant-migration.ts');
  const migrationPath = resolve(copyRoot, 'prisma/migrations', migrations[0].name, 'migration.sql');
  const originalMigration = await readFile(migrationPath);
  const descriptorPath = resolve(copyRoot, 'railway.schema-release.json');
  const originalDescriptor = await readFile(descriptorPath, 'utf8');
  const constantsPath = resolve(copyRoot, 'scripts/schema-control/constants.mjs');
  const originalConstants = await readFile(constantsPath, 'utf8');

  const mutations = [
    async () => {
      const pkg = JSON.parse(originalPackage);
      pkg.scripts.start = 'npx prisma migrate deploy && next start';
      await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
      return async () => writeFile(packagePath, originalPackage);
    },
    async () => {
      await writeFile(legacyPath, 'throw new Error("legacy");\n');
      return async () => rm(legacyPath, { force: true });
    },
    async () => {
      const pkg = JSON.parse(originalPackage);
      pkg.scripts['db:push'] = 'prisma db push';
      await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
      return async () => writeFile(packagePath, originalPackage);
    },
    async () => {
      await writeFile(migrationPath, Buffer.concat([originalMigration, Buffer.from('\n-- changed\n')]));
      return async () => writeFile(migrationPath, originalMigration);
    },
    async () => {
      const descriptor = JSON.parse(originalDescriptor);
      descriptor.deploy.restartPolicyType = 'ON_FAILURE';
      await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
      return async () => writeFile(descriptorPath, originalDescriptor);
    },
    async () => {
      const descriptor = JSON.parse(originalDescriptor);
      descriptor.build.buildCommand = 'npm ci --include=dev --no-audit --no-fund';
      await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
      return async () => writeFile(descriptorPath, originalDescriptor);
    },
    async () => {
      const dockerfile = resolve(copyRoot, 'Dockerfile.schema-escape');
      await writeFile(dockerfile, 'CMD npx prisma migrate deploy\n');
      return async () => rm(dockerfile, { force: true });
    },
    async () => {
      await writeFile(
        constantsPath,
        originalConstants.replace(
          "const directUrl = requireValue(env, 'DIRECT_URL');",
          "const directUrl = env.DIRECT_URL || env.DATABASE_URL;",
        ),
      );
      return async () => writeFile(constantsPath, originalConstants);
    },
  ];

  for (const mutate of mutations) {
    const restore = await mutate();
    const offenders = await evaluateSchemaControl(copyRoot);
    await restore();
    assert(offenders.length > 0, 'Schema-control guard lost a negative mutation');
    const restored = await evaluateSchemaControl(copyRoot);
    assert(restored.length === 0, `Guard did not recover after mutation:\n${restored.join('\n')}`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log('[Schema control unit] Manifest, ledger, redaction, caller census and guard mutations passed');
