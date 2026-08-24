import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toJsonValue } from "@/lib/prisma/json";
import type { JobRequirements } from "./jd-digest";
import type { CrustdataSearchResult } from "./crustdata-client";
import { createCandidateAdmissionProofs } from "@/lib/candidate-privacy/decision";
import { requireHealthyCandidatePrivacyContext } from "@/lib/candidate-privacy/repository";

export type CrustdataAcquisitionSlot = "exact" | "spill";

export class CrustdataAcquisitionSafetyError extends Error {
  readonly code:
    | "receipt_in_progress"
    | "receipt_missing"
    | "receipt_uncertain"
    | "receipt_invalid"
    | "receipt_persistence_failed"
    | "memory_ingest_failed";

  constructor(code: CrustdataAcquisitionSafetyError["code"], message: string) {
    super(message);
    this.name = "CrustdataAcquisitionSafetyError";
    this.code = code;
  }
}

export interface CrustdataAcquisitionMetadata {
  rungId: string;
  rungDescription: string;
  submittedExclusionCount: number;
  publicExclusionTelemetry?: Record<string, unknown>;
}

export interface StoredReceipt {
  id: string;
  status: string;
  startedAt: Date;
  requestFingerprint: string;
  requestMetadata: unknown;
  result: unknown;
  error: string | null;
  effectsAppliedAt?: Date | null;
  effectMetadata?: unknown;
  memoryIngestedAt?: Date | null;
  memoryIngestMetadata?: unknown;
}

export interface CrustdataReceiptStore {
  find(
    tenantId: string,
    sourcingRequestId: string,
    acquisitionGeneration: number,
    slot: CrustdataAcquisitionSlot,
  ): Promise<StoredReceipt | null>;
  reserve(input: {
    tenantId: string;
    sourcingRequestId: string;
    acquisitionGeneration: number;
    slot: CrustdataAcquisitionSlot;
    requestFingerprint: string;
    requestInput: unknown;
    requestMetadata: CrustdataAcquisitionMetadata;
  }): Promise<StoredReceipt>;
  complete(id: string, result: CrustdataSearchResult): Promise<void>;
  markUncertain(id: string, error: string): Promise<void>;
}

interface AcquireDependencies {
  store: CrustdataReceiptStore;
  search: (
    requirements: JobRequirements,
    limit: number,
    options: { excludePersonIds?: number[] },
  ) => Promise<CrustdataSearchResult>;
  sleep?: (milliseconds: number) => Promise<void>;
  waitAttempts?: number;
  waitIntervalMs?: number;
  requirePrivacyHealth?: () => Promise<unknown>;
}

export interface AcquireCrustdataSearchInput {
  tenantId: string;
  sourcingRequestId: string;
  acquisitionGeneration: number;
  slot: CrustdataAcquisitionSlot;
  requirements: JobRequirements;
  limit: number;
  excludePersonIds?: number[];
  metadata: CrustdataAcquisitionMetadata;
  reuseOnly?: boolean;
}

export interface AcquiredCrustdataSearch {
  result: CrustdataSearchResult;
  receiptId: string;
  reused: boolean;
  requestFingerprint: string;
  requestFingerprintMatched: boolean;
  metadata: CrustdataAcquisitionMetadata;
  acquiredAt: Date;
  memoryIngestedAt: Date | null;
}

const DEFAULT_WAIT_ATTEMPTS = 240;
const DEFAULT_WAIT_INTERVAL_MS = 250;

function disposablePrivacyAdapterEnabled(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER ===
      "disposable_passthrough"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function findStoredReceipt(
  store: CrustdataReceiptStore,
  input: Pick<
    AcquireCrustdataSearchInput,
    "tenantId" | "sourcingRequestId" | "acquisitionGeneration" | "slot"
  >,
): Promise<StoredReceipt | null> {
  try {
    return await store.find(
      input.tenantId,
      input.sourcingRequestId,
      input.acquisitionGeneration,
      input.slot,
    );
  } catch (error) {
    throw new CrustdataAcquisitionSafetyError(
      "receipt_persistence_failed",
      `Crustdata ${input.slot} acquisition receipt could not be read; refusing an unreceipted provider call: ${errorMessage(error)}`,
    );
  }
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJson(entry)]),
  );
}

export function buildCrustdataRequestFingerprint(
  input: Pick<
    AcquireCrustdataSearchInput,
    "requirements" | "limit" | "excludePersonIds"
  >,
): string {
  const payload = buildCrustdataRequestInput(input);
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildCrustdataRequestInput(
  input: Pick<
    AcquireCrustdataSearchInput,
    "requirements" | "limit" | "excludePersonIds"
  >,
): unknown {
  const excludePersonIds = [
    ...new Set(
      (input.excludePersonIds ?? []).filter((id) => Number.isFinite(id)),
    ),
  ].sort((left, right) => left - right);
  return stableJson({
    version: 1,
    requirements: input.requirements,
    limit: input.limit,
    excludePersonIds,
  });
}

function parseMetadata(value: unknown): CrustdataAcquisitionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CrustdataAcquisitionSafetyError(
      "receipt_invalid",
      "Crustdata acquisition receipt metadata is invalid",
    );
  }
  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.rungId !== "string" ||
    typeof metadata.rungDescription !== "string" ||
    typeof metadata.submittedExclusionCount !== "number" ||
    (metadata.publicExclusionTelemetry !== undefined &&
      (!metadata.publicExclusionTelemetry ||
        typeof metadata.publicExclusionTelemetry !== "object" ||
        Array.isArray(metadata.publicExclusionTelemetry)))
  ) {
    throw new CrustdataAcquisitionSafetyError(
      "receipt_invalid",
      "Crustdata acquisition receipt metadata is invalid",
    );
  }
  return {
    rungId: metadata.rungId,
    rungDescription: metadata.rungDescription,
    submittedExclusionCount: metadata.submittedExclusionCount,
    ...(metadata.publicExclusionTelemetry
      ? {
          publicExclusionTelemetry:
            metadata.publicExclusionTelemetry as Record<string, unknown>,
        }
      : {}),
  };
}

function parseResult(value: unknown): CrustdataSearchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CrustdataAcquisitionSafetyError(
      "receipt_invalid",
      "Crustdata acquisition receipt result is invalid",
    );
  }
  const result = value as Record<string, unknown>;
  if (
    !Array.isArray(result.profiles) ||
    (result.providerTotal !== null &&
      typeof result.providerTotal !== "number") ||
    typeof result.rawReturnedCount !== "number" ||
    typeof result.requestedLimit !== "number"
  ) {
    throw new CrustdataAcquisitionSafetyError(
      "receipt_invalid",
      "Crustdata acquisition receipt result is invalid",
    );
  }
  return result as unknown as CrustdataSearchResult;
}

function crustdataLinkedinUrl(
  profile: CrustdataSearchResult["profiles"][number],
): string | null {
  const value =
    profile.social_handles?.professional_network_identifier?.profile_url;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function privacyFilterCrustdataResult(
  result: CrustdataSearchResult,
): Promise<CrustdataSearchResult> {
  if (disposablePrivacyAdapterEnabled()) {
    return result;
  }
  if (!disposablePrivacyAdapterEnabled()) {
    await requireHealthyCandidatePrivacyContext();
  }
  const anchored = result.profiles.flatMap((profile, index) => {
    const linkedinUrl = crustdataLinkedinUrl(profile);
    return linkedinUrl
      ? [{ key: `${index}`, linkedinUrl, profile }]
      : [];
  });
  if (anchored.length === 0) {
    return {
      profiles: [],
      providerTotal: null,
      rawReturnedCount: 0,
      requestedLimit: result.requestedLimit,
    };
  }
  const proofs = await createCandidateAdmissionProofs(
    anchored.map(({ key, linkedinUrl }) => ({ key, linkedinUrl })),
  );
  const profiles = anchored
    .filter(({ key }) => proofs.has(key))
    .map(({ profile }) => profile);
  return {
    profiles,
    providerTotal: null,
    rawReturnedCount: profiles.length,
    requestedLimit: result.requestedLimit,
  };
}

async function resolveStoredReceipt(
  receipt: StoredReceipt,
  input: AcquireCrustdataSearchInput,
  dependencies: AcquireDependencies,
  requestFingerprint: string,
): Promise<AcquiredCrustdataSearch> {
  let current = receipt;
  const waitAttempts = dependencies.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
  const waitIntervalMs =
    dependencies.waitIntervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; current.status === "started"; attempt += 1) {
    if (attempt >= waitAttempts) {
      throw new CrustdataAcquisitionSafetyError(
        "receipt_in_progress",
        `Crustdata ${input.slot} acquisition is still in progress; refusing a duplicate provider call`,
      );
    }
    await sleep(waitIntervalMs);
    const refreshed = await findStoredReceipt(dependencies.store, input);
    if (!refreshed) {
      throw new CrustdataAcquisitionSafetyError(
        "receipt_missing",
        `Crustdata ${input.slot} acquisition receipt disappeared; refusing a duplicate provider call`,
      );
    }
    current = refreshed;
  }

  if (current.status === "uncertain") {
    throw new CrustdataAcquisitionSafetyError(
      "receipt_uncertain",
      `Crustdata ${input.slot} acquisition outcome is uncertain; refusing a duplicate provider call${
        current.error ? `: ${current.error}` : ""
      }`,
    );
  }
  if (current.status !== "complete") {
    throw new CrustdataAcquisitionSafetyError(
      "receipt_invalid",
      `Crustdata ${input.slot} acquisition receipt has unsupported status ${current.status}`,
    );
  }

  return {
    result: await privacyFilterCrustdataResult(parseResult(current.result)),
    receiptId: current.id,
    reused: true,
    requestFingerprint: current.requestFingerprint,
    requestFingerprintMatched:
      current.requestFingerprint === requestFingerprint,
    metadata: parseMetadata(current.requestMetadata),
    acquiredAt: current.startedAt,
    memoryIngestedAt: current.memoryIngestedAt ?? null,
  };
}

export async function acquireCrustdataSearch(
  input: AcquireCrustdataSearchInput,
  dependencies: AcquireDependencies,
): Promise<AcquiredCrustdataSearch> {
  if (!disposablePrivacyAdapterEnabled()) {
    await (dependencies.requirePrivacyHealth ??
      requireHealthyCandidatePrivacyContext)();
  }
  const requestFingerprint = buildCrustdataRequestFingerprint(input);
  const existing = await findStoredReceipt(dependencies.store, input);
  if (existing) {
    return resolveStoredReceipt(
      existing,
      input,
      dependencies,
      requestFingerprint,
    );
  }
  if (input.reuseOnly) {
    throw new CrustdataAcquisitionSafetyError(
      "receipt_missing",
      `Crustdata ${input.slot} acquisition receipt disappeared; refusing a duplicate provider call`,
    );
  }

  let receipt: StoredReceipt;
  try {
    receipt = await dependencies.store.reserve({
      tenantId: input.tenantId,
      sourcingRequestId: input.sourcingRequestId,
      acquisitionGeneration: input.acquisitionGeneration,
      slot: input.slot,
      requestFingerprint,
      requestInput: buildCrustdataRequestInput(input),
      requestMetadata: input.metadata,
    });
  } catch (error) {
    const competing = await findStoredReceipt(dependencies.store, input);
    if (!competing) {
      throw new CrustdataAcquisitionSafetyError(
        "receipt_persistence_failed",
        `Crustdata ${input.slot} acquisition receipt could not be reserved; refusing an unreceipted provider call: ${errorMessage(error)}`,
      );
    }
    return resolveStoredReceipt(
      competing,
      input,
      dependencies,
      requestFingerprint,
    );
  }

  // Crustdata documents no request idempotency key. The durable reservation is
  // therefore committed before dispatch. If the process dies after dispatch but
  // before `complete`, `started` is never reclaimed automatically: availability
  // is sacrificed rather than risking a second charge for this generation.
  let result: CrustdataSearchResult;
  try {
    result = await dependencies.search(input.requirements, input.limit, {
      excludePersonIds: input.excludePersonIds,
    });
  } catch (error) {
    const message = errorMessage(error);
    await dependencies.store.markUncertain(receipt.id, message).catch(() => {});
    throw new CrustdataAcquisitionSafetyError(
      "receipt_uncertain",
      `Crustdata ${input.slot} acquisition outcome is uncertain; refusing a duplicate provider call: ${message}`,
    );
  }

  let privacySafeResult: CrustdataSearchResult;
  try {
    privacySafeResult = await privacyFilterCrustdataResult(result);
  } catch {
    await dependencies.store
      .markUncertain(receipt.id, "candidate_privacy_unavailable")
      .catch(() => {});
    throw new CrustdataAcquisitionSafetyError(
      "receipt_uncertain",
      "Crustdata acquisition could not be privacy-admitted; provider output was discarded",
    );
  }

  try {
    await dependencies.store.complete(receipt.id, privacySafeResult);
  } catch (error) {
    const message = errorMessage(error);
    throw new CrustdataAcquisitionSafetyError(
      "receipt_persistence_failed",
      `Crustdata ${input.slot} acquisition succeeded but its receipt could not be persisted; refusing a duplicate provider call: ${message}`,
    );
  }
  return {
    result: privacySafeResult,
    receiptId: receipt.id,
    reused: false,
    requestFingerprint,
    requestFingerprintMatched: true,
    metadata: input.metadata,
    acquiredAt: receipt.startedAt,
    memoryIngestedAt: receipt.memoryIngestedAt ?? null,
  };
}

export const prismaCrustdataReceiptStore: CrustdataReceiptStore = {
  async find(tenantId, sourcingRequestId, acquisitionGeneration, slot) {
    return prisma.crustdataAcquisitionReceipt.findUnique({
      where: {
        tenantId_sourcingRequestId_acquisitionGeneration_slot: {
          tenantId,
          sourcingRequestId,
          acquisitionGeneration,
          slot,
        },
      },
      select: {
        id: true,
        status: true,
        startedAt: true,
        requestFingerprint: true,
        requestMetadata: true,
        result: true,
        error: true,
        effectsAppliedAt: true,
        effectMetadata: true,
        memoryIngestedAt: true,
        memoryIngestMetadata: true,
      },
    });
  },
  async reserve(input) {
    return prisma.crustdataAcquisitionReceipt.create({
      data: {
        tenantId: input.tenantId,
        sourcingRequestId: input.sourcingRequestId,
        acquisitionGeneration: input.acquisitionGeneration,
        slot: input.slot,
        status: "started",
        requestFingerprint: input.requestFingerprint,
        requestInput: toJsonValue(input.requestInput),
        requestMetadata: toJsonValue(input.requestMetadata),
      },
      select: {
        id: true,
        status: true,
        startedAt: true,
        requestFingerprint: true,
        requestMetadata: true,
        result: true,
        error: true,
        effectsAppliedAt: true,
        effectMetadata: true,
        memoryIngestedAt: true,
        memoryIngestMetadata: true,
      },
    });
  },
  async complete(id, result) {
    const updated = await prisma.crustdataAcquisitionReceipt.updateMany({
      where: { id, status: "started" },
      data: {
        status: "complete",
        result: toJsonValue(result),
        error: null,
        completedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      throw new Error(
        "Crustdata acquisition receipt could not be completed; refusing to reacquire",
      );
    }
  },
  async markUncertain(id, error) {
    await prisma.crustdataAcquisitionReceipt.updateMany({
      where: { id, status: "started" },
      data: {
        status: "uncertain",
        error,
      },
    });
  },
};

export async function acquireCrustdataSearchForRequest(
  input: AcquireCrustdataSearchInput,
): Promise<AcquiredCrustdataSearch> {
  const { searchPeople } = await import("./crustdata-client");
  return acquireCrustdataSearch(input, {
    store: prismaCrustdataReceiptStore,
    search: searchPeople,
  });
}

export async function findCrustdataAcquisitionReceipt(
  tenantId: string,
  sourcingRequestId: string,
  acquisitionGeneration: number,
  slot: CrustdataAcquisitionSlot,
): Promise<StoredReceipt | null> {
  return findStoredReceipt(prismaCrustdataReceiptStore, {
    tenantId,
    sourcingRequestId,
    acquisitionGeneration,
    slot,
  });
}

export async function applyCrustdataReceiptEffectOnce<T>(
  tenantId: string,
  receiptId: string,
  effect: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<{ applied: boolean; metadata: T }> {
  return prisma.$transaction(async (transaction) => {
    const claimed = await transaction.crustdataAcquisitionReceipt.updateMany({
      where: {
        id: receiptId,
        tenantId,
        status: "complete",
        effectsAppliedAt: null,
      },
      data: { effectsAppliedAt: new Date() },
    });

    if (claimed.count === 0) {
      const existing = await transaction.crustdataAcquisitionReceipt.findFirst({
        where: { id: receiptId, tenantId },
        select: { effectsAppliedAt: true, effectMetadata: true },
      });
      if (!existing?.effectsAppliedAt) {
        throw new Error(
          "Crustdata acquisition receipt is not eligible for downstream effects",
        );
      }
      return { applied: false, metadata: existing.effectMetadata as T };
    }

    const metadata = await effect(transaction);
    await transaction.crustdataAcquisitionReceipt.update({
      where: { id: receiptId },
      data: { effectMetadata: toJsonValue(metadata) },
    });
    return { applied: true, metadata };
  });
}

export async function markCrustdataReceiptMemoryIngested(
  tenantId: string,
  receiptId: string,
  metadata: unknown,
): Promise<boolean> {
  const now = new Date();
  const updated = await prisma.crustdataAcquisitionReceipt.updateMany({
    where: {
      id: receiptId,
      tenantId,
      status: "complete",
      memoryIngestedAt: null,
    },
    data: {
      memoryIngestedAt: now,
      memoryIngestMetadata: toJsonValue(metadata),
    },
  });
  if (updated.count === 1) return true;

  const existing = await prisma.crustdataAcquisitionReceipt.findFirst({
    where: { id: receiptId, tenantId },
    select: { memoryIngestedAt: true },
  });
  if (existing?.memoryIngestedAt) return false;
  throw new Error(
    "Crustdata receipt Memory ingestion could not be recorded",
  );
}

export async function releaseCrustdataReceiptPayloads(
  tenantId: string,
  sourcingRequestId: string,
  acquisitionGeneration: number,
): Promise<number> {
  const released = await prisma.crustdataAcquisitionReceipt.updateMany({
    where: {
      tenantId,
      sourcingRequestId,
      acquisitionGeneration,
      status: "complete",
      memoryIngestedAt: { not: null },
    },
    data: {
      status: "released",
      result: Prisma.DbNull,
    },
  });
  return released.count;
}

export async function releaseAbandonedCrustdataReceiptPayloads(
  tenantId: string,
  sourcingRequestId: string,
  acquisitionGeneration: number,
): Promise<number> {
  const released = await prisma.crustdataAcquisitionReceipt.updateMany({
    where: {
      tenantId,
      sourcingRequestId,
      acquisitionGeneration,
      status: "complete",
    },
    data: {
      status: "released",
      result: Prisma.DbNull,
    },
  });
  return released.count;
}

export async function releaseDeliveredCrustdataReceiptPayloads(
  tenantId?: string,
): Promise<number> {
  const released = await prisma.crustdataAcquisitionReceipt.updateMany({
    where: {
      status: "complete",
      memoryIngestedAt: { not: null },
      ...(tenantId ? { tenantId } : {}),
      sourcingRequest: {
        status: "complete",
        callbackStatus: "delivered",
      },
    },
    data: {
      status: "released",
      result: Prisma.DbNull,
    },
  });
  return released.count;
}
