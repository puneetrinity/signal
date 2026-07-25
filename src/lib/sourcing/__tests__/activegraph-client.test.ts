import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateForRanking } from "../ranking-new";
import type { JobRequirements } from "../jd-digest";
import { buildPublicMarket } from "../public-memory";

vi.mock("../activegraph-auth", () => ({
  signActiveGraphJWT: vi.fn().mockResolvedValue("test-token"),
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
const GLOBAL_ID = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
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
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        candidate_id: "memory-tenant-candidate-1",
        global_candidate_id: GLOBAL_ID,
        resolution_status: "matched",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ingestCandidateWithResult } = await import("../activegraph-client");

    const result = await ingestCandidateWithResult(
      "org_1",
      unsafeCandidate,
      ["python"],
      "req-5",
      {
        publicMarket: market,
        publicCandidateRoleFamily: "backend",
      },
    );

    expect(result).toEqual({
      success: true,
      signalCandidateId: "signal-candidate-1",
      memoryCandidateId: "memory-tenant-candidate-1",
      globalCandidateId: GLOBAL_ID,
      resolutionStatus: "matched",
      errorCode: null,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(JSON.stringify(body)).not.toContain("alice@example.com");
    expect(JSON.stringify(body)).not.toContain("+1-415-555-0123");
    expect(JSON.stringify(body)).not.toContain("nested@example.com");
    expect(JSON.stringify(body)).not.toContain("private@example.com");
    expect(body.display_name).toBe("Alice [redacted]");
    expect(body.headline).toBe("Engineer [redacted]");
    expect(body.source_metadata).toEqual({
      public_memory_surface: "public_v1",
      public_candidate_role_family: "backend",
      public_market: {
        version: 1,
        coarse_market_key: market.coarseMarketKey,
        role_family: "backend",
        location_city: "bangalore",
        location_country_code: "IN",
        seniority_band: "senior",
      },
    });
  });

  it("marks public-v1 ingest even when no coarse market can be formed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        candidate_id: "memory-tenant-candidate-1",
        global_candidate_id: GLOBAL_ID,
        resolution_status: "created",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ingestCandidateWithResult } = await import("../activegraph-client");

    await ingestCandidateWithResult("org_1", candidate, ["python"], "req-6");

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.source_metadata).toEqual({
      public_memory_surface: "public_v1",
    });
  });

  it("rejects malformed canonical IDs from ingest and identity lookup", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({
          candidate_id: "memory-tenant-candidate-1",
          global_candidate_id: "not-a-uuid",
          resolution_status: "matched",
        }),
      )
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
      ingestCandidateWithResult("org_1", candidate, ["python"], "bad-ingest"),
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
