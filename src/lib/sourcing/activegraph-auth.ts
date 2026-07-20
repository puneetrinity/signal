/**
 * Service JWT for ActiveGraph (Ealana Memory) calls.
 *
 * Signs RS256 tokens with SIGNAL_JWT_PRIVATE_KEY (same key as VantaHire
 * callbacks), issuer `signal`, audience `activekg` — ActiveGraph verifies the
 * signal issuer via its SIGNAL_JWT_PUBLIC_KEY and derives the tenant from the
 * `tenant_id` claim, which MUST be the canonical memory tenant (the same
 * `org_<id>` value carried on the inbound VantaHire request).
 */

import { SignJWT, importPKCS8 } from 'jose';
import { v4 as uuidv4 } from 'uuid';

const ACTIVEGRAPH_JWT_AUDIENCE = process.env.ACTIVEGRAPH_JWT_AUDIENCE || 'activekg';

let cachedKey: CryptoKey | null = null;

function decodePemMaybeBase64(pem: string): string {
  return pem.includes('-----BEGIN') ? pem : Buffer.from(pem, 'base64').toString('utf-8');
}

async function getSigningKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const pem = process.env.SIGNAL_JWT_PRIVATE_KEY;
  if (!pem) throw new Error('SIGNAL_JWT_PRIVATE_KEY not configured');
  cachedKey = await importPKCS8(decodePemMaybeBase64(pem), 'RS256');
  return cachedKey;
}

export async function signActiveGraphJWT(
  tenantId: string,
  scopes: 'kg:read' | 'kg:write',
  requestId?: string
): Promise<string> {
  const key = await getSigningKey();
  return new SignJWT({
    tenant_id: tenantId,
    request_id: requestId,
    scopes,
  })
    .setProtectedHeader({ alg: 'RS256', kid: process.env.SIGNAL_JWT_ACTIVE_KID || 'v1' })
    .setIssuer('signal')
    .setAudience(ACTIVEGRAPH_JWT_AUDIENCE)
    .setSubject('sourcing')
    .setExpirationTime('5m')
    .setIssuedAt()
    .setJti(uuidv4())
    .sign(key);
}
