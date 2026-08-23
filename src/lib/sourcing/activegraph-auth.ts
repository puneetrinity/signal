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

export type ActiveGraphScope =
  | 'kg:read'
  | 'kg:write'
  | 'contact:read'
  | 'contact:write';

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
  scopes: ActiveGraphScope,
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

/**
 * Candidate privacy is a distinct, read-only Memory authority. Keep its
 * actor/scope contract separate from the existing tenant sourcing signer so a
 * generic KG caller cannot silently gain directive write authority.
 */
export async function signCandidatePrivacyJWT(): Promise<string> {
  const key = await getSigningKey();
  const actorId = process.env.SIGNAL_CANDIDATE_PRIVACY_ACTOR_ID ?? 'signal-service';
  if (actorId !== 'signal-service') {
    throw new Error('candidate_privacy_configuration_invalid');
  }
  return new SignJWT({
    tenant_id: 'platform',
    scopes: 'candidate-privacy:read',
    actor_type: 'service',
  })
    .setProtectedHeader({ alg: 'RS256', kid: process.env.SIGNAL_JWT_ACTIVE_KID || 'v1' })
    .setIssuer('signal')
    .setAudience('activekg')
    .setSubject(actorId)
    .setExpirationTime('5m')
    .setIssuedAt()
    .setJti(uuidv4())
    .sign(key);
}
