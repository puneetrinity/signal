export const CONTACT_OPERATION_STATES = [
  'queued',
  'awaiting_global_id',
  'memory_lookup',
  'fullenrich_starting',
  'fullenrich_polling',
  'fullenrich_ambiguous',
  'enrichlayer_starting',
  'enrichlayer_ambiguous',
  'evidence_pending',
  'found',
  'suppressed',
  'not_found',
  'failed',
] as const;

export type ContactOperationState =
  (typeof CONTACT_OPERATION_STATES)[number];

export type ContactProvider = 'fullenrich' | 'enrichlayer';

export type ContactEvidenceStatus = 'found' | 'verified';

export interface StagedContactEvidenceItem {
  email: string;
  provider: ContactProvider;
  providerRecordId: string | null;
  confidence: number;
  observedAt: string;
  validatedAt: string | null;
  status: ContactEvidenceStatus;
}

export interface StagedContactEvidence {
  version: 1;
  globalCandidateId: string;
  items: StagedContactEvidenceItem[];
}

export interface ContactOperationSnapshot {
  id: string;
  tenantId: string;
  candidateId: string;
  globalCandidateId: string | null;
  state: ContactOperationState;
  generation: number;
  provider: ContactProvider | null;
  providerRequestKey: string | null;
  providerRecordId: string | null;
  stagedEvidence: StagedContactEvidence | null;
  stagedAt: Date | null;
  attempts: number;
  nextAttemptAt: Date;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
  providerStartedAt: Date | null;
  selectedEmail: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaimedContactOperation extends ContactOperationSnapshot {
  leaseToken: string;
  leaseExpiresAt: Date;
  linkedinUrl: string;
  nameHint: string | null;
  companyHint: string | null;
  linkedGlobalCandidateId: string | null;
}

export function normalizeContactEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }
  return email;
}

export function parseContactOperationState(
  value: string,
): ContactOperationState {
  if (
    (CONTACT_OPERATION_STATES as readonly string[]).includes(value)
  ) {
    return value as ContactOperationState;
  }
  throw new Error('Unknown contact operation state');
}

export function sanitizeContactErrorCode(
  value: string | null | undefined,
  fallback = 'contact_enrichment_failed',
): string {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-z0-9_]{1,80}$/.test(normalized)
    ? normalized
    : fallback;
}
