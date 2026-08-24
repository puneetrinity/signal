import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  isCandidatePrivacyDisposableTestAdapter,
  loadCandidatePrivacyConfig,
} from './config';
import {
  privacyDecisionSchema,
  privacySyncStatusSchema,
  type CandidatePrivacyDecision,
  type CandidatePrivacySyncStatus,
} from './models';

export const CANDIDATE_PRIVACY_ADMISSION_LOCK =
  'discover_candidate_privacy_admission_v1';
export const CANDIDATE_PRIVACY_PROCESSOR_LOCK =
  'discover_candidate_privacy_processor_v1';

export type CandidatePrivacyRawClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | '$executeRaw'
>;

export class CandidatePrivacyUnavailableError extends Error {
  constructor(
    public readonly code:
      | 'candidate_privacy_unavailable'
      | 'candidate_privacy_stale'
      | 'candidate_privacy_rebuilding'
      | 'candidate_privacy_projection_missing'
      | 'candidate_privacy_conflict',
  ) {
    super(code);
    this.name = 'CandidatePrivacyUnavailableError';
  }
}

export class CandidatePrivacyRestrictedError extends Error {
  constructor(
    public readonly code:
      | 'candidate_privacy_restricted'
      | 'candidate_privacy_review_required',
  ) {
    super(code);
    this.name = 'CandidatePrivacyRestrictedError';
  }
}

export interface HealthyCandidatePrivacyContext {
  generation: bigint;
  cursor: bigint;
  checkedAt: Date;
}

interface SyncStateRow {
  cursor: bigint;
  active_generation: bigint;
  status: string;
  last_success_at: Date | null;
  expected_candidates: number;
  projected_candidates: number;
}

export interface CandidatePrivacySyncSnapshot {
  cursor: bigint;
  activeGeneration: bigint;
  status: CandidatePrivacySyncStatus;
  lastSuccessAt: Date | null;
  expectedCandidates: number;
  projectedCandidates: number;
}

export async function readCandidatePrivacySyncState(
  db: CandidatePrivacyRawClient = prisma,
): Promise<CandidatePrivacySyncSnapshot> {
  const rows = await db.$queryRaw<SyncStateRow[]>`
    SELECT
      "cursor",
      "active_generation",
      "status",
      "last_success_at",
      "expected_candidates",
      "projected_candidates"
    FROM "candidate_privacy_sync_state"
    WHERE "consumer_name" = 'discover'
  `;
  if (rows.length !== 1) {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_unavailable');
  }
  const status = privacySyncStatusSchema.safeParse(rows[0].status);
  if (!status.success) {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_unavailable');
  }
  return {
    cursor: rows[0].cursor,
    activeGeneration: rows[0].active_generation,
    status: status.data,
    lastSuccessAt: rows[0].last_success_at,
    expectedCandidates: rows[0].expected_candidates,
    projectedCandidates: rows[0].projected_candidates,
  };
}

export async function requireHealthyCandidatePrivacyContext(
  db: CandidatePrivacyRawClient = prisma,
  now = new Date(),
): Promise<HealthyCandidatePrivacyContext> {
  if (isCandidatePrivacyDisposableTestAdapter()) {
    return { generation: BigInt(1), cursor: BigInt(0), checkedAt: now };
  }
  const config = loadCandidatePrivacyConfig();
  const state = await readCandidatePrivacySyncState(db);
  if (state.status === 'rebuilding') {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_rebuilding');
  }
  if (
    state.status !== 'healthy' ||
    state.activeGeneration <= BigInt(0) ||
    state.expectedCandidates !== state.projectedCandidates
  ) {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_unavailable');
  }
  if (
    !state.lastSuccessAt ||
    now.getTime() - state.lastSuccessAt.getTime() > config.staleMs
  ) {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_stale');
  }
  return {
    generation: state.activeGeneration,
    cursor: state.cursor,
    checkedAt: state.lastSuccessAt,
  };
}

export async function requireCandidatePrivacyAllowed(
  tenantId: string,
  candidateId: string,
  db: CandidatePrivacyRawClient = prisma,
): Promise<HealthyCandidatePrivacyContext> {
  if (isCandidatePrivacyDisposableTestAdapter()) {
    return { generation: BigInt(1), cursor: BigInt(0), checkedAt: new Date() };
  }
  const context = await requireHealthyCandidatePrivacyContext(db);
  const rows = await db.$queryRaw<Array<{ decision: string }>>`
    SELECT "decision"
    FROM "candidate_privacy_projection"
    WHERE "tenant_id" = ${tenantId}
      AND "candidate_id" = ${candidateId}
      AND "generation" = ${context.generation}
      AND "evaluated_cursor" = ${context.cursor}
  `;
  if (rows.length !== 1) {
    throw new CandidatePrivacyUnavailableError(
      'candidate_privacy_projection_missing',
    );
  }
  const decision = privacyDecisionSchema.safeParse(rows[0].decision);
  if (!decision.success) {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_unavailable');
  }
  if (decision.data === 'review') {
    throw new CandidatePrivacyRestrictedError(
      'candidate_privacy_review_required',
    );
  }
  if (decision.data !== 'allow') {
    throw new CandidatePrivacyRestrictedError('candidate_privacy_restricted');
  }
  return context;
}

export async function filterCandidateIdsBeforeLimit(
  tenantId: string,
  candidateIds: string[],
  db: CandidatePrivacyRawClient = prisma,
): Promise<string[]> {
  if (candidateIds.length === 0) return [];
  if (isCandidatePrivacyDisposableTestAdapter()) return [...candidateIds];
  const context = await requireHealthyCandidatePrivacyContext(db);
  const rows = await db.$queryRaw<Array<{ candidate_id: string }>>`
    SELECT p."candidate_id"
    FROM "candidate_privacy_projection" p
    WHERE p."tenant_id" = ${tenantId}
      AND p."generation" = ${context.generation}
      AND p."evaluated_cursor" = ${context.cursor}
      AND p."decision" = 'allow'
      AND p."candidate_id" IN (${Prisma.join(candidateIds)})
  `;
  const allowed = new Set(rows.map((row) => row.candidate_id));
  return candidateIds.filter((candidateId) => allowed.has(candidateId));
}

const issuedAdmissionProofs = new WeakSet<object>();

export class CandidatePrivacyAdmissionProof {
  private readonly opaque = true;

  private constructor(
    readonly requestRef: string,
    readonly generation: bigint,
    readonly cursor: bigint,
    readonly decision: CandidatePrivacyDecision,
  ) {}

  static issue(input: {
    requestRef: string;
    generation: bigint;
    cursor: bigint;
    decision: CandidatePrivacyDecision;
  }): CandidatePrivacyAdmissionProof {
    const proof = new CandidatePrivacyAdmissionProof(
      input.requestRef,
      input.generation,
      input.cursor,
      input.decision,
    );
    issuedAdmissionProofs.add(proof);
    return proof;
  }

  isOpaque(): boolean {
    return this.opaque;
  }
}

export async function persistAdmissionProjection(
  db: CandidatePrivacyRawClient,
  input: {
    tenantId: string;
    candidateId: string;
    proof: CandidatePrivacyAdmissionProof;
  },
): Promise<void> {
  if (isCandidatePrivacyDisposableTestAdapter()) return;
  await assertAdmissionProofCurrent(db, input.proof);
  const existing = await db.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM "candidate_privacy_projection"
      WHERE "tenant_id" = ${input.tenantId}
        AND "candidate_id" = ${input.candidateId}
        AND "generation" = ${input.proof.generation}
    ) AS "present"
  `;
  if (existing.length !== 1) {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_conflict');
  }
  await db.$executeRaw`
    INSERT INTO "candidate_privacy_projection" (
      "tenant_id", "candidate_id", "generation", "decision",
      "evaluated_cursor", "checked_at"
    ) VALUES (
      ${input.tenantId}, ${input.candidateId}, ${input.proof.generation},
      'allow', ${input.proof.cursor}, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("tenant_id", "candidate_id", "generation")
    DO UPDATE SET
      "decision" = EXCLUDED."decision",
      "evaluated_cursor" = EXCLUDED."evaluated_cursor",
      "checked_at" = EXCLUDED."checked_at"
  `;
  if (!existing[0].present) {
    const updated = await db.$executeRaw`
      UPDATE "candidate_privacy_sync_state"
      SET "expected_candidates" = "expected_candidates" + 1,
          "projected_candidates" = "projected_candidates" + 1,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "consumer_name" = 'discover'
        AND "status" = 'healthy'
        AND "active_generation" = ${input.proof.generation}
        AND "cursor" = ${input.proof.cursor}
    `;
    if (updated !== 1) {
      throw new CandidatePrivacyUnavailableError('candidate_privacy_conflict');
    }
  }
}

export async function assertAdmissionProofCurrent(
  db: CandidatePrivacyRawClient,
  proof: CandidatePrivacyAdmissionProof,
): Promise<void> {
  if (isCandidatePrivacyDisposableTestAdapter()) return;
  const staleMs = loadCandidatePrivacyConfig().staleMs;
  if (
    !issuedAdmissionProofs.has(proof) ||
    !proof.isOpaque() ||
    proof.decision !== 'allow'
  ) {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_conflict');
  }
  await db.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${CANDIDATE_PRIVACY_ADMISSION_LOCK}, 0)
    )
  `;
  const state = await db.$queryRaw<Array<{ ok: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM "candidate_privacy_sync_state"
      WHERE "consumer_name" = 'discover'
        AND "status" = 'healthy'
        AND "active_generation" = ${proof.generation}
        AND "cursor" = ${proof.cursor}
        AND "last_success_at" IS NOT NULL
        AND "last_success_at" >=
          CURRENT_TIMESTAMP - (${staleMs} * INTERVAL '1 millisecond')
    ) AS "ok"
  `;
  if (state.length !== 1 || state[0].ok !== true) {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_conflict');
  }
}

export function candidatePrivacyAllowedRelationWhere(
  context: HealthyCandidatePrivacyContext,
): Prisma.CandidateWhereInput {
  if (isCandidatePrivacyDisposableTestAdapter()) return {};
  return {
    privacyProjections: {
      some: {
        generation: context.generation,
        evaluatedCursor: context.cursor,
        decision: 'allow',
      },
    },
  };
}

export async function withCandidatePrivacyTransaction<T>(
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return (prisma as PrismaClient).$transaction(run, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 120_000,
  });
}
