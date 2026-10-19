/** Safe failure metadata only: never retain provider bodies, prompts, headers or keys. */
export type GroqFailureReason = 'not_configured' | 'circuit_open' | 'timeout' | 'authentication'
  | 'model_unavailable' | 'rate_limited' | 'provider_unavailable' | 'invalid_response' | 'network' | 'unexpected';

export class GroqFailure extends Error {
  readonly name = 'GroqFailure';
  constructor(readonly reason: GroqFailureReason, readonly attempts = 0) {
    super('The AI check is unavailable right now.');
  }
}

export function groqFailure(error: unknown, attempts = 0): GroqFailure {
  if (error instanceof GroqFailure) return new GroqFailure(error.reason, attempts || error.attempts);
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const name = typeof record.name === 'string' ? record.name.toLowerCase() : '';
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  const status = record.statusCode ?? record.status;
  let reason: GroqFailureReason = 'unexpected';
  if (name.includes('timeout') || name === 'aborterror' || message.includes('timeout')) reason = 'timeout';
  else if (status === 401 || status === 403) reason = 'authentication';
  else if (status === 404) reason = 'model_unavailable';
  else if (status === 429) reason = 'rate_limited';
  else if (typeof status === 'number' && status >= 500 && status <= 599) reason = 'provider_unavailable';
  else if (name.includes('noobjectgenerated') || name.includes('typevalidation') || name.includes('zod') || name === 'syntaxerror') reason = 'invalid_response';
  else if (/econn|socket|network|fetch failed/.test(message)) reason = 'network';
  return new GroqFailure(reason, attempts);
}

export function groqFailureFields(error: unknown) {
  const failure = groqFailure(error);
  return { outcome: 'failed' as const, reason: failure.reason, attempts: failure.attempts };
}
