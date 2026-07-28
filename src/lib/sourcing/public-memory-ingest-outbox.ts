import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CandidateForRanking } from "./ranking-new";
import type {
  CandidateIngestOptions,
  CandidateIngestResult,
} from "./activegraph-client";
import {
  projectPublicCrustdataProfile,
  redactPublicContactText,
} from "./public-profile-redaction";

export interface PublicMemoryOutboxPayload {
  expectedGlobalCandidateId: string | null;
  candidate: {
    id: string;
    linkedinUrl: string;
    name?: string;
    headlineHint: string | null;
    seniorityHint?: string | null;
    locationHint: string | null;
    searchTitle: string | null;
    searchSnippet: string | null;
    enrichmentStatus: string;
    lastEnrichedAt: string | null;
    crustdata: CandidateForRanking["crustdata"];
    snapshot: {
      skillsNormalized: string[];
      roleType: string | null;
      seniorityBand: string | null;
      location: string | null;
      activityRecencyDays?: number | null;
      computedAt: string;
      staleAfter: string;
    } | null;
  };
  options: CandidateIngestOptions;
}

export interface PublicMemoryOutboxEnqueueInput {
  candidate: CandidateForRanking & {
    linkedinUrl?: string;
    name?: string;
  };
  options: CandidateIngestOptions;
  expectedGlobalCandidateId?: string | null;
}

export interface ClaimedPublicMemoryOutboxRow {
  id: string;
  tenantId: string;
  signalCandidateId: string;
  sourcingRequestId: string | null;
  localCandidateId: string | null;
  payload: PublicMemoryOutboxPayload;
  generation: number;
  attempts: number;
  leaseToken: string;
}

export interface PublicMemoryOutboxStore {
  claim(input: {
    limit: number;
    leaseMs: number;
    now: Date;
  }): Promise<ClaimedPublicMemoryOutboxRow[]>;
  acknowledge(input: {
    row: ClaimedPublicMemoryOutboxRow;
    result: CandidateIngestResult;
    now: Date;
  }): Promise<boolean>;
  fail(input: {
    row: ClaimedPublicMemoryOutboxRow;
    errorCode: string;
    maxAttempts: number;
    terminal?: boolean;
    now: Date;
  }): Promise<boolean>;
}

export function dedupePublicMemoryOutboxInputs(
  candidates: PublicMemoryOutboxEnqueueInput[],
): PublicMemoryOutboxEnqueueInput[] {
  const bySignalCandidateId = new Map<string, PublicMemoryOutboxEnqueueInput>();
  for (const input of candidates) {
    const existing = bySignalCandidateId.get(input.candidate.id);
    const existingExpected = existing?.expectedGlobalCandidateId ?? null;
    const nextExpected = input.expectedGlobalCandidateId ?? null;
    if (existingExpected && nextExpected && existingExpected !== nextExpected) {
      throw new Error(
        `Conflicting Memory identity receipts for ${input.candidate.id}`,
      );
    }
    bySignalCandidateId.set(input.candidate.id, {
      ...input,
      expectedGlobalCandidateId: nextExpected || existingExpected,
    });
  }
  return Array.from(bySignalCandidateId.values());
}

function serializeCandidate(
  candidate: PublicMemoryOutboxEnqueueInput["candidate"],
): PublicMemoryOutboxPayload["candidate"] {
  const linkedinUrl = candidate.linkedinUrl ?? candidate.id;
  const redact = <T extends string | null | undefined>(value: T): T =>
    (typeof value === "string"
      ? redactPublicContactText(value)
      : value) as T;
  return {
    id: candidate.id,
    linkedinUrl,
    name: redact(candidate.name),
    headlineHint: redact(candidate.headlineHint),
    seniorityHint: redact(candidate.seniorityHint),
    locationHint: redact(candidate.locationHint),
    searchTitle: redact(candidate.searchTitle),
    searchSnippet: redact(candidate.searchSnippet),
    enrichmentStatus: candidate.enrichmentStatus,
    lastEnrichedAt: candidate.lastEnrichedAt?.toISOString() ?? null,
    crustdata: projectPublicCrustdataProfile(candidate.crustdata),
    snapshot: candidate.snapshot
      ? {
          ...candidate.snapshot,
          computedAt: candidate.snapshot.computedAt.toISOString(),
          staleAfter: candidate.snapshot.staleAfter.toISOString(),
        }
      : null,
  };
}

export function hydrateOutboxCandidate(
  payload: PublicMemoryOutboxPayload,
): PublicMemoryOutboxEnqueueInput["candidate"] {
  return {
    ...payload.candidate,
    lastEnrichedAt: payload.candidate.lastEnrichedAt
      ? new Date(payload.candidate.lastEnrichedAt)
      : null,
    snapshot: payload.candidate.snapshot
      ? {
          ...payload.candidate.snapshot,
          computedAt: new Date(payload.candidate.snapshot.computedAt),
          staleAfter: new Date(payload.candidate.snapshot.staleAfter),
        }
      : null,
  };
}

export async function enqueuePublicMemoryIngestOutbox({
  tenantId,
  sourcingRequestId,
  candidates,
}: {
  tenantId: string;
  sourcingRequestId: string;
  candidates: PublicMemoryOutboxEnqueueInput[];
}): Promise<number> {
  const uniqueCandidates = dedupePublicMemoryOutboxInputs(candidates);
  if (uniqueCandidates.length === 0) return 0;
  const rows = uniqueCandidates.map(
    ({ candidate, options, expectedGlobalCandidateId }) => ({
      id: randomUUID(),
      receipt_id: randomUUID(),
      tenant_id: tenantId,
      signal_candidate_id: candidate.id,
      sourcing_request_id: sourcingRequestId,
      payload: {
        expectedGlobalCandidateId: expectedGlobalCandidateId ?? null,
        candidate: serializeCandidate(candidate),
        options,
      },
    }),
  );

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "public_memory_ingest_outbox" (
      "id", "tenantId", "signalCandidateId", "sourcingRequestId",
      "payload", "generation", "status", "attempts", "nextAttemptAt",
      "createdAt", "updatedAt"
    )
      SELECT
      input.id,
      input.tenant_id,
      input.signal_candidate_id,
      input.sourcing_request_id,
      input.payload,
      1,
      'pending',
      0,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS input(
      id text,
      receipt_id text,
      tenant_id text,
      signal_candidate_id text,
      sourcing_request_id text,
      payload jsonb
    )
      ON CONFLICT ("tenantId", "signalCandidateId") DO UPDATE SET
      "sourcingRequestId" = EXCLUDED."sourcingRequestId",
      "payload" = EXCLUDED."payload",
      "generation" = "public_memory_ingest_outbox"."generation" + 1,
      "status" = 'pending',
      "attempts" = 0,
      "nextAttemptAt" = CURRENT_TIMESTAMP,
      "leaseToken" = NULL,
      "leaseExpiresAt" = NULL,
      "globalCandidateId" = NULL,
      "lastErrorCode" = NULL,
      "acknowledgedAt" = NULL,
      "linkedAt" = NULL,
      "linkAttempts" = 0,
      "linkNextAttemptAt" = CURRENT_TIMESTAMP,
      "linkLastErrorCode" = NULL,
      "linkDeadAt" = NULL,
      "payloadCompactedAt" = NULL,
      "diagnosticsRecordedAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    `;

    return tx.$executeRaw`
      INSERT INTO "public_memory_ingest_receipts" (
        "id", "tenantId", "signalCandidateId", "sourcingRequestId",
        "status", "createdAt", "updatedAt"
      )
      SELECT
        input.receipt_id,
        input.tenant_id,
        input.signal_candidate_id,
        input.sourcing_request_id,
        'pending',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS input(
        id text,
        receipt_id text,
        tenant_id text,
        signal_candidate_id text,
        sourcing_request_id text,
        payload jsonb
      )
      ON CONFLICT ("sourcingRequestId", "signalCandidateId") DO UPDATE SET
        "status" = 'pending',
        "terminalAt" = NULL,
        "diagnosticsRecordedAt" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    `;
  });
}

export async function attachLocalCandidatesToPublicMemoryOutbox(
  tenantId: string,
  links: Array<{ signalCandidateId: string; localCandidateId: string }>,
): Promise<number> {
  if (links.length === 0) return 0;
  const serializedLinks = JSON.stringify(
    links.map((link) => ({
      signal_candidate_id: link.signalCandidateId,
      local_candidate_id: link.localCandidateId,
    })),
  );
  return prisma.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "public_memory_ingest_outbox" AS outbox
      SET "localCandidateId" = input.local_candidate_id,
          "linkedAt" = NULL,
          "linkAttempts" = 0,
          "linkNextAttemptAt" = CURRENT_TIMESTAMP,
          "linkLastErrorCode" = NULL,
          "linkDeadAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${serializedLinks}::jsonb) AS input(
        signal_candidate_id text,
        local_candidate_id text
      )
      WHERE outbox."tenantId" = ${tenantId}
        AND outbox."signalCandidateId" = input.signal_candidate_id
    `;
    await tx.$executeRaw`
      UPDATE "public_memory_ingest_receipts" AS receipt
      SET "diagnosticsRecordedAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${serializedLinks}::jsonb) AS input(
        signal_candidate_id text,
        local_candidate_id text
      )
      WHERE receipt."tenantId" = ${tenantId}
        AND receipt."signalCandidateId" = input.signal_candidate_id
        AND receipt."status" = 'succeeded'
    `;
    return updated;
  });
}

export class PrismaPublicMemoryOutboxStore implements PublicMemoryOutboxStore {
  async claim({
    limit,
    leaseMs,
    now,
  }: {
    limit: number;
    leaseMs: number;
    now: Date;
  }): Promise<ClaimedPublicMemoryOutboxRow[]> {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        tenantId: string;
        signalCandidateId: string;
        sourcingRequestId: string | null;
        localCandidateId: string | null;
        payload: Prisma.JsonValue;
        generation: number;
        attempts: number;
        leaseToken: string;
      }>
    >`
      WITH claimable AS (
        SELECT "id"
        FROM "public_memory_ingest_outbox"
        WHERE (
          ("status" = 'pending' AND "nextAttemptAt" <= ${now})
          OR
          ("status" = 'processing' AND "leaseExpiresAt" <= ${now})
        )
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE "public_memory_ingest_outbox" AS outbox
      SET "status" = 'processing',
          "attempts" = outbox."attempts" + 1,
          "leaseToken" = ${leaseToken},
          "leaseExpiresAt" = ${leaseExpiresAt},
          "updatedAt" = ${now}
      FROM claimable
      WHERE outbox."id" = claimable."id"
      RETURNING
        outbox."id",
        outbox."tenantId",
        outbox."signalCandidateId",
        outbox."sourcingRequestId",
        outbox."localCandidateId",
        outbox."payload",
        outbox."generation",
        outbox."attempts",
        outbox."leaseToken"
    `;
    // Payloads are written only by enqueuePublicMemoryIngestOutbox. The
    // generation/lease predicates below still arbitrate every state change.
    return rows as unknown as ClaimedPublicMemoryOutboxRow[];
  }

  async acknowledge({
    row,
    result,
    now,
  }: {
    row: ClaimedPublicMemoryOutboxRow;
    result: CandidateIngestResult;
    now: Date;
  }): Promise<boolean> {
    if (!result.success || !result.globalCandidateId) return false;
    return prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE "public_memory_ingest_outbox"
        SET "status" = 'succeeded',
          "globalCandidateId" = ${result.globalCandidateId},
          "lastErrorCode" = NULL,
          "acknowledgedAt" = ${now},
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "diagnosticsRecordedAt" = NULL,
          "updatedAt" = ${now}
        WHERE "id" = ${row.id}
        AND "generation" = ${row.generation}
        AND "leaseToken" = ${row.leaseToken}
      `;
      if (updated !== 1) return false;
      await tx.publicMemoryIngestReceipt.updateMany({
        where: {
          tenantId: row.tenantId,
          signalCandidateId: row.signalCandidateId,
          status: "pending",
        },
        data: {
          status: "succeeded",
          terminalAt: now,
          diagnosticsRecordedAt: null,
        },
      });
      return true;
    });
  }

  async fail({
    row,
    errorCode,
    maxAttempts,
    terminal = false,
    now,
  }: {
    row: ClaimedPublicMemoryOutboxRow;
    errorCode: string;
    maxAttempts: number;
    terminal?: boolean;
    now: Date;
  }): Promise<boolean> {
    const dead = terminal || row.attempts >= maxAttempts;
    const delayMs = Math.min(
      60 * 60 * 1000,
      10_000 * 2 ** Math.max(0, row.attempts - 1),
    );
    return prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE "public_memory_ingest_outbox"
        SET "status" = ${dead ? "dead" : "pending"},
          "nextAttemptAt" = ${new Date(now.getTime() + delayMs)},
          "lastErrorCode" = ${errorCode.slice(0, 80)},
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "diagnosticsRecordedAt" = NULL,
          "updatedAt" = ${now}
        WHERE "id" = ${row.id}
        AND "generation" = ${row.generation}
        AND "leaseToken" = ${row.leaseToken}
      `;
      if (updated !== 1) return false;
      if (dead) {
        await tx.publicMemoryIngestReceipt.updateMany({
          where: {
            tenantId: row.tenantId,
            signalCandidateId: row.signalCandidateId,
            status: "pending",
          },
          data: {
            status: "dead",
            terminalAt: now,
            diagnosticsRecordedAt: null,
          },
        });
      }
      return true;
    });
  }
}

export async function reconcilePublicMemoryOutboxLinks(): Promise<number> {
  const now = new Date();
  const rows = await prisma.publicMemoryIngestOutbox.findMany({
    where: {
      status: "succeeded",
      globalCandidateId: { not: null },
      localCandidateId: { not: null },
      linkedAt: null,
      linkDeadAt: null,
      linkNextAttemptAt: { lte: now },
    },
    select: {
      id: true,
      tenantId: true,
      localCandidateId: true,
      globalCandidateId: true,
      generation: true,
      status: true,
      linkAttempts: true,
    },
    orderBy: [{ linkNextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: 100,
  });
  if (rows.length === 0) return 0;

  const { ensureCandidateGlobalLink } = await import(
    "./public-memory-materialization"
  );
  let linked = 0;
  for (const row of rows) {
    if (!row.localCandidateId || !row.globalCandidateId) continue;
    try {
      const link = await ensureCandidateGlobalLink({
        tenantId: row.tenantId,
        candidateId: row.localCandidateId,
        globalCandidateId: row.globalCandidateId,
        matchMethod: "linkedin_id_exact",
      });
      const updated = await prisma.publicMemoryIngestOutbox.updateMany({
        where: {
          id: row.id,
          generation: row.generation,
          status: row.status,
          linkedAt: null,
          globalCandidateId: row.globalCandidateId,
          localCandidateId: row.localCandidateId,
        },
        data: {
          localCandidateId: link.candidateId,
          linkedAt: now,
          linkLastErrorCode: null,
        },
      });
      linked += updated.count;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const errorCode = message.includes("does not belong to tenant")
        ? "link_tenant_mismatch"
        : message.includes("already linked")
          ? "link_identity_conflict"
          : "link_failed";
      const attempts = row.linkAttempts + 1;
      const dead = attempts >= 8;
      const delayMs = Math.min(
        60 * 60 * 1000,
        10_000 * 2 ** Math.max(0, attempts - 1),
      );
      await prisma.publicMemoryIngestOutbox.updateMany({
        where: {
          id: row.id,
          generation: row.generation,
          status: row.status,
          linkedAt: null,
          globalCandidateId: row.globalCandidateId,
          localCandidateId: row.localCandidateId,
          linkAttempts: row.linkAttempts,
        },
        data: {
          linkAttempts: attempts,
          linkLastErrorCode: errorCode,
          linkNextAttemptAt: new Date(now.getTime() + delayMs),
          linkDeadAt: dead ? now : null,
        },
      });
    }
  }
  return linked;
}

export async function reconcilePublicMemoryOutboxDiagnostics(): Promise<number> {
  const updatedRequests = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH eligible_receipts AS (
      SELECT receipt."id", receipt."sourcingRequestId" AS request_id
      FROM "public_memory_ingest_receipts" AS receipt
      JOIN "public_memory_ingest_outbox" AS outbox
        ON outbox."tenantId" = receipt."tenantId"
       AND outbox."signalCandidateId" = receipt."signalCandidateId"
      WHERE receipt."diagnosticsRecordedAt" IS NULL
        AND receipt."status" IN ('succeeded', 'dead')
        AND (
          receipt."status" = 'dead'
          OR outbox."localCandidateId" IS NULL
          OR outbox."linkedAt" IS NOT NULL
          OR outbox."linkDeadAt" IS NOT NULL
        )
    ),
    affected_requests AS (
      SELECT DISTINCT request_id FROM eligible_receipts
    ),
    counts AS (
      SELECT
        receipt."sourcingRequestId" AS request_id,
        COUNT(*)::int AS queued,
        COUNT(*) FILTER (WHERE receipt."status" = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE receipt."status" = 'succeeded')::int AS confirmed,
        COUNT(*) FILTER (WHERE receipt."status" = 'dead')::int AS failed,
        COUNT(*) FILTER (
          WHERE receipt."status" = 'succeeded'
            AND outbox."localCandidateId" IS NOT NULL
            AND outbox."linkedAt" IS NOT NULL
        )::int AS links_confirmed,
        COUNT(*) FILTER (
          WHERE receipt."status" = 'succeeded'
            AND outbox."localCandidateId" IS NOT NULL
            AND outbox."linkDeadAt" IS NOT NULL
        )::int AS links_failed
      FROM "public_memory_ingest_receipts" AS receipt
      JOIN affected_requests AS affected
        ON affected.request_id = receipt."sourcingRequestId"
      LEFT JOIN "public_memory_ingest_outbox" AS outbox
        ON outbox."tenantId" = receipt."tenantId"
       AND outbox."signalCandidateId" = receipt."signalCandidateId"
      GROUP BY receipt."sourcingRequestId"
    )
    UPDATE "job_sourcing_requests" AS request
    SET "diagnostics" = jsonb_set(
          COALESCE(request."diagnostics", '{}'::jsonb),
          '{publicMemory}',
          COALESCE(request."diagnostics"->'publicMemory', '{}'::jsonb)
            || jsonb_build_object(
              'ingestQueued', counts.queued,
              'ingestPending', counts.pending,
              'ingestConfirmed', counts.confirmed,
              'ingestFailed', counts.failed,
              'asyncLinksConfirmed', counts.links_confirmed,
              'asyncLinksFailed', counts.links_failed
            ),
          true
        )
    FROM counts
    WHERE request."id" = counts.request_id
      AND request."status" IN ('complete', 'failed')
    RETURNING request."id"
  `;
  if (updatedRequests.length === 0) return 0;

  const requestIds = updatedRequests.map((request) => request.id);
  await prisma.$executeRaw`
    UPDATE "public_memory_ingest_receipts" AS receipt
    SET "diagnosticsRecordedAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM "public_memory_ingest_outbox" AS outbox
    WHERE receipt."tenantId" = outbox."tenantId"
      AND receipt."signalCandidateId" = outbox."signalCandidateId"
      AND receipt."sourcingRequestId" = ANY(${requestIds}::text[])
      AND receipt."diagnosticsRecordedAt" IS NULL
      AND receipt."status" IN ('succeeded', 'dead')
      AND (
        receipt."status" = 'dead'
        OR outbox."localCandidateId" IS NULL
        OR outbox."linkedAt" IS NOT NULL
        OR outbox."linkDeadAt" IS NOT NULL
      )
  `;
  return requestIds.length;
}

export async function compactPublicMemoryOutboxPayloads({
  receiptRetentionDays = 90,
}: {
  receiptRetentionDays?: number;
} = {}): Promise<{ compacted: number; receiptsDeleted: number }> {
  const compacted = await prisma.$executeRaw`
    WITH eligible AS (
      SELECT outbox."id"
      FROM "public_memory_ingest_outbox" AS outbox
      WHERE outbox."status" IN ('succeeded', 'dead')
        AND outbox."payloadCompactedAt" IS NULL
        AND (
          outbox."status" = 'dead'
          OR outbox."localCandidateId" IS NULL
          OR outbox."linkedAt" IS NOT NULL
          OR outbox."linkDeadAt" IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "public_memory_ingest_receipts" AS receipt
          WHERE receipt."tenantId" = outbox."tenantId"
            AND receipt."signalCandidateId" = outbox."signalCandidateId"
            AND (
              receipt."status" = 'pending'
              OR receipt."diagnosticsRecordedAt" IS NULL
            )
        )
      ORDER BY outbox."updatedAt" ASC
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "public_memory_ingest_outbox" AS outbox
    SET "payload" = jsonb_build_object(
          'compacted', true,
          'signalCandidateId', outbox."signalCandidateId",
          'deliveryLag', jsonb_build_object(
            'coarseMarketKey',
              outbox."payload"->'options'->'publicMarket'
                ->>'coarseMarketKey',
            'crustdataPersonId',
              outbox."payload"->'candidate'->'crustdata'
                ->>'crustdata_person_id'
          )
        ),
        "payloadCompactedAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM eligible
    WHERE outbox."id" = eligible."id"
  `;

  const cutoff = new Date(
    Date.now() - Math.max(1, receiptRetentionDays) * 24 * 60 * 60 * 1000,
  );
  const deleted = await prisma.publicMemoryIngestReceipt.deleteMany({
    where: {
      diagnosticsRecordedAt: { not: null },
      createdAt: { lt: cutoff },
    },
  });
  return { compacted, receiptsDeleted: deleted.count };
}
