/**
 * JWT-signed callback delivery to VantaHire with retry.
 */

import { SignJWT, importPKCS8 } from 'jose';
import { v4 as uuidv4 } from 'uuid';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import {
  releaseCrustdataReceiptPayloads,
  releaseDeliveredCrustdataReceiptPayloads,
} from './crustdata-acquisition';
import type { SourcingCallbackPayload } from './types';
import {
  candidatePrivacyAllowedRelationWhere,
  requireCandidatePrivacyAllowed,
  requireHealthyCandidatePrivacyContext,
} from '@/lib/candidate-privacy/repository';

const log = createLogger('SourcingCallback');

export const MAX_ATTEMPTS = 5;
export const BASE_DELAYS_MS = [1_000, 3_000, 10_000, 30_000];
const REQUEST_TIMEOUT_MS = 300_000; // 5 minutes

export interface SourcingExecutionFence {
  acquisitionGeneration: number;
  executionAttemptId: string;
  processingLeaseId: string;
}

export function buildCallbackStateWhere(
  requestId: string,
  tenantId: string,
  fence: SourcingExecutionFence | undefined,
  unlessDelivered: boolean,
): Prisma.JobSourcingRequestWhereInput {
  return {
    id: requestId,
    tenantId,
    ...(fence
      ? {
          acquisitionGeneration: fence.acquisitionGeneration,
          executionAttemptId: fence.executionAttemptId,
          processingLeaseId: fence.processingLeaseId,
        }
      : {}),
    ...(unlessDelivered
      ? {
          OR: [
            { callbackStatus: null },
            { callbackStatus: { not: 'delivered' } },
          ],
        }
      : {}),
  };
}

export function buildStaleCallbackWhere(
  cutoff: Date,
  tenantId?: string,
): Prisma.JobSourcingRequestWhereInput {
  return {
    callbackStatus: { in: ['failed', 'pending'] },
    status: 'complete',
    completedAt: { lt: cutoff },
    ...(tenantId ? { tenantId } : {}),
  };
}

async function executionFenceIsCurrent(
  requestId: string,
  tenantId: string,
  fence: SourcingExecutionFence | undefined,
  callbackMustNotBeDelivered = false,
): Promise<boolean> {
  const count = await prisma.jobSourcingRequest.count({
    where: buildCallbackStateWhere(
      requestId,
      tenantId,
      fence,
      callbackMustNotBeDelivered,
    ),
  });
  return count === 1;
}

async function updateCallbackState(
  requestId: string,
  tenantId: string,
  data: Parameters<typeof prisma.jobSourcingRequest.update>[0]['data'],
  fence: SourcingExecutionFence | undefined,
  unlessDelivered = false,
): Promise<boolean> {
  const updated = await prisma.jobSourcingRequest.updateMany({
    where: buildCallbackStateWhere(
      requestId,
      tenantId,
      fence,
      unlessDelivered,
    ),
    data,
  });
  return updated.count === 1;
}

export function jitteredDelay(baseMs: number): number {
  return Math.round(baseMs * (0.8 + Math.random() * 0.4));
}

let cachedKey: CryptoKey | null = null;

function decodePemMaybeBase64(pem: string): string {
  return pem.includes('-----BEGIN') ? pem : Buffer.from(pem, 'base64').toString('utf-8');
}

async function getSigningKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const pem = process.env.SIGNAL_JWT_PRIVATE_KEY;
  if (!pem) throw new Error('SIGNAL_JWT_PRIVATE_KEY not configured');
  const decoded = decodePemMaybeBase64(pem);
  cachedKey = await importPKCS8(decoded, 'RS256');
  return cachedKey;
}

async function signCallbackJWT(
  tenantId: string,
  requestId: string,
  payload: SourcingCallbackPayload,
): Promise<string> {
  const key = await getSigningKey();
  return new SignJWT({
    tenant_id: tenantId,
    request_id: requestId,
    ...(payload.acquisitionGeneration != null
      ? { acquisition_generation: payload.acquisitionGeneration }
      : {}),
    ...(payload.executionAttemptId
      ? { execution_attempt_id: payload.executionAttemptId }
      : {}),
    scopes: 'callbacks:write',
  })
    .setProtectedHeader({ alg: 'RS256', kid: process.env.SIGNAL_JWT_ACTIVE_KID || 'v1' })
    .setIssuer('signal')
    .setAudience('vantahire')
    .setSubject('sourcing')
    .setExpirationTime('5m')
    .setIssuedAt()
    .setJti(uuidv4())
    .sign(key);
}

export async function deliverCallback(
  requestId: string,
  tenantId: string,
  callbackUrl: string,
  payload: SourcingCallbackPayload,
  /** When false, only update callbackAttempts/lastCallbackError — don't touch status. */
  updateStatus = true,
  executionFence?: SourcingExecutionFence,
): Promise<boolean> {
  const privacyContext = await requireHealthyCandidatePrivacyContext();
  const candidateData = payload.candidateData as
    | { candidateId?: unknown }
    | undefined;
  if (typeof candidateData?.candidateId === 'string') {
    await requireCandidatePrivacyAllowed(
      tenantId,
      candidateData.candidateId,
    );
  }
  const allowedCandidateCount = await prisma.jobSourcingCandidate.count({
    where: {
      tenantId,
      sourcingRequestId: requestId,
      candidate: candidatePrivacyAllowedRelationWhere(privacyContext),
    },
  });
  const privacySafePayload: SourcingCallbackPayload = {
    ...payload,
    candidateCount: allowedCandidateCount,
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Wait before retry (skip on first attempt)
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, jitteredDelay(BASE_DELAYS_MS[attempt - 1])));
    }

    try {
      if (
        !(await executionFenceIsCurrent(
          requestId,
          tenantId,
          executionFence,
          updateStatus,
        ))
      ) {
        log.info(
          { requestId, executionFence },
          'Skipping callback for superseded sourcing execution',
        );
        return false;
      }
      const token = await signCallbackJWT(tenantId, requestId, privacySafePayload);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(privacySafePayload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.ok) {
        const updated = await updateCallbackState(
          requestId,
          tenantId,
          {
            ...(updateStatus ? { callbackStatus: 'delivered', callbackSentAt: new Date(), lastCallbackError: null } : {}),
            callbackAttempts: attempt + 1,
          },
          executionFence,
          updateStatus,
        );
        if (!updated) return false;
        if (
          updateStatus &&
          privacySafePayload.status === 'complete' &&
          executionFence
        ) {
          await releaseCrustdataReceiptPayloads(
            tenantId,
            requestId,
            executionFence.acquisitionGeneration,
          ).catch((error) => {
            log.warn(
              { requestId, error },
              'Callback delivered but Crustdata receipt payload cleanup failed',
            );
          });
        }
        log.info({ requestId, attempt: attempt + 1 }, 'Callback delivered');
        return true;
      }

      const errorText = `HTTP ${res.status}`;
      const nonRetryableUnknownRequest = res.status === 404;
      const updated = await updateCallbackState(
        requestId,
        tenantId,
        {
          callbackAttempts: attempt + 1,
          lastCallbackError: errorText,
        },
        executionFence,
        updateStatus,
      );
      if (!updated) return false;
      log.warn({ requestId, attempt: attempt + 1, error: errorText }, 'Callback attempt failed');
      if (nonRetryableUnknownRequest) {
        log.warn({ requestId }, 'Stopping callback retries due to non-retryable unknown request ID');
        break;
      }
    } catch (err) {
      const errorMsg = err instanceof Error
        ? `callback_error:${err.constructor.name}`
        : 'callback_error:UnknownError';
      const updated = await updateCallbackState(
        requestId,
        tenantId,
        {
          callbackAttempts: attempt + 1,
          lastCallbackError: errorMsg,
        },
        executionFence,
        updateStatus,
      );
      if (!updated) return false;
      log.warn({ requestId, attempt: attempt + 1, error: errorMsg }, 'Callback attempt error');
    }
  }

  // All attempts exhausted
  if (updateStatus) {
    await updateCallbackState(
      requestId,
      tenantId,
      { callbackStatus: 'failed' },
      executionFence,
      true,
    );
  }
  log.error({ requestId }, 'Callback delivery failed after all attempts');
  return false;
}

export async function redeliverStaleCallbacks(opts: {
  tenantId?: string;
  maxAgeMinutes?: number;
  limit?: number;
}): Promise<{ attempted: number; succeeded: number; failed: number }> {
  const maxAge = opts.maxAgeMinutes ?? 30;
  const limit = opts.limit ?? 50;
  const cutoff = new Date(Date.now() - maxAge * 60 * 1000);

  const staleRequests = await prisma.jobSourcingRequest.findMany({
    // `pending` also needs recovery: the request is marked complete before
    // callback delivery, so a worker crash or callback-state DB error can
    // otherwise strand the paid receipt forever.
    where: buildStaleCallbackWhere(cutoff, opts.tenantId),
    take: limit,
    orderBy: { completedAt: 'asc' },
  });

  let succeeded = 0;
  let failed = 0;

  await releaseDeliveredCrustdataReceiptPayloads(opts.tenantId).catch(
    (error) => {
      log.warn(
        { error },
        'Opportunistic Crustdata receipt payload cleanup failed',
      );
    },
  );

  for (const req of staleRequests) {
    const payload: SourcingCallbackPayload = {
      version: 1,
      requestId: req.id,
      externalJobId: req.externalJobId,
      acquisitionGeneration: req.acquisitionGeneration,
      executionAttemptId: req.executionAttemptId ?? undefined,
      status: 'complete',
      candidateCount: req.resultCount ?? 0,
    };

    try {
      const ok = await deliverCallback(
        req.id,
        req.tenantId,
        req.callbackUrl,
        payload,
        true,
        req.executionAttemptId && req.processingLeaseId
          ? {
              acquisitionGeneration: req.acquisitionGeneration,
              executionAttemptId: req.executionAttemptId,
              processingLeaseId: req.processingLeaseId,
            }
          : undefined,
      );
      if (ok) succeeded++;
      else failed++;
    } catch {
      failed++;
    }
  }

  log.info({ attempted: staleRequests.length, succeeded, failed }, 'Stale callback redelivery complete');
  return { attempted: staleRequests.length, succeeded, failed };
}
