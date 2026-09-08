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
        basic_profile: {
          name: 'Example Person',
          headline: 'Backend Engineer',
        },
        contact: { email: 'nested@example.com' },
      },
    } as CandidateForRanking & {
      linkedinUrl: string;
      name: string;
    };

    const payload = buildActiveGraphCandidatePayload('org_1', candidate, ['python'], 'request-1', {
      profileObservedAt: observedAt,
      acquisitionGeneration: 4,
      acquisitionReceiptId: 'receipt:one',
      acquisitionSlot: 'exact',
      expectedGlobalCandidateId: globalCandidateId,
    });
    expect(payload).toMatchObject({
      schema_version: 1,
      provider_namespace: 'crustdata',
      record_type: 'person',
      adapter_version: 'crustdata_person_v1',
      provider_record_id: '123',
      linkedin_url: 'https://linkedin.com/in/example-person',
      expected_global_candidate_id: globalCandidateId,
      acquisition_receipt_id: 'receipt:one',
      acquisition_generation: 4,
      acquisition_slot: 'exact',
      acquired_at: observedAt.toISOString(),
      provider_observed_at: observedAt.toISOString(),
      normalized_profile: {
        display_name: 'Example Person',
        headline: 'Backend Engineer',
      },
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
      signalCandidateId: 'signal-1',
      memoryCandidateId: null,
      globalCandidateId,
      sourceRecordId: 'a'.repeat(64),
      resolutionStatus: 'matched',
      deliveryStatus: 'recorded' as const,
      sourceIdentityId: '33333333-3333-4333-8333-333333333333',
      sourceObservationId: '44444444-4444-4444-8444-444444444444',
      ingestReceiptId: 'a'.repeat(64),
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
        resolutionStatus: 'unknown',
      }),
    ).toBe(false);
    expect(
      isConfirmedCandidateIngestResult({
        ...result,
        ingestReceiptId: ' ',
      }),
    ).toBe(false);
    expect(
      isConfirmedCandidateIngestResult({
        ...result,
        sourceObservationId: 'not-a-uuid',
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
