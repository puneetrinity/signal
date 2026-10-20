import { createHash } from 'node:crypto';
import { prepareMemoryPacket, type MemoryAcquisitionOwner } from './immutable-memory-ingest';
import type { adaptCrustdataCandidateForMemory, SourcedCandidateAdapterOptions } from './sourced-candidate-adapter';

// Only deterministic candidate-format failures may be isolated. Privacy,
// ownership, receipt, database and unknown failures must still fail closed.
const candidateErrors: Readonly<Record<string, string>> = Object.freeze({
  sourced_candidate_linkedin_invalid: 'linkedin_invalid',
  sourced_candidate_profile_missing: 'profile_missing',
  sourced_candidate_profile_field_too_large: 'profile_field_too_large',
  sourced_candidate_profile_list_invalid: 'profile_list_invalid',
  sourced_candidate_employment_invalid: 'employment_invalid',
  sourced_candidate_education_invalid: 'education_invalid',
  sourced_candidate_certification_invalid: 'certification_invalid',
  sourced_candidate_honor_invalid: 'honor_invalid',
});

type Candidate = Parameters<typeof adaptCrustdataCandidateForMemory>[0];
export interface CandidateExclusion {
  index: number;
  providerRecordId: string;
  candidateFingerprint: string;
  reason: string;
}

/** Validate before any identity/Memory/RC work. Never mutate the saved purchase.
 * Keep raw provider counts for acquisition capacity; this filtered list must
 * never be used to request replacement purchases.
 */
export function partitionMemoryCandidates<T extends Candidate>(
  candidates: readonly T[],
  context: (candidate: T) => { owner: MemoryAcquisitionOwner; options: SourcedCandidateAdapterOptions },
): { accepted: T[]; excluded: CandidateExclusion[] } {
  const accepted: T[] = [];
  const excluded: CandidateExclusion[] = [];
  for (const [index, candidate] of candidates.entries()) {
    // Context failures are run-level, not a malformed provider profile.
    const { owner, options } = context(candidate);
    try {
      prepareMemoryPacket(owner, candidate, options);
      accepted.push(candidate);
    } catch (error) {
      const reason = error instanceof Error && Object.hasOwn(candidateErrors, error.message)
        ? candidateErrors[error.message] : undefined;
      if (!reason) throw error;
      const providerId = candidate.crustdata?.crustdata_person_id;
      // An exclusion must be attributable to an actual purchased record.
      if (!Number.isSafeInteger(providerId) || Number(providerId) <= 0) throw error;
      excluded.push({
        index,
        providerRecordId: String(providerId),
        candidateFingerprint: createHash('sha256')
          .update(JSON.stringify([owner.acquisitionReceiptId, index, candidate.id])).digest('hex'),
        reason,
      });
    }
  }
  return { accepted, excluded };
}
