import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CandidateForRanking } from '../ranking-new';
import type { JobRequirements } from '../jd-digest';
import { buildPublicMarket } from '../public-memory';
import { signSourcedCandidateIngestJWT } from '../activegraph-auth';

vi.mock('../activegraph-auth', () => ({
  signActiveGraphJWT: vi.fn().mockResolvedValue('test-token'),
  signSourcedCandidateIngestJWT: vi.fn().mockResolvedValue('source-token'),
}));

const requirements: JobRequirements = {
  title: "Senior Backend Engineer",
  topSkills: ["python"],
  seniorityLevel: "senior",
  domain: "software",
  roleFamily: "backend",
  location: "Bengaluru, India",
  experienceYears: 5,
  experienceYearsMax: null,
  education: null,
  titleSearchTerms: ["backend engineer"],
  adjacentBuckets: [],
  adjacentLocations: [],
};

const candidate: CandidateForRanking & {
  linkedinUrl: string;
  name: string;
} = {
  id: "signal-candidate-1",
  linkedinUrl: "https://www.linkedin.com/in/alice",
  name: "Alice",
  headlineHint: "Senior Backend Engineer",
  locationHint: "Bengaluru, India",
  searchTitle: null,
  searchSnippet: null,
  enrichmentStatus: "complete",
  lastEnrichedAt: null,
  crustdata: {
    crustdata_person_id: 123,
    basic_profile: {
      name: "Alice",
      headline: "Senior Backend Engineer",
    },
  },
  snapshot: null,
};
const GLOBAL_ID = '123e4567-e89b-42d3-a456-426614174000';
const SOURCE_ID = '223e4567-e89b-42d3-a456-426614174000';
const OBSERVATION_ID = '323e4567-e89b-42d3-a456-426614174000';
const OBSERVED_AT = new Date('2026-09-07T12:00:00.000Z');

function ingestOptions(overrides: Record<string, unknown> = {}) {
  return {
    profileObservedAt: OBSERVED_AT,
    acquisitionGeneration: 1,
    acquisitionReceiptId: 'receipt:exact:one',
    acquisitionSlot: 'exact' as const,
    ...overrides,
  };
}

function sourcedResponse(body: Record<string, unknown>, overrides = {}) {
  return {
    delivery_status: 'recorded',
    resolution: 'matched',
    provider_namespace: body.provider_namespace,
    record_type: body.record_type,
    provider_record_id: body.provider_record_id,
    acquisition_receipt_id: body.acquisition_receipt_id,
    acquisition_generation: body.acquisition_generation,
    acquisition_slot: body.acquisition_slot,
    idempotency_key: body.idempotency_key,
    source_observation_id: OBSERVATION_ID,
    ingest_receipt_id: body.idempotency_key,
    source_identity_id: SOURCE_ID,
    global_candidate_id: GLOBAL_ID,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe("ActiveGraph public Memory contracts", () => {
  it("chunks identity receipts so all 300 purchased URLs are checked", async () => {
    const { chunkPublicIdentityUrls } = await import("../activegraph-client");
    const chunks = chunkPublicIdentityUrls(
      Array.from(
        { length: 300 },
        (_, index) => `https://www.linkedin.com/in/person-${index}`,
      ),
    );
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 100]);
  });

  it("keeps legacy search results-only while sending the explicit legacy surface", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        results: [{ id: "global-1" }],
        count: 1,
        applied_limit: 50,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { searchGlobalPool } = await import("../activegraph-client");

    const results = await searchGlobalPool(requirements, "org_1", 50, "req-1");

    expect(results).toEqual([{ id: "global-1" }]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.surface).toBe("legacy_v0");
  });

  it("requires an explicit public-v1 response for public hydration", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        surface: "public_v1",
        results: [
          {
            id: "123e4567-e89b-42d3-a456-426614174000",
            name: null,
            headline: "Senior Backend Engineer",
            linkedin_url: "https://www.linkedin.com/in/alice",
            linkedin_id: "alice",
            role_family: "backend",
            seniority_band: "senior",
            skills_normalized: null,
            public_skills_normalized: ["python"],
            location_city: "bangalore",
            location_country_code: "IN",
            similarity: 0.75,
            crustdata_profile: null,
            tenant_candidate_id: null,
            signal_candidate_id: null,
            evidence_surface: "public",
          },
        ],
        count: 1,
        applied_limit: 500,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { searchPublicGlobalPool } = await import("../activegraph-client");

    const response = await searchPublicGlobalPool(
      requirements,
      "org_2",
      500,
      "req-2",
    );

    expect(response?.surface).toBe("public_v1");
    expect(response?.results[0]?.skills_normalized).toBeNull();
    expect(response?.results[0]?.public_skills_normalized).toEqual(["python"]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.surface).toBe("public_v1");
  });

  it("rejects tenant-private evidence on the public surface", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        surface: "public_v1",
        results: [
          {
            id: "123e4567-e89b-42d3-a456-426614174000",
            name: null,
            headline: null,
            linkedin_url: null,
            linkedin_id: null,
            role_family: null,
            seniority_band: null,
            skills_normalized: ["private-skill"],
            public_skills_normalized: null,
            location_city: null,
            location_country_code: null,
            similarity: 0.5,
            crustdata_profile: null,
            tenant_candidate_id: "private-candidate",
            signal_candidate_id: "private-source",
            evidence_surface: "tenant_private",
          },
        ],
        count: 1,
        applied_limit: 500,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { searchPublicGlobalPool } = await import("../activegraph-client");

    await expect(
      searchPublicGlobalPool(requirements, "org_2", 500, "req-private"),
    ).resolves.toBeNull();
  });

  it("rejects restricted contact evidence inside a public profile blob", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        surface: "public_v1",
        results: [
          {
            id: "123e4567-e89b-42d3-a456-426614174000",
            name: null,
            headline: null,
            linkedin_url: "https://www.linkedin.com/in/alice",
            linkedin_id: "alice",
            role_family: "backend",
            seniority_band: "senior",
            skills_normalized: null,
            public_skills_normalized: ["python"],
            location_city: "bangalore",
            location_country_code: "IN",
            similarity: 0.5,
            crustdata_profile: {
              basic_profile: { headline: "Backend Engineer" },
              contact: { email: "restricted@example.com" },
            },
            tenant_candidate_id: null,
            signal_candidate_id: null,
            evidence_surface: "public",
          },
        ],
        count: 1,
        applied_limit: 500,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { searchPublicGlobalPool } = await import("../activegraph-client");

    await expect(
      searchPublicGlobalPool(requirements, "org_2", 500, "req-contact"),
    ).resolves.toBeNull();
  });

  it("rejects unknown top-level and private recruiting fields on the public surface", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        surface: "public_v1",
        results: [
          {
            id: GLOBAL_ID,
            name: null,
            headline: null,
            linkedin_url: "https://www.linkedin.com/in/alice",
            linkedin_id: "alice",
            role_family: "backend",
            seniority_band: "senior",
            skills_normalized: null,
            public_skills_normalized: ["python"],
            location_city: "bangalore",
            location_country_code: "IN",
            similarity: 0.5,
            crustdata_profile: {
              basic_profile: { headline: "Backend Engineer" },
              application_notes: "private recruiting evidence",
            },
            tenant_candidate_id: null,
            signal_candidate_id: null,
            evidence_surface: "public",
            private_provenance: { tenant_id: "org_1" },
          },
        ],
        count: 1,
        applied_limit: 500,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { searchPublicGlobalPool } = await import("../activegraph-client");

    await expect(
      searchPublicGlobalPool(requirements, "org_2", 500, "req-private-field"),
    ).resolves.toBeNull();
  });

  it("accepts only the typed tenant-private projection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        surface: "tenant_private_v1",
        results: [
          {
            candidate_id: "private-memory-1",
            global_candidate_id: GLOBAL_ID,
            display_name: "Private Applicant",
            linkedin_url: "https://www.linkedin.com/in/private-applicant",
            linkedin_id: "private-applicant",
            headline: "Backend Engineer",
            location_raw: "Bengaluru, India",
            skills: ["Python", "Django"],
            seniority_level: "senior",
            keyword_score: 0.75,
            skill_overlap_count: 2,
            evidence_surface: "tenant_private_v1",
          },
        ],
        total: 1,
        total_available: 1,
        truncated: false,
        applied_limit: 500,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { searchTenantPrivateCandidates } = await import(
      "../activegraph-client"
    );

    await expect(
      searchTenantPrivateCandidates(requirements, "org_1", 500, "private-1"),
    ).resolves.toMatchObject({
      surface: "tenant_private_v1",
      results: [
        {
          candidateId: "private-memory-1",
          globalCandidateId: GLOBAL_ID,
          skills: ["python", "django"],
          evidenceSurface: "tenant_private_v1",
        },
      ],
    });
  });

  it("rejects raw profile or contact fields on the tenant-private surface", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        surface: "tenant_private_v1",
        results: [
          {
            candidate_id: "private-memory-1",
            global_candidate_id: null,
            display_name: "Private Applicant",
            linkedin_url: null,
            linkedin_id: null,
            headline: null,
            location_raw: null,
            skills: [],
            seniority_level: null,
            keyword_score: 0,
            skill_overlap_count: 0,
            evidence_surface: "tenant_private_v1",
            profile: { email: "private@example.com" },
          },
        ],
        total: 1,
        total_available: 1,
        truncated: false,
        applied_limit: 500,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { searchTenantPrivateCandidates } = await import(
      "../activegraph-client"
    );

    await expect(
      searchTenantPrivateCandidates(requirements, "org_1", 500, "private-2"),
    ).resolves.toBeNull();
  });

  it("maps only public Crustdata exclusion IDs from the requested market", async () => {
    const market = buildPublicMarket(requirements)!;
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        surface: "public_v1",
        coarse_market_key: market.coarseMarketKey,
        crustdata_person_ids: [123, 456],
        total: 2,
        total_matched: 3,
        classified_matched: 2,
        unclassified_matched: 1,
        unclassified_returned: 0,
        truncated: true,
        applied_limit: 2,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getPublicMarketExclusions } = await import("../activegraph-client");

    const response = await getPublicMarketExclusions(
      "org_2",
      market,
      14,
      2,
      "req-3",
    );

    expect(response).toMatchObject({
      surface: "public_v1",
      crustdataPersonIds: [123, 456],
      totalMatched: 3,
      classifiedMatched: 2,
      unclassifiedMatched: 1,
      unclassifiedReturned: 0,
      truncated: true,
    });
  });

  it("resolves public identity anchors without a profile payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        surface: "public_v1",
        results: [
          {
            linkedin_url: "https://linkedin.com/in/Alice",
            normalized_linkedin_url: "https://www.linkedin.com/in/Alice",
            global_candidate_id: GLOBAL_ID.toUpperCase(),
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { resolvePublicIdentities } = await import("../activegraph-client");

    const response = await resolvePublicIdentities(
      "org_2",
      ["https://linkedin.com/in/Alice"],
      "req-4",
    );

    expect(response).toEqual({
      surface: "public_v1",
      results: [
        {
          linkedinUrl: "https://linkedin.com/in/Alice",
          normalizedLinkedinUrl: "https://www.linkedin.com/in/Alice",
          globalCandidateId: GLOBAL_ID,
        },
      ],
    });
  });

  it("returns canonical IDs from ingest and serializes public metadata separately", async () => {
    const market = buildPublicMarket(requirements)!;
    const unsafeCandidate = {
      ...candidate,
      name: "Alice alice@example.com",
      headlineHint: "Engineer +1-415-555-0123",
      crustdata: {
        ...candidate.crustdata,
        basic_profile: {
          ...candidate.crustdata?.basic_profile,
          summary: "Reach me at nested@example.com",
          email: "private@example.com",
        },
      },
    } as typeof candidate;
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return okJson(sourcedResponse(body));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { ingestCandidateWithResult } = await import('../activegraph-client');

    const result = await ingestCandidateWithResult('org_1', unsafeCandidate, ['python'], 'req-5', {
      publicMarket: market,
      publicCandidateRoleFamily: 'backend',
      ...ingestOptions({ expectedGlobalCandidateId: GLOBAL_ID }),
    });

    expect(result).toEqual({
      success: true,
      signalCandidateId: 'signal-candidate-1',
      memoryCandidateId: null,
      globalCandidateId: GLOBAL_ID,
      sourceRecordId: expect.stringMatching(/^[0-9a-f]{64}$/),
      resolutionStatus: 'matched',
      deliveryStatus: 'recorded',
      sourceIdentityId: SOURCE_ID,
      sourceObservationId: OBSERVATION_ID,
      ingestReceiptId: expect.stringMatching(/^[0-9a-f]{64}$/),
      errorCode: null,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(JSON.stringify(body)).not.toContain('alice@example.com');
    expect(JSON.stringify(body)).not.toContain('+1-415-555-0123');
    expect(JSON.stringify(body)).not.toContain('nested@example.com');
    expect(JSON.stringify(body)).not.toContain('private@example.com');
    expect(body.normalized_profile.display_name).toBe('Alice');
    expect(body.normalized_profile.headline).toBe('Senior Backend Engineer');
    expect(body.normalized_profile.role_family).toBe('backend');
    expect(body.public_market).toEqual({
      version: 1,
      coarse_market_key: market.coarseMarketKey,
      role_family: 'backend',
      location_city: 'bangalore',
      location_country_code: 'IN',
      seniority_band: 'senior',
    });
    expect(body.acquisition_receipt_id).toBe('receipt:exact:one');
    expect(body.expected_global_candidate_id).toBe(GLOBAL_ID);
    expect(signSourcedCandidateIngestJWT).toHaveBeenCalledWith('org_1', 'req-5');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:8000/sourced-candidates/ingest');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer source-token',
    );
  });

  it('omits coarse market when none can be formed', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return okJson(sourcedResponse(body, { resolution: 'created' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { ingestCandidateWithResult } = await import('../activegraph-client');

    await ingestCandidateWithResult('org_1', candidate, ['python'], 'req-6', ingestOptions());

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.public_market).toBeUndefined();
    expect(body.provider_namespace).toBe('crustdata');
  });

  it('rejects an ingest response for a different source record', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return okJson(sourcedResponse(body, { provider_record_id: '999' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { ingestCandidateWithResult } = await import('../activegraph-client');

    await expect(
      ingestCandidateWithResult('org_1', candidate, ['python'], 'req-mismatch', ingestOptions()),
    ).resolves.toMatchObject({
      success: false,
      signalCandidateId: "signal-candidate-1",
      errorCode: "invalid_contract",
    });
  });

  it('classifies 451 without reading or reflecting its response body', async () => {
    const privateCanary = 'private-person@example.invalid';
    const response = new Response(privateCanary, { status: 451 });
    const read = vi.spyOn(response, 'text');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const { ingestCandidateWithResult } = await import('../activegraph-client');

    await expect(
      ingestCandidateWithResult('org_1', candidate, [], 'req-451', ingestOptions()),
    ).resolves.toMatchObject({
      success: false,
      errorCode: 'http_451',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses oversized and extra-field response contracts', async () => {
    const oversized = new Response('{}', {
      status: 200,
      headers: { 'content-length': String(16 * 1024 + 1) },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(oversized)
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return okJson(sourcedResponse(body, { private_note: 'no' }));
      });
    vi.stubGlobal('fetch', fetchMock);
    const { ingestCandidateWithResult } = await import('../activegraph-client');

    await expect(
      ingestCandidateWithResult('org_1', candidate, [], 'req-large', ingestOptions()),
    ).resolves.toMatchObject({
      success: false,
      errorCode: 'response_too_large',
    });
    await expect(
      ingestCandidateWithResult('org_1', candidate, [], 'req-extra', ingestOptions()),
    ).resolves.toMatchObject({
      success: false,
      errorCode: 'invalid_contract',
    });
  });

  it('refuses redirects and enforces the five-second deadline', async () => {
    const redirectFetch = vi.fn().mockRejectedValue(new TypeError('redirect refused'));
    vi.stubGlobal('fetch', redirectFetch);
    const { ingestCandidateWithResult } = await import('../activegraph-client');
    await expect(
      ingestCandidateWithResult('org_1', candidate, [], 'req-redirect', ingestOptions()),
    ).resolves.toMatchObject({ success: false, errorCode: 'transport' });
    expect(redirectFetch.mock.calls[0]?.[1]?.redirect).toBe('error');

    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const pending = ingestCandidateWithResult(
      'org_1',
      candidate,
      [],
      'req-timeout',
      ingestOptions(),
    );
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(pending).resolves.toMatchObject({
      success: false,
      errorCode: 'transport',
    });
  });

  it('rejects malformed canonical IDs from ingest and identity lookup', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return okJson(sourcedResponse(body, { global_candidate_id: 'not-a-uuid' }));
      })
      .mockResolvedValueOnce(
        okJson({
          surface: "public_v1",
          results: [
            {
              linkedin_url: "https://linkedin.com/in/Alice",
              normalized_linkedin_url: "https://www.linkedin.com/in/Alice",
              global_candidate_id: "not-a-uuid",
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const {
      ingestCandidateWithResult,
      resolvePublicIdentities,
    } = await import("../activegraph-client");

    await expect(
      ingestCandidateWithResult('org_1', candidate, ['python'], 'bad-ingest', ingestOptions()),
    ).resolves.toMatchObject({
      success: false,
      globalCandidateId: null,
      errorCode: "invalid_contract",
    });
    await expect(
      resolvePublicIdentities(
        "org_1",
        ["https://linkedin.com/in/Alice"],
        "bad-identity",
      ),
    ).resolves.toBeNull();
  });
});
