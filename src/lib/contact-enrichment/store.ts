import { randomUUID } from "node:crypto";
import { Prisma, type ContactEnrichmentOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  parseContactOperationState,
  normalizeContactEmail,
  type ClaimedContactOperation,
  type ContactOperationSnapshot,
  type ContactOperationState,
  type ContactProvider,
  type StagedContactEvidence,
} from "./types";
import type { MemoryContactLookupResult } from "./memory-client";
import {
  candidatePrivacyAllowedRelationWhere,
  CANDIDATE_PRIVACY_ADMISSION_LOCK,
  requireCandidatePrivacyAllowed,
  requireHealthyCandidatePrivacyContext,
} from "@/lib/candidate-privacy/repository";

const CLAIMABLE_STATES: ContactOperationState[] = [
  "queued",
  "awaiting_global_id",
  "memory_lookup",
  "fullenrich_polling",
  "evidence_pending",
];

function parseStagedEvidence(
  value: Prisma.JsonValue | null,
): StagedContactEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.globalCandidateId !== "string" ||
    !Array.isArray(record.items)
  ) {
    return null;
  }
  const items = record.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const evidence = item as Record<string, unknown>;
    const email = normalizeContactEmail(evidence.email);
    const provider = evidence.provider;
    const status = evidence.status;
    const confidence = evidence.confidence;
    const providerRecordId = evidence.providerRecordId;
    const observedAt = evidence.observedAt;
    const validatedAt = evidence.validatedAt;
    if (
      !email ||
      (provider !== "fullenrich" && provider !== "enrichlayer") ||
      (status !== "found" && status !== "verified") ||
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      (providerRecordId !== null && typeof providerRecordId !== "string") ||
      typeof observedAt !== "string" ||
      Number.isNaN(Date.parse(observedAt)) ||
      (validatedAt !== null &&
        (typeof validatedAt !== "string" ||
          Number.isNaN(Date.parse(validatedAt))))
    ) {
      return null;
    }
    return {
      email,
      provider,
      providerRecordId,
      confidence,
      observedAt,
      validatedAt,
      status,
    };
  });
  if (items.length === 0 || items.some((item) => item === null)) {
    return null;
  }
  return {
    version: 1,
    globalCandidateId: record.globalCandidateId,
    items: items as StagedContactEvidence["items"],
  };
}

export function toContactOperationSnapshot(
  row: ContactEnrichmentOperation,
): ContactOperationSnapshot {
  return {
    ...row,
    state: parseContactOperationState(row.state),
    provider:
      row.provider === "fullenrich" || row.provider === "enrichlayer"
        ? row.provider
        : null,
    stagedEvidence: parseStagedEvidence(row.stagedEvidence),
  };
}

export interface ContactOperationTransition {
  state: ContactOperationState;
  nextAttemptAt?: Date;
  globalCandidateId?: string | null;
  provider?: ContactProvider | null;
  providerRequestKey?: string | null;
  providerRecordId?: string | null;
  stagedEvidence?: StagedContactEvidence | null;
  stagedAt?: Date | null;
  lastErrorCode?: string | null;
  providerStartedAt?: Date | null;
  selectedEmail?: string | null;
  completedAt?: Date | null;
}

export interface ContactOperationStore {
  claim(input: {
    limit: number;
    leaseMs: number;
    now: Date;
  }): Promise<ClaimedContactOperation[]>;
  transition(input: {
    row: ClaimedContactOperation;
    expectedStates: ContactOperationState[];
    transition: ContactOperationTransition;
    releaseLease: boolean;
    now: Date;
  }): Promise<boolean>;
}

export async function candidateAppearedInSourcingJob({
  tenantId,
  candidateId,
  externalJobId,
}: {
  tenantId: string;
  candidateId: string;
  externalJobId: string;
}): Promise<boolean> {
  const privacyContext = await requireHealthyCandidatePrivacyContext();
  const appearance = await prisma.jobSourcingCandidate.findFirst({
    where: {
      tenantId,
      candidateId,
      candidate: candidatePrivacyAllowedRelationWhere(privacyContext),
      sourcingRequest: {
        tenantId,
        externalJobId,
      },
    },
    select: { id: true },
  });
  return Boolean(appearance);
}

export async function findOrCreateContactOperation({
  tenantId,
  candidateId,
}: {
  tenantId: string;
  candidateId: string;
}): Promise<ContactOperationSnapshot | null> {
  const admitted = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${CANDIDATE_PRIVACY_ADMISSION_LOCK}, 0)
      )
    `;
    await requireCandidatePrivacyAllowed(tenantId, candidateId, tx);
    const candidate = await tx.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: {
        id: true,
        globalLink: {
          select: { globalCandidateId: true },
        },
      },
    });
    if (!candidate) return null;
    const linkedGlobalCandidateId =
      candidate.globalLink?.globalCandidateId ?? null;
    const operation = await tx.contactEnrichmentOperation.upsert({
      where: {
        tenantId_candidateId: { tenantId, candidateId },
      },
      create: {
        tenantId,
        candidateId,
        globalCandidateId: linkedGlobalCandidateId,
        state: linkedGlobalCandidateId ? "queued" : "awaiting_global_id",
        nextAttemptAt: new Date(),
      },
      update: {},
    });
    return { candidate, operation, linkedGlobalCandidateId };
  });
  if (!admitted) return null;
  const { operation, linkedGlobalCandidateId } = admitted;

  if (
    linkedGlobalCandidateId &&
    !operation.globalCandidateId &&
    (operation.state === "queued" ||
      operation.state === "awaiting_global_id" ||
      operation.state === "memory_lookup")
  ) {
    const attached = await prisma.contactEnrichmentOperation.updateMany({
      where: {
        id: operation.id,
        generation: operation.generation,
        globalCandidateId: null,
        state: {
          in: ["queued", "awaiting_global_id", "memory_lookup"],
        },
        leaseToken: null,
      },
      data: {
        globalCandidateId: linkedGlobalCandidateId,
        state: "queued",
        nextAttemptAt: new Date(),
        lastErrorCode: null,
      },
    });
    if (attached.count === 1) {
      const refreshed =
        await prisma.contactEnrichmentOperation.findUniqueOrThrow({
          where: { id: operation.id },
        });
      return toContactOperationSnapshot(refreshed);
    }
  }
  if (
    operation.globalCandidateId &&
    linkedGlobalCandidateId &&
    operation.globalCandidateId !== linkedGlobalCandidateId
  ) {
    // Identity changes are the sole exception to terminal immutability.
    // A previously selected email may belong to the old canonical person, so
    // fence the operation and clear it without starting another provider.
    const failed = await prisma.contactEnrichmentOperation.updateMany({
      where: {
        id: operation.id,
        generation: operation.generation,
        globalCandidateId: operation.globalCandidateId,
      },
      data: {
        state: "failed",
        generation: { increment: 1 },
        lastErrorCode: "global_identity_changed",
        selectedEmail: null,
        completedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (failed.count === 1) {
      const refreshed =
        await prisma.contactEnrichmentOperation.findUniqueOrThrow({
          where: { id: operation.id },
        });
      return toContactOperationSnapshot(refreshed);
    }
  }
  return toContactOperationSnapshot(operation);
}

export async function applyContactMemoryRevalidation({
  operation,
  result,
  now = new Date(),
}: {
  operation: ContactOperationSnapshot;
  result: MemoryContactLookupResult;
  now?: Date;
}): Promise<ContactOperationSnapshot> {
  const transition =
    result.state === "found"
      ? {
          state: "found",
          selectedEmail: result.email,
          lastErrorCode: null,
        }
      : result.state === "suppressed"
        ? {
            state: "suppressed",
            selectedEmail: null,
            lastErrorCode: "contact_suppressed",
          }
        : {
            state: "failed",
            selectedEmail: null,
            lastErrorCode: "memory_contact_missing",
          };
  await prisma.contactEnrichmentOperation.updateMany({
    where: {
      id: operation.id,
      generation: operation.generation,
      state: "found",
      globalCandidateId: operation.globalCandidateId,
    },
    data: {
      ...transition,
      completedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  const current = await prisma.contactEnrichmentOperation.findUniqueOrThrow({
    where: { id: operation.id },
  });
  return toContactOperationSnapshot(current);
}

export class PrismaContactOperationStore implements ContactOperationStore {
  async claim({
    limit,
    leaseMs,
    now,
  }: {
    limit: number;
    leaseMs: number;
    now: Date;
  }): Promise<ClaimedContactOperation[]> {
    const privacyContext = await requireHealthyCandidatePrivacyContext();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "contact_enrichment_operations"
        SET "state" = CASE
              WHEN "state" = 'fullenrich_starting'
                THEN 'fullenrich_ambiguous'
              ELSE 'enrichlayer_ambiguous'
            END,
            "lastErrorCode" = CASE
              WHEN "state" = 'fullenrich_starting'
                THEN 'fullenrich_start_lease_expired'
              ELSE 'enrichlayer_start_lease_expired'
            END,
            "leaseToken" = NULL,
            "leaseExpiresAt" = NULL,
            "completedAt" = CASE
              WHEN "state" = 'fullenrich_starting'
                THEN NULL
              ELSE ${now}
            END,
            "updatedAt" = ${now}
        WHERE "state" IN (
          'fullenrich_starting',
          'enrichlayer_starting'
        )
          AND "leaseExpiresAt" <= ${now}
      `;

      return tx.$queryRaw<
        Array<{
          id: string;
          tenantId: string;
          candidateId: string;
          globalCandidateId: string | null;
          state: string;
          generation: number;
          provider: string | null;
          providerRequestKey: string | null;
          providerRecordId: string | null;
          stagedEvidence: Prisma.JsonValue | null;
          stagedAt: Date | null;
          attempts: number;
          nextAttemptAt: Date;
          leaseToken: string;
          leaseExpiresAt: Date;
          lastErrorCode: string | null;
          providerStartedAt: Date | null;
          selectedEmail: string | null;
          completedAt: Date | null;
          createdAt: Date;
          updatedAt: Date;
          linkedinUrl: string;
          nameHint: string | null;
          companyHint: string | null;
          linkedGlobalCandidateId: string | null;
        }>
      >`
        WITH claimable AS (
          SELECT operation."id"
          FROM "contact_enrichment_operations" AS operation
          JOIN "candidate_privacy_projection" AS privacy_projection
            ON privacy_projection."tenant_id" = operation."tenantId"
           AND privacy_projection."candidate_id" = operation."candidateId"
           AND privacy_projection."generation" = ${privacyContext.generation}
           AND privacy_projection."evaluated_cursor" = ${privacyContext.cursor}
           AND privacy_projection."decision" = 'allow'
          WHERE operation."state" = ANY(${CLAIMABLE_STATES}::text[])
            AND operation."nextAttemptAt" <= ${now}
            AND (
              operation."leaseToken" IS NULL
              OR operation."leaseExpiresAt" <= ${now}
            )
          ORDER BY
            operation."nextAttemptAt" ASC,
            operation."createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        ),
        claimed AS (
          UPDATE "contact_enrichment_operations" AS operation
          SET "leaseToken" = ${leaseToken},
              "leaseExpiresAt" = ${leaseExpiresAt},
              "attempts" = operation."attempts" + 1,
              "updatedAt" = ${now}
          FROM claimable
          WHERE operation."id" = claimable."id"
          RETURNING operation.*
        )
        SELECT
          claimed.*,
          candidate."linkedinUrl",
          candidate."nameHint",
          candidate."companyHint",
          link."globalCandidateId" AS "linkedGlobalCandidateId"
        FROM claimed
        JOIN "candidates" AS candidate
          ON candidate."tenantId" = claimed."tenantId"
         AND candidate."id" = claimed."candidateId"
        LEFT JOIN "candidate_global_links" AS link
          ON link."tenantId" = claimed."tenantId"
         AND link."candidateId" = claimed."candidateId"
      `;
    });

    return rows.map((row) => ({
      ...row,
      state: parseContactOperationState(row.state),
      provider:
        row.provider === "fullenrich" || row.provider === "enrichlayer"
          ? row.provider
          : null,
      stagedEvidence: parseStagedEvidence(row.stagedEvidence),
    }));
  }

  async transition({
    row,
    expectedStates,
    transition,
    releaseLease,
    now,
  }: {
    row: ClaimedContactOperation;
    expectedStates: ContactOperationState[];
    transition: ContactOperationTransition;
    releaseLease: boolean;
    now: Date;
  }): Promise<boolean> {
    const data: Prisma.ContactEnrichmentOperationUncheckedUpdateManyInput = {
      state: transition.state,
      updatedAt: now,
      ...(transition.nextAttemptAt
        ? { nextAttemptAt: transition.nextAttemptAt }
        : {}),
      ...(transition.globalCandidateId !== undefined
        ? {
            globalCandidateId: transition.globalCandidateId,
          }
        : {}),
      ...(transition.provider !== undefined
        ? { provider: transition.provider }
        : {}),
      ...(transition.providerRequestKey !== undefined
        ? {
            providerRequestKey: transition.providerRequestKey,
          }
        : {}),
      ...(transition.providerRecordId !== undefined
        ? {
            providerRecordId: transition.providerRecordId,
          }
        : {}),
      ...(transition.stagedEvidence !== undefined
        ? {
            stagedEvidence: transition.stagedEvidence
              ? (transition.stagedEvidence as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
          }
        : {}),
      ...(transition.stagedAt !== undefined
        ? { stagedAt: transition.stagedAt }
        : {}),
      ...(transition.lastErrorCode !== undefined
        ? {
            lastErrorCode: transition.lastErrorCode,
          }
        : {}),
      ...(transition.providerStartedAt !== undefined
        ? {
            providerStartedAt: transition.providerStartedAt,
          }
        : {}),
      ...(transition.selectedEmail !== undefined
        ? {
            selectedEmail: transition.selectedEmail,
          }
        : {}),
      ...(transition.completedAt !== undefined
        ? { completedAt: transition.completedAt }
        : {}),
      ...(releaseLease ? { leaseToken: null, leaseExpiresAt: null } : {}),
    };
    const updated = await prisma.contactEnrichmentOperation.updateMany({
      where: {
        id: row.id,
        generation: row.generation,
        leaseToken: row.leaseToken,
        state: { in: expectedStates },
      },
      data,
    });
    return updated.count === 1;
  }
}

export async function applyFullEnrichWebhookTransition({
  operationId,
  generation,
  expectedStates,
  transition,
  now,
}: {
  operationId: string;
  generation: number;
  expectedStates: ContactOperationState[];
  transition: ContactOperationTransition;
  now: Date;
}): Promise<boolean> {
  const data: Prisma.ContactEnrichmentOperationUncheckedUpdateManyInput = {
    state: transition.state,
    nextAttemptAt: transition.nextAttemptAt ?? now,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: now,
    ...(transition.providerRecordId !== undefined
      ? { providerRecordId: transition.providerRecordId }
      : {}),
    ...(transition.stagedEvidence !== undefined
      ? {
          stagedEvidence: transition.stagedEvidence
            ? (transition.stagedEvidence as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        }
      : {}),
    ...(transition.stagedAt !== undefined
      ? { stagedAt: transition.stagedAt }
      : {}),
    ...(transition.lastErrorCode !== undefined
      ? { lastErrorCode: transition.lastErrorCode }
      : {}),
    ...(transition.completedAt !== undefined
      ? { completedAt: transition.completedAt }
      : {}),
  };
  const updated = await prisma.contactEnrichmentOperation.updateMany({
    where: {
      id: operationId,
      generation,
      provider: "fullenrich",
      state: { in: expectedStates },
    },
    data,
  });
  return updated.count === 1;
}
