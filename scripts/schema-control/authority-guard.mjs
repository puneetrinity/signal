import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { loadMigrationLock } from './manifest.mjs';

const EXPECTED_SCRIPTS = {
  start: 'node scripts/schema-control/schema-ready.mjs && next start',
  'worker:sourcing': 'node scripts/schema-control/schema-ready.mjs && tsx src/lib/sourcing/worker.ts',
  'db:migrate:release': 'node scripts/schema-control/migrate-release.mjs',
  'db:schema:adopt-existing': 'node scripts/schema-control/adopt-existing.mjs',
  'db:schema:provision-runtime-role': 'node scripts/schema-control/provision-runtime-role.mjs',
  'db:bootstrap-empty': 'node scripts/bootstrap-empty-db.mjs',
};

const EXPECTED_SURFACES = [
  { id: 'web-runtime', source: 'package.json#scripts.start', authority: 'read-only-startup' },
  { id: 'sourcing-worker-runtime', source: 'package.json#scripts.worker:sourcing', authority: 'read-only-startup' },
  { id: 'release-job', source: 'package.json#scripts.db:migrate:release', authority: 'migration-release-only' },
  { id: 'release-descriptor', source: 'railway.schema-release.json', authority: 'manual-one-shot' },
  { id: 'existing-target-adoption', source: 'package.json#scripts.db:schema:adopt-existing', authority: 'control-metadata-only' },
  { id: 'runtime-role-provision', source: 'package.json#scripts.db:schema:provision-runtime-role', authority: 'credential-control-only' },
  { id: 'empty-database-bootstrap', source: 'package.json#scripts.db:bootstrap-empty', authority: 'disposable-fresh-only' },
  { id: 'railway-runtime-config', source: 'railway.toml', authority: 'no-schema-authority' },
  { id: 'ci', source: '.github/workflows/ci.yml', authority: 'disposable-proof-only' },
  { id: 'scheduled-drift', source: '.github/workflows/schema-drift.yml', authority: 'read-only-audit' },
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function executableFiles(root, directory) {
  const start = resolve(root, directory);
  if (!(await exists(start))) return [];
  const files = [];
  for (const entry of await readdir(start, { withFileTypes: true })) {
    const path = join(start, entry.name);
    if (entry.isDirectory()) {
      files.push(...await executableFiles(root, relative(root, path)));
    } else if (['.js', '.mjs', '.sh', '.ts', '.yml', '.yaml'].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

async function verifyBaselineArtifacts(root, offenders) {
  const manifestPath = resolve(root, 'prisma/baseline/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const [pathKey, hashKey] of [
    ['baselinePath', 'baselineSha256'],
    ['baselineSchemaPath', 'baselineSchemaSha256'],
  ]) {
    const path = resolve(root, manifest[pathKey]);
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');
    if (hash !== manifest[hashKey]) offenders.push(`${manifest[pathKey]} checksum changed`);
  }
}

export async function evaluateSchemaControl(root) {
  const offenders = [];
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  for (const [name, expected] of Object.entries(EXPECTED_SCRIPTS)) {
    if (packageJson.scripts?.[name] !== expected) {
      offenders.push(`package.json#scripts.${name} is not the declared schema-control command`);
    }
  }

  const callerManifest = JSON.parse(await readFile(
    resolve(root, 'scripts/schema-control/caller-manifest.json'),
    'utf8',
  ));
  if (
    callerManifest?.formatVersion !== 1 ||
    callerManifest?.system !== 'discover' ||
    JSON.stringify(callerManifest?.surfaces) !== JSON.stringify(EXPECTED_SURFACES)
  ) {
    offenders.push('schema-control caller manifest is missing, reordered, or unsupported');
  }

  const descriptor = JSON.parse(await readFile(resolve(root, 'railway.schema-release.json'), 'utf8'));
  if (
    descriptor?.deploy?.startCommand !== 'npm run db:migrate:release' ||
    descriptor?.deploy?.restartPolicyType !== 'NEVER' ||
    'healthcheckPath' in (descriptor?.deploy ?? {}) ||
    'cronSchedule' in (descriptor?.deploy ?? {})
  ) {
    offenders.push('railway.schema-release.json is not a manual one-shot release descriptor');
  }

  for (const legacy of ['scripts/fix-tenant-migration.ts', 'scripts/fix-tenant-migration.sql']) {
    if (await exists(resolve(root, legacy))) offenders.push(`${legacy} remains executable`);
  }
  const constantsSource = await readFile(
    resolve(root, 'scripts/schema-control/constants.mjs'),
    'utf8',
  );
  if (/DIRECT_URL\s*(?:\|\||\?\?)/.test(constantsSource)) {
    offenders.push('production schema-control credential resolution falls back from DIRECT_URL');
  }

  try {
    await loadMigrationLock({ root });
  } catch (error) {
    offenders.push(`migration checksum lock rejected: ${error.message}`);
  }
  await verifyBaselineArtifacts(root, offenders);

  const rootEntries = await readdir(root, { withFileTypes: true });
  const rootAuthorityFiles = rootEntries
    .filter((entry) => entry.isFile() && (
      /^Dockerfile/i.test(entry.name) ||
      /^railway.*\.(?:json|toml)$/i.test(entry.name)
    ))
    .map((entry) => resolve(root, entry.name));
  const active = [
    resolve(root, 'package.json'),
    ...rootAuthorityFiles,
    ...await executableFiles(root, '.github/workflows'),
    ...await executableFiles(root, 'scripts'),
  ];
  for (const path of active) {
    const rel = relative(root, path);
    if (
      rel === 'scripts/schema-control/authority-guard.mjs' ||
      rel === 'scripts/schema-control/test-schema-control-unit.mjs' ||
      rel === 'scripts/check-no-db-push.mjs'
    ) {
      continue;
    }
    const contents = await readFile(path, 'utf8');
    if (/\bprisma\s+migrate\s+deploy\b/i.test(contents)) {
      offenders.push(`${rel} contains an undeclared direct prisma migrate deploy path`);
    }
    if (/\bprisma\s+db\s+push\b/i.test(contents)) {
      offenders.push(`${rel} contains forbidden prisma db push authority`);
    }
    if (/fix-tenant-migration\.(?:ts|sql)/i.test(contents)) {
      offenders.push(`${rel} references a retired tenant-repair authority`);
    }
  }

  return [...new Set(offenders)].sort();
}
