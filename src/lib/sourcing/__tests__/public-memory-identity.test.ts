import { describe, expect, it } from 'vitest';
import type { GlobalPoolSearchResult } from '../activegraph-client';
import {
  buildExpectedGlobalIdentityReceipts,
  candidatePublicIdentityKey,
  expectedGlobalCandidateIdForCandidate,
} from '../public-memory-identity';
import { extractLinkedInIdFromUrl } from '../discovery';

function publicResult(
  id: string,
  personId: number,
): GlobalPoolSearchResult {
  return {
    id,
    name: null,
    headline: null,
    linkedin_url: `https://www.linkedin.com/in/person-${personId}`,
    linkedin_id: `person-${personId}`,
    role_family: 'backend',
    seniority_band: 'senior',
    skills_normalized: null,
    public_skills_normalized: ['python'],
    location_city: 'bangalore',
    location_country_code: 'IN',
    similarity: 0.7,
    crustdata_profile: { crustdata_person_id: personId },
    tenant_candidate_id: null,
    signal_candidate_id: null,
    evidence_surface: 'public',
  };
}

describe('public Memory identity receipts', () => {
  it('accepts only LinkedIn person hosts and canonicalizes legacy /pub anchors', () => {
    expect(
      extractLinkedInIdFromUrl(
        'https://uk.linkedin.com/pub/Public-Person/1/2/3',
      ),
    ).toBe('Public-Person');
    expect(
      extractLinkedInIdFromUrl(
        'https://evillinkedin.com/in/public-person',
      ),
    ).toBeNull();
    expect(
      extractLinkedInIdFromUrl(
        'https://linkedin.com/company/public-person',
      ),
    ).toBeNull();
  });

  it('covers both existing-local and temporary public overlaps', () => {
    const existingId = '123e4567-e89b-42d3-a456-426614174001';
    const temporaryId = '123e4567-e89b-42d3-a456-426614174002';
    const { expectedByIdentity: expected } =
      buildExpectedGlobalIdentityReceipts([
      publicResult(existingId, 101),
      publicResult(temporaryId, 202),
      ]);

    expect(
      expected.get(
        candidatePublicIdentityKey({
          id: 'fresh',
          crustdata: { crustdata_person_id: 101 },
        }),
      ),
    ).toBe(existingId);
    expect(
      expected.get(
        candidatePublicIdentityKey({
          id: 'fresh',
          crustdata: { crustdata_person_id: 202 },
        }),
      ),
    ).toBe(temporaryId);
  });

  it('omits a conflicting identity instead of choosing a UUID by order', () => {
    const first = '123e4567-e89b-42d3-a456-426614174004';
    const second = '123e4567-e89b-42d3-a456-426614174005';
    const receipts = buildExpectedGlobalIdentityReceipts([
      publicResult(first, 404),
      publicResult(second, 404),
    ]);
    expect(receipts.expectedByIdentity.has('cid:404')).toBe(false);
    expect(receipts.conflictedIdentityKeys.has('cid:404')).toBe(true);
  });

  it('uses a batched identity receipt when the candidate was absent from vector results', () => {
    const globalId = '123e4567-e89b-42d3-a456-426614174003';
    const expected = new Map([
      ['li:outside-vector', globalId],
    ]);
    expect(
      expectedGlobalCandidateIdForCandidate(
        {
          id: 'fresh',
          linkedinUrl: 'https://www.linkedin.com/in/outside-vector',
          crustdata: { crustdata_person_id: 303 },
        },
        expected,
      ),
    ).toBe(globalId);
  });
});
