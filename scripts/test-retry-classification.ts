/**
 * Tests for the EnrichLayer + Crustdata retry/classification fix.
 *
 * EnrichLayer (`getJson`):
 *   - 4xx (except 429) → EnrichLayerUnrecoverableError (BullMQ won't retry)
 *   - 429 / 5xx / network / timeout → plain Error (BullMQ retries with 5s backoff)
 *   - timeout fires after CRUSTDATA-equivalent budget
 *
 * Crustdata (`fetchCrustdata`):
 *   - 5xx → retry once, then throw (caller falls back to Serper)
 *   - 4xx (except 429) → throw immediately
 *   - 429 with short Retry-After → wait + retry
 *   - 429 with long Retry-After → throw immediately (Serper is faster)
 *
 * Strategy: run a tiny in-process HTTP server and point env vars at it.
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  EnrichLayerUnrecoverableError,
  fetchEnrichLayerProfile,
} from '@/lib/enrichment/enrichlayer';
import { crustdataProvider } from '@/lib/search/providers/crustdata';
import type { StructuredJobSearchSpec } from '@/lib/search/providers/types';

interface MockResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
  delayMs?: number;
}

interface MockServerHandle {
  url: string;
  setNext: (responses: MockResponse[]) => void;
  close: () => Promise<void>;
  callCount: () => number;
}

async function startMockServer(): Promise<MockServerHandle> {
  let queue: MockResponse[] = [];
  let calls = 0;

  const server = http.createServer((_req, res) => {
    calls++;
    const next = queue.shift();
    if (!next) {
      res.statusCode = 599;
      res.end('no mock queued');
      return;
    }
    const send = () => {
      res.statusCode = next.status;
      for (const [k, v] of Object.entries(next.headers ?? {})) res.setHeader(k, v);
      res.end(next.body);
    };
    if (next.delayMs && next.delayMs > 0) setTimeout(send, next.delayMs);
    else send();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/profile`;
  return {
    url,
    setNext: (responses) => {
      queue = [...responses];
      calls = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    callCount: () => calls,
  };
}

interface CaseResult {
  label: string;
  pass: boolean;
  detail: string;
}

async function runEnrichLayerCases(server: MockServerHandle): Promise<CaseResult[]> {
  process.env.ENRICHLAYER_API_KEY = 'test';
  process.env.ENRICHLAYER_PROFILE_URL = server.url;

  const results: CaseResult[] = [];

  // Case 1: 404 → EnrichLayerUnrecoverableError
  server.setNext([{ status: 404, body: 'not found' }]);
  try {
    await fetchEnrichLayerProfile('https://www.linkedin.com/in/anyone');
    results.push({
      label: '404 → EnrichLayerUnrecoverableError',
      pass: false,
      detail: 'expected throw, got success',
    });
  } catch (err) {
    const ok = err instanceof EnrichLayerUnrecoverableError;
    results.push({
      label: '404 → EnrichLayerUnrecoverableError',
      pass: ok,
      detail: ok
        ? `EnrichLayerUnrecoverableError(status=${(err as EnrichLayerUnrecoverableError).status})`
        : `got ${err instanceof Error ? err.constructor.name : typeof err}: ${err instanceof Error ? err.message : err}`,
    });
  }

  // Case 2: 401 → unrecoverable
  server.setNext([{ status: 401, body: 'unauthorized' }]);
  try {
    await fetchEnrichLayerProfile('https://www.linkedin.com/in/anyone');
    results.push({ label: '401 → unrecoverable', pass: false, detail: 'expected throw' });
  } catch (err) {
    const ok = err instanceof EnrichLayerUnrecoverableError;
    results.push({
      label: '401 → unrecoverable',
      pass: ok,
      detail: ok ? 'unrecoverable as expected' : `got ${err instanceof Error ? err.constructor.name : typeof err}`,
    });
  }

  // Case 3: 503 → plain Error (BullMQ-retryable)
  server.setNext([{ status: 503, body: 'service unavailable' }]);
  try {
    await fetchEnrichLayerProfile('https://www.linkedin.com/in/anyone');
    results.push({ label: '503 → plain Error (retryable)', pass: false, detail: 'expected throw' });
  } catch (err) {
    const isUnrec = err instanceof EnrichLayerUnrecoverableError;
    const isErr = err instanceof Error;
    const ok = !isUnrec && isErr;
    results.push({
      label: '503 → plain Error (retryable)',
      pass: ok,
      detail: ok ? 'plain Error as expected' : `got unrecoverable=${isUnrec}`,
    });
  }

  // Case 4: 429 → plain Error (no inner retry, BullMQ handles it)
  server.setNext([{ status: 429, body: 'too many', headers: { 'retry-after': '5' } }]);
  try {
    await fetchEnrichLayerProfile('https://www.linkedin.com/in/anyone');
    results.push({ label: '429 → plain Error (retryable)', pass: false, detail: 'expected throw' });
  } catch (err) {
    const isUnrec = err instanceof EnrichLayerUnrecoverableError;
    const ok = !isUnrec && err instanceof Error;
    const calls = server.callCount();
    results.push({
      label: '429 → plain Error (retryable)',
      pass: ok && calls === 1,
      detail: `unrecoverable=${isUnrec} calls=${calls} (expected 1, no inner retry)`,
    });
  }

  // Case 5: success after retry would happen — confirm just one call goes out
  // (i.e. enrichlayer.getJson does NOT retry internally on 503)
  server.setNext([
    { status: 503, body: 'first' },
    { status: 200, body: '{"full_name":"X"}' },
  ]);
  try {
    await fetchEnrichLayerProfile('https://www.linkedin.com/in/anyone');
    results.push({
      label: 'no inner retry on 503 (BullMQ owns retry)',
      pass: false,
      detail: 'unexpected success — should have thrown after first 503',
    });
  } catch {
    const calls = server.callCount();
    results.push({
      label: 'no inner retry on 503 (BullMQ owns retry)',
      pass: calls === 1,
      detail: `calls=${calls} (expected 1)`,
    });
  }

  return results;
}

async function runCrustdataCases(server: MockServerHandle): Promise<CaseResult[]> {
  process.env.CRUSTDATA_API_KEY = 'test';
  process.env.CRUSTDATA_SEARCH_URL = server.url;

  const spec: StructuredJobSearchSpec = {
    title: 'Engineer',
    city: 'Bengaluru',
    country: 'IN',
    skills: [],
  };
  const results: CaseResult[] = [];

  // Case 1: 5xx then 200 → retried once, succeeds.
  server.setNext([
    { status: 503, body: 'down' },
    { status: 200, body: JSON.stringify({ profiles: [] }) },
  ]);
  try {
    await crustdataProvider.searchByJobSpec!(spec, 10);
    const calls = server.callCount();
    results.push({
      label: '5xx then 200 → 1 retry, success',
      pass: calls === 2,
      detail: `calls=${calls} (expected 2)`,
    });
  } catch (err) {
    results.push({
      label: '5xx then 200 → 1 retry, success',
      pass: false,
      detail: `unexpected throw: ${err instanceof Error ? err.message : err}`,
    });
  }

  // Case 2: 5xx twice → throws (caller falls back to Serper).
  server.setNext([
    { status: 502, body: 'first' },
    { status: 502, body: 'second' },
  ]);
  try {
    await crustdataProvider.searchByJobSpec!(spec, 10);
    results.push({
      label: '5xx twice → throws after 1 retry',
      pass: false,
      detail: 'expected throw, got success',
    });
  } catch {
    const calls = server.callCount();
    results.push({
      label: '5xx twice → throws after 1 retry',
      pass: calls === 2,
      detail: `calls=${calls} (expected 2)`,
    });
  }

  // Case 3: 400 → throws immediately, no retry.
  server.setNext([
    { status: 400, body: 'bad request' },
    { status: 200, body: JSON.stringify({ profiles: [] }) },
  ]);
  try {
    await crustdataProvider.searchByJobSpec!(spec, 10);
    results.push({
      label: '400 → throws immediately (no retry)',
      pass: false,
      detail: 'expected throw',
    });
  } catch {
    const calls = server.callCount();
    results.push({
      label: '400 → throws immediately (no retry)',
      pass: calls === 1,
      detail: `calls=${calls} (expected 1)`,
    });
  }

  // Case 4: 429 with Retry-After 1s → retries (within 2s cap).
  server.setNext([
    { status: 429, body: 'slow', headers: { 'retry-after': '1' } },
    { status: 200, body: JSON.stringify({ profiles: [] }) },
  ]);
  const start = Date.now();
  try {
    await crustdataProvider.searchByJobSpec!(spec, 10);
    const elapsed = Date.now() - start;
    const calls = server.callCount();
    results.push({
      label: '429 Retry-After:1 → retries, succeeds',
      pass: calls === 2 && elapsed >= 900,
      detail: `calls=${calls} elapsedMs=${elapsed} (expected 2 calls, ~1000ms)`,
    });
  } catch (err) {
    results.push({
      label: '429 Retry-After:1 → retries, succeeds',
      pass: false,
      detail: `unexpected throw: ${err instanceof Error ? err.message : err}`,
    });
  }

  // Case 5: 429 with Retry-After 10s → throws immediately (above 2s cap).
  server.setNext([
    { status: 429, body: 'slow', headers: { 'retry-after': '10' } },
    { status: 200, body: JSON.stringify({ profiles: [] }) },
  ]);
  try {
    await crustdataProvider.searchByJobSpec!(spec, 10);
    results.push({
      label: '429 Retry-After:10 → throws (cap = 2s)',
      pass: false,
      detail: 'expected throw',
    });
  } catch {
    const calls = server.callCount();
    results.push({
      label: '429 Retry-After:10 → throws (cap = 2s)',
      pass: calls === 1,
      detail: `calls=${calls} (expected 1)`,
    });
  }

  return results;
}

async function main() {
  const server = await startMockServer();
  try {
    console.log('=== EnrichLayer ===');
    const enrichResults = await runEnrichLayerCases(server);
    console.log('=== Crustdata ===');
    const crustResults = await runCrustdataCases(server);
    const all = [...enrichResults, ...crustResults];
    let passed = 0;
    let failed = 0;
    for (const r of all) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}`);
      console.log(`      ${r.detail}`);
      if (r.pass) passed++;
      else failed++;
    }
    console.log();
    console.log(`=== ${passed} passed, ${failed} failed ===`);
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
