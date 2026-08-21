import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT_DIR } from '../lib/database-bootstrap.mjs';
import { SYSTEM } from './constants.mjs';

const MIGRATION_NAME_PATTERN = /^\d{14}_[a-z0-9_]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export async function loadMigrationLock(options = {}) {
  const root = options.root ?? ROOT_DIR;
  const lockPath = options.lockPath ?? resolve(root, 'prisma/migrations.lock.json');
  const migrationsPath = options.migrationsPath ?? resolve(root, 'prisma/migrations');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));

  if (
    lock?.formatVersion !== 1 ||
    lock.system !== SYSTEM ||
    !Array.isArray(lock.migrations) ||
    lock.migrations.length === 0
  ) {
    throw new Error('Unsupported or empty Discover migration checksum lock');
  }

  const directories = (await readdir(migrationsPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const lockedNames = lock.migrations.map((entry) => entry?.name);
  if (JSON.stringify(directories) !== JSON.stringify(lockedNames)) {
    throw new Error('Migration directories do not exactly match the ordered checksum lock');
  }

  let previous = '';
  const seen = new Set();
  for (const entry of lock.migrations) {
    if (
      !MIGRATION_NAME_PATTERN.test(entry?.name ?? '') ||
      !SHA256_PATTERN.test(entry?.sha256 ?? '') ||
      entry.name <= previous ||
      seen.has(entry.name)
    ) {
      throw new Error(`Invalid or out-of-order migration lock entry: ${entry?.name ?? 'unknown'}`);
    }
    const bytes = await readFile(resolve(migrationsPath, entry.name, 'migration.sql'));
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`Migration checksum mismatch: ${entry.name}`);
    }
    previous = entry.name;
    seen.add(entry.name);
  }

  return lock.migrations.map((entry) => ({ ...entry }));
}

export function assertPrismaLedger(rows, migrations, options = {}) {
  const allowPending = options.allowPending === true;
  const successful = new Map();
  const expectedByName = new Map(migrations.map((entry) => [entry.name, entry]));
  const activeRows = [];

  for (const row of rows) {
    if (row.rolled_back_at !== null) {
      const expected = expectedByName.get(row.migration_name);
      if (!expected || row.checksum !== expected.sha256) {
        throw new Error(`Unknown or checksum-mismatched rolled-back migration: ${row.migration_name}`);
      }
      continue;
    }
    // `prisma migrate resolve --applied` legitimately records zero applied
    // steps for the guarded baseline while still setting finished_at. Prisma's
    // successful terminal marker is finished_at with no rolled_back_at; a
    // positive step count is not a universal success invariant.
    if (row.finished_at === null || Number(row.applied_steps_count) < 0) {
      throw new Error(`Unfinished Prisma migration: ${row.migration_name}`);
    }
    if (successful.has(row.migration_name)) {
      throw new Error(`Duplicate successful Prisma migration: ${row.migration_name}`);
    }
    successful.set(row.migration_name, row);
    activeRows.push(row);
  }

  if (activeRows.length > migrations.length) {
    throw new Error('Database contains migration history not present in the checksum lock');
  }
  for (let index = 0; index < activeRows.length; index += 1) {
    const expected = migrations[index];
    const row = activeRows[index];
    if (row.migration_name !== expected.name || row.checksum !== expected.sha256) {
      throw new Error(`Prisma migration ledger mismatch at position ${index + 1}`);
    }
  }
  if (!allowPending && activeRows.length !== migrations.length) {
    throw new Error(`Expected ${migrations.length} applied migrations, found ${activeRows.length}`);
  }
  return { applied: activeRows.length, pending: migrations.length - activeRows.length };
}
