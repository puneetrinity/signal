import { NextRequest, NextResponse } from "next/server";
import { verifyServiceJWT } from "@/lib/auth/service-jwt";
import { requireScope } from "@/lib/auth/service-scopes";
import { contactOperationRouteResult } from "@/lib/contact-enrichment/route-contract";
import { ActiveGraphContactMemoryClient } from "@/lib/contact-enrichment/memory-client";
import {
  applyContactMemoryRevalidation,
  candidateAppearedInSourcingJob,
  findOrCreateContactOperation,
} from "@/lib/contact-enrichment/store";
import { requireCandidatePrivacyAllowed } from "@/lib/candidate-privacy/repository";

interface ShortlistContactTrigger {
  trigger: "shortlist";
  jobId: string;
}

async function readShortlistTrigger(
  request: NextRequest,
): Promise<ShortlistContactTrigger | null> {
  const value: unknown = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    body.trigger !== "shortlist" ||
    typeof body.jobId !== "string" ||
    !body.jobId.trim()
  ) {
    return null;
  }
  return { trigger: "shortlist", jobId: body.jobId.trim() };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyServiceJWT(request);
  if (!auth.authorized) return auth.response;

  const scopeCheck = requireScope(auth.context, "contact:write");
  if (!scopeCheck.authorized) return scopeCheck.response;

  const { id: candidateId } = await params;
  try {
    await requireCandidatePrivacyAllowed(auth.context.tenantId, candidateId);
    const trigger = await readShortlistTrigger(request);
    if (!trigger) {
      return NextResponse.json(
        {
          success: false,
          error: "A shortlist trigger and non-empty jobId are required",
        },
        { status: 400 },
      );
    }
    const appeared = await candidateAppearedInSourcingJob({
      tenantId: auth.context.tenantId,
      candidateId,
      externalJobId: trigger.jobId,
    });
    if (!appeared) {
      return NextResponse.json(
        { success: false, error: "Candidate not found for job" },
        { status: 404 },
      );
    }
    let operation = await findOrCreateContactOperation({
      tenantId: auth.context.tenantId,
      candidateId,
    });
    if (!operation) {
      return NextResponse.json(
        { success: false, error: "Candidate not found" },
        { status: 404 },
      );
    }
    if (operation.state === "found") {
      if (!operation.globalCandidateId) {
        return NextResponse.json(
          {
            success: false,
            state: "failed",
            emails: [],
            code: "contact_result_identity_missing",
          },
          { status: 409 },
        );
      }
      try {
        const memory = new ActiveGraphContactMemoryClient();
        const memoryResult = await memory.lookup({
          tenantId: auth.context.tenantId,
          globalCandidateId: operation.globalCandidateId,
        });
        operation = await applyContactMemoryRevalidation({
          operation,
          result: memoryResult,
        });
      } catch {
        // Never return a cached address when the suppression source of truth
        // cannot be checked. Flow can safely poll this recoverable state.
        return NextResponse.json(
          {
            success: true,
            state: "pending",
            emails: [],
            code: "memory_revalidation_pending",
          },
          { status: 202 },
        );
      }
    }
    const result = contactOperationRouteResult(operation);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("candidate_privacy_")
    ) {
      return NextResponse.json(
        { success: false, error: "candidate_privacy_unavailable" },
        { status: 503 },
      );
    }
    console.error("[ContactEnrichmentRoute] Request failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
