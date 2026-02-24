/**
 * JWT-signed callback delivery to VantaHire with retry.
 */

import { SignJWT, importPKCS8 } from 'jose';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import type { SourcingCallbackPayload } from './types';

const log = createLogger('SourcingCallback');

export const MAX_ATTEMPTS = 5;
export const BASE_DELAYS_MS = [1_000, 3_000, 10_000, 30_000];
const REQUEST_TIMEOUT_MS = 10_000;

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

async function signCallbackJWT(tenantId: string, requestId: string): Promise<string> {
  const key = await getSigningKey();
  return new SignJWT({
    tenant_id: tenantId,
    request_id: requestId,
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
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Wait before retry (skip on first attempt)
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, jitteredDelay(BASE_DELAYS_MS[attempt - 1])));
    }

    try {
      const token = await signCallbackJWT(tenantId, requestId);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.ok) {
        await prisma.jobSourcingRequest.update({
          where: { id: requestId },
          data: {
            ...(updateStatus ? { status: 'callback_sent' } : {}),
            callbackAttempts: attempt + 1,
          },
        });
        log.info({ requestId, attempt: attempt + 1 }, 'Callback delivered');
        return true;
      }

      const errorText = `HTTP ${res.status}: ${await res.text().catch(() => '')}`;
      await prisma.jobSourcingRequest.update({
        where: { id: requestId },
        data: {
          callbackAttempts: attempt + 1,
          lastCallbackError: errorText,
        },
      });
      log.warn({ requestId, attempt: attempt + 1, error: errorText }, 'Callback attempt failed');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      await prisma.jobSourcingRequest.update({
        where: { id: requestId },
        data: {
          callbackAttempts: attempt + 1,
          lastCallbackError: errorMsg,
        },
      });
      log.warn({ requestId, attempt: attempt + 1, error: errorMsg }, 'Callback attempt error');
    }
  }

  // All attempts exhausted
  if (updateStatus) {
    await prisma.jobSourcingRequest.update({
      where: { id: requestId },
      data: { status: 'callback_failed' },
    });
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
    where: {
      status: 'callback_failed',
      completedAt: { lt: cutoff },
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
    take: limit,
    orderBy: { completedAt: 'asc' },
  });

  let succeeded = 0;
  let failed = 0;

  for (const req of staleRequests) {
    const payload: SourcingCallbackPayload = {
      version: 1,
      requestId: req.id,
      externalJobId: req.externalJobId,
      status: 'complete',
      candidateCount: req.resultCount ?? 0,
      enrichedCount: 0,
    };

    try {
      const ok = await deliverCallback(req.id, req.tenantId, req.callbackUrl, payload, true);
      if (ok) succeeded++;
      else failed++;
    } catch {
      failed++;
    }
  }

  log.info({ attempted: staleRequests.length, succeeded, failed }, 'Stale callback redelivery complete');
  return { attempted: staleRequests.length, succeeded, failed };
}
