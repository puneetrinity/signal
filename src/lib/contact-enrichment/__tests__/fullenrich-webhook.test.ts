import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findFirst, updateMany } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    contactEnrichmentOperation: {
      findFirst,
      updateMany,
    },
  },
}));

import {
  getFullEnrichWebhookProviderRecordId,
  verifyFullEnrichSignature,
} from '../fullenrich-webhook';
import { handleFullEnrichWebhookPayload } from '../webhook-handler';

const GLOBAL_ID = '11111111-1111-4111-8111-111111111111';

function documentedWebhookPayload() {
  return {
    id: 'fe-documented-id',
    status: 'FINISHED',
    data: [
      {
        custom: {
          operation: JSON.stringify({
            operation_id: 'operation-1',
            generation: 4,
          }),
        },
        contact_info: {
          personal_emails: [
            {
              email: 'Alice@Example.com',
              status: 'DELIVERABLE',
            },
          ],
        },
      },
    ],
  };
}

describe('FullEnrich webhook recovery', () => {
  beforeEach(() => {
    findFirst.mockReset();
    updateMany.mockReset();
    findFirst.mockResolvedValue({
      globalCandidateId: GLOBAL_ID,
      providerRecordId: null,
    });
    updateMany.mockResolvedValue({ count: 1 });
  });

  it('verifies HMAC-SHA1 against the raw request body', () => {
    const raw = '{"id":"fe-1"}';
    const signature = createHmac('sha1', 'secret')
      .update(raw)
      .digest('hex');
    expect(
      verifyFullEnrichSignature(raw, signature, 'secret'),
    ).toBe(true);
    expect(
      verifyFullEnrichSignature(raw, '0'.repeat(40), 'secret'),
    ).toBe(false);
  });

  it('recovers a lost POST response from documented root id shape', async () => {
    const payload = documentedWebhookPayload();
    expect(getFullEnrichWebhookProviderRecordId(payload)).toBe(
      'fe-documented-id',
    );

    await expect(
      handleFullEnrichWebhookPayload(payload),
    ).resolves.toEqual({ accepted: true, updated: true });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'operation-1',
        generation: 4,
        provider: 'fullenrich',
        state: {
          in: [
            'fullenrich_starting',
            'fullenrich_polling',
            'fullenrich_ambiguous',
          ],
        },
      },
      data: expect.objectContaining({
        state: 'evidence_pending',
        providerRecordId: 'fe-documented-id',
        leaseToken: null,
        leaseExpiresAt: null,
        stagedEvidence: expect.objectContaining({
          globalCandidateId: GLOBAL_ID,
          items: [
            expect.objectContaining({
              email: 'alice@example.com',
              status: 'verified',
            }),
          ],
        }),
      }),
    });
  });

  it('ignores a stale generation without overwriting newer state', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      handleFullEnrichWebhookPayload(documentedWebhookPayload()),
    ).resolves.toEqual({ accepted: true, updated: false });
  });

  it('routes a definitive no-email webhook to the EL continuation marker', async () => {
    const payload = documentedWebhookPayload();
    payload.data[0].contact_info.personal_emails = [];
    await handleFullEnrichWebhookPayload(payload);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'queued',
          providerRecordId: 'fe-documented-id',
          lastErrorCode: 'fullenrich_no_email',
        }),
      }),
    );
  });
});
