import { z } from 'zod';

export const privacyDecisionSchema = z.enum([
  'allow',
  'block_global',
  'block_all',
  'review',
]);
export type CandidatePrivacyDecision = z.infer<typeof privacyDecisionSchema>;

export const privacySyncStatusSchema = z.enum([
  'uninitialized',
  'healthy',
  'stale',
  'rebuilding',
  'needs_reconciliation',
]);
export type CandidatePrivacySyncStatus = z.infer<typeof privacySyncStatusSchema>;

export const privacyIdentifierTypeSchema = z.enum([
  'linkedin_url',
  'signal_candidate_id',
]);

export const privacyIdentifierSchema = z.object({
  identifier_type: privacyIdentifierTypeSchema,
  value: z.string().min(1).max(2048),
}).strict();
export type CandidatePrivacyIdentifier = z.infer<typeof privacyIdentifierSchema>;

export const canonicalReferenceSchema = z.object({
  global_candidate_id: z.string().uuid().optional(),
}).strict();
export type CandidatePrivacyCanonicalReference = z.infer<typeof canonicalReferenceSchema>;

export const eligibilitySubjectSchema = z.object({
  request_ref: z.string().uuid(),
  identifiers: z.array(privacyIdentifierSchema).max(8).default([]),
  canonical: canonicalReferenceSchema.optional(),
}).strict().refine(
  (subject) => subject.identifiers.length > 0 || subject.canonical !== undefined,
  'candidate privacy subject is required',
);
export type CandidatePrivacyEligibilitySubject = z.infer<typeof eligibilitySubjectSchema>;

export const eligibilityResponseSchema = z.object({
  results: z.array(z.object({
    request_ref: z.string().uuid(),
    decision: privacyDecisionSchema,
  }).strict()).max(200),
  count: z.number().int().min(0).max(200),
}).strict();

export const changeEventSchema = z.object({
  cursor: z.number().int().nonnegative().safe(),
  event_id: z.string().uuid(),
  directive_id: z.string().uuid(),
  action: z.enum(['withdraw_global_matching', 'request_erasure']),
  scope: z.enum(['global_matching', 'active_profile']),
  state: z.enum([
    'requested',
    'verified',
    'active_quarantine',
    'needs_review',
    'superseded',
    'released',
  ]),
  version: z.number().int().positive().safe(),
  effective_at: z.string().datetime({ offset: true }),
}).strict();

export const changesResponseSchema = z.object({
  events: z.array(changeEventSchema).max(500),
  count: z.number().int().min(0).max(500),
}).strict();

export const snapshotDirectiveSchema = z.object({
  directive_id: z.string().uuid(),
  action: z.enum(['withdraw_global_matching', 'request_erasure']),
  scope: z.enum(['global_matching', 'active_profile']),
  state: z.enum([
    'requested',
    'verified',
    'active_quarantine',
    'needs_review',
    'superseded',
    'released',
  ]),
  version: z.number().int().positive().safe(),
  effective_at: z.string().datetime({ offset: true }),
}).strict();

export const snapshotResponseSchema = z.object({
  high_water_cursor: z.number().int().nonnegative().safe(),
  directives: z.array(snapshotDirectiveSchema).max(500),
  count: z.number().int().min(0).max(500),
}).strict();

export interface CandidatePrivacyAnchor {
  requestRef: string;
  linkedinUrl?: string | null;
  signalCandidateId?: string | null;
  globalCandidateId?: string | null;
}

export function anchorToEligibilitySubject(
  anchor: CandidatePrivacyAnchor,
): CandidatePrivacyEligibilitySubject {
  const identifiers: CandidatePrivacyIdentifier[] = [];
  if (anchor.linkedinUrl) {
    identifiers.push({
      identifier_type: 'linkedin_url',
      value: anchor.linkedinUrl,
    });
  }
  if (anchor.signalCandidateId) {
    identifiers.push({
      identifier_type: 'signal_candidate_id',
      value: anchor.signalCandidateId,
    });
  }
  return eligibilitySubjectSchema.parse({
    request_ref: anchor.requestRef,
    identifiers,
    ...(anchor.globalCandidateId
      ? { canonical: { global_candidate_id: anchor.globalCandidateId } }
      : {}),
  });
}

export function decisionAllowsDiscoverUse(decision: CandidatePrivacyDecision): boolean {
  return decision === 'allow';
}
