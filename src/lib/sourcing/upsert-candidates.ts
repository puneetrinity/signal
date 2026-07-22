import { prisma } from '@/lib/prisma';
import { extractAllHints, extractCompanyFromHeadline } from '@/lib/search/hint-extraction';
import {
  normalizeHint,
  shouldReplaceHint,
  shouldReplaceLocationHint,
  shouldReplaceCompanyHint,
  locationHintQualityScore,
} from './hint-sanitizer';
import { enqueueGraphSync } from '@/lib/integrations/candidate-graph-sync';
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

  const chunkSize = 25;
  for (let i = 0; i < profiles.length; i += chunkSize) {
    const chunk = profiles.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (result) => {
        const linkedinId = result.canonicalLinkedinId || extractLinkedInId(result.linkedinUrl);
        if (!linkedinId) return;

        // Run hint extraction only over title + headline — NOT the full snippet blob.
        // The snippet can be several KB of job description text, causing extractAllHints
        // to pick up garbage (e.g. "UK" as a company name from "...based in the UK").
        const hintText = [result.title, result.headline].filter(Boolean).join(' | ');
        const extractedHints = extractAllHints(linkedinId, result.title, hintText);
        const nameHint = normalizeHint(result.name ?? extractedHints.nameHint ?? undefined) ?? undefined;
        const headlineHint = normalizeHint(result.headline ?? extractedHints.headlineHint ?? undefined) ?? undefined;
        const locationHint = normalizeHint(result.location ?? extractedHints.locationHint ?? undefined) ?? undefined;
        // Company: prefer explicit value from Crustdata structured field over text extraction.
        let companyHint = normalizeHint(result.companyHint ?? extractedHints.companyHint ?? undefined) ?? undefined;
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
              profilePictureUrl: true,
            },
          });

          const updateData: Prisma.CandidateUpdateInput = {
            searchTitle: result.title,
            searchSnippet: result.snippet,
            searchMeta: ({
              ...(result.providerMeta ?? {}),
              ...(result.crustdata ? { crustdata: result.crustdata } : {}),
            }) as Prisma.InputJsonValue,
            searchProvider,
            updatedAt: new Date(),
          };
          // Only overwrite profilePictureUrl if we don't already have one
          // (enrichment-sourced pictures are higher quality than Crustdata CDN URLs).
          if (result.profilePictureUrl && (!existing || !existing.profilePictureUrl)) {
            updateData.profilePictureUrl = result.profilePictureUrl;
          }
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
              searchMeta: ({
                ...(result.providerMeta ?? {}),
                ...(result.crustdata ? { crustdata: result.crustdata } : {}),
              }) as Prisma.InputJsonValue,
              nameHint,
              headlineHint,
              locationHint,
              companyHint,
              captureSource: 'sourcing',
              searchQuery,
              searchProvider,
              ...(result.profilePictureUrl ? { profilePictureUrl: result.profilePictureUrl } : {}),
            },
          });

          candidateMap.set(linkedinId, candidate.id);
        } catch (error) {
          console.error(`[sourcing] Failed to upsert candidate ${linkedinId}:`, error);
        }
      })
    );
  }

  return candidateMap;
}

