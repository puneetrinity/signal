import type { TenantPrivateSearchResult } from './activegraph-client';
import { resolveRoleDeterministic } from '@/lib/taxonomy/role-service';
import type { CandidateForRanking } from './ranking-new';

const PRIVATE_TEMP_PREFIX = 'private-memory:';

export interface TenantPrivateLinkedInAnchor {
  linkedinUrl: string;
  linkedinId: string;
}

export function resolveTenantPrivateLinkedInAnchor(
  candidate: Pick<TenantPrivateSearchResult, 'linkedinUrl' | 'linkedinId'>,
): TenantPrivateLinkedInAnchor | null {
  if (candidate.linkedinUrl) {
    try {
      const parsed = new URL(candidate.linkedinUrl);
      const host = parsed.hostname.toLowerCase();
      if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
        const match = parsed.pathname.match(/^\/(?:in|pub)\/([^/]+)/i);
        const slug = match?.[1]?.split(/[?#]/)[0]?.trim();
        if (slug) {
          return {
            linkedinUrl: `https://www.linkedin.com/in/${slug}`,
            linkedinId: slug,
          };
        }
      }
    } catch {
      // Try the typed linkedin_id below.
    }
  }
  const slug = candidate.linkedinId?.trim();
  if (!slug || /[/?#\s]/.test(slug)) return null;
  return {
    linkedinUrl: `https://www.linkedin.com/in/${slug}`,
    linkedinId: slug,
  };
}

export function makeTenantPrivateTemporaryId(candidateId: string): string {
  if (!candidateId.trim()) {
    throw new Error('Tenant-private Memory candidate ID is required');
  }
  return `${PRIVATE_TEMP_PREFIX}${encodeURIComponent(candidateId)}`;
}

export function isTenantPrivateTemporaryId(value: string): boolean {
  return value.startsWith(PRIVATE_TEMP_PREFIX);
}

function privateSnapshot(
  candidate: TenantPrivateSearchResult,
  existing: CandidateForRanking['snapshot'] = null,
  now = new Date(),
): NonNullable<CandidateForRanking['snapshot']> {
  const roleType =
    existing?.roleType ??
    (candidate.headline
      ? resolveRoleDeterministic(candidate.headline).family
      : null);
  return {
    skillsNormalized: Array.from(
      new Set([...(existing?.skillsNormalized ?? []), ...candidate.skills]),
    ),
    roleType,
    seniorityBand:
      existing?.seniorityBand ?? candidate.seniorityLevel,
    location: existing?.location ?? candidate.locationRaw,
    activityRecencyDays: existing?.activityRecencyDays ?? null,
    computedAt: existing?.computedAt ?? now,
    staleAfter:
      existing?.staleAfter ??
      new Date(now.getTime() + 24 * 60 * 60 * 1000),
  };
}

export function buildTenantPrivateRankingCandidate(
  candidate: TenantPrivateSearchResult,
  now = new Date(),
): {
  anchor: TenantPrivateLinkedInAnchor;
  rankingCandidate: CandidateForRanking;
} | null {
  const anchor = resolveTenantPrivateLinkedInAnchor(candidate);
  if (!anchor) return null;
  return {
    anchor,
    rankingCandidate: {
      id: makeTenantPrivateTemporaryId(candidate.candidateId),
      headlineHint: candidate.headline,
      seniorityHint: candidate.seniorityLevel,
      locationHint: candidate.locationRaw,
      searchTitle: candidate.headline,
      searchSnippet: null,
      enrichmentStatus: 'completed',
      lastEnrichedAt: null,
      crustdata: null,
      snapshot: privateSnapshot(candidate, null, now),
    },
  };
}

export function mergeTenantPrivateEvidence(
  existing: CandidateForRanking,
  candidate: TenantPrivateSearchResult,
  now = new Date(),
): CandidateForRanking {
  existing.headlineHint ??= candidate.headline;
  existing.seniorityHint ??= candidate.seniorityLevel;
  existing.locationHint ??= candidate.locationRaw;
  existing.snapshot = privateSnapshot(candidate, existing.snapshot, now);
  return existing;
}
