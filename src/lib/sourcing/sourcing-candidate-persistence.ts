import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { PublicMemoryMaterializationFailure } from './public-memory-materialization';
import {
  CANDIDATE_PRIVACY_ADMISSION_LOCK,
  filterCandidateIdsBeforeLimit,
} from '@/lib/candidate-privacy/repository';

export interface SourcingExecutionFence {
  acquisitionGeneration: number;
  executionAttemptId: string;
  processingLeaseId: string;
}

export async function persistSourcingCandidatesForRequest({
  requestId,
  tenantId,
  data,
  executionFence,
  materializationDiagnostics,
}: {
  requestId: string;
  tenantId: string;
  data: Prisma.JobSourcingCandidateCreateManyInput[];
  executionFence?: SourcingExecutionFence;
  materializationDiagnostics?: {
    failureCount: number;
    failures: PublicMemoryMaterializationFailure[];
  };
}): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${CANDIDATE_PRIVACY_ADMISSION_LOCK}, 0)
      )
    `;
    const candidateIds = [...new Set(data.map((row) => row.candidateId))];
    const allowedIds = await filterCandidateIdsBeforeLimit(
      tenantId,
      candidateIds,
      transaction,
    );
    if (allowedIds.length !== candidateIds.length) {
      throw new Error('candidate_privacy_unavailable');
    }
    if (executionFence) {
      // Hold the request row through replacement so a stale BullMQ delivery
      // cannot pass the fence and then overwrite the current candidate set.
      const current = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "job_sourcing_requests"
        WHERE "id" = ${requestId}
          AND "tenantId" = ${tenantId}
          AND "acquisition_generation" = ${executionFence.acquisitionGeneration}
          AND "execution_attempt_id" = ${executionFence.executionAttemptId}
          AND "processing_lease_id" = ${executionFence.processingLeaseId}
          AND "status" = 'processing'
        FOR UPDATE
      `;
      if (current.length !== 1) {
        throw new Error('Sourcing execution was superseded');
      }
    }

    await transaction.jobSourcingCandidate.deleteMany({
      where: { sourcingRequestId: requestId },
    });
    await transaction.jobSourcingCandidate.createMany({ data });

    if (materializationDiagnostics) {
      const payload = JSON.stringify({
        materializationFailures:
          materializationDiagnostics.failureCount,
        materializationFailureDetails:
          materializationDiagnostics.failures,
      });
      const fencePredicate = executionFence
        ? Prisma.sql`
            AND "acquisition_generation" =
              ${executionFence.acquisitionGeneration}
            AND "execution_attempt_id" =
              ${executionFence.executionAttemptId}
            AND "processing_lease_id" =
              ${executionFence.processingLeaseId}
            AND "status" = 'processing'
          `
        : Prisma.empty;
      const updated = await transaction.$executeRaw`
        UPDATE "job_sourcing_requests"
        SET "diagnostics" = jsonb_set(
          COALESCE("diagnostics", '{}'::jsonb),
          '{publicMemory}',
          COALESCE("diagnostics"->'publicMemory', '{}'::jsonb) ||
            ${payload}::jsonb,
          true
        )
        WHERE "id" = ${requestId}
          AND "tenantId" = ${tenantId}
          ${fencePredicate}
      `;
      if (updated !== 1) {
        throw new Error('Sourcing execution was superseded');
      }
    }
  });
}
