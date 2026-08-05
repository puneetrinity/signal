import {
  PRISMA_SCHEMA_PATH,
  assertReadOnlyAuditUrl,
  datasourceEnvironment,
  runPrisma,
} from './lib/database-bootstrap.mjs';

const auditUrl = process.env.SIGNAL_SCHEMA_AUDIT_DATABASE_URL;
if (!auditUrl) throw new Error('SIGNAL_SCHEMA_AUDIT_DATABASE_URL is required');

assertReadOnlyAuditUrl(
  auditUrl,
  process.env.SIGNAL_SCHEMA_AUDIT_ALLOW_TEST_ROLE === '1',
);

await runPrisma(
  [
    'migrate',
    'diff',
    '--from-schema-datasource',
    PRISMA_SCHEMA_PATH,
    '--to-schema-datamodel',
    PRISMA_SCHEMA_PATH,
    '--exit-code',
  ],
  { env: datasourceEnvironment(auditUrl) },
);
console.log('[Schema drift] Database matches prisma/schema.prisma');
