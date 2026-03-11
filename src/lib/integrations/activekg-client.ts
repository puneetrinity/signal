/**
 * ActiveKG HTTP Client for Signal
 *
 * Typed client for communicating with ActiveKG's global memory endpoints.
 * Uses RS256 JWT auth signed with Signal's private key.
 * Includes a circuit breaker to avoid hammering a failing upstream.
 */

import { SignJWT, importPKCS8 } from 'jose';
import { createLogger } from '@/lib/logger';

const log = createLogger('ActiveKGClient');

const BASE_URL = process.env.ACTIVEKG_BASE_URL || 'http://localhost:8000';
const TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface GlobalCandidateUpsertRequest {
  linkedin_id?: string;
  linkedin_url?: string;
  github_id?: string;
  email_hash?: string;
  name?: string;
  headline?: string;
  location_city?: string;
  location_country_code?: string;
  location_confidence?: number;
  location_source?: string;
  role_family?: string;
  seniority_band?: string;
  skills_normalized?: string[];
  identity_confidence?: number;
  merge_status?: string;
}

export interface GlobalCandidateUpsertResponse {
  global_candidate_id: string;
  action: 'created' | 'updated';
}

export interface GlobalCandidateRecord {
  id: string;
  linkedin_id?: string;
  github_id?: string;
  email_hash?: string;
  name?: string;
  headline?: string;
  location_city?: string;
  location_country_code?: string;
  role_family?: string;
  seniority_band?: string;
  skills_normalized?: string[];
  identity_confidence?: number;
  merge_status?: string;
}

export interface ProvenanceCreateRequest {
  source_type: string;
  tenant_id?: string;
  source_detail?: Record<string, unknown>;
}

export interface AccessUpsertRequest {
  tenant_id: string;
  visibility: string;
  consent_state?: string;
  access_reason: string;
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

class CircuitBreaker {
  private failures: number[] = []; // timestamps of recent failures
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private lastOpenedAt = 0;

  private readonly failureThreshold = 5;
  private readonly windowMs = 60_000;
  private readonly halfOpenAfterMs = 30_000;

  /** Throw if the circuit is open and not yet eligible for half-open probe. */
  check(): void {
    this.pruneWindow();

    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastOpenedAt;
      if (elapsed >= this.halfOpenAfterMs) {
        this.state = 'half-open';
        log.info('circuit breaker half-open, allowing probe request');
      } else {
        throw new Error(
          `ActiveKG circuit breaker open – rejecting request (retry in ${Math.ceil((this.halfOpenAfterMs - elapsed) / 1000)}s)`
        );
      }
    }
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      log.info('circuit breaker closing after successful probe');
      this.state = 'closed';
      this.failures = [];
    }
  }

  recordFailure(): void {
    const now = Date.now();
    this.failures.push(now);

    if (this.state === 'half-open') {
      log.warn('circuit breaker re-opening after failed probe');
      this.state = 'open';
      this.lastOpenedAt = now;
      return;
    }

    this.pruneWindow();
    if (this.failures.length >= this.failureThreshold) {
      log.warn(
        { failures: this.failures.length, windowMs: this.windowMs },
        'circuit breaker opening'
      );
      this.state = 'open';
      this.lastOpenedAt = now;
    }
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }
}

const breaker = new CircuitBreaker();

// ---------------------------------------------------------------------------
// JWT Signing
// ---------------------------------------------------------------------------

let cachedKey: CryptoKey | null = null;

async function getPrivateKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  const pem = process.env.SIGNAL_JWT_PRIVATE_KEY;
  if (!pem) throw new Error('SIGNAL_JWT_PRIVATE_KEY not configured');

  cachedKey = await importPKCS8(pem, 'RS256');
  return cachedKey;
}

async function signActiveKGJwt(tenantId: string): Promise<string> {
  const privateKey = await getPrivateKey();

  return new SignJWT({
    tenant_id: tenantId,
    scopes: 'kg:write kg:read',
    actor_type: 'service',
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer('signal')
    .setAudience('activekg')
    .setSubject('signal-service')
    .setExpirationTime('5m')
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(
  method: string,
  path: string,
  tenantId: string,
  body?: unknown
): Promise<T> {
  breaker.check();

  const url = `${BASE_URL}${path}`;
  const token = await signActiveKGJwt(tenantId);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      },
      TIMEOUT_MS
    );

    if (response.ok) {
      breaker.recordSuccess();
      // Some endpoints return 204 with no body
      if (response.status === 204) return undefined as unknown as T;
      return (await response.json()) as T;
    }

    const text = await response.text().catch(() => '');
    const msg = `ActiveKG ${method} ${path} failed: ${response.status} ${text.slice(0, 200)}`;

    // 404 is not a circuit-breaker-worthy failure
    if (response.status === 404) {
      throw new ActiveKGError(msg, response.status);
    }

    breaker.recordFailure();
    throw new ActiveKGError(msg, response.status);
  } catch (error) {
    if (error instanceof ActiveKGError) throw error;

    // Network / timeout error
    breaker.recordFailure();
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? 'request timeout'
        : error instanceof Error
          ? error.message
          : String(error);
    throw new ActiveKGError(`ActiveKG ${method} ${path}: ${reason}`, 0);
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ActiveKGError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'ActiveKGError';
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export const activeKGClient = {
  async upsertGlobalCandidate(
    tenantId: string,
    data: GlobalCandidateUpsertRequest
  ): Promise<GlobalCandidateUpsertResponse> {
    log.debug({ tenantId }, 'upserting global candidate');
    return request<GlobalCandidateUpsertResponse>(
      'POST',
      '/global-candidates/upsert',
      tenantId,
      data
    );
  },

  async findGlobalCandidate(
    tenantId: string,
    anchors: {
      linkedin_id?: string;
      github_id?: string;
      email_hash?: string;
    }
  ): Promise<GlobalCandidateRecord | null> {
    const params = new URLSearchParams();
    if (anchors.linkedin_id) params.set('linkedin_id', anchors.linkedin_id);
    if (anchors.github_id) params.set('github_id', anchors.github_id);
    if (anchors.email_hash) params.set('email_hash', anchors.email_hash);

    log.debug({ tenantId, anchors }, 'finding global candidate');

    try {
      return await request<GlobalCandidateRecord>(
        'GET',
        `/global-candidates/by-anchor?${params.toString()}`,
        tenantId
      );
    } catch (error) {
      if (error instanceof ActiveKGError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  },

  async upsertProvenance(
    tenantId: string,
    globalCandidateId: string,
    data: ProvenanceCreateRequest
  ): Promise<void> {
    log.debug({ tenantId, globalCandidateId }, 'upserting provenance');
    await request<void>(
      'POST',
      `/global-candidates/${encodeURIComponent(globalCandidateId)}/provenance`,
      tenantId,
      data
    );
  },

  async upsertAccess(
    tenantId: string,
    globalCandidateId: string,
    data: AccessUpsertRequest
  ): Promise<void> {
    log.debug({ tenantId, globalCandidateId }, 'upserting access');
    await request<void>(
      'POST',
      `/global-candidates/${encodeURIComponent(globalCandidateId)}/access`,
      tenantId,
      data
    );
  },
};
