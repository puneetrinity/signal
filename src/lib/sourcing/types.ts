/**
 * Shared types for the v3 sourcing pipeline.
 */

export type SourcingRequestStatus =
  | 'queued'
  | 'processing'
  | 'complete'
  | 'callback_sent'
  | 'callback_failed'
  | 'failed';

export interface SourcingJobData {
  requestId: string;
  tenantId: string;
  externalJobId: string;
  callbackUrl: string;
}

export interface SourcingJobResult {
  requestId: string;
  status: SourcingRequestStatus;
  candidateCount: number;
  enrichedCount: number;
  durationMs: number;
  error?: string;
}

export interface SourcingCallbackPayload {
  version: 1;
  requestId: string;
  externalJobId: string;
  status: 'complete' | 'partial' | 'failed';
  candidateCount: number;
  enrichedCount: number;
  error?: string;
}
