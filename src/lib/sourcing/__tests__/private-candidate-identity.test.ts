import { describe, expect, it } from 'vitest';
import { isPublicAcquisitionIdentity } from '../private-candidate-identity';

const publicRow = { identityKind: 'linkedin', privateCandidateRef: null,
  linkedinId: 'example', linkedinUrl: 'https://www.linkedin.com/in/example' };

describe('public acquisition identity boundary', () => {
  it('accepts an explicit real public identity', () => {
    expect(isPublicAcquisitionIdentity(publicRow)).toBe(true);
  });
  it.each([
    {}, { identityKind: null }, { identityKind: 'organization_candidate' },
    { privateCandidateRef: 'e31ae031-55da-4b52-9de8-0c855a6969d8' },
    { linkedinUrl: null }, { linkedinId: null }, { linkedinId: '' },
    { linkedinUrl: 'https://linkedin.com.evil.test/in/example' },
    { linkedinUrl: 'https://password@linkedin.com/in/example' },
    { linkedinUrl: 'https://linkedin.com/in/example?private=yes' },
    { linkedinUrl: 'https://linkedin.com/in/' },
  ])('rejects malformed or private identity %j', (change) => {
    expect(isPublicAcquisitionIdentity(Object.keys(change).length ? { ...publicRow, ...change } : {})).toBe(false);
  });
});
