import { prisma } from '@/lib/prisma';
import { extractAllHints, extractCompanyFromHeadline } from '@/lib/enrichment/hint-extraction';
import {
  normalizeHint,
  shouldReplaceHint,
  shouldReplaceLocationHint,
  shouldReplaceCompanyHint,
} from './hint-sanitizer';
import type { ProfileSummary } from '@/types/linkedin';
import type { Prisma } from '@prisma/client';

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
  searchProvider: string,
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
        searchProvider,
        updatedAt: new Date(),
      };
      if (shouldReplaceHint(existing?.nameHint ?? null, nameHint)) updateData.nameHint = nameHint;
      if (shouldReplaceHint(existing?.headlineHint ?? null, headlineHint)) updateData.headlineHint = headlineHint;
      if (shouldReplaceLocationHint(existing?.locationHint ?? null, locationHint)) updateData.locationHint = locationHint;
      if (shouldReplaceCompanyHint(existing?.companyHint ?? null, companyHint)) updateData.companyHint = companyHint;

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
          searchProvider,
        },
      });

      candidateMap.set(linkedinId, candidate.id);
    } catch (error) {
      console.error(`[sourcing] Failed to upsert candidate ${linkedinId}:`, error);
    }
  }

  return candidateMap;
}
