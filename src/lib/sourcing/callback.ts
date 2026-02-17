/**
 * JWT-signed callback delivery to VantaHire with retry.
 */

import { SignJWT, importPKCS8 } from 'jose';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import type { SourcingCallbackPayload } from './types';

const log = createLogger('SourcingCallback');

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 5_000]; // delays between attempts (factor 5)
const REQUEST_TIMEOUT_MS = 10_000;

let cachedKey: CryptoKey | null = null;

async function getSigningKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const pem = process.env.SIGNAL_JWT_PRIVATE_KEY;
  if (!pem) throw new Error('SIGNAL_JWT_PRIVATE_KEY not configured');
  cachedKey = await importPKCS8(pem, 'RS256');
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
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
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
