import { describe, expect, it } from 'vitest';
import {
  assertPublicSourceDetailIsNonPrivate,
  buildPublicWebDiscoverySourceDetail,
  isExplicitPublicSourcingProvenance,
} from '../public-memory-provenance';

describe('public Memory provenance', () => {
  it('publishes only the provider fact', () => {
    expect(buildPublicWebDiscoverySourceDetail(' Crustdata ')).toEqual({
      provider: 'crustdata',
    });
    expect(buildPublicWebDiscoverySourceDetail(null)).toEqual({});
  });

  it('rejects tenant, request, query, and activity metadata', () => {
    for (const key of [
      'tenant_id',
      'signal_candidate_id',
      'job_id',
      'request_id',
      'serp_query',
      'search_query',
      'discovered_at',
    ]) {
      expect(() =>
        assertPublicSourceDetailIsNonPrivate({ [key]: 'private' }),
      ).toThrow(/Private provenance key/);
    }
    expect(() =>
      assertPublicSourceDetailIsNonPrivate({ provider: 'crustdata' }),
    ).not.toThrow();
  });

  it('allows public publication only for explicit Crustdata sourcing rows', () => {
    expect(
      isExplicitPublicSourcingProvenance({
        captureSource: 'sourcing',
        provider: 'crustdata',
      }),
    ).toBe(true);
    for (const input of [
      { captureSource: 'import', provider: 'crustdata' },
      { captureSource: 'manual', provider: 'crustdata' },
      {
        captureSource: 'activegraph_private',
        provider: 'activegraph_private',
      },
      { captureSource: 'sourcing', provider: 'activegraph_public' },
      { captureSource: 'sourcing', provider: 'serper' },
    ]) {
      expect(isExplicitPublicSourcingProvenance(input)).toBe(false);
    }
  });
});
