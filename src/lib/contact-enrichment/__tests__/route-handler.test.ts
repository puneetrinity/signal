import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  verifyServiceJWT,
  memoryLookup,
  applyContactMemoryRevalidation,
  candidateAppearedInSourcingJob,
  findOrCreateContactOperation,
} = vi.hoisted(() => ({
  verifyServiceJWT: vi.fn(),
  memoryLookup: vi.fn(),
  applyContactMemoryRevalidation: vi.fn(),
  candidateAppearedInSourcingJob: vi.fn(),
  findOrCreateContactOperation: vi.fn(),
}));

vi.mock("@/lib/auth/service-jwt", () => ({ verifyServiceJWT }));
vi.mock("@/lib/contact-enrichment/memory-client", () => ({
  ActiveGraphContactMemoryClient: class {
    lookup = memoryLookup;
  },
}));
vi.mock("@/lib/contact-enrichment/store", () => ({
  applyContactMemoryRevalidation,
  candidateAppearedInSourcingJob,
  findOrCreateContactOperation,
}));

import { POST } from "@/app/api/v3/candidates/[id]/find-contact/route";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function pendingOperation() {
  return {
    id: "operation-1",
    tenantId: "org_1",
    candidateId: "candidate-1",
    globalCandidateId: null,
    state: "awaiting_global_id",
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
  } as const;
}

describe("find-contact route handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyServiceJWT.mockResolvedValue({
      authorized: true,
      context: {
        tenantId: "org_1",
        sub: "flow",
        actorType: "service",
        scopes: ["contact:write"],
        jti: "jti-1",
      },
    });
    findOrCreateContactOperation.mockResolvedValue(pendingOperation());
    candidateAppearedInSourcingJob.mockResolvedValue(true);
    memoryLookup.mockResolvedValue({
      state: "found",
      email: "alice@example.com",
    });
    applyContactMemoryRevalidation.mockImplementation(
      async ({ operation }) => operation,
    );
  });

  it("creates or reads only the tenant-scoped operation and returns 202", async () => {
    const request = new NextRequest(
      "https://signal.example/api/v3/candidates/candidate-1/find-contact",
      {
        method: "POST",
        body: JSON.stringify({
          trigger: "shortlist",
          jobId: "job-42",
        }),
      },
    );
    const response = await POST(request, {
      params: Promise.resolve({ id: "candidate-1" }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: true,
      state: "pending",
      emails: [],
    });
    expect(findOrCreateContactOperation).toHaveBeenCalledWith({
      tenantId: "org_1",
      candidateId: "candidate-1",
    });
    expect(candidateAppearedInSourcingJob).toHaveBeenCalledWith({
      tenantId: "org_1",
      candidateId: "candidate-1",
      externalJobId: "job-42",
    });
  });

  it("rejects a missing explicit shortlist trigger", async () => {
    const request = new NextRequest(
      "https://signal.example/api/v3/candidates/candidate-1/find-contact",
      { method: "POST", body: JSON.stringify({ jobId: "job-42" }) },
    );
    const response = await POST(request, {
      params: Promise.resolve({ id: "candidate-1" }),
    });

    expect(response.status).toBe(400);
    expect(candidateAppearedInSourcingJob).not.toHaveBeenCalled();
    expect(findOrCreateContactOperation).not.toHaveBeenCalled();
  });

  it("rejects a candidate that was not sourced for the job", async () => {
    candidateAppearedInSourcingJob.mockResolvedValueOnce(false);
    const request = new NextRequest(
      "https://signal.example/api/v3/candidates/candidate-1/find-contact",
      {
        method: "POST",
        body: JSON.stringify({
          trigger: "shortlist",
          jobId: "job-42",
        }),
      },
    );
    const response = await POST(request, {
      params: Promise.resolve({ id: "candidate-1" }),
    });

    expect(response.status).toBe(404);
    expect(findOrCreateContactOperation).not.toHaveBeenCalled();
  });

  it("rejects jobs:source without contact:write", async () => {
    verifyServiceJWT.mockResolvedValueOnce({
      authorized: true,
      context: {
        tenantId: "org_1",
        sub: "flow",
        actorType: "service",
        scopes: ["jobs:source"],
        jti: "jti-2",
      },
    });
    const request = new NextRequest(
      "https://signal.example/api/v3/candidates/candidate-1/find-contact",
      {
        method: "POST",
        body: JSON.stringify({
          trigger: "shortlist",
          jobId: "job-42",
        }),
      },
    );
    const response = await POST(request, {
      params: Promise.resolve({ id: "candidate-1" }),
    });

    expect(response.status).toBe(403);
    expect(findOrCreateContactOperation).not.toHaveBeenCalled();
  });

  it("revalidates a found result and honors a later Memory suppression", async () => {
    const found = {
      ...pendingOperation(),
      globalCandidateId: "11111111-1111-4111-8111-111111111111",
      state: "found",
      selectedEmail: "stale@example.com",
      completedAt: NOW,
    } as const;
    const suppressed = {
      ...found,
      state: "suppressed",
      selectedEmail: null,
      lastErrorCode: "contact_suppressed",
    } as const;
    findOrCreateContactOperation.mockResolvedValueOnce(found);
    memoryLookup.mockResolvedValueOnce({ state: "suppressed" });
    applyContactMemoryRevalidation.mockResolvedValueOnce(suppressed);
    const request = new NextRequest(
      "https://signal.example/api/v3/candidates/candidate-1/find-contact",
      {
        method: "POST",
        body: JSON.stringify({
          trigger: "shortlist",
          jobId: "job-42",
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ id: "candidate-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      state: "suppressed",
      emails: [],
    });
    expect(memoryLookup).toHaveBeenCalledWith({
      tenantId: "org_1",
      globalCandidateId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("never returns a cached found email while Memory revalidation is unavailable", async () => {
    findOrCreateContactOperation.mockResolvedValueOnce({
      ...pendingOperation(),
      globalCandidateId: "11111111-1111-4111-8111-111111111111",
      state: "found",
      selectedEmail: "stale@example.com",
      completedAt: NOW,
    });
    memoryLookup.mockRejectedValueOnce(new Error("unavailable"));
    const request = new NextRequest(
      "https://signal.example/api/v3/candidates/candidate-1/find-contact",
      {
        method: "POST",
        body: JSON.stringify({
          trigger: "shortlist",
          jobId: "job-42",
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ id: "candidate-1" }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: true,
      state: "pending",
      emails: [],
      code: "memory_revalidation_pending",
    });
    expect(applyContactMemoryRevalidation).not.toHaveBeenCalled();
  });
});
