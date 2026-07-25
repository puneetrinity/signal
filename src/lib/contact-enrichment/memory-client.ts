import { z } from 'zod';
import { signActiveGraphJWT } from '@/lib/sourcing/activegraph-auth';
import {
  normalizeContactEmail,
  type StagedContactEvidence,
} from './types';

const ACTIVEGRAPH_URL =
  process.env.ACTIVEGRAPH_URL || 'http://localhost:8000';
const DEFAULT_TIMEOUT_MS = 10_000;

export const CONTACT_EVIDENCE_LOOKUP_PATH =
  '/contact-evidence/lookup';
export const CONTACT_EVIDENCE_RECORD_PATH =
  '/contact-evidence/record';

const memoryContactSchema = z.object({
  email: z.string(),
  provider: z.enum(['fullenrich', 'enrichlayer']),
  provider_record_id: z.string().nullable().optional(),
  confidence: z.number(),
  observed_at: z.string(),
  validated_at: z.string().nullable().optional(),
  status: z.string(),
});

const lookupResultSchema = z.object({
  global_candidate_id: z.string().uuid(),
  state: z.enum(['found', 'suppressed', 'miss']),
  contact: memoryContactSchema.nullable().optional(),
  reason: z.string().nullable().optional(),
});

const lookupResponseSchema = z.object({
  results: z.array(lookupResultSchema),
});

export type MemoryContactLookupResult =
  | { state: 'found'; email: string }
  | { state: 'suppressed' }
  | { state: 'miss' };

export class MemoryContactUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MemoryContactUnavailableError';
  }
}

export interface ContactMemoryClient {
  lookup(input: {
    tenantId: string;
    globalCandidateId: string;
  }): Promise<MemoryContactLookupResult>;
  record(input: {
    tenantId: string;
    evidence: StagedContactEvidence;
  }): Promise<MemoryContactLookupResult>;
}

async function fetchMemory(
  path: string,
  tenantId: string,
  scope: 'contact:read' | 'contact:write',
  body: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number.parseInt(
      process.env.CONTACT_MEMORY_TIMEOUT_MS ||
        String(DEFAULT_TIMEOUT_MS),
      10,
    ),
  );
  try {
    const token = await signActiveGraphJWT(tenantId, scope);
    const response = await fetch(`${ACTIVEGRAPH_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new MemoryContactUnavailableError(
        response.status >= 500
          ? 'memory_unavailable'
          : 'memory_contract_rejected',
      );
    }
    try {
      return await response.json();
    } catch {
      throw new MemoryContactUnavailableError(
        'memory_invalid_response',
      );
    }
  } catch (error) {
    if (error instanceof MemoryContactUnavailableError) throw error;
    throw new MemoryContactUnavailableError(
      error instanceof Error && error.name === 'AbortError'
        ? 'memory_timeout'
        : 'memory_unavailable',
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseLookup(
  payload: unknown,
  globalCandidateId: string,
): MemoryContactLookupResult {
  const parsed = lookupResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new MemoryContactUnavailableError(
      'memory_invalid_response',
    );
  }
  const result = parsed.data.results.find(
    (item) => item.global_candidate_id === globalCandidateId,
  );
  if (!result) {
    throw new MemoryContactUnavailableError(
      'memory_missing_result',
    );
  }
  if (result.state === 'suppressed') return { state: 'suppressed' };
  if (result.state === 'miss') return { state: 'miss' };
  const email = normalizeContactEmail(result.contact?.email);
  if (!email) {
    throw new MemoryContactUnavailableError(
      'memory_invalid_contact',
    );
  }
  return { state: 'found', email };
}

export class ActiveGraphContactMemoryClient
  implements ContactMemoryClient
{
  async lookup({
    tenantId,
    globalCandidateId,
  }: {
    tenantId: string;
    globalCandidateId: string;
  }): Promise<MemoryContactLookupResult> {
    const payload = await fetchMemory(
      CONTACT_EVIDENCE_LOOKUP_PATH,
      tenantId,
      'contact:read',
      { global_candidate_ids: [globalCandidateId] },
    );
    return parseLookup(payload, globalCandidateId);
  }

  async record({
    tenantId,
    evidence,
  }: {
    tenantId: string;
    evidence: StagedContactEvidence;
  }): Promise<MemoryContactLookupResult> {
    for (const item of evidence.items) {
      await fetchMemory(
        CONTACT_EVIDENCE_RECORD_PATH,
        tenantId,
        'contact:write',
        {
          global_candidate_id: evidence.globalCandidateId,
          email: item.email,
          provider: item.provider,
          provider_record_id: item.providerRecordId,
          confidence: item.confidence,
          observed_at: item.observedAt,
          validated_at: item.validatedAt,
          status: item.status,
        },
      );
    }
    return this.lookup({
      tenantId,
      globalCandidateId: evidence.globalCandidateId,
    });
  }
}
