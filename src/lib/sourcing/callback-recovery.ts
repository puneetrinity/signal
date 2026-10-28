/**
 * Recovery for governed failure callbacks.
 *
 * Flow refunds a search when Discover reports it failed, so a failure callback
 * must eventually reach Flow even across deployments and outages. This path:
 * - selects only governed failed searches finished since the configured floor
 *   (historical callbacks are never resent, completions are out of scope);
 * - resends with the original execution identity and fence, and stops once
 *   Flow acknowledges (deliverCallback marks the request `delivered`);
 * - backs off per request, retries least-attempted first so a repeatedly
 *   failing callback cannot starve newer ones, and bounds work per cycle;
 * - after the retry bound, keeps the callback pending and flags it for operator
 *   review instead of abandoning it.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { deliverCallback } from './callback';
import type { SourcingCallbackPayload } from './types';

const log = createLogger('SourcingCallbackRecovery');

export const RECOVERY_MAX_ATTEMPTS = 12;
export const RECOVERY_BATCH_SIZE = 10;
const RECOVERY_MIN_AGE_MS = 5 * 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60_000;

/** Strict ISO-8601 UTC instant in the past, or null (fail closed). */
export function parseRedeliveryNotBefore(raw: string | undefined, now = new Date()): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(raw)) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) || at.getTime() > now.getTime() ? null : at;
}

/** Delay before the next attempt after `attempts` recovery attempts: 1, 2, 4… minutes, capped at 6 hours. */
export function recoveryBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
}

export function buildFailureRecoveryWhere(notBefore: Date, now: Date, maxAttempts = RECOVERY_MAX_ATTEMPTS): Prisma.JobSourcingRequestWhereInput {
  return {
    status: 'failed',
    flowRunId: { not: null },
    callbackStatus: { in: ['failed', 'pending'] },
    completedAt: { gte: notBefore, lt: new Date(now.getTime() - RECOVERY_MIN_AGE_MS) },
    callbackReviewRequiredAt: null,
    // Exhausted-but-unflagged rows (crash after the final claim) are selected
    // immediately so they are settled for review, never sent.
    OR: [{ callbackNextRedeliveryAt: null }, { callbackNextRedeliveryAt: { lte: now } }, { callbackRedeliveryAttempts: { gte: maxAttempts } }],
  };
}

type Delivery = typeof deliverCallback;

export async function redeliverFailedCallbacks(opts: {
  notBefore: Date;
  limit?: number;
  maxAttempts?: number;
  now?: () => Date;
  deliver?: Delivery;
}): Promise<{ attempted: number; succeeded: number; failed: number; review: number }> {
  const now = opts.now ?? (() => new Date());
  const limit = Math.min(Math.max(1, opts.limit ?? RECOVERY_BATCH_SIZE), 50);
  const maxAttempts = opts.maxAttempts ?? RECOVERY_MAX_ATTEMPTS;
  const deliver = opts.deliver ?? deliverCallback;
  const due = await prisma.jobSourcingRequest.findMany({
    where: buildFailureRecoveryWhere(opts.notBefore, now(), maxAttempts),
    orderBy: [{ callbackRedeliveryAttempts: 'asc' }, { completedAt: 'asc' }],
    take: limit,
  });
  let attempted = 0, succeeded = 0, failed = 0, review = 0;
  const flagForReview = async (req: (typeof due)[number], attempts: number): Promise<void> => {
    const flagged = await prisma.jobSourcingRequest.updateMany({
      where: { id: req.id, tenantId: req.tenantId, acquisitionGeneration: req.acquisitionGeneration,
        callbackRedeliveryAttempts: attempts, callbackReviewRequiredAt: null, callbackStatus: { in: ['failed', 'pending'] } },
      data: { callbackReviewRequiredAt: now(), callbackNextRedeliveryAt: null },
    });
    if (flagged.count === 1) {
      review++;
      // Identifiers only. The pending callback is the durable obligation; this log
      // line and the review flag are the operator alert (low priority, no email).
      // releaseCallbackReview() returns it to automatic recovery.
      log.error({ requestId: req.id, tenantId: req.tenantId, attempts, code: 'CALLBACK_REDELIVERY_EXHAUSTED' },
        '[callback-review-required] failure callback needs operator review');
    }
  };
  for (const req of due) {
    // The budget is recovery attempts (each deliverCallback also retries HTTP
    // internally). A row already at the budget is never sent again: it is settled
    // for review first, which also covers a crash after the final claim.
    if (req.callbackRedeliveryAttempts >= maxAttempts) {
      await flagForReview(req, req.callbackRedeliveryAttempts);
      continue;
    }
    const attempts = req.callbackRedeliveryAttempts + 1;
    // Claim this attempt before sending, so a crash still advances the schedule
    // and two workers never send the same attempt.
    const claimed = await prisma.jobSourcingRequest.updateMany({
      where: { id: req.id, tenantId: req.tenantId, acquisitionGeneration: req.acquisitionGeneration,
        callbackRedeliveryAttempts: { equals: req.callbackRedeliveryAttempts, lt: maxAttempts },
        callbackReviewRequiredAt: null, callbackStatus: { in: ['failed', 'pending'] } },
      data: { callbackRedeliveryAttempts: attempts, callbackNextRedeliveryAt: new Date(now().getTime() + recoveryBackoffMs(attempts)) },
    });
    if (claimed.count !== 1) continue;
    attempted++;
    const payload: SourcingCallbackPayload = {
      version: 1,
      requestId: req.id,
      externalJobId: req.externalJobId,
      acquisitionGeneration: req.acquisitionGeneration,
      executionAttemptId: req.executionAttemptId ?? undefined,
      status: 'failed',
      candidateCount: req.resultCount ?? 0,
    };
    let ok = false;
    try {
      ok = await deliver(req.id, req.tenantId, req.callbackUrl, payload, true,
        req.executionAttemptId && req.processingLeaseId
          ? { acquisitionGeneration: req.acquisitionGeneration, executionAttemptId: req.executionAttemptId, processingLeaseId: req.processingLeaseId }
          : undefined);
    } catch {
      ok = false;
    }
    if (ok) { succeeded++; continue; }
    failed++;
    if (attempts >= maxAttempts) await flagForReview(req, attempts);
  }
  if (attempted > 0) log.info({ attempted, succeeded, failed, review }, 'Failure callback recovery cycle complete');
  return { attempted, succeeded, failed, review };
}

/** Operator action after review: return a flagged failure callback to automatic
 * recovery with a fresh retry budget. Never touches a delivered callback. */
export async function releaseCallbackReview(input: { requestId: string; tenantId: string }): Promise<boolean> {
  const released = await prisma.jobSourcingRequest.updateMany({
    where: { id: input.requestId, tenantId: input.tenantId, status: 'failed', flowRunId: { not: null },
      callbackReviewRequiredAt: { not: null }, callbackStatus: { in: ['failed', 'pending'] } },
    data: { callbackReviewRequiredAt: null, callbackRedeliveryAttempts: 0, callbackNextRedeliveryAt: null },
  });
  return released.count === 1;
}
