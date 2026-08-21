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

try {
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
