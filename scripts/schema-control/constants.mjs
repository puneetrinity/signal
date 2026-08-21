import { createHash } from 'node:crypto';

export const SYSTEM = 'discover';
export const CONTROL_SCHEMA = 'signal_schema_control';
export const RUNTIME_ROLE = 'signal_runtime';
export const WRAPPER_LOCK_KEY = 0x1a0d1a0d;
export const ADOPTION_LOCK_KEY = 0x1a0d0ad0;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENTS = new Set(['development', 'staging', 'production']);

export function requireValue(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function resolveIdentityEnvironment(env = process.env) {
  const environment = requireValue(env, 'SIGNAL_SCHEMA_ENVIRONMENT');
  if (!ENVIRONMENTS.has(environment)) {
    throw new Error('SIGNAL_SCHEMA_ENVIRONMENT must be development, staging, or production');
  }
  const targetId = requireValue(env, 'SIGNAL_SCHEMA_TARGET_ID');
  if (!UUID_PATTERN.test(targetId)) {
    throw new Error('SIGNAL_SCHEMA_TARGET_ID must be a UUID');
  }
  return { system: SYSTEM, environment, targetId: targetId.toLowerCase() };
}

export function resolveReleaseEnvironment(env = process.env) {
  const identity = resolveIdentityEnvironment(env);
  if (env.SIGNAL_MIGRATION_APPLY !== '1') {
    throw new Error('SIGNAL_MIGRATION_APPLY=1 is required');
  }
  const directUrl = requireValue(env, 'DIRECT_URL');
  return { ...identity, directUrl };
}

export function resolveAdoptionEnvironment(env = process.env) {
  const identity = resolveIdentityEnvironment(env);
  if (env.SIGNAL_SCHEMA_ADOPT_EXISTING !== '1') {
    throw new Error('SIGNAL_SCHEMA_ADOPT_EXISTING=1 is required');
  }
  const directUrl = requireValue(env, 'DIRECT_URL');
  return { ...identity, directUrl };
}

export function assertRuntimeEnvironment(env = process.env) {
  const identity = resolveIdentityEnvironment(env);
  const runtimeUrl = requireValue(env, 'DATABASE_URL');
  if (identity.environment !== 'development') {
    const forbidden = [
      'DIRECT_URL',
      'SIGNAL_MIGRATION_APPLY',
      'SIGNAL_SCHEMA_ADOPT_EXISTING',
      'SIGNAL_RUNTIME_ROLE_PASSWORD',
      'SIGNAL_RUNTIME_DATABASE_URL',
      'SIGNAL_SCHEMA_CONTROL_TEST_ROOT',
    ].filter((name) => Boolean(env[name]));
    if (forbidden.length > 0) {
      throw new Error(`Runtime environment contains forbidden schema-control variables: ${forbidden.join(', ')}`);
    }
  }
  return { ...identity, runtimeUrl };
}

export function resolveControlRoot(identity, defaultRoot, env = process.env) {
  const override = env.SIGNAL_SCHEMA_CONTROL_TEST_ROOT?.trim();
  if (!override) return defaultRoot;
  if (
    identity.environment !== 'development' ||
    env.SIGNAL_SCHEMA_DISPOSABLE_SINGLE_CREDENTIAL !== '1'
  ) {
    throw new Error('Schema-control root override is allowed only for disposable development tests');
  }
  return override;
}

export function isDisposableDevelopment(identity, databaseUrl, env = process.env) {
  if (
    identity.environment !== 'development' ||
    env.SIGNAL_SCHEMA_DISPOSABLE_SINGLE_CREDENTIAL !== '1'
  ) {
    return false;
  }
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.replace(/^\//, '');
  const localHost = ['', 'localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  return localHost && /(?:^|[_-])(?:test|disposable)(?:[_-]|$)/i.test(databaseName);
}

export function safeTargetFingerprint(targetId) {
  return createHash('sha256').update(`${SYSTEM}:${targetId}`).digest('hex').slice(0, 16);
}

export function safeOperationalMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(?:postgres(?:ql)?):\/\/[^\s'"`]+/gi, '[redacted-dsn]')
    .replace(/(password|passwd|pwd)=([^\s&;]+)/gi, '$1=[redacted]')
    .replace(/\bPASSWORD\s+'(?:''|[^'])*'/gi, "PASSWORD '[redacted]'")
    .replace(/Datasource\s+"[^"]+"[^\n]*\bat\s+"[^"]+"/gi, 'Datasource [redacted]')
    .replace(/\bat\s+"[^"\n]+:\d+"/gi, 'at "[redacted-host]"')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '[redacted-id]')
    .slice(0, 500);
}

export function quoteLiteral(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Secret contains forbidden control characters');
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteIdentifier(value) {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Identifier is empty or contains forbidden control characters');
  }
  return `"${value.replaceAll('"', '""')}"`;
}
