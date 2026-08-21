import { resolve } from 'node:path';
import { ROOT_DIR, datasourceEnvironment, runPrisma } from '../lib/database-bootstrap.mjs';
import { WRAPPER_LOCK_KEY, resolveControlRoot, resolveReleaseEnvironment, safeOperationalMessage,
  safeTargetFingerprint } from './constants.mjs';
import { assertCoreRelations, assertIdentity, beginBoundedTransaction, createPrisma,
  finishAttempt, readIdentity, readPrismaLedger, startAttempt } from './database.mjs';
import { assertPrismaLedger, loadMigrationLock } from './manifest.mjs';

const release = resolveReleaseEnvironment();
const controlRoot = resolveControlRoot(release, ROOT_DIR);
const migrations = await loadMigrationLock({ root: controlRoot });
const prisma = createPrisma(release.directUrl);
const fingerprint = safeTargetFingerprint(release.targetId);
let refused = null;

try {
  await prisma.$transaction(async (tx) => {
    await beginBoundedTransaction(tx, { statementMs: 60_000, lockMs: 10_000 });
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1)', WRAPPER_LOCK_KEY);
    assertIdentity(release, await readIdentity(tx));
    assertPrismaLedger(await readPrismaLedger(tx), migrations, { allowPending: true });
    await assertCoreRelations(tx);

    const attemptId = await startAttempt(tx, { fingerprint, kind: 'migration' });
    try {
      await runPrisma(
        ['migrate', 'deploy', '--schema', resolve(controlRoot, 'prisma/schema.prisma')],
        {
          env: datasourceEnvironment(release.directUrl),
          capture: true,
          timeoutMs: 540_000,
          includeOutputOnError: false,
        },
      );
      assertIdentity(release, await readIdentity(tx));
      assertPrismaLedger(await readPrismaLedger(tx), migrations);
      await assertCoreRelations(tx);
      await finishAttempt(tx, attemptId, 'success', 'applied=verified');
    } catch (error) {
      refused = safeOperationalMessage(error);
      await finishAttempt(tx, attemptId, 'failure', refused);
    }
  }, { maxWait: 10_000, timeout: 600_000 });

  if (refused !== null) throw new Error(refused);
  console.log(`[Schema release] OK (target=${fingerprint}; migrations=${migrations.length})`);
} catch (error) {
  console.error(`[Schema release] REFUSED: ${safeOperationalMessage(error)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
