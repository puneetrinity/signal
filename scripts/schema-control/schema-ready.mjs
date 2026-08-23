import { ROOT_DIR } from '../lib/database-bootstrap.mjs';
import { assertRuntimeEnvironment, isDisposableDevelopment, resolveControlRoot, safeOperationalMessage,
  safeTargetFingerprint } from './constants.mjs';
import { assertCoreRelations, assertIdentity, assertRuntimePrivileges, beginBoundedTransaction,
  createPrisma, readIdentity, readPrismaLedger, readReleaseHealth } from './database.mjs';
import { assertPrismaLedger, loadMigrationLock } from './manifest.mjs';

const runtime = assertRuntimeEnvironment();
const controlRoot = resolveControlRoot(runtime, ROOT_DIR);
const migrations = await loadMigrationLock({ root: controlRoot });
const prisma = createPrisma(runtime.runtimeUrl);
const fingerprint = safeTargetFingerprint(runtime.targetId);

function boundedPrivacyInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('Candidate privacy runtime configuration is invalid');
  }
}

function assertCandidatePrivacyRuntimeConfiguration() {
  const baseUrl = process.env.ACTIVEGRAPH_URL;
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('Candidate privacy runtime configuration is invalid');
  }
  boundedPrivacyInteger('SIGNAL_CANDIDATE_PRIVACY_HTTP_TIMEOUT_MS', 5_000, 1, 10_000);
  boundedPrivacyInteger('SIGNAL_CANDIDATE_PRIVACY_POLL_MS', 30_000, 5_000, 60_000);
  boundedPrivacyInteger('SIGNAL_CANDIDATE_PRIVACY_STALE_MS', 120_000, 60_000, 300_000);
  boundedPrivacyInteger('SIGNAL_CANDIDATE_PRIVACY_BATCH_SIZE', 200, 1, 200);
  boundedPrivacyInteger('SIGNAL_CANDIDATE_PRIVACY_FEED_PAGE_SIZE', 500, 1, 500);
}

try {
  assertCandidatePrivacyRuntimeConfiguration();
  await prisma.$transaction(async (tx) => {
    await beginBoundedTransaction(tx, { readOnly: true, statementMs: 10_000, lockMs: 2_000 });
    assertIdentity(runtime, await readIdentity(tx));
    assertPrismaLedger(await readPrismaLedger(tx), migrations);
    await readReleaseHealth(tx);
    await assertCoreRelations(tx);
    await assertRuntimePrivileges(tx, {
      allowOwner: isDisposableDevelopment(runtime, runtime.runtimeUrl),
    });
  }, { maxWait: 5_000, timeout: 15_000 });
  console.log(`[Schema ready] OK (target=${fingerprint}; migrations=${migrations.length})`);
} catch (error) {
  console.error(`[Schema ready] REFUSED: ${safeOperationalMessage(error)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
