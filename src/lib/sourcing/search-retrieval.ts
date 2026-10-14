/** Internal failure taxonomy. Never attach upstream bodies, query text or names. */
export class SearchRetrievalError extends Error {
  constructor(
    readonly code: 'transport' | 'rate_limited' | 'upstream' | 'unauthorized'
      | 'invalid_contract' | 'privacy_unavailable' | 'configuration',
    readonly retryable = false,
    readonly retryAfterMs = 0,
  ) { super(`MEMORY_RETRIEVAL_${code.toUpperCase()}`); }
}

export function assertRetrievalPoolBound(publicLimit: number, privateLimit: number, recent: number) {
  if (![publicLimit, privateLimit, recent].every(n => Number.isSafeInteger(n) && n >= 0)
    || publicLimit < 1 || privateLimit < 1 || publicLimit + privateLimit + recent + 300 > 2000) {
    throw new SearchRetrievalError('configuration');
  }
}

export interface RetrievalConfiguration {
  version: 1;
  publicLimit: number;
  privateLimit: number;
  recentLimit: number;
  newLimit: 300;
}

export function retrievalConfiguration(publicLimit: number, privateLimit: number, recentLimit: number): Readonly<RetrievalConfiguration> {
  assertRetrievalPoolBound(publicLimit, privateLimit, recentLimit);
  return Object.freeze({version: 1, publicLimit, privateLimit, recentLimit, newLimit: 300});
}

/** Both lanes share the deadline; successful empty results are not outages.
 * Each operation must honour the supplied timeout through reading its body.
 * Only known transient failures retry, once. No purchase is performed here.
 */
export async function retrieveMemoryLanes<P, T>(
  publicLane: (timeoutMs: number) => Promise<P>,
  privateLane: (timeoutMs: number) => Promise<T>,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void>; jitter?: () => number } = {},
): Promise<{ publicLane: P; privateLane: T }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const jitter = options.jitter ?? (() => Math.floor(Math.random() * 251));
  const deadline = now() + 30_000;
  async function lane<R>(operation: (timeoutMs: number) => Promise<R>): Promise<R> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new SearchRetrievalError('transport');
      try { return await operation(Math.min(15_000, remaining)); }
      catch (error) {
        if (!(error instanceof SearchRetrievalError) || !error.retryable || attempt === 1) throw error;
        const delay = Math.max(250 + Math.max(0, Math.min(250, jitter())), error.retryAfterMs);
        if (!Number.isFinite(delay) || delay >= deadline - now()) throw error;
        await sleep(delay);
      }
    }
    throw new SearchRetrievalError('transport');
  }
  // Observe both branches even if one fails; no background retrieval left running
  // when the caller releases its no-dispatch execution.
  const [publicResult, privateResult] = await Promise.allSettled([lane(publicLane), lane(privateLane)]);
  if (publicResult.status === 'rejected') throw publicResult.reason;
  if (privateResult.status === 'rejected') throw privateResult.reason;
  return { publicLane: publicResult.value, privateLane: privateResult.value };
}

/** Deadline covers headers AND body, unlike a fetch-only timeout. */
export async function fetchMemorySearch(url: string, init: RequestInit, timeoutMs: number,
  timing?: (phase: 'networkMs' | 'bodyReadMs', elapsedMs: number) => void): Promise<Response> {
  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const networkStart = performance.now();
      try { response = await fetch(url, { ...init, signal: controller.signal }); }
      finally { timing?.('networkMs', performance.now() - networkStart); }
      if (response.ok) {
        const bodyStart = performance.now();
        let body: string;
        try { body = await response.text(); }
        finally { timing?.('bodyReadMs', performance.now() - bodyStart); }
        return new Response(body, { status: response.status, headers: response.headers });
      }
      await response.body?.cancel();
    } finally { clearTimeout(timer); }
  } catch { throw new SearchRetrievalError('transport', true); }
  if (response.status === 429) {
    const raw = response.headers.get('retry-after');
    const delay = raw && /^\d+$/.test(raw) ? Number(raw) * 1000
      : raw && Number.isFinite(Date.parse(raw)) ? Math.max(0, Date.parse(raw) - Date.now()) : 1000;
    throw new SearchRetrievalError('rate_limited', true, delay);
  }
  if (response.status >= 500) throw new SearchRetrievalError('upstream', true);
  throw new SearchRetrievalError(response.status === 401 || response.status === 403 ? 'unauthorized' : 'invalid_contract');
}
