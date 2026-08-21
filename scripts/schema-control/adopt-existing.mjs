import { createPrisma, CONTROL_DDL_STATEMENTS, assertCoreRelations, assertIdentity,
  assertNoProductRowMutation, beginBoundedTransaction, finishAttempt, readIdentity,
  readPrismaLedger, startAttempt } from './database.mjs';
import { ADOPTION_LOCK_KEY, CONTROL_SCHEMA, RUNTIME_ROLE, resolveAdoptionEnvironment,
  safeOperationalMessage, safeTargetFingerprint } from './constants.mjs';
import { assertPrismaLedger, loadMigrationLock } from './manifest.mjs';

const credentials = resolveAdoptionEnvironment();
const migrations = await loadMigrationLock();
const fingerprint = safeTargetFingerprint(credentials.targetId);
const prisma = createPrisma(credentials.directUrl);

try {
  await prisma.$transaction(async (tx) => {
    await beginBoundedTransaction(tx, { statementMs: 30_000, lockMs: 10_000 });
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1)', ADOPTION_LOCK_KEY);

    const [{ control_schema: controlSchema }] = await tx.$queryRawUnsafe(`
      SELECT to_regnamespace('${CONTROL_SCHEMA}')::TEXT AS control_schema
    `);
    if (controlSchema !== null) {
      throw new Error('Discover target adoption refuses pre-existing or partial control-plane state');
    }

    const ledger = await readPrismaLedger(tx);
    assertPrismaLedger(ledger, migrations);
    await assertCoreRelations(tx);

    for (const statement of CONTROL_DDL_STATEMENTS) {
      await tx.$executeRawUnsafe(statement);
    }
    await tx.$executeRawUnsafe(`
      INSERT INTO ${CONTROL_SCHEMA}.target_identity
        (singleton, system, environment, target_id)
      VALUES (1, 'discover', $1, $2::UUID)
    `, credentials.environment, credentials.targetId);

    const [{ runtime_role_exists: runtimeRoleExists }] = await tx.$queryRawUnsafe(`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') AS runtime_role_exists
    `);
    if (credentials.environment === 'production' && !runtimeRoleExists) {
      throw new Error('Restricted signal_runtime role must be provisioned before production adoption');
    }
    if (runtimeRoleExists) {
      await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA ${CONTROL_SCHEMA} TO ${RUNTIME_ROLE}`);
      await tx.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA ${CONTROL_SCHEMA} TO ${RUNTIME_ROLE}`);
      await tx.$executeRawUnsafe(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA ${CONTROL_SCHEMA} FROM ${RUNTIME_ROLE}`);
      await tx.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${CONTROL_SCHEMA} TO ${RUNTIME_ROLE}`);
    }

    const attemptId = await startAttempt(tx, { fingerprint, kind: 'adoption' });
    await finishAttempt(tx, attemptId, 'success', `identity=adopted migrations=${migrations.length}`);
    assertIdentity(credentials, await readIdentity(tx));
    assertPrismaLedger(await readPrismaLedger(tx), migrations);
    await assertCoreRelations(tx);
    await assertNoProductRowMutation(tx);
  }, { maxWait: 10_000, timeout: 120_000 });
  console.log(`[Schema control] Discover target adopted (${fingerprint}; migrations=${migrations.length})`);
} catch (error) {
  console.error(`[Schema control] Adoption refused: ${safeOperationalMessage(error)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
