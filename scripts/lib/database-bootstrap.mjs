import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = resolve(here, '../..');
export const PRISMA_SCHEMA_PATH = resolve(ROOT_DIR, 'prisma/schema.prisma');
export const BASELINE_MANIFEST_PATH = resolve(
  ROOT_DIR,
  'prisma/baseline/manifest.json',
);

const prismaCliPath = require.resolve('prisma/build/index.js');
const MIGRATION_NAME_PATTERN = /^\d{14}_[a-z0-9_]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function datasourceEnvironment(url) {
  return {
    ...process.env,
    DATABASE_URL: url,
    DIRECT_URL: url,
  };
}

export function runPrisma(args, options = {}) {
  const {
    env = process.env,
    input,
    capture = false,
    timeoutMs,
    includeOutputOnError = true,
  } = options;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [prismaCliPath, ...args], {
      cwd: ROOT_DIR,
      env,
      stdio: capture || input !== undefined
        ? ['pipe', 'pipe', 'pipe']
        : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKill = null;
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      }, timeoutMs)
      : null;

    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk; });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (timedOut) {
        reject(new Error(`Prisma command exceeded its ${timeoutMs}ms deadline`));
        return;
      }
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const detail = includeOutputOnError
        ? [stdout, stderr].filter(Boolean).join('\n').trim()
        : '';
      reject(
        new Error(
          `Prisma command failed with exit code ${code}${detail ? `:\n${detail}` : ''}`,
        ),
      );
    });

    if (child.stdin) child.stdin.end(input);
  });
}

async function sha256File(path) {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

function resolveInsideRoot(relativePath) {
  const absolutePath = resolve(ROOT_DIR, relativePath);
  if (
    absolutePath !== ROOT_DIR &&
    !absolutePath.startsWith(`${ROOT_DIR}${sep}`)
  ) {
    throw new Error(`Baseline path escapes the repository: ${relativePath}`);
  }
  return absolutePath;
}

function assertManifestShape(manifest) {
  if (manifest?.version !== 1) throw new Error('Unsupported baseline manifest');
  if (!MIGRATION_NAME_PATTERN.test(manifest.baselineMigrationThrough ?? '')) {
    throw new Error('Invalid baseline migration cutoff');
  }
  if (!SHA256_PATTERN.test(manifest.baselineSha256 ?? '')) {
    throw new Error('Invalid baseline checksum');
  }
  if (!SHA256_PATTERN.test(manifest.baselineSchemaSha256 ?? '')) {
    throw new Error('Invalid baseline schema checksum');
  }
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
    throw new Error('Baseline manifest has no migrations');
  }
}

export async function validateBaselineManifest() {
  const manifest = JSON.parse(await readFile(BASELINE_MANIFEST_PATH, 'utf8'));
  assertManifestShape(manifest);

  const baselinePath = resolveInsideRoot(manifest.baselinePath);
  const baselineSchemaPath = resolveInsideRoot(manifest.baselineSchemaPath);
  if ((await sha256File(baselinePath)) !== manifest.baselineSha256) {
    throw new Error('Baseline SQL checksum mismatch');
  }
  if (
    (await sha256File(baselineSchemaPath)) !==
    manifest.baselineSchemaSha256
  ) {
    throw new Error('Baseline schema checksum mismatch');
  }

  const baselineSql = await readFile(baselinePath, 'utf8');
  if (!baselineSql.includes('\nBEGIN;\n') || !baselineSql.trimEnd().endsWith('COMMIT;')) {
    throw new Error('Baseline SQL must contain an explicit transaction');
  }

  const migrationsDirectory = resolve(ROOT_DIR, 'prisma/migrations');
  const migrationDirectories = (await readdir(migrationsDirectory, {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isDirectory() && MIGRATION_NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const expectedBaselineMigrations = migrationDirectories.filter(
    (name) => name <= manifest.baselineMigrationThrough,
  );
  const manifestNames = manifest.migrations.map((entry) => entry.name);

  if (
    JSON.stringify(manifestNames) !== JSON.stringify([...manifestNames].sort()) ||
    JSON.stringify(manifestNames) !== JSON.stringify(expectedBaselineMigrations)
  ) {
    throw new Error(
      'Baseline manifest must contain every migration through its cutoff exactly once',
    );
  }

  for (const migration of manifest.migrations) {
    if (
      !MIGRATION_NAME_PATTERN.test(migration.name ?? '') ||
      !SHA256_PATTERN.test(migration.sha256 ?? '')
    ) {
      throw new Error(`Invalid baseline migration entry: ${migration.name ?? 'unknown'}`);
    }
    const migrationPath = resolve(
      migrationsDirectory,
      migration.name,
      'migration.sql',
    );
    if ((await sha256File(migrationPath)) !== migration.sha256) {
      throw new Error(`Migration checksum mismatch: ${migration.name}`);
    }
  }

  return {
    manifest,
    baselinePath,
    baselineSchemaPath,
  };
}

export function assertReadOnlyAuditUrl(url, allowTestRole = false) {
  const parsed = new URL(url);
  const databaseName = parsed.pathname.replace(/^\//, '');
  const isTestDatabase = /(?:^|[_-])test(?:[_-]|$)/i.test(databaseName);
  if (parsed.username !== 'signal_debug_ro' && !(allowTestRole && isTestDatabase)) {
    throw new Error(
      'Schema drift checks require the signal_debug_ro database role',
    );
  }
}
