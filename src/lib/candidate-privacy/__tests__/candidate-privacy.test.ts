import { randomUUID } from 'node:crypto';
import { decodeJwt, exportPKCS8, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCandidatePrivacyConfig } from '../config';
import {
  CandidatePrivacyMemoryError,
  HttpCandidatePrivacyMemoryClient,
} from '../memory-client';
import { anchorToEligibilitySubject } from '../models';
import { signCandidatePrivacyJWT } from '@/lib/sourcing/activegraph-auth';

const originalEnvironment = { ...process.env };

function config() {
  return loadCandidatePrivacyConfig({
    NODE_ENV: 'test',
    ACTIVEGRAPH_URL: 'http://127.0.0.1:18000',
    SIGNAL_CANDIDATE_PRIVACY_ACTOR_ID: 'signal-service',
    SIGNAL_CANDIDATE_PRIVACY_HTTP_TIMEOUT_MS: '5000',
    SIGNAL_CANDIDATE_PRIVACY_POLL_MS: '30000',
    SIGNAL_CANDIDATE_PRIVACY_STALE_MS: '120000',
    SIGNAL_CANDIDATE_PRIVACY_REBUILD_LEASE_MS: '300000',
    SIGNAL_CANDIDATE_PRIVACY_BATCH_SIZE: '200',
    SIGNAL_CANDIDATE_PRIVACY_FEED_PAGE_SIZE: '500',
  });
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  process.env.SIGNAL_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
  process.env.SIGNAL_CANDIDATE_PRIVACY_ACTOR_ID = 'signal-service';
  process.env.ACTIVEGRAPH_JWT_AUDIENCE = 'activekg';
});

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
});

describe('Discover candidate privacy contract', () => {
  it('privacy-config-contract: accepts only bounded, credential-free URLs and knobs', () => {
    expect(config()).toMatchObject({
      memoryBaseUrl: 'http://127.0.0.1:18000',
      actorId: 'signal-service',
      rebuildLeaseMs: 300000,
      eligibilityBatchSize: 200,
      feedPageSize: 500,
    });
    expect(() => loadCandidatePrivacyConfig({ NODE_ENV: 'test', ACTIVEGRAPH_URL: 'https://u:p@example.test' }))
      .toThrow('candidate_privacy_configuration_invalid');
    expect(() => loadCandidatePrivacyConfig({
      NODE_ENV: 'test',
      ACTIVEGRAPH_URL: 'https://example.test',
      SIGNAL_CANDIDATE_PRIVACY_STALE_MS: '300001',
    })).toThrow('candidate_privacy_configuration_invalid');
    expect(() => loadCandidatePrivacyConfig({
      NODE_ENV: 'test',
      ACTIVEGRAPH_URL: 'https://example.test',
      SIGNAL_CANDIDATE_PRIVACY_REBUILD_LEASE_MS: '59999',
    })).toThrow('candidate_privacy_configuration_invalid');
    expect(() => loadCandidatePrivacyConfig({
      NODE_ENV: 'test',
      ACTIVEGRAPH_URL: 'https://example.test',
      SIGNAL_CANDIDATE_PRIVACY_REBUILD_LEASE_MS: '900001',
    })).toThrow('candidate_privacy_configuration_invalid');
    expect(() => loadCandidatePrivacyConfig({
      NODE_ENV: 'test',
      ACTIVEGRAPH_URL: 'https://example.test',
      SIGNAL_CANDIDATE_PRIVACY_ACTOR_ID: 'sourcing',
    })).toThrow('candidate_privacy_configuration_invalid');
  });

  it('privacy-jwt-contract: signs only the Memory read identity', async () => {
    const token = await signCandidatePrivacyJWT();
    const payload = decodeJwt(token);
    expect(payload).toMatchObject({
      iss: 'signal',
      sub: 'signal-service',
      aud: 'activekg',
      tenant_id: 'platform',
      actor_type: 'service',
      scopes: 'candidate-privacy:read',
    });
    expect(String(payload.scopes)).not.toContain('write');
    expect(payload.jti).toEqual(expect.any(String));
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
  });

  it('privacy-memory-contract: validates a complete eligibility response', async () => {
    const subject = anchorToEligibilitySubject({
      requestRef: randomUUID(),
      signalCandidateId: 'synthetic-candidate',
      linkedinUrl: 'https://www.linkedin.com/in/synthetic-candidate',
    });
    let observedAuthorization = '';
    const client = new HttpCandidatePrivacyMemoryClient(
      config(),
      async (_input, init) => {
        observedAuthorization = new Headers(init?.headers).get('authorization') ?? '';
        return jsonResponse({
          results: [{ request_ref: subject.request_ref, decision: 'allow' }],
          count: 1,
        });
      },
    );
    await expect(client.eligibilityBatch([subject])).resolves.toEqual(
      new Map([[subject.request_ref, 'allow']]),
    );
    expect(observedAuthorization).toMatch(/^Bearer /);
  });

  it.each([
    ['duplicate', (requestRef: string) => ({
      results: [
        { request_ref: requestRef, decision: 'allow' },
        { request_ref: requestRef, decision: 'allow' },
      ],
      count: 1,
    })],
    ['missing', () => ({ results: [], count: 1 })],
    ['unknown decision', (requestRef: string) => ({
      results: [{ request_ref: requestRef, decision: 'maybe' }],
      count: 1,
    })],
    ['unexpected request ref', () => ({
      results: [{ request_ref: randomUUID(), decision: 'allow' }],
      count: 1,
    })],
    ['inconsistent count', (requestRef: string) => ({
      results: [{ request_ref: requestRef, decision: 'allow' }],
      count: 0,
    })],
  ])('privacy-memory-contract: rejects %s eligibility output', async (_label, body) => {
    const subject = anchorToEligibilitySubject({
      requestRef: randomUUID(),
      signalCandidateId: 'synthetic-candidate',
    });
    const client = new HttpCandidatePrivacyMemoryClient(
      config(),
      async () => jsonResponse(body(subject.request_ref)),
    );
    await expect(client.eligibilityBatch([subject])).rejects.toMatchObject({
      code: 'candidate_privacy_response_invalid',
    });
  });

  it('privacy-memory-contract: refuses a cursor gap and decreasing feed', async () => {
    for (const cursor of [12, 9]) {
      const client = new HttpCandidatePrivacyMemoryClient(
        config(),
        async () => jsonResponse({
          events: [{
            cursor,
            event_id: randomUUID(),
            directive_id: randomUUID(),
            action: 'withdraw_global_matching',
            scope: 'global_matching',
            state: 'active_quarantine',
            version: 1,
            effective_at: new Date().toISOString(),
          }],
          count: 1,
        }),
      );
      await expect(client.readChanges(10)).rejects.toMatchObject({
        code: 'candidate_privacy_response_invalid',
      });
    }
  });

  it('no-leak-canary: never reads or reflects an HTTP error body', async () => {
    const canary = 'person@example.invalid https://example.invalid/private?token=canary';
    let bodyRead = false;
    const response = new Response(canary, { status: 503 });
    const originalText = response.text.bind(response);
    Object.defineProperty(response, 'text', {
      value: async () => {
        bodyRead = true;
        return originalText();
      },
    });
    const client = new HttpCandidatePrivacyMemoryClient(config(), async () => response);
    const subject = anchorToEligibilitySubject({
      requestRef: randomUUID(),
      signalCandidateId: 'synthetic-candidate',
    });
    let error: unknown;
    try {
      await client.eligibilityBatch([subject]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CandidatePrivacyMemoryError);
    expect(String(error)).not.toContain(canary);
    expect(bodyRead).toBe(false);
  });

  it('privacy-memory-contract: rejects a response above the byte cap before parsing', async () => {
    const client = new HttpCandidatePrivacyMemoryClient(
      config(),
      async () => new Response('{}', {
        status: 200,
        headers: { 'content-length': String(257 * 1024) },
      }),
    );
    await expect(client.readHighWater()).rejects.toMatchObject({
      code: 'candidate_privacy_response_invalid',
    });
  });

  it('privacy-memory-contract: enforces the configured HTTP deadline', async () => {
    const timeoutConfig = loadCandidatePrivacyConfig({
      NODE_ENV: 'test',
      ACTIVEGRAPH_URL: 'http://127.0.0.1:18000',
      SIGNAL_CANDIDATE_PRIVACY_HTTP_TIMEOUT_MS: '1',
    });
    const client = new HttpCandidatePrivacyMemoryClient(
      timeoutConfig,
      async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    await expect(client.readHighWater()).rejects.toMatchObject({
      code: 'candidate_privacy_unavailable',
    });
  });
});
