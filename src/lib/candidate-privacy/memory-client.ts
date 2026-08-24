import { signCandidatePrivacyJWT } from '@/lib/sourcing/activegraph-auth';
import type { CandidatePrivacyConfig } from './config';
import { loadCandidatePrivacyConfig } from './config';
import {
  changesResponseSchema,
  eligibilityResponseSchema,
  snapshotResponseSchema,
  type CandidatePrivacyDecision,
  type CandidatePrivacyEligibilitySubject,
} from './models';

const MAX_RESPONSE_BYTES = 256 * 1024;

export type CandidatePrivacyMemoryErrorCode =
  | 'candidate_privacy_unavailable'
  | 'candidate_privacy_conflict'
  | 'candidate_privacy_response_invalid';

export class CandidatePrivacyMemoryError extends Error {
  constructor(
    public readonly code: CandidatePrivacyMemoryErrorCode,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'CandidatePrivacyMemoryError';
  }
}

export interface CandidatePrivacyMemoryClient {
  eligibilityBatch(
    subjects: CandidatePrivacyEligibilitySubject[],
  ): Promise<Map<string, CandidatePrivacyDecision>>;
  readChanges(afterCursor: number): Promise<{
    events: Array<{ cursor: number }>;
    count: number;
  }>;
  readHighWater(): Promise<number>;
}

export class HttpCandidatePrivacyMemoryClient implements CandidatePrivacyMemoryClient {
  private readonly config: CandidatePrivacyConfig;

  constructor(
    config: CandidatePrivacyConfig = loadCandidatePrivacyConfig(
      process.env,
      { requireProcessor: true },
    ),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.config = config;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      const token = await signCandidatePrivacyJWT();
      response = await this.fetchImpl(`${this.config.memoryBaseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
      });
    } catch {
      throw new CandidatePrivacyMemoryError('candidate_privacy_unavailable', true);
    }

    if (!response.ok) {
      if (response.status === 409) {
        throw new CandidatePrivacyMemoryError('candidate_privacy_conflict', false);
      }
      throw new CandidatePrivacyMemoryError(
        'candidate_privacy_unavailable',
        response.status === 429 || response.status >= 500,
      );
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (!Number.isFinite(contentLength) || contentLength > MAX_RESPONSE_BYTES) {
      throw new CandidatePrivacyMemoryError('candidate_privacy_response_invalid', false);
    }
    try {
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new CandidatePrivacyMemoryError('candidate_privacy_response_invalid', false);
      }
      return JSON.parse(body);
    } catch (error) {
      if (error instanceof CandidatePrivacyMemoryError) throw error;
      throw new CandidatePrivacyMemoryError('candidate_privacy_response_invalid', false);
    }
  }

  async eligibilityBatch(
    subjects: CandidatePrivacyEligibilitySubject[],
  ): Promise<Map<string, CandidatePrivacyDecision>> {
    if (subjects.length < 1 || subjects.length > this.config.eligibilityBatchSize) {
      throw new CandidatePrivacyMemoryError('candidate_privacy_response_invalid', false);
    }
    const parsed = eligibilityResponseSchema.safeParse(await this.request(
      '/candidate-privacy/eligibility/batch',
      { method: 'POST', body: JSON.stringify({ subjects }) },
    ));
    if (!parsed.success || parsed.data.count !== subjects.length) {
      throw new CandidatePrivacyMemoryError('candidate_privacy_response_invalid', false);
    }
    const decisions = new Map<string, CandidatePrivacyDecision>();
    for (const result of parsed.data.results) {
      if (decisions.has(result.request_ref)) {
        throw new CandidatePrivacyMemoryError('candidate_privacy_response_invalid', false);
      }
      decisions.set(result.request_ref, result.decision);
    }
    if (
      decisions.size !== subjects.length ||
      subjects.some((subject) => !decisions.has(subject.request_ref))
    ) {
      throw new CandidatePrivacyMemoryError('candidate_privacy_response_invalid', false);
    }
    return decisions;
  }

  async readChanges(afterCursor: number): Promise<{
    events: Array<{ cursor: number }>;
    count: number;
  }> {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new CandidatePrivacyMemoryError('candidate_privacy_response_invalid', false);
    }
    const query = new URLSearchParams({
      after_cursor: String(afterCursor),
      limit: String(this.config.feedPageSize),
    });
    const parsed = changesResponseSchema.safeParse(await this.request(
      `/candidate-privacy/changes?${query.toString()}`,
      { method: 'GET' },
    ));
    if (!parsed.success || parsed.data.count !== parsed.data.events.length) {
      throw new CandidatePrivacyMemoryError('candidate_privacy_response_invalid', false);
    }
    let previous = afterCursor;
    for (const event of parsed.data.events) {
      if (event.cursor !== previous + 1) {
        throw new CandidatePrivacyMemoryError('candidate_privacy_response_invalid', false);
      }
      previous = event.cursor;
    }
    return parsed.data;
  }

  async readHighWater(): Promise<number> {
    const parsed = snapshotResponseSchema.safeParse(await this.request(
      '/candidate-privacy/snapshot?limit=1',
      { method: 'GET' },
    ));
    if (!parsed.success || parsed.data.count !== parsed.data.directives.length) {
      throw new CandidatePrivacyMemoryError('candidate_privacy_response_invalid', false);
    }
    return parsed.data.high_water_cursor;
  }
}
