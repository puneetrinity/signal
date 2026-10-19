// Disposable local PostgreSQL only. Run the assertions in a genuine tsx process,
// not Vitest's module loader. No production credentials or provider access.
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

assert.equal(process.versions.node.split('.')[0], '20', 'production Node 20 required');
const raw = process.env.SIGNAL_MODULE_TEST_ADMIN_URL;
assert.ok(raw, 'local disposable admin URL required');
const url = new URL(raw);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
assert.ok(/\/(postgres|[^/]*test[^/]*)$/.test(url.pathname));
const suffix = randomBytes(6).toString('hex');
const database = `module_test_${suffix}`, runtime = `module_runtime_${suffix}`;
const admin = new Client({ connectionString: raw });
let owner, created = false, roleCreated = false;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`); created = true;
  url.pathname = `/${database}`;
  owner = new Client({ connectionString: url.toString() }); await owner.connect();
  const manifest = JSON.parse(await readFile('prisma/baseline/manifest.json', 'utf8'));
  await owner.query(await readFile(manifest.baselinePath, 'utf8'));
  for (const migration of (await readdir('prisma/migrations')).filter(n => /^\d{14}_/.test(n) && n > manifest.baselineMigrationThrough).sort()) {
    await owner.query('BEGIN');
    try { await owner.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8')); await owner.query('COMMIT'); }
    catch (error) { await owner.query('ROLLBACK'); throw error; }
  }
  await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'local-test-only'`); roleCreated = true;
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
  await owner.query(`GRANT SELECT ON candidate_privacy_sync_state TO ${runtime}`);
  await owner.query(`GRANT EXECUTE ON FUNCTION signal_memory_ingest(jsonb,jsonb) TO ${runtime}`);
  const runtimeUrl = new URL(url); runtimeUrl.username = runtime; runtimeUrl.password = 'local-test-only';
  // Do not inherit provider credentials, Redis settings, or privacy test adapters.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', LOG_LEVEL: 'silent',
    DATABASE_URL: runtimeUrl.toString(), MODULE_TEST_OWNER_URL: url.toString() };
  for (const entry of ['sourcing', 'maintenance']) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/worker-module-loading-regression.ts'],
        { env: { ...env, MODULE_TEST_ENTRY: entry }, stdio: 'inherit' });
      child.once('error', reject); child.once('exit', (code, signal) => resolve(signal ? 1 : code));
    });
    assert.equal(code, 0, `${entry}: production-loader regression failed`);
  }
} finally {
  await owner?.end();
  if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE ${runtime}`);
  await admin.end();
}
