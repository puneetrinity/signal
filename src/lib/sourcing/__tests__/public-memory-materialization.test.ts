import { describe, expect, it } from 'vitest';
import {
  assertPersistableCandidateIds,
  buildObservedCandidatePublicMarket,
  isForbiddenCandidateForeignKey,
  makeGlobalTemporaryCandidateId,
  parseGlobalTemporaryCandidateId,
  publicMaterializationLinkedinAnchorsAgree,
  resolvePublicCandidateRoleFamily,
} from '../public-memory-materialization';

describe('public Memory materialization guards', () => {
  const globalCandidateId = '123e4567-e89b-42d3-a456-426614174000';

  it('uses an explicit temporary namespace and round-trips only UUIDs', () => {
    const temporaryId = makeGlobalTemporaryCandidateId(globalCandidateId);
    expect(temporaryId).toBe(`global:${globalCandidateId}`);
    expect(parseGlobalTemporaryCandidateId(temporaryId)).toBe(globalCandidateId);
    expect(parseGlobalTemporaryCandidateId('global:not-a-uuid')).toBeNull();
    expect(() => makeGlobalTemporaryCandidateId('not-a-uuid')).toThrow();
  });

  it('rejects Memory UUIDs, temporary IDs, and URLs as database foreign keys', () => {
    expect(isForbiddenCandidateForeignKey('cm123localcandidate')).toBe(false);
    expect(isForbiddenCandidateForeignKey(globalCandidateId)).toBe(true);
    expect(isForbiddenCandidateForeignKey(`global:${globalCandidateId}`)).toBe(true);
    expect(isForbiddenCandidateForeignKey('https://www.linkedin.com/in/alice')).toBe(true);
    expect(() =>
      assertPersistableCandidateIds([
        'cm123localcandidate',
        `global:${globalCandidateId}`,
      ]),
    ).toThrow(/Refusing to persist unresolved candidate IDs/);
  });

  it('requires the public LinkedIn URL and ID to identify the same person', () => {
    expect(
      publicMaterializationLinkedinAnchorsAgree({
        linkedinUrl: 'https://www.linkedin.com/in/Alice',
        canonicalLinkedinId: 'alice',
      }),
    ).toBe(true);
    expect(
      publicMaterializationLinkedinAnchorsAgree({
        linkedinUrl: 'https://www.linkedin.com/pub/Alice',
        canonicalLinkedinId: 'alice',
      }),
    ).toBe(true);
    expect(
      publicMaterializationLinkedinAnchorsAgree({
        linkedinUrl: 'https://www.linkedin.com/in/bob',
        canonicalLinkedinId: 'alice',
      }),
    ).toBe(false);
    expect(
      publicMaterializationLinkedinAnchorsAgree({
        linkedinUrl: 'https://evillinkedin.com/in/alice',
        canonicalLinkedinId: 'alice',
      }),
    ).toBe(false);
    expect(
      publicMaterializationLinkedinAnchorsAgree({
        linkedinUrl: 'ftp://www.linkedin.com/in/alice',
        canonicalLinkedinId: 'alice',
      }),
    ).toBe(false);
  });

  it('derives public role evidence from the candidate, never the job', () => {
    expect(
      resolvePublicCandidateRoleFamily({
        searchTitle: 'Senior Backend Engineer',
        headlineHint: 'Python infrastructure',
      }),
    ).toBe('backend');
    expect(
      resolvePublicCandidateRoleFamily({
        searchTitle: null,
        headlineHint: 'Technology professional',
      }),
    ).toBeNull();
  });

  it('uses observed candidate seniority for membership', () => {
    const market = buildObservedCandidatePublicMarket({
      searchTitle: 'Lead Backend Engineer',
      headlineHint: null,
      seniorityHint: 'lead',
      locationHint: 'Bengaluru, India',
    });
    expect(market?.roleFamily).toBe('backend');
    expect(market?.seniorityBand).toBe('lead');
  });
});
