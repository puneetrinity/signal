import { afterEach, describe, expect, it, vi } from 'vitest';

const { signActiveGraphJWT } = vi.hoisted(() => ({
  signActiveGraphJWT: vi.fn(async () => 'signed-memory-token'),
}));

vi.mock('@/lib/sourcing/activegraph-auth', () => ({
  signActiveGraphJWT,
}));

import {
  ActiveGraphContactMemoryClient,
  CONTACT_EVIDENCE_LOOKUP_PATH,
  CONTACT_EVIDENCE_RECORD_PATH,
  MemoryContactUnavailableError,
} from '../memory-client';

const GLOBAL_ID = '11111111-1111-4111-8111-111111111111';

describe('Memory contact evidence client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses the code-grounded paths and least-privilege scopes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                global_candidate_id: GLOBAL_ID,
                state: 'found',
                contact: {
                  email: 'selected@example.com',
                  provider: 'fullenrich',
                  provider_record_id: 'fe-1',
                  confidence: 0.95,
                  observed_at: '2026-07-25T12:00:00Z',
                  validated_at: '2026-07-25T12:00:00Z',
                  status: 'verified',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new ActiveGraphContactMemoryClient();
    const result = await client.record({
      tenantId: 'org_1',
      evidence: {
        version: 1,
        globalCandidateId: GLOBAL_ID,
        items: [
          {
            email: 'selected@example.com',
            provider: 'fullenrich',
            providerRecordId: 'fe-1',
            confidence: 0.95,
            observedAt: '2026-07-25T12:00:00Z',
            validatedAt: '2026-07-25T12:00:00Z',
            status: 'verified',
          },
        ],
      },
    });

    expect(result).toEqual({
      state: 'found',
      email: 'selected@example.com',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:8000${CONTACT_EVIDENCE_RECORD_PATH}`,
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://localhost:8000${CONTACT_EVIDENCE_LOOKUP_PATH}`,
    );
    expect(signActiveGraphJWT.mock.calls).toEqual([
      ['org_1', 'contact:write'],
      ['org_1', 'contact:read'],
    ]);
  });

  it('treats malformed or unavailable Memory as retryable failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('not-json', {
            status: 200,
          }),
      ),
    );
    const client = new ActiveGraphContactMemoryClient();
    await expect(
      client.lookup({
        tenantId: 'org_1',
        globalCandidateId: GLOBAL_ID,
      }),
    ).rejects.toBeInstanceOf(MemoryContactUnavailableError);
  });
});
