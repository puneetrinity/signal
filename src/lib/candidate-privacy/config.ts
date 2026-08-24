export interface CandidatePrivacyConfig {
  memoryBaseUrl: string;
  actorId: 'signal-service';
  httpTimeoutMs: number;
  pollMs: number;
  staleMs: number;
  rebuildLeaseMs: number;
  eligibilityBatchSize: number;
  feedPageSize: number;
}

export class CandidatePrivacyConfigurationError extends Error {
  constructor(public readonly code: 'candidate_privacy_configuration_invalid') {
    super(code);
    this.name = 'CandidatePrivacyConfigurationError';
  }
}

export function isCandidatePrivacyDisposableTestAdapter(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === 'test' &&
    env.SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER === 'disposable_passthrough';
}

function boundedInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CandidatePrivacyConfigurationError('candidate_privacy_configuration_invalid');
  }
  return value;
}

function parseBaseUrl(value: string | undefined): string {
  if (!value) {
    throw new CandidatePrivacyConfigurationError('candidate_privacy_configuration_invalid');
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('invalid');
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new CandidatePrivacyConfigurationError('candidate_privacy_configuration_invalid');
  }
}

export function loadCandidatePrivacyConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { requireProcessor?: boolean } = {},
): CandidatePrivacyConfig {
  const actorId = env.SIGNAL_CANDIDATE_PRIVACY_ACTOR_ID ?? 'signal-service';
  if (actorId !== 'signal-service') {
    throw new CandidatePrivacyConfigurationError('candidate_privacy_configuration_invalid');
  }
  if (
    options.requireProcessor &&
    !env.SIGNAL_JWT_PRIVATE_KEY
  ) {
    throw new CandidatePrivacyConfigurationError('candidate_privacy_configuration_invalid');
  }
  return {
    memoryBaseUrl: parseBaseUrl(env.ACTIVEGRAPH_URL),
    actorId,
    httpTimeoutMs: boundedInt(
      env,
      'SIGNAL_CANDIDATE_PRIVACY_HTTP_TIMEOUT_MS',
      5_000,
      1,
      10_000,
    ),
    pollMs: boundedInt(
      env,
      'SIGNAL_CANDIDATE_PRIVACY_POLL_MS',
      30_000,
      5_000,
      60_000,
    ),
    staleMs: boundedInt(
      env,
      'SIGNAL_CANDIDATE_PRIVACY_STALE_MS',
      120_000,
      60_000,
      300_000,
    ),
    rebuildLeaseMs: boundedInt(
      env,
      'SIGNAL_CANDIDATE_PRIVACY_REBUILD_LEASE_MS',
      300_000,
      60_000,
      900_000,
    ),
    eligibilityBatchSize: boundedInt(
      env,
      'SIGNAL_CANDIDATE_PRIVACY_BATCH_SIZE',
      200,
      1,
      200,
    ),
    feedPageSize: boundedInt(
      env,
      'SIGNAL_CANDIDATE_PRIVACY_FEED_PAGE_SIZE',
      500,
      1,
      500,
    ),
  };
}
