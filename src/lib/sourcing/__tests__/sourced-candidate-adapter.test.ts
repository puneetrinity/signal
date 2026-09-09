import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CandidateForRanking } from '../ranking-new';
import {
  adaptCrustdataCandidateForMemory,
  computeSourcedCandidateIdempotencyKey,
  normalizeSourcedCandidateLinkedInUrl,
  type SourcedCandidateAdapterOptions,
} from '../sourced-candidate-adapter';

const observedAt = new Date('2026-09-07T12:34:56.000Z');

function candidate(
  overrides: Record<string, unknown> = {},
): CandidateForRanking & { linkedinUrl: string; name: string } {
  return {
    id: 'https://www.linkedin.com/in/Alice-Example/?trk=private',
    linkedinUrl: 'https://www.linkedin.com/in/Alice-Example/?trk=private',
    name: 'Alice alice@example.com',
    headlineHint: 'Private hint +1-415-555-0123',
    locationHint: 'Bengaluru, India',
    searchTitle: 'Backend Engineer',
    searchSnippet: 'private@example.com',
    enrichmentStatus: 'complete',
    lastEnrichedAt: null,
    snapshot: null,
    crustdata: {
      crustdata_person_id: 123456,
      basic_profile: {
        name: 'Álice Example',
        first_name: 'Álice',
        last_name: 'Example',
        headline: 'Principal Engineer',
        summary: 'Public systems engineer; email alice@example.com',
        languages: ['English', 'हिन्दी'],
        location: {
          city: 'Bengaluru',
          country: 'India',
          country_code: 'IN',
        },
        email: 'never@example.com',
      },
      contact: { personal_email: 'private@example.com' },
      experience: {
        employment_details: {
          current: [{ company_name: 'Acme', title: 'Principal Engineer' }],
          past: [{ company_name: 'Before', title: 'Engineer' }],
        },
      },
      skills: { professional_network_skills: ['TypeScript', 'PostgreSQL'] },
      social_handles: {
        dev_platform_identifier: { profile_url: 'https://github.com/alice' },
      },
      years_of_experience_raw: 9,
    },
    ...overrides,
  } as CandidateForRanking & { linkedinUrl: string; name: string };
}

function options(
  overrides: Partial<SourcedCandidateAdapterOptions> = {},
): SourcedCandidateAdapterOptions {
  return {
    acquisitionReceiptId: 'receipt:exact:one',
    acquisitionGeneration: 2,
    acquisitionSlot: 'exact',
    acquiredAt: observedAt,
    profileObservedAt: observedAt,
    expectedGlobalCandidateId: '11111111-1111-4111-8111-111111111111',
    publicCandidateRoleFamily: 'backend',
    ...overrides,
  };
}

describe('approved-provider sourced-candidate adapter', () => {
  it('produces the exact neutral v1 contract and deterministic canonical bytes', () => {
    const first = adaptCrustdataCandidateForMemory(candidate(), options());
    const second = adaptCrustdataCandidateForMemory(candidate(), options());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema_version: 1,
      provider_namespace: 'crustdata',
      record_type: 'person',
      adapter_version: 'crustdata_person_v1',
      provider_record_id: '123456',
      linkedin_url: 'https://linkedin.com/in/alice-example',
      expected_global_candidate_id: '11111111-1111-4111-8111-111111111111',
      acquisition_receipt_id: 'receipt:exact:one',
      acquisition_generation: 2,
      acquisition_slot: 'exact',
      acquired_at: observedAt.toISOString(),
      provider_observed_at: observedAt.toISOString(),
      normalized_profile: {
        display_name: 'Álice Example',
        role_family: 'backend',
        skills: ['TypeScript', 'PostgreSQL'],
      },
    });
    expect(first.idempotency_key).toBe(
      computeSourcedCandidateIdempotencyKey({
        providerRecordId: '123456',
        acquisitionReceiptId: 'receipt:exact:one',
        acquisitionGeneration: 2,
        acquisitionSlot: 'exact',
      }),
    );
    expect(first.idempotency_key).toHaveLength(64);
    expect(JSON.stringify(first)).not.toMatch(
      /alice@example\.com|private@example\.com|never@example\.com|\+1-415/,
    );
    expect(JSON.stringify(first)).not.toMatch(
      /tenant|organization|job_id|query|rank|contact|resume|application|outreach/i,
    );
  });

  it('normalizes only public LinkedIn person URLs', () => {
    expect(normalizeSourcedCandidateLinkedInUrl('linkedin.com/in/Some.One/?trk=x')).toBe(
      'https://linkedin.com/in/some.one',
    );
    expect(normalizeSourcedCandidateLinkedInUrl('https://linkedin.com/pub/Some-One/1/2')).toBe(
      'https://linkedin.com/in/some-one',
    );
    for (const value of [
      'http://linkedin.com/in/alice',
      'https://evil.example/in/alice',
      'https://linkedin.com/company/acme',
      'https://user:secret@linkedin.com/in/alice',
    ]) {
      expect(() => normalizeSourcedCandidateLinkedInUrl(value)).toThrow(
        /sourced_candidate_linkedin_invalid/,
      );
    }
  });

  it('refuses malformed acquisition identity and bounded profile overflow', () => {
    expect(() =>
      adaptCrustdataCandidateForMemory(
        candidate({ crustdata: { crustdata_person_id: 'not-numeric' } }),
        options(),
      ),
    ).toThrow(/provider_id_invalid/);
    expect(() =>
      adaptCrustdataCandidateForMemory(candidate(), options({ acquisitionReceiptId: 'bad id' })),
    ).toThrow(/receipt_invalid/);
    expect(() =>
      adaptCrustdataCandidateForMemory(candidate(), options({ acquisitionGeneration: 0 })),
    ).toThrow(/generation_invalid/);
    const oversized = candidate();
    if (!oversized.crustdata?.basic_profile) throw new Error('fixture invalid');
    oversized.crustdata.basic_profile.headline = 'x'.repeat(501);
    expect(() => adaptCrustdataCandidateForMemory(oversized, options())).toThrow(
      /profile_field_too_large/,
    );
  });

  it('keeps the idempotency key scoped to receipt generation and slot', () => {
    const key = (slot: 'exact' | 'spill', generation: number) =>
      computeSourcedCandidateIdempotencyKey({
        providerRecordId: '123456',
        acquisitionReceiptId: 'receipt-one',
        acquisitionGeneration: generation,
        acquisitionSlot: slot,
      });
    expect(key('exact', 1)).not.toBe(key('spill', 1));
    expect(key('exact', 1)).not.toBe(key('exact', 2));
    expect(key('exact', 1)).toBe(
      createHash('sha256')
        .update(
          ['v1', 'crustdata', 'person', '123456', 'receipt-one', '1', 'exact'].join('\0'),
          'utf8',
        )
        .digest('hex'),
    );
  });
});
