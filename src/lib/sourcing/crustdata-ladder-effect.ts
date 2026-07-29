import { applyCrustdataReceiptEffectOnce } from "./crustdata-acquisition";
import type { CrustdataSearchResult } from "./crustdata-client";
import {
  nextActiveRungId,
  nextShortfallStreak,
  type RelaxationRung,
  type RelaxationState,
} from "./relaxation-ladder";

export interface CrustdataLadderEffectMetadata {
  activeRung: string | null;
  shortfallStreak: number;
  observedAt: string;
  appliedAt: string;
  staleObservationIgnored: boolean;
}

export function ladderObservationIsStale(
  currentObservedAt: Date | null | undefined,
  incomingObservedAt: Date,
): boolean {
  return Boolean(
    currentObservedAt && currentObservedAt > incomingObservedAt,
  );
}

export async function applyCrustdataLadderObservationOnce(input: {
  tenantId: string;
  requestId: string;
  acquisitionGeneration: number;
  executionAttemptId?: string;
  processingLeaseId?: string;
  receiptId: string;
  fineQueryFingerprint: string;
  rungs: RelaxationRung[];
  exactSearch: CrustdataSearchResult;
  exactSubmittedExclusionCount: number;
  spillSearch: CrustdataSearchResult | null;
  spillRungId: string | null;
  observedAt: Date;
  stateStaleBefore: Date;
  depletionRuns: number;
}): Promise<{ applied: boolean; metadata: CrustdataLadderEffectMetadata }> {
  return applyCrustdataReceiptEffectOnce<CrustdataLadderEffectMetadata>(
    input.tenantId,
    input.receiptId,
    async (transaction) => {
      if (input.executionAttemptId && input.processingLeaseId) {
        const currentExecution = await transaction.$queryRaw<
          Array<{ id: string }>
        >`
          SELECT "id"
          FROM "job_sourcing_requests"
          WHERE "id" = ${input.requestId}
            AND "tenantId" = ${input.tenantId}
            AND "acquisition_generation" = ${input.acquisitionGeneration}
            AND "execution_attempt_id" = ${input.executionAttemptId}
            AND "processing_lease_id" = ${input.processingLeaseId}
            AND "status" = 'processing'
          FOR UPDATE
        `;
        if (currentExecution.length !== 1) {
          throw new Error("Sourcing execution was superseded");
        }
      }

      const lockKey = `tenant|${input.tenantId}|${input.fineQueryFingerprint}`;
      // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, which
      // $queryRaw cannot deserialize — this killed every post-#40 sourcing run.
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
      `;
      const currentRow = await transaction.sourcingCoverageState.findUnique({
        where: {
          scope_scopeKey_queryFingerprint: {
            scope: "tenant",
            scopeKey: input.tenantId,
            queryFingerprint: input.fineQueryFingerprint,
          },
        },
      });
      const currentState: RelaxationState | null = currentRow
        ? {
            activeRung: currentRow.activeRung,
            shortfallStreak: currentRow.shortfallStreak,
            lastExactProviderTotal: currentRow.lastExactProviderTotal,
            lastExactRequestedLimit: currentRow.lastExactRequestedLimit,
            lastProviderTotal: currentRow.lastProviderTotal,
            lastRequestedLimit: currentRow.lastRequestedLimit,
            lastSpillObservedAt: currentRow.lastSpillObservedAt,
            lastObservedAt: currentRow.lastObservedAt,
          }
        : null;
      const appliedAt = new Date();
      if (
        ladderObservationIsStale(
          currentRow?.lastObservedAt,
          input.observedAt,
        )
      ) {
        return {
          activeRung: currentRow!.activeRung,
          shortfallStreak: currentRow!.shortfallStreak,
          observedAt: input.observedAt.toISOString(),
          appliedAt: appliedAt.toISOString(),
          staleObservationIgnored: true,
        };
      }
      const appliesToCurrentRung =
        Boolean(input.spillSearch && input.spillRungId) &&
        (!currentRow?.activeRung ||
          currentRow.activeRung === input.spillRungId);
      let activeRung = currentRow?.activeRung ?? input.spillRungId;
      let shortfallStreak = currentRow?.shortfallStreak ?? 0;

      if (appliesToCurrentRung && input.spillSearch && input.spillRungId) {
        shortfallStreak = nextShortfallStreak(
          currentState,
          input.spillSearch.providerTotal,
          input.spillSearch.requestedLimit,
          input.stateStaleBefore,
        );
        activeRung = input.spillRungId;
        if (shortfallStreak >= input.depletionRuns) {
          const advanced = nextActiveRungId(input.rungs, input.spillRungId);
          if (advanced !== input.spillRungId) {
            activeRung = advanced;
            shortfallStreak = 0;
          }
        }
      }

      await transaction.sourcingCoverageState.upsert({
        where: {
          scope_scopeKey_queryFingerprint: {
            scope: "tenant",
            scopeKey: input.tenantId,
            queryFingerprint: input.fineQueryFingerprint,
          },
        },
        create: {
          scope: "tenant",
          scopeKey: input.tenantId,
          queryFingerprint: input.fineQueryFingerprint,
          activeRung,
          shortfallStreak,
          lastExactProviderTotal: input.exactSearch.providerTotal,
          lastExactRequestedLimit: input.exactSearch.requestedLimit,
          lastProviderTotal: input.spillSearch?.providerTotal ?? null,
          lastRequestedLimit: input.spillSearch?.requestedLimit ?? 0,
          lastRawReturnedCount: input.spillSearch?.rawReturnedCount ?? 0,
          lastSpillObservedAt: input.spillSearch
            ? input.observedAt
            : null,
          lastSubmittedExclusionCount: input.exactSubmittedExclusionCount,
          lastObservedAt: input.observedAt,
        },
        update: {
          ...(appliesToCurrentRung && input.spillSearch
            ? {
                activeRung,
                shortfallStreak,
                lastProviderTotal: input.spillSearch.providerTotal,
                lastRequestedLimit: input.spillSearch.requestedLimit,
                lastRawReturnedCount: input.spillSearch.rawReturnedCount,
                lastSpillObservedAt: input.observedAt,
              }
            : {}),
          lastExactProviderTotal: input.exactSearch.providerTotal,
          lastExactRequestedLimit: input.exactSearch.requestedLimit,
          lastSubmittedExclusionCount: input.exactSubmittedExclusionCount,
          lastObservedAt: input.observedAt,
        },
      });
      return {
        activeRung,
        shortfallStreak,
        observedAt: input.observedAt.toISOString(),
        appliedAt: appliedAt.toISOString(),
        staleObservationIgnored: false,
      };
    },
  );
}
