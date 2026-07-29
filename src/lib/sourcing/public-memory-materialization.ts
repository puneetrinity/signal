import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolveRoleDeterministic, type RoleFamily } from '@/lib/taxonomy/role-service';
import type { ProfileSummary } from '@/types/linkedin';
import type { CrustdataProfileResponse } from './crustdata-client';
import { extractLinkedInIdFromUrl } from './discovery';
import { buildObservedPublicMarket, type PublicMarket } from './public-memory';
import { normalizeGlobalCandidateId } from './global-candidate-id';
import { isTenantPrivateTemporaryId } from './tenant-private-memory';
import { upsertDiscoveredCandidates } from './upsert-candidates';

const GLOBAL_TEMP_PREFIX = 'global:';

export interface PublicCandidateRoleInput {
  searchTitle?: string | null;
  headlineHint?: string | null;
  crustdata?: CrustdataProfileResponse | null;
}

export interface CandidateGlobalLinkResult {
  candidateId: string;
  created: boolean;
  raceResolved: boolean;
}

export type PublicMemoryMaterializationFailureCode =
  | 'missing_public_profile'
  | 'missing_linkedin_anchor'
  | 'linkedin_anchor_mismatch'
  | 'candidate_upsert_failed'
  | 'candidate_upsert_skipped'
  | 'global_link_failed';

export interface PublicMemoryMaterializationFailure {
  globalCandidateId: string | null;
  code: PublicMemoryMaterializationFailureCode;
}

export interface PublicMemoryMaterializationEntry {
  temporaryId: string;
  globalCandidateId: string;
  profile: ProfileSummary & { canonicalLinkedinId: string };
}

export interface PublicMemoryMaterializationResult {
  materializedByTemporaryId: Map<string, string>;
  failures: PublicMemoryMaterializationFailure[];
  raceWins: number;
}

const MATERIALIZATION_CONCURRENCY = 10;
export const MAX_MATERIALIZATION_FAILURE_DETAILS = 20;
type CandidateGlobalLinkClient = Pick<
  Prisma.TransactionClient,
  'candidate' | 'candidateGlobalLink'
>;

class MaterializationRaceWinner extends Error {
  constructor(readonly candidateId: string) {
    super('Another local candidate already owns this Memory identity');
    this.name = 'MaterializationRaceWinner';
  }
}

class MaterializationStageError extends Error {
  constructor(readonly stage: 'upsert' | 'link') {
    super(`Public Memory materialization ${stage} failed`);
    this.name = 'MaterializationStageError';
  }
}

export function makeGlobalTemporaryCandidateId(globalCandidateId: string): string {
  const normalized = normalizeGlobalCandidateId(globalCandidateId);
  if (!normalized) {
    throw new Error(`Invalid Memory global candidate UUID: ${globalCandidateId}`);
  }
  return `${GLOBAL_TEMP_PREFIX}${normalized}`;
}

export function parseGlobalTemporaryCandidateId(value: string): string | null {
  if (!value.startsWith(GLOBAL_TEMP_PREFIX)) return null;
  return normalizeGlobalCandidateId(value.slice(GLOBAL_TEMP_PREFIX.length));
}

export function isForbiddenCandidateForeignKey(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  return (
    normalized.startsWith(GLOBAL_TEMP_PREFIX) ||
    isTenantPrivateTemporaryId(normalized) ||
    normalizeGlobalCandidateId(normalized) !== null ||
    /^https?:\/\//i.test(normalized) ||
    /linkedin\.com\//i.test(normalized)
  );
}

export function assertPersistableCandidateIds(candidateIds: string[]): void {
  const invalid = candidateIds.filter(isForbiddenCandidateForeignKey);
  if (invalid.length > 0) {
    throw new Error(
      `Refusing to persist unresolved candidate IDs: ${invalid.slice(0, 5).join(', ')}`,
    );
  }
}

export function publicMaterializationLinkedinAnchorsAgree(
  profile: Pick<ProfileSummary, 'linkedinUrl'> & {
    canonicalLinkedinId: string;
  },
): boolean {
  const urlLinkedinId = extractLinkedInIdFromUrl(profile.linkedinUrl);
  return Boolean(
    urlLinkedinId &&
      urlLinkedinId.toLowerCase() ===
        profile.canonicalLinkedinId.trim().toLowerCase(),
  );
}

export function applyCandidateMaterializationResults<
  T extends { candidateId: string },
>({
  candidates,
  replacements,
  publicTemporaryCandidateIds,
}: {
  candidates: T[];
  replacements: ReadonlyMap<string, string>;
  publicTemporaryCandidateIds: ReadonlySet<string>;
}): {
  candidates: T[];
  skippedTemporaryCandidateIds: string[];
} {
  const resolved: T[] = [];
  const skippedTemporaryCandidateIds: string[] = [];
  for (const candidate of candidates) {
    const replacement = replacements.get(candidate.candidateId);
    if (replacement) {
      resolved.push({ ...candidate, candidateId: replacement });
      continue;
    }
    if (publicTemporaryCandidateIds.has(candidate.candidateId)) {
      skippedTemporaryCandidateIds.push(candidate.candidateId);
      continue;
    }
    resolved.push(candidate);
  }
  return { candidates: resolved, skippedTemporaryCandidateIds };
}

export async function materializePublicMemoryCandidates({
  tenantId,
  entries,
}: {
  tenantId: string;
  entries: PublicMemoryMaterializationEntry[];
}): Promise<PublicMemoryMaterializationResult> {
  const outcomes: Array<
    | {
        temporaryId: string;
        candidateId: string;
        raceResolved: boolean;
      }
    | { failure: PublicMemoryMaterializationFailure }
  > = [];

  for (
    let offset = 0;
    offset < entries.length;
    offset += MATERIALIZATION_CONCURRENCY
  ) {
    const chunk = entries.slice(
      offset,
      offset + MATERIALIZATION_CONCURRENCY,
    );
    outcomes.push(
      ...(await Promise.all(
        chunk.map(async (entry) => {
          if (!publicMaterializationLinkedinAnchorsAgree(entry.profile)) {
            return {
              failure: {
                globalCandidateId:
                  normalizeGlobalCandidateId(entry.globalCandidateId),
                code: 'linkedin_anchor_mismatch' as const,
              },
            };
          }

          try {
            const link = await prisma.$transaction(
              async (transaction) => {
                let candidateMap: Map<string, string>;
                try {
                  candidateMap = await upsertDiscoveredCandidates(
                    tenantId,
                    [entry.profile],
                    'public_memory_hydration',
                    'activegraph_public',
                    {
                      failOnError: true,
                      adoptCaseVariantIdentity: true,
                      db: transaction,
                    },
                  );
                } catch {
                  throw new MaterializationStageError('upsert');
                }
                const candidateId = candidateMap.get(
                  entry.profile.canonicalLinkedinId,
                );
                if (!candidateId) return null;
                try {
                  const linked = await ensureCandidateGlobalLink({
                    tenantId,
                    candidateId,
                    globalCandidateId: entry.globalCandidateId,
                    matchMethod: 'global_id_exact',
                    db: transaction,
                  });
                  if (linked.candidateId !== candidateId) {
                    throw new MaterializationRaceWinner(
                      linked.candidateId,
                    );
                  }
                  return linked;
                } catch (error) {
                  if (error instanceof MaterializationRaceWinner) {
                    throw error;
                  }
                  throw new MaterializationStageError('link');
                }
              },
            );
            if (!link) {
              return {
                failure: {
                  globalCandidateId:
                    normalizeGlobalCandidateId(
                      entry.globalCandidateId,
                    ),
                  code: 'candidate_upsert_skipped' as const,
                },
              };
            }
            return {
              temporaryId: entry.temporaryId,
              candidateId: link.candidateId,
              raceResolved: link.raceResolved,
            };
          } catch (error) {
            if (error instanceof MaterializationRaceWinner) {
              return {
                temporaryId: entry.temporaryId,
                candidateId: error.candidateId,
                raceResolved: true,
              };
            }
            return {
              failure: {
                globalCandidateId:
                  normalizeGlobalCandidateId(entry.globalCandidateId),
                code:
                  error instanceof MaterializationStageError &&
                  error.stage === 'link'
                    ? ('global_link_failed' as const)
                    : ('candidate_upsert_failed' as const),
              },
            };
          }
        }),
      )),
    );
  }

  const materializedByTemporaryId = new Map<string, string>();
  const failures: PublicMemoryMaterializationFailure[] = [];
  let raceWins = 0;
  for (const outcome of outcomes) {
    if ('failure' in outcome) {
      failures.push(outcome.failure);
      continue;
    }
    materializedByTemporaryId.set(
      outcome.temporaryId,
      outcome.candidateId,
    );
    if (outcome.raceResolved) raceWins++;
  }
  failures.sort((left, right) =>
    `${left.globalCandidateId}:${left.code}`.localeCompare(
      `${right.globalCandidateId}:${right.code}`,
    ),
  );
  return { materializedByTemporaryId, failures, raceWins };
}

export function resolvePublicCandidateRoleFamily(
  candidate: PublicCandidateRoleInput,
): RoleFamily | null {
  const currentTitles =
    candidate.crustdata?.experience?.employment_details?.current
      ?.map((role) => role.title)
      .filter((title): title is string => Boolean(title?.trim())) ?? [];
  const candidates = [
    ...currentTitles,
    candidate.searchTitle,
    candidate.crustdata?.basic_profile?.current_title,
    candidate.headlineHint,
    candidate.crustdata?.basic_profile?.headline,
  ];

  for (const title of candidates) {
    if (!title?.trim()) continue;
    const family = resolveRoleDeterministic(title).family;
    if (family) return family;
  }
  return null;
}

export function buildObservedCandidatePublicMarket(
  candidate: PublicCandidateRoleInput & {
    seniorityHint?: string | null;
    locationHint?: string | null;
  },
): PublicMarket | null {
  const currentRole =
    candidate.crustdata?.experience?.employment_details?.current?.[0];
  const publicLocation = candidate.crustdata?.basic_profile?.location;
  const location = [
    publicLocation?.city,
    publicLocation?.state,
    publicLocation?.country,
  ]
    .filter(Boolean)
    .join(', ');
  const resolvedLocation =
    publicLocation?.full_location ||
    publicLocation?.raw ||
    location ||
    candidate.locationHint ||
    null;
  const seniority =
    currentRole?.seniority_level ??
    candidate.seniorityHint ??
    candidate.searchTitle ??
    currentRole?.title ??
    null;

  return buildObservedPublicMarket({
    roleFamily: resolvePublicCandidateRoleFamily(candidate),
    location: resolvedLocation,
    seniorityLevel: seniority,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Link a Signal-local candidate to a canonical Memory UUID without ever
 * reassigning either side. The database constraint arbitrates concurrent
 * materializers; the loser re-reads and adopts the existing local winner.
 */
export async function ensureCandidateGlobalLink({
  tenantId,
  candidateId,
  globalCandidateId,
  matchMethod,
  linkConfidence,
  db = prisma,
}: {
  tenantId: string;
  candidateId: string;
  globalCandidateId: string;
  matchMethod: string;
  linkConfidence?: number | null;
  db?: CandidateGlobalLinkClient;
}): Promise<CandidateGlobalLinkResult> {
  const canonicalGlobalCandidateId =
    normalizeGlobalCandidateId(globalCandidateId);
  if (!canonicalGlobalCandidateId) {
    throw new Error(`Invalid Memory global candidate UUID: ${globalCandidateId}`);
  }
  const tenantCandidate = await db.candidate.findFirst({
    where: { id: candidateId, tenantId },
    select: { id: true },
  });
  if (!tenantCandidate) {
    throw new Error(
      `Candidate ${candidateId} does not belong to tenant ${tenantId}`,
    );
  }

  const linkedByGlobal = await db.candidateGlobalLink.findUnique({
    where: {
      tenantId_globalCandidateId: {
        tenantId,
        globalCandidateId: canonicalGlobalCandidateId,
      },
    },
    select: { candidateId: true },
  });
  if (linkedByGlobal) {
    if (linkedByGlobal.candidateId === candidateId) {
      await db.candidateGlobalLink.update({
        where: {
          tenantId_globalCandidateId: {
            tenantId,
            globalCandidateId: canonicalGlobalCandidateId,
          },
        },
        data: {
          matchMethod,
          ...(linkConfidence == null ? {} : { linkConfidence }),
        },
      });
    }
    return {
      candidateId: linkedByGlobal.candidateId,
      created: false,
      raceResolved: linkedByGlobal.candidateId !== candidateId,
    };
  }

  const linkedByCandidate = await db.candidateGlobalLink.findUnique({
    where: { candidateId },
    select: {
      tenantId: true,
      globalCandidateId: true,
    },
  });
  if (linkedByCandidate) {
    if (
      linkedByCandidate.tenantId === tenantId &&
      linkedByCandidate.globalCandidateId === canonicalGlobalCandidateId
    ) {
      await db.candidateGlobalLink.update({
        where: { candidateId },
        data: {
          matchMethod,
          ...(linkConfidence == null ? {} : { linkConfidence }),
        },
      });
      return { candidateId, created: false, raceResolved: false };
    }
    throw new Error(
      `Candidate ${candidateId} is already linked to another Memory identity`,
    );
  }

  try {
    await db.candidateGlobalLink.create({
      data: {
        tenantId,
        candidateId,
        globalCandidateId: canonicalGlobalCandidateId,
        linkConfidence,
        matchMethod,
      },
    });
    return { candidateId, created: true, raceResolved: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const raceWinner = await db.candidateGlobalLink.findUnique({
      where: {
        tenantId_globalCandidateId: {
          tenantId,
          globalCandidateId: canonicalGlobalCandidateId,
        },
      },
      select: { candidateId: true },
    });
    if (raceWinner) {
      return {
        candidateId: raceWinner.candidateId,
        created: false,
        raceResolved: raceWinner.candidateId !== candidateId,
      };
    }

    const candidateWinner = await db.candidateGlobalLink.findUnique({
      where: { candidateId },
      select: {
        tenantId: true,
        globalCandidateId: true,
      },
    });
    if (
      candidateWinner?.tenantId === tenantId &&
      candidateWinner.globalCandidateId === canonicalGlobalCandidateId
    ) {
      return { candidateId, created: false, raceResolved: false };
    }
    throw error;
  }
}
