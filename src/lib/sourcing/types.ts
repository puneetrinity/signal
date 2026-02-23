/**
 * Shared types for the v3 sourcing pipeline.
 */

export type JobTrack = 'tech' | 'non_tech' | 'blended';

export interface TrackDecision {
  track: JobTrack;
  confidence: number;
  method: 'deterministic' | 'groq' | 'deterministic+groq';
  classifierVersion: string;
  deterministicSignals: {
    techScore: number;
    nonTechScore: number;
    matchedTechKeywords: string[];
    matchedNonTechKeywords: string[];
    roleFamilySignal: string | null;
  };
  groqResult?: {
    track: 'tech' | 'non_tech';
    confidence: number;
    reasons: string[];
    ambiguityFlag: boolean;
    modelName: string;
    latencyMs: number;
    cached: boolean;
  };
  hintUsed?: { hint: string; source: string; reason?: string };
  resolvedAt: string;
}

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
  resolvedTrack?: TrackDecision;
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
