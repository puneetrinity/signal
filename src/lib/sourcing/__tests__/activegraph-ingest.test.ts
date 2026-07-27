import { describe, expect, it } from "vitest";
import type { CandidateForRanking } from "../ranking-new";
import {
  buildActiveGraphCandidatePayload,
  isDurableActiveGraphCandidateResolve,
} from "../activegraph-client";

describe("ActiveGraph candidate ingest evidence time", () => {
  it("carries the paid provider observation and acquisition generation", () => {
    const observedAt = new Date("2026-07-27T01:02:03.000Z");
    const candidate = {
      id: "https://www.linkedin.com/in/example-person",
      linkedinUrl: "https://www.linkedin.com/in/example-person",
      name: "Example Person",
      headlineHint: "Backend Engineer",
      crustdata: { crustdata_person_id: 123 },
    } as CandidateForRanking & {
      linkedinUrl: string;
      name: string;
    };

    expect(
      buildActiveGraphCandidatePayload(
        "org_1",
        candidate,
        ["python"],
        "request-1",
        {
          profileObservedAt: observedAt,
          acquisitionGeneration: 4,
        },
      ),
    ).toMatchObject({
      signal_candidate_id:
        "https://www.linkedin.com/in/example-person",
      tenant_id: "org_1",
      request_id: "request-1",
      profile_observed_at: observedAt.toISOString(),
      acquisition_generation: 4,
      crustdata: { crustdata_person_id: 123 },
    });
  });

  it("accepts only canonical resolutions with a durable source record", () => {
    expect(
      isDurableActiveGraphCandidateResolve({
        resolution_status: "created",
        candidate_id: "candidate-1",
        source_record_id: "source-1",
      }),
    ).toBe(true);
    expect(
      isDurableActiveGraphCandidateResolve({
        resolution_status: "matched",
        candidate_id: "candidate-1",
        source_record_id: "source-1",
      }),
    ).toBe(true);
    expect(
      isDurableActiveGraphCandidateResolve({
        resolution_status: "review_required",
        candidate_id: null,
        source_record_id: null,
      }),
    ).toBe(false);
    expect(
      isDurableActiveGraphCandidateResolve({
        resolution_status: "created",
        candidate_id: "candidate-1",
        source_record_id: null,
      }),
    ).toBe(false);
  });
});
