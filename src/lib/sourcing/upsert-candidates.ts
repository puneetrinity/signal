import { prisma } from '@/lib/prisma';
import { extractAllHints, extractCompanyFromHeadline } from '@/lib/enrichment/hint-extraction';
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
): Promise<Map<string, string>> {
  const candidateMap = new Map<string, string>();

  for (const result of profiles) {
    const linkedinId = extractLinkedInId(result.linkedinUrl);
    if (!linkedinId) continue;

    const extractedHints = extractAllHints(linkedinId, result.title, result.snippet);
    const nameHint = result.name ?? extractedHints.nameHint ?? undefined;
    const headlineHint = result.headline ?? extractedHints.headlineHint ?? undefined;
    const locationHint = result.location ?? extractedHints.locationHint ?? undefined;
    let companyHint = extractedHints.companyHint ?? undefined;
    if (!companyHint && headlineHint) {
      companyHint = extractCompanyFromHeadline(headlineHint) ?? undefined;
    }

    try {
      const candidate = await prisma.candidate.upsert({
        where: { tenantId_linkedinId: { tenantId, linkedinId } },
        update: {
          searchTitle: result.title,
          searchSnippet: result.snippet,
          searchMeta: (result.providerMeta ?? undefined) as Prisma.InputJsonValue | undefined,
          nameHint,
          headlineHint,
          locationHint,
          companyHint,
          updatedAt: new Date(),
        },
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
