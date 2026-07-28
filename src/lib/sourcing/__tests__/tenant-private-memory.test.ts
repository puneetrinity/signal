import { describe, expect, it } from 'vitest';
import { isForbiddenCandidateForeignKey } from '../public-memory-materialization';
import {
  buildTenantPrivateRankingCandidate,
  makeTenantPrivateTemporaryId,
  mergeTenantPrivateEvidence,
  resolveTenantPrivateLinkedInAnchor,
} from '../tenant-private-memory';
import type { TenantPrivateSearchResult } from '../activegraph-client';

const privateResult: TenantPrivateSearchResult = {
  candidateId: 'node:private-1',
  globalCandidateId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Private Applicant',
  linkedinUrl: 'https://www.linkedin.com/in/private-applicant',
  linkedinId: 'private-applicant',
  headline: 'Senior Python Engineer',
  locationRaw: 'Bengaluru, India',
  skills: ['python', 'django'],
  seniorityLevel: 'senior',
  keywordScore: 1,
  skillOverlapCount: 2,
  evidenceSurface: 'tenant_private_v1',
};

describe('tenant-private Memory materialization', () => {
  it('accepts only a real LinkedIn person anchor', () => {
    expect(
      resolveTenantPrivateLinkedInAnchor({
        linkedinUrl: 'https://linkedin.com/in/Mixed-Case',
        linkedinId: null,
      }),
    ).toEqual({
      linkedinUrl: 'https://www.linkedin.com/in/Mixed-Case',
      linkedinId: 'Mixed-Case',
    });
    expect(
      resolveTenantPrivateLinkedInAnchor({
        linkedinUrl: 'https://evillinkedin.com/in/not-safe',
        linkedinId: null,
      }),
    ).toBeNull();
  });

  it('counts email-only rows as unmaterializable without inventing an anchor', () => {
    expect(
      resolveTenantPrivateLinkedInAnchor({
        linkedinUrl: null,
        linkedinId: null,
      }),
    ).toBeNull();
  });

  it('keeps temporary private IDs out of candidate foreign keys', () => {
    const temporaryId = makeTenantPrivateTemporaryId('node:private-1');
    expect(temporaryId).toBe('private-memory:node%3Aprivate-1');
    expect(isForbiddenCandidateForeignKey(temporaryId)).toBe(true);
  });

  it('builds verified tenant-private ranking evidence without public profile data', () => {
    const now = new Date('2026-07-25T00:00:00.000Z');
    const prepared = buildTenantPrivateRankingCandidate(privateResult, now);
    expect(prepared?.rankingCandidate).toMatchObject({
      id: 'private-memory:node%3Aprivate-1',
      crustdata: null,
      snapshot: {
        skillsNormalized: ['python', 'django'],
        seniorityBand: 'senior',
        location: 'Bengaluru, India',
        computedAt: now,
      },
    });
  });

  it('merges private verified skills into an existing tenant candidate', () => {
    const existing = buildTenantPrivateRankingCandidate(
      {
        ...privateResult,
        skills: ['python'],
      },
    )!.rankingCandidate;
    mergeTenantPrivateEvidence(existing, {
      ...privateResult,
      skills: ['django', 'postgresql'],
    });
    expect(existing.snapshot?.skillsNormalized).toEqual([
      'python',
      'django',
      'postgresql',
    ]);
  });
});
