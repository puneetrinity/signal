import { PrismaClient } from '@prisma/client';
import { CONTROL_SCHEMA, RUNTIME_ROLE, SYSTEM } from './constants.mjs';

export const CORE_RELATIONS = [
  'candidates',
  'identity_candidates',
  'search_cache_v2',
  'job_sourcing_requests',
  'job_sourcing_candidates',
  'crustdata_acquisition_receipts',
  'public_memory_ingest_outbox',
  'candidate_privacy_projection',
  'candidate_privacy_sync_state',
];

export const CONTROL_DDL_STATEMENTS = [
  `CREATE SCHEMA ${CONTROL_SCHEMA}`,
  `REVOKE ALL ON SCHEMA ${CONTROL_SCHEMA} FROM PUBLIC`,
  `CREATE TABLE ${CONTROL_SCHEMA}.target_identity (
     singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
     system TEXT NOT NULL CHECK (system = 'discover'),
     environment TEXT NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
     target_id UUID NOT NULL,
     adopted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
   )`,
  `CREATE TABLE ${CONTROL_SCHEMA}.release_attempts (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     target_fingerprint TEXT NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{16}$'),
     kind TEXT NOT NULL CHECK (kind IN ('adoption', 'migration')),
     started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
     finished_at TIMESTAMPTZ,
     outcome TEXT NOT NULL CHECK (outcome IN ('running', 'success', 'failure')),
     detail TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 500),
     CHECK (
       (outcome = 'running' AND finished_at IS NULL) OR
       (outcome IN ('success', 'failure') AND finished_at IS NOT NULL)
     )
   )`,
  `REVOKE ALL ON ALL TABLES IN SCHEMA ${CONTROL_SCHEMA} FROM PUBLIC`,
  `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${CONTROL_SCHEMA} FROM PUBLIC`,
];

export function createPrisma(databaseUrl) {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

export async function beginBoundedTransaction(tx, options = {}) {
  if (options.readOnly) {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  }
  const statementMs = Math.max(1, Math.floor(options.statementMs ?? 10_000));
  const lockMs = Math.max(1, Math.floor(options.lockMs ?? 2_000));
  await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${statementMs}ms'`);
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockMs}ms'`);
}

export async function readIdentity(tx) {
  const [{ schema_exists: schemaExists }] = await tx.$queryRawUnsafe(`
    SELECT to_regnamespace('${CONTROL_SCHEMA}') IS NOT NULL AS schema_exists
  `);
  if (!schemaExists) return null;
  const rows = await tx.$queryRawUnsafe(`
    SELECT system, environment, target_id::TEXT AS target_id, adopted_at
    FROM ${CONTROL_SCHEMA}.target_identity
    ORDER BY singleton
  `);
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one ${CONTROL_SCHEMA} target identity, found ${rows.length}`);
  }
  return rows[0];
}

export function assertIdentity(expected, actual) {
  if (
    actual === null ||
    actual.system !== SYSTEM ||
    actual.environment !== expected.environment ||
    actual.target_id?.toLowerCase() !== expected.targetId.toLowerCase()
  ) {
    throw new Error('Discover schema-control target identity mismatch');
  }
}

export async function readPrismaLedger(tx) {
  const [{ ledger_exists: ledgerExists }] = await tx.$queryRawUnsafe(`
    SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS ledger_exists
  `);
  if (!ledgerExists) return [];
  return tx.$queryRawUnsafe(`
    SELECT migration_name, checksum, started_at, finished_at, rolled_back_at,
           applied_steps_count
    FROM public."_prisma_migrations"
    ORDER BY migration_name, started_at, id
  `);
}

export async function assertCoreRelations(tx, options = {}) {
  const requiredRelations = options.requireCandidatePrivacy === false
    ? CORE_RELATIONS.filter((relation) => !relation.startsWith('candidate_privacy_'))
    : CORE_RELATIONS;
  const rows = await tx.$queryRawUnsafe(`
    SELECT relation_name,
           to_regclass('public.' || quote_ident(relation_name)) IS NOT NULL AS present
    FROM unnest($1::TEXT[]) AS relation_name
    ORDER BY relation_name
  `, requiredRelations);
  const missing = rows.filter((row) => !row.present).map((row) => row.relation_name);
  if (missing.length > 0) {
    throw new Error(`Discover database is missing critical relations: ${missing.join(', ')}`);
  }
  if (options.requireCandidatePrivacy === false) return;
  const privacyObjects = await tx.$queryRawUnsafe(`
    WITH required(kind, name) AS (
      VALUES
        ('constraint', 'candidate_privacy_sync_state_pkey'),
        ('constraint', 'candidate_privacy_sync_state_consumer_check'),
        ('constraint', 'candidate_privacy_sync_state_cursor_check'),
        ('constraint', 'candidate_privacy_sync_state_generation_check'),
        ('constraint', 'candidate_privacy_sync_state_status_check'),
        ('constraint', 'candidate_privacy_sync_state_error_code_check'),
        ('constraint', 'candidate_privacy_sync_state_counts_check'),
        ('constraint', 'candidate_privacy_projection_pkey'),
        ('constraint', 'candidate_privacy_projection_generation_check'),
        ('constraint', 'candidate_privacy_projection_cursor_check'),
        ('constraint', 'candidate_privacy_projection_decision_check'),
        ('constraint', 'candidate_privacy_projection_tenant_id_candidate_id_fkey'),
        ('index', 'candidate_privacy_projection_active_idx'),
        ('index', 'candidate_privacy_projection_generation_idx')
    )
    SELECT required.kind, required.name,
           CASE required.kind
             WHEN 'constraint' THEN EXISTS (
               SELECT 1
               FROM pg_constraint c
               JOIN pg_namespace n ON n.oid = c.connamespace
               WHERE n.nspname = 'public' AND c.conname = required.name
             )
             ELSE to_regclass('public.' || quote_ident(required.name)) IS NOT NULL
           END AS present
    FROM required
    ORDER BY required.kind, required.name
  `);
  const missingPrivacyObjects = privacyObjects
    .filter((row) => !row.present)
    .map((row) => `${row.kind}:${row.name}`);
  if (missingPrivacyObjects.length > 0) {
    throw new Error(
      `Discover database is missing candidate privacy objects: ${missingPrivacyObjects.join(', ')}`,
    );
  }
}

export async function readReleaseHealth(tx) {
  const [{ unfinished }] = await tx.$queryRawUnsafe(`
    SELECT COUNT(*)::INTEGER AS unfinished
    FROM ${CONTROL_SCHEMA}.release_attempts
    WHERE outcome = 'running' OR finished_at IS NULL
  `);
  const latestRows = await tx.$queryRawUnsafe(`
    SELECT outcome, kind, finished_at
    FROM ${CONTROL_SCHEMA}.release_attempts
    ORDER BY id DESC
    LIMIT 1
  `);
  if (unfinished !== 0) throw new Error('Discover schema-control has an unfinished release attempt');
  if (latestRows.length !== 1 || latestRows[0].outcome !== 'success') {
    throw new Error('Discover schema-control latest release attempt is not successful');
  }
  return latestRows[0];
}

export async function startAttempt(tx, { fingerprint, kind }) {
  const [row] = await tx.$queryRawUnsafe(`
    INSERT INTO ${CONTROL_SCHEMA}.release_attempts
      (target_fingerprint, kind, outcome)
    VALUES ($1, $2, 'running')
    RETURNING id
  `, fingerprint, kind);
  return row.id;
}

export async function finishAttempt(tx, id, outcome, detail) {
  const count = await tx.$executeRawUnsafe(`
    UPDATE ${CONTROL_SCHEMA}.release_attempts
    SET outcome = $2, detail = $3, finished_at = clock_timestamp()
    WHERE id = $1 AND outcome = 'running' AND finished_at IS NULL
  `, id, outcome, detail);
  if (count !== 1) throw new Error('Release-attempt finish compare-and-set failed');
}

export async function assertNoProductRowMutation(tx) {
  const rows = await tx.$queryRawUnsafe(`
    SELECT schemaname, relname, n_tup_ins, n_tup_upd, n_tup_del
    FROM pg_stat_xact_user_tables
    WHERE schemaname NOT IN ('${CONTROL_SCHEMA}')
      AND (n_tup_ins <> 0 OR n_tup_upd <> 0 OR n_tup_del <> 0)
    ORDER BY schemaname, relname
  `);
  if (rows.length > 0) {
    throw new Error('Schema-control transaction modified a non-control relation');
  }
}

export async function assertRuntimePrivileges(tx, options = {}) {
  const [{ control_exists: controlExists }] = await tx.$queryRawUnsafe(`
    SELECT to_regnamespace('${CONTROL_SCHEMA}') IS NOT NULL AS control_exists
  `);
  if (!controlExists) {
    if (!options.allowMissingControl) {
      throw new Error('Discover schema-control metadata is missing');
    }
    const [row] = await tx.$queryRawUnsafe(`
      SELECT current_user AS role_name,
             has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
             has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
             has_table_privilege(current_user, 'public."_prisma_migrations"', 'SELECT') AS migration_read,
             (
               has_table_privilege(current_user, 'public."_prisma_migrations"', 'INSERT') OR
               has_table_privilege(current_user, 'public."_prisma_migrations"', 'UPDATE') OR
               has_table_privilege(current_user, 'public."_prisma_migrations"', 'DELETE') OR
               has_table_privilege(current_user, 'public."_prisma_migrations"', 'TRUNCATE')
             ) AS migration_write,
             EXISTS (
               SELECT 1
               FROM pg_class relation
               JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'public'
                 AND pg_get_userbyid(relation.relowner) = current_user
                 AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
             ) AS owns_relation
    `);
    if (
      row.role_name !== RUNTIME_ROLE ||
      !row.public_usage ||
      !row.migration_read ||
      row.public_create ||
      row.migration_write ||
      row.owns_relation
    ) {
      throw new Error('Pre-adoption runtime role has schema-owner or migration-write authority');
    }
    return row;
  }

  const [row] = await tx.$queryRawUnsafe(`
    SELECT current_user AS role_name,
           has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
           has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
           has_schema_privilege(current_user, '${CONTROL_SCHEMA}', 'USAGE') AS control_usage,
           has_schema_privilege(current_user, '${CONTROL_SCHEMA}', 'CREATE') AS control_create,
           has_table_privilege(current_user, '${CONTROL_SCHEMA}.target_identity', 'SELECT') AS identity_read,
           (
             has_table_privilege(current_user, '${CONTROL_SCHEMA}.target_identity', 'INSERT') OR
             has_table_privilege(current_user, '${CONTROL_SCHEMA}.target_identity', 'UPDATE') OR
             has_table_privilege(current_user, '${CONTROL_SCHEMA}.target_identity', 'DELETE')
           ) AS identity_write,
           (
             has_table_privilege(current_user, 'public.candidate_privacy_projection', 'SELECT') AND
             has_table_privilege(current_user, 'public.candidate_privacy_projection', 'INSERT') AND
             has_table_privilege(current_user, 'public.candidate_privacy_projection', 'UPDATE') AND
             has_table_privilege(current_user, 'public.candidate_privacy_projection', 'DELETE') AND
             has_table_privilege(current_user, 'public.candidate_privacy_sync_state', 'SELECT') AND
             has_table_privilege(current_user, 'public.candidate_privacy_sync_state', 'INSERT') AND
             has_table_privilege(current_user, 'public.candidate_privacy_sync_state', 'UPDATE') AND
             has_table_privilege(current_user, 'public.candidate_privacy_sync_state', 'DELETE')
           ) AS privacy_dml,
           (
             has_table_privilege(current_user, 'public.candidate_privacy_projection', 'TRUNCATE') OR
             has_table_privilege(current_user, 'public.candidate_privacy_projection', 'REFERENCES') OR
             has_table_privilege(current_user, 'public.candidate_privacy_projection', 'TRIGGER') OR
             has_table_privilege(current_user, 'public.candidate_privacy_sync_state', 'TRUNCATE') OR
             has_table_privilege(current_user, 'public.candidate_privacy_sync_state', 'REFERENCES') OR
             has_table_privilege(current_user, 'public.candidate_privacy_sync_state', 'TRIGGER')
           ) AS privacy_escalated,
           EXISTS (
             SELECT 1
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname IN ('public', '${CONTROL_SCHEMA}')
               AND pg_get_userbyid(relation.relowner) = current_user
               AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
           ) AS owns_relation
  `);
  if (
    !row.public_usage ||
    !row.control_usage ||
    !row.identity_read ||
    (!options.allowOwner && (!row.privacy_dml || row.privacy_escalated))
  ) {
    throw new Error('Runtime role is missing required read/schema privileges');
  }
  if (!options.allowOwner && (
    row.role_name !== RUNTIME_ROLE ||
    row.public_create ||
    row.control_create ||
    row.identity_write ||
    row.owns_relation
  )) {
    throw new Error('Runtime role has schema-owner or control-plane write authority');
  }
  return row;
}
