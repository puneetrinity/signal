/**
 * v3 Service-to-Service JWT Authentication (RS256)
 *
 * Independent of Clerk auth. Used exclusively by /api/v3/* routes.
 * Verifies RS256-signed JWTs issued by VantaHire, with jti replay guard via Redis.
 *
 * Fail-closed: if Redis is unavailable (including NoopRedis), returns 503.
 */

import { importSPKI, jwtVerify, errors } from 'jose';
import { NextRequest } from 'next/server';
import { redis } from '@/lib/redis/client';

export interface ServiceAuthContext {
  tenantId: string;
  sub: string;
  actorType: string;
  scopes: string[];
  requestId?: string;
  jti: string;
}

type VerifyResult =
  | { authorized: true; context: ServiceAuthContext }
  | { authorized: false; response: Response };

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
    },
  });
}

function fail401(error: string): { authorized: false; response: Response } {
  return { authorized: false, response: jsonResponse(401, { success: false, error }) };
}

function fail403(error: string): { authorized: false; response: Response } {
  return { authorized: false, response: jsonResponse(403, { success: false, error }) };
}

function fail503(error: string): { authorized: false; response: Response } {
  return { authorized: false, response: jsonResponse(503, { success: false, error }) };
}

export async function verifyServiceJWT(request: NextRequest): Promise<VerifyResult> {
  // 1. Extract Bearer token
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return fail401('Missing or invalid Authorization header');
  }
  const token = authHeader.slice(7);

  // 2. Import public key
  const publicKeyPem = process.env.VANTAHIRE_JWT_PUBLIC_KEY;
  if (!publicKeyPem) {
    console.error('[ServiceAuth] VANTAHIRE_JWT_PUBLIC_KEY not configured');
    return fail401('Service authentication not configured');
  }

  let key;
  try {
    key = await importSPKI(publicKeyPem, 'RS256');
  } catch (err) {
    console.error('[ServiceAuth] Failed to import public key:', err);
    return fail401('Service authentication not configured');
  }

  // 3. Verify JWT (signature, exp, nbf, aud, iss)
  let payload;
  try {
    const result = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      audience: 'signal',
      issuer: 'vantahire',
      clockTolerance: 5,
    });
    payload = result.payload;
  } catch (err) {
    // Wrong aud or iss → 403 per integration spec
    if (err instanceof errors.JWTClaimValidationFailed && (err.claim === 'aud' || err.claim === 'iss')) {
      return fail403(`Invalid token: ${err.message}`);
    }
    const message = err instanceof Error ? err.message : 'Token verification failed';
    return fail401(`Invalid token: ${message}`);
  }

  // 4. Validate required custom claims
  const tenantId = payload.tenant_id;
  const sub = payload.sub;
  const scopes = payload.scopes;
  const jti = payload.jti;
  const actorType = payload.actor_type;

  if (typeof tenantId !== 'string' || !tenantId) {
    return fail401('Missing required claim: tenant_id');
  }
  if (typeof sub !== 'string' || !sub) {
    return fail401('Missing required claim: sub');
  }
  // scopes: space-delimited string per integration spec (e.g. "jobs:source pdl:contact")
  if (typeof scopes !== 'string' || !scopes) {
    return fail401('Missing or invalid claim: scopes');
  }
  const scopeList = scopes.split(' ').filter(Boolean);
  if (typeof jti !== 'string' || !jti) {
    return fail401('Missing required claim: jti');
  }

  // 5. JTI replay guard — fail-closed (Redis required)
  try {
    // Calculate remaining TTL from exp claim
    const exp = payload.exp;
    if (typeof exp !== 'number') {
      return fail401('Missing required claim: exp');
    }
    const now = Math.floor(Date.now() / 1000);
    const remainingTTL = exp - now;
    if (remainingTTL <= 0) {
      return fail401('Token expired');
    }

    // Detect NoopRedis (fail-closed: no Redis = no service auth)
    const ping = await redis.ping();
    if (ping === 'DISABLED') {
      console.error('[ServiceAuth] Redis not available — fail-closed, rejecting request');
      return fail503('Service temporarily unavailable (replay guard offline)');
    }

    // Atomic SET NX EX — returns 'OK' if set, null if key already exists
    const redisResult = await (redis as import('ioredis').default).set(
      `jwt:jti:${tenantId}:${jti}`,
      '1',
      'EX',
      remainingTTL,
      'NX',
    );

    if (redisResult !== 'OK') {
      return fail401('Token already used (replay detected)');
    }
  } catch (err) {
    console.error('[ServiceAuth] Redis error during JTI check:', err);
    return fail503('Service temporarily unavailable (replay guard error)');
  }

  // 6. Return context
  const context: ServiceAuthContext = {
    tenantId: tenantId as string,
    sub,
    actorType: typeof actorType === 'string' ? actorType : 'service',
    scopes: scopeList,
    requestId: typeof payload.request_id === 'string' ? payload.request_id : undefined,
    jti,
  };

  return { authorized: true, context };
}
