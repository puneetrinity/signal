import { prisma } from '@/lib/prisma';
import { extractAllHints, extractCompanyFromHeadline } from '@/lib/enrichment/hint-extraction';
import type { ProfileSummary } from '@/types/linkedin';
import type { Prisma } from '@prisma/client';

const PLACEHOLDER_HINTS = new Set(['na', 'n/a', 'unknown', 'none', 'null', '-', '...']);

function normalizeHint(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function isNoisyHint(value: string): boolean {
  const lower = value.toLowerCase();
  if (PLACEHOLDER_HINTS.has(lower)) return true;
  if (/\.{3,}|…/.test(value)) return true;
  if (/\blinkedin\b|\bview\b.*\bprofile\b|https?:\/\/|www\./i.test(value)) return true;
  return false;
}

function hintQualityScore(value: string | null): number {
  if (!value) return 0;
  if (isNoisyHint(value)) return 0;
  const words = value.split(/\s+/).filter(Boolean).length;
  return Math.min(4, Math.max(1, words));
}

function shouldReplaceHint(existing: string | null, incoming: string | undefined): boolean {
  const normalizedIncoming = normalizeHint(incoming);
  if (!normalizedIncoming) return false;
  const incomingScore = hintQualityScore(normalizedIncoming);
  if (incomingScore === 0) return false;
  return incomingScore > hintQualityScore(existing);
}

function extractLinkedInId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/in\/([^/]+)/);
    if (match) {
      return match[1].split(/[?#]/)[0].replace(/\/$/, '');
    }
    return null;
  } catch {
    return null;
  }
}

export async function upsertDiscoveredCandidates(
  tenantId: string,
  profiles: ProfileSummary[],
  searchQuery: string,
): Promise<Map<string, string>> {
  const candidateMap = new Map<string, string>();

  for (const result of profiles) {
    const linkedinId = extractLinkedInId(result.linkedinUrl);
    if (!linkedinId) continue;

    const extractedHints = extractAllHints(linkedinId, result.title, result.snippet);
    const nameHint = normalizeHint(result.name ?? extractedHints.nameHint ?? undefined) ?? undefined;
    const headlineHint = normalizeHint(result.headline ?? extractedHints.headlineHint ?? undefined) ?? undefined;
    const locationHint = normalizeHint(result.location ?? extractedHints.locationHint ?? undefined) ?? undefined;
    let companyHint = normalizeHint(extractedHints.companyHint ?? undefined) ?? undefined;
    if (!companyHint && headlineHint) {
      companyHint = normalizeHint(extractCompanyFromHeadline(headlineHint) ?? undefined) ?? undefined;
    }

    try {
      const existing = await prisma.candidate.findUnique({
        where: { tenantId_linkedinId: { tenantId, linkedinId } },
        select: {
          nameHint: true,
          headlineHint: true,
          locationHint: true,
          companyHint: true,
        },
      });

      // For updates: only overwrite hint fields with truthy values to preserve
      // existing clean data when new extraction yields nothing/noise.
      const updateData: Prisma.CandidateUpdateInput = {
        searchTitle: result.title,
        searchSnippet: result.snippet,
        searchMeta: (result.providerMeta ?? undefined) as Prisma.InputJsonValue | undefined,
        updatedAt: new Date(),
      };
      if (shouldReplaceHint(existing?.nameHint ?? null, nameHint)) updateData.nameHint = nameHint;
      if (shouldReplaceHint(existing?.headlineHint ?? null, headlineHint)) updateData.headlineHint = headlineHint;
      if (shouldReplaceHint(existing?.locationHint ?? null, locationHint)) updateData.locationHint = locationHint;
      if (shouldReplaceHint(existing?.companyHint ?? null, companyHint)) updateData.companyHint = companyHint;

      const candidate = await prisma.candidate.upsert({
        where: { tenantId_linkedinId: { tenantId, linkedinId } },
        update: updateData,
        create: {
          tenantId,
          linkedinUrl: result.linkedinUrl,
          linkedinId,
          searchTitle: result.title,
          searchSnippet: result.snippet,
          searchMeta: (result.providerMeta ?? undefined) as Prisma.InputJsonValue | undefined,
          nameHint,
          headlineHint,
          locationHint,
          companyHint,
          captureSource: 'sourcing',
          searchQuery,
          searchProvider: 'serper',
        },
      });

      candidateMap.set(linkedinId, candidate.id);
    } catch (error) {
      console.error(`[sourcing] Failed to upsert candidate ${linkedinId}:`, error);
    }
  }

  return candidateMap;
}
