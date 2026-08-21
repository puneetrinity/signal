import { CONTROL_SCHEMA, RUNTIME_ROLE, quoteIdentifier, quoteLiteral, requireValue, resolveIdentityEnvironment,
  safeOperationalMessage } from './constants.mjs';
import { assertIdentity, assertRuntimePrivileges, beginBoundedTransaction, createPrisma,
  readIdentity } from './database.mjs';

const identity = resolveIdentityEnvironment();
const directUrl = requireValue(process.env, 'DIRECT_URL');
const runtimeUrl = requireValue(process.env, 'SIGNAL_RUNTIME_DATABASE_URL');
const runtimePassword = requireValue(process.env, 'SIGNAL_RUNTIME_ROLE_PASSWORD');
const parsedRuntime = new URL(runtimeUrl);
if (decodeURIComponent(parsedRuntime.username) !== RUNTIME_ROLE) {
  throw new Error(`SIGNAL_RUNTIME_DATABASE_URL must authenticate as ${RUNTIME_ROLE}`);
}

const owner = createPrisma(directUrl);
let expectedDatabaseOid;
let expectedDatabaseName;
try {
  await owner.$transaction(async (tx) => {
    await beginBoundedTransaction(tx, { statementMs: 30_000, lockMs: 5_000 });
    const existingIdentity = await readIdentity(tx);
    if (existingIdentity !== null) assertIdentity(identity, existingIdentity);

    const [{ database_oid: databaseOid, database_name: databaseName }] = await tx.$queryRawUnsafe(`
      SELECT oid::TEXT AS database_oid, datname AS database_name
      FROM pg_database WHERE datname = current_database()
    `);
    await tx.$executeRawUnsafe(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
          CREATE ROLE ${RUNTIME_ROLE} LOGIN;
        END IF;
      END
      $role$
    `);
    await tx.$executeRawUnsafe(`ALTER ROLE ${RUNTIME_ROLE} PASSWORD ${quoteLiteral(runtimePassword)}`);
    await tx.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await tx.$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM ${RUNTIME_ROLE}`);
    await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
    await tx.$executeRawUnsafe(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${RUNTIME_ROLE}`);
    await tx.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE}`);
    await tx.$executeRawUnsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`);
    await tx.$executeRawUnsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${RUNTIME_ROLE}`);
    await tx.$executeRawUnsafe(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public."_prisma_migrations" FROM ${RUNTIME_ROLE}`);
    await tx.$executeRawUnsafe(`GRANT SELECT ON TABLE public."_prisma_migrations" TO ${RUNTIME_ROLE}`);
    await tx.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_ROLE}`);
    await tx.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${RUNTIME_ROLE}`);
    await tx.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${RUNTIME_ROLE}`);

    if (existingIdentity !== null) {
      await tx.$executeRawUnsafe(`REVOKE ALL ON SCHEMA ${CONTROL_SCHEMA} FROM ${RUNTIME_ROLE}`);
      await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA ${CONTROL_SCHEMA} TO ${RUNTIME_ROLE}`);
      await tx.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA ${CONTROL_SCHEMA} TO ${RUNTIME_ROLE}`);
      await tx.$executeRawUnsafe(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA ${CONTROL_SCHEMA} FROM ${RUNTIME_ROLE}`);
      await tx.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${CONTROL_SCHEMA} TO ${RUNTIME_ROLE}`);
    }
    expectedDatabaseOid = databaseOid;
    expectedDatabaseName = databaseName;
  }, { maxWait: 10_000, timeout: 120_000 });

  const runtime = createPrisma(runtimeUrl);
  try {
    await runtime.$transaction(async (tx) => {
      await beginBoundedTransaction(tx, { readOnly: true, statementMs: 10_000, lockMs: 2_000 });
      const [{ database_oid: runtimeOid, database_name: runtimeName }] = await tx.$queryRawUnsafe(`
        SELECT oid::TEXT AS database_oid, datname AS database_name
        FROM pg_database WHERE datname = current_database()
      `);
      if (
        runtimeOid !== expectedDatabaseOid ||
        runtimeName !== expectedDatabaseName
      ) {
        throw new Error('Migration and runtime credentials do not resolve to the same database');
      }
      const currentIdentity = await readIdentity(tx);
      if (currentIdentity !== null) {
        assertIdentity(identity, currentIdentity);
        await assertRuntimePrivileges(tx);
      }
    }, { maxWait: 5_000, timeout: 15_000 });
  } finally {
    await runtime.$disconnect();
  }
  console.log('[Schema control] Restricted Discover runtime role provisioned');
} catch (error) {
  console.error(`[Schema control] Runtime-role provisioning refused: ${safeOperationalMessage(error)}`);
  process.exitCode = 1;
} finally {
  await owner.$disconnect();
}
