import { describe, expect, it } from "vitest";
import { requireScope } from "@/lib/auth/service-scopes";
import { contactOperationRouteResult } from "../route-contract";
import type { ContactOperationSnapshot, ContactOperationState } from "../types";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function operation(
  state: ContactOperationState,
  overrides: Partial<ContactOperationSnapshot> = {},
): ContactOperationSnapshot {
  return {
    id: "operation-1",
    tenantId: "org_1",
    candidateId: "candidate-1",
    globalCandidateId: null,
    state,
    generation: 1,
    provider: null,
    providerRequestKey: null,
    providerRecordId: null,
    stagedEvidence: null,
    stagedAt: null,
    attempts: 0,
    nextAttemptAt: NOW,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    providerStartedAt: null,
    selectedEmail: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("contact route contract", () => {
  it("uses the dedicated contact:write scope", () => {
    const context = {
      tenantId: "org_1",
      sub: "flow",
      actorType: "service",
      scopes: ["contact:write"],
      jti: "jti-1",
    };
    expect(requireScope(context, "contact:write")).toEqual({
      authorized: true,
    });
    expect(
      requireScope({ ...context, scopes: ["jobs:source"] }, "contact:write")
        .authorized,
    ).toBe(false);
  });

  it.each([
    "queued",
    "awaiting_global_id",
    "memory_lookup",
    "fullenrich_starting",
    "fullenrich_polling",
    "enrichlayer_starting",
    "evidence_pending",
  ] as ContactOperationState[])("returns 202 while %s", (state) => {
    expect(contactOperationRouteResult(operation(state))).toEqual({
      status: 202,
      body: {
        success: true,
        state: "pending",
        emails: [],
      },
    });
  });

  it("returns only Memory-selected email for found", () => {
    expect(
      contactOperationRouteResult(
        operation("found", {
          selectedEmail: "selected@example.com",
        }),
      ),
    ).toEqual({
      status: 200,
      body: {
        success: true,
        state: "found",
        emails: ["selected@example.com"],
      },
    });
  });

  it.each(["suppressed", "not_found"] as const)(
    "returns a redacted terminal %s response",
    (state) => {
      expect(
        contactOperationRouteResult(
          operation(state, {
            selectedEmail: "must-not-leak@example.com",
          }),
        ),
      ).toEqual({
        status: 200,
        body: {
          success: true,
          state,
          emails: [],
        },
      });
    },
  );

  it("keeps FullEnrich ambiguity pending for signed-webhook recovery", () => {
    expect(
      contactOperationRouteResult(
        operation("fullenrich_ambiguous", {
          lastErrorCode: "fullenrich_start_ambiguous",
        }),
      ),
    ).toEqual({
      status: 202,
      body: {
        success: true,
        state: "provider_recovery_pending",
        emails: [],
        code: "fullenrich_start_ambiguous",
      },
    });
  });

  it("preserves terminal EnrichLayer ambiguity and failed codes", () => {
    expect(
      contactOperationRouteResult(
        operation("enrichlayer_ambiguous", {
          lastErrorCode: "enrichlayer_ambiguous",
        }),
      ),
    ).toEqual({
      status: 409,
      body: {
        success: false,
        state: "ambiguous",
        emails: [],
        code: "enrichlayer_ambiguous",
      },
    });
    expect(
      contactOperationRouteResult(
        operation("failed", {
          lastErrorCode: "missing_linkedin_url",
        }),
      ),
    ).toEqual({
      status: 409,
      body: {
        success: false,
        state: "failed",
        emails: [],
        code: "missing_linkedin_url",
      },
    });
  });
});
