import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolveRoleDeterministic, type RoleFamily } from '@/lib/taxonomy/role-service';
import type { CrustdataProfileResponse } from './crustdata-client';
import { buildObservedPublicMarket, type PublicMarket } from './public-memory';
import { normalizeGlobalCandidateId } from './global-candidate-id';
import { isTenantPrivateTemporaryId } from './tenant-private-memory';

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
}: {
  tenantId: string;
  candidateId: string;
  globalCandidateId: string;
  matchMethod: string;
  linkConfidence?: number | null;
}): Promise<CandidateGlobalLinkResult> {
  const canonicalGlobalCandidateId =
    normalizeGlobalCandidateId(globalCandidateId);
  if (!canonicalGlobalCandidateId) {
    throw new Error(`Invalid Memory global candidate UUID: ${globalCandidateId}`);
  }
  const tenantCandidate = await prisma.candidate.findFirst({
    where: { id: candidateId, tenantId },
    select: { id: true },
  });
  if (!tenantCandidate) {
    throw new Error(
      `Candidate ${candidateId} does not belong to tenant ${tenantId}`,
    );
  }

  const linkedByGlobal = await prisma.candidateGlobalLink.findUnique({
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
      await prisma.candidateGlobalLink.update({
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

  const linkedByCandidate = await prisma.candidateGlobalLink.findUnique({
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
      await prisma.candidateGlobalLink.update({
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
    await prisma.candidateGlobalLink.create({
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

    const raceWinner = await prisma.candidateGlobalLink.findUnique({
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

    const candidateWinner = await prisma.candidateGlobalLink.findUnique({
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
