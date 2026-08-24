import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import {
  getFullEnrichWebhookProviderRecordId,
  parseFullEnrichWebhookIdentity,
  parseFullEnrichWebhookResult,
} from './fullenrich-webhook';
import { applyFullEnrichWebhookTransition } from './store';
import type { StagedContactEvidence } from './types';
import { requireCandidatePrivacyAllowed } from '@/lib/candidate-privacy/repository';

export type FullEnrichWebhookHandleResult =
  | { accepted: false; code: 'invalid_identity' }
  | { accepted: true; updated: boolean };

export async function handleFullEnrichWebhookPayload(
  payload: unknown,
  now = new Date(),
): Promise<FullEnrichWebhookHandleResult> {
  const identity = parseFullEnrichWebhookIdentity(payload);
  if (!identity) {
    return { accepted: false, code: 'invalid_identity' };
  }
  const operation =
    await prisma.contactEnrichmentOperation.findFirst({
      where: {
        id: identity.operationId,
        generation: identity.generation,
      },
      select: {
        tenantId: true,
        candidateId: true,
        globalCandidateId: true,
        providerRecordId: true,
      },
    });
  if (!operation) return { accepted: true, updated: false };

  try {
    await requireCandidatePrivacyAllowed(
      operation.tenantId,
      operation.candidateId,
    );
  } catch (error) {
    const updated = await prisma.contactEnrichmentOperation.updateMany({
      where: {
        id: identity.operationId,
        generation: identity.generation,
      },
      data: {
        state: 'failed',
        stagedEvidence: Prisma.DbNull,
        selectedEmail: null,
        completedAt: now,
        lastErrorCode:
          error instanceof Error && error.message === 'candidate_privacy_restricted'
            ? 'privacy_restricted'
            : 'privacy_unavailable',
      },
    });
    return { accepted: true, updated: updated.count === 1 };
  }

  const providerRecordId =
    getFullEnrichWebhookProviderRecordId(payload) ||
    operation.providerRecordId;
  if (!providerRecordId) {
    return { accepted: true, updated: false };
  }
  const result = parseFullEnrichWebhookResult(
    payload,
    providerRecordId,
  );
  if (result.kind === 'pending') {
    return { accepted: true, updated: false };
  }

  const expectedStates = [
    'fullenrich_starting',
    'fullenrich_polling',
    'fullenrich_ambiguous',
  ] as const;
  if (result.kind === 'found') {
    if (!operation.globalCandidateId) {
      const updated = await applyFullEnrichWebhookTransition({
        operationId: identity.operationId,
        generation: identity.generation,
        expectedStates: [...expectedStates],
        transition: {
          state: 'failed',
          providerRecordId,
          lastErrorCode: 'missing_global_id',
          completedAt: now,
        },
        now,
      });
      return { accepted: true, updated };
    }
    const stagedEvidence: StagedContactEvidence = {
      version: 1,
      globalCandidateId: operation.globalCandidateId,
      items: result.evidence,
    };
    const updated = await applyFullEnrichWebhookTransition({
      operationId: identity.operationId,
      generation: identity.generation,
      expectedStates: [...expectedStates],
      transition: {
        state: 'evidence_pending',
        providerRecordId,
        stagedEvidence,
        stagedAt: now,
        nextAttemptAt: now,
        lastErrorCode: null,
        completedAt: null,
      },
      now,
    });
    return { accepted: true, updated };
  }
  if (result.kind === 'not_found') {
    const updated = await applyFullEnrichWebhookTransition({
      operationId: identity.operationId,
      generation: identity.generation,
      expectedStates: [...expectedStates],
      transition: {
        state: 'queued',
        providerRecordId,
        nextAttemptAt: now,
        lastErrorCode: 'fullenrich_no_email',
        completedAt: null,
      },
      now,
    });
    return { accepted: true, updated };
  }
  const updated = await applyFullEnrichWebhookTransition({
    operationId: identity.operationId,
    generation: identity.generation,
    expectedStates: [...expectedStates],
    transition: {
      state: 'failed',
      providerRecordId,
      lastErrorCode: result.code,
      completedAt: now,
    },
    now,
  });
  return { accepted: true, updated };
}
