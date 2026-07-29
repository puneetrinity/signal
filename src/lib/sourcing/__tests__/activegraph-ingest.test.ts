import { describe, expect, it } from "vitest";
import type { CandidateForRanking } from "../ranking-new";
import {
  buildActiveGraphCandidatePayload,
  isConfirmedCandidateIngestResult,
  isDurableActiveGraphCandidateResolve,
} from "../activegraph-client";

describe("ActiveGraph candidate ingest evidence time", () => {
  const globalCandidateId = "11111111-1111-4111-8111-111111111111";

  it("carries receipt timing through the sanitized public-v1 payload", () => {
    const observedAt = new Date("2026-07-27T01:02:03.000Z");
    const candidate = {
      id: "https://www.linkedin.com/in/example-person",
      linkedinUrl: "https://www.linkedin.com/in/example-person",
      name: "Example Person person@example.com",
      headlineHint: "Backend Engineer +1-415-555-0123",
      locationHint: "Bengaluru, India",
      searchTitle: "Backend Engineer",
      searchSnippet: "Python",
      enrichmentStatus: "pending",
      lastEnrichedAt: null,
      crustdata: {
        crustdata_person_id: 123,
        contact: { email: "nested@example.com" },
      },
    } as CandidateForRanking & {
      linkedinUrl: string;
      name: string;
    };

    const payload = buildActiveGraphCandidatePayload(
      "org_1",
      candidate,
      ["python"],
      "request-1",
      {
        profileObservedAt: observedAt,
        acquisitionGeneration: 4,
      },
    );
    expect(payload).toMatchObject({
      signal_candidate_id:
        "https://www.linkedin.com/in/example-person",
      tenant_id: "org_1",
      request_id: "request-1",
      profile_observed_at: observedAt.toISOString(),
      acquisition_generation: 4,
      crustdata: { crustdata_person_id: 123 },
      source_metadata: { public_memory_surface: "public_v1" },
    });
    expect(JSON.stringify(payload)).not.toContain("person@example.com");
    expect(JSON.stringify(payload)).not.toContain("+1-415-555-0123");
    expect(JSON.stringify(payload)).not.toContain("nested@example.com");
  });

  it("accepts only canonical resolutions with a durable source record", () => {
    expect(
      isDurableActiveGraphCandidateResolve({
        resolution_status: "created",
        candidate_id: "candidate-1",
        global_candidate_id: globalCandidateId,
        source_record_id: "source-1",
      }),
    ).toBe(true);
    expect(
      isDurableActiveGraphCandidateResolve({
        resolution_status: "matched",
        candidate_id: "candidate-1",
        global_candidate_id: globalCandidateId,
        source_record_id: "source-1",
      }),
    ).toBe(true);
    expect(
      isDurableActiveGraphCandidateResolve({
        resolution_status: "review_required",
        candidate_id: null,
        global_candidate_id: null,
        source_record_id: null,
      }),
    ).toBe(false);
    expect(
      isDurableActiveGraphCandidateResolve({
        resolution_status: "created",
        candidate_id: "candidate-1",
        global_candidate_id: globalCandidateId,
        source_record_id: null,
      }),
    ).toBe(false);
  });

  it("does not confirm a mismatched canonical identity", () => {
    const result = {
      success: true,
      signalCandidateId: "signal-1",
      memoryCandidateId: "candidate-1",
      globalCandidateId,
      sourceRecordId: "signal-1",
      resolutionStatus: "matched",
      errorCode: null,
    };

    expect(
      isConfirmedCandidateIngestResult(result, globalCandidateId),
    ).toBe(true);
    expect(
      isConfirmedCandidateIngestResult(
        result,
        "22222222-2222-4222-8222-222222222222",
      ),
    ).toBe(false);
    expect(
      isConfirmedCandidateIngestResult({
        ...result,
        resolutionStatus: "review_required",
      }),
    ).toBe(false);
    expect(
      isConfirmedCandidateIngestResult({
        ...result,
        sourceRecordId: " ",
      }),
    ).toBe(false);
    expect(
      isConfirmedCandidateIngestResult({
        ...result,
        sourceRecordId: "signal-2",
      }),
    ).toBe(false);
    expect(
      isConfirmedCandidateIngestResult(
        result,
        globalCandidateId,
        "signal-2",
      ),
    ).toBe(false);
  });
});
