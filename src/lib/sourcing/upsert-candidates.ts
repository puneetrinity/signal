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

export function resolveProviderObservedAt(
  existingUpdatedAt: Date | null | undefined,
  providerObservedAt: Date | undefined,
  now = new Date(),
): Date {
  const observedAt = providerObservedAt ?? now;
  return existingUpdatedAt && existingUpdatedAt > observedAt
    ? existingUpdatedAt
    : observedAt;
}

export function providerObservationIsOlder(
  existingUpdatedAt: Date | null | undefined,
  providerObservedAt: Date | undefined,
): boolean {
  return Boolean(
    providerObservedAt &&
      existingUpdatedAt &&
      existingUpdatedAt > providerObservedAt,
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'P2002',
  );
}

const MAX_CANDIDATE_WRITE_ATTEMPTS = 5;

export async function upsertDiscoveredCandidates(
  tenantId: string,
  profiles: ProfileSummary[],
  searchQuery: string,
  searchProvider: string,
  options: {
    captureSource?: string;
    preserveExistingProvenance?: boolean;
    providerObservedAt?: Date;
    providerObservedAtByRung?: ReadonlyMap<string, Date>;
    failOnError?: boolean;
  } = {},
): Promise<Map<string, string>> {
  const candidateMap = new Map<string, string>();

  const chunkSize = 25;
  for (let i = 0; i < profiles.length; i += chunkSize) {
    const chunk = profiles.slice(i, i + chunkSize);
    const outcomes = await Promise.allSettled(
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
          const sourcingMetadata = (
            result.providerMeta as
              | { sourcing?: { ladderRung?: string } }
              | undefined
          )?.sourcing;
          const rungObservedAt = sourcingMetadata?.ladderRung
            ? options?.providerObservedAtByRung?.get(
                sourcingMetadata.ladderRung,
              )
            : undefined;
          const providerObservedAt =
            rungObservedAt ?? options?.providerObservedAt ?? new Date();
          const hasExplicitProviderObservation = Boolean(
            rungObservedAt ?? options?.providerObservedAt,
          );
          let candidateId: string | null = null;

          // Optimistic compare-and-swap makes provider observation ordering
          // atomic. If another run updates this person between our read and
          // write, the timestamp predicate fails and we re-read before deciding
          // whether the older receipt is still allowed to write.
          for (
            let attempt = 0;
            attempt < MAX_CANDIDATE_WRITE_ATTEMPTS;
            attempt += 1
          ) {
            const existing = await prisma.candidate.findUnique({
              where: { tenantId_linkedinId: { tenantId, linkedinId } },
              select: {
                id: true,
                nameHint: true,
                headlineHint: true,
                locationHint: true,
                companyHint: true,
                profilePictureUrl: true,
                updatedAt: true,
              },
            });

            if (
              existing &&
              providerObservationIsOlder(
                existing.updatedAt,
                providerObservedAt,
              )
            ) {
              candidateId = existing.id;
              break;
            }

            if (!existing) {
              try {
                const created = await prisma.candidate.create({
                  data: {
                    tenantId,
                    linkedinUrl: result.linkedinUrl,
                    linkedinId,
                    searchTitle: result.title,
                    searchSnippet: result.snippet,
                    searchMeta: ({
                      ...(result.providerMeta ?? {}),
                      ...(result.crustdata
                        ? { crustdata: result.crustdata }
                        : {}),
                    }) as Prisma.InputJsonValue,
                    nameHint,
                    headlineHint,
                    locationHint,
                    companyHint,
                    captureSource: options.captureSource ?? 'sourcing',
                    searchQuery,
                    searchProvider,
                    ...(hasExplicitProviderObservation
                      ? {
                          createdAt: providerObservedAt,
                          updatedAt: providerObservedAt,
                        }
                      : {}),
                    ...(result.profilePictureUrl
                      ? { profilePictureUrl: result.profilePictureUrl }
                      : {}),
                  },
                  select: { id: true },
                });
                candidateId = created.id;
                break;
              } catch (error) {
                if (isUniqueConstraintError(error)) continue;
                throw error;
              }
            }

            const updateData: Prisma.CandidateUpdateManyMutationInput = {
              ...(options.preserveExistingProvenance
                ? {}
                : {
                    searchTitle: result.title,
                    searchSnippet: result.snippet,
                    searchMeta: ({
                      ...(result.providerMeta ?? {}),
                      ...(result.crustdata
                        ? { crustdata: result.crustdata }
                        : {}),
                    }) as Prisma.InputJsonValue,
                    searchProvider,
                  }),
              updatedAt: resolveProviderObservedAt(
                existing.updatedAt,
                providerObservedAt,
              ),
            };
            // Only overwrite profilePictureUrl if we don't already have one
            // (enrichment-sourced pictures are higher quality than Crustdata CDN URLs).
            if (result.profilePictureUrl && !existing.profilePictureUrl) {
              updateData.profilePictureUrl = result.profilePictureUrl;
            }
            if (shouldReplaceHint(existing.nameHint, nameHint)) {
              updateData.nameHint = nameHint;
            }
            if (shouldReplaceHint(existing.headlineHint, headlineHint)) {
              updateData.headlineHint = headlineHint;
            }
            if (
              shouldReplaceLocationHint(existing.locationHint, locationHint)
            ) {
              updateData.locationHint = locationHint;
            }
            if (
              shouldReplaceCompanyHint(existing.companyHint, companyHint)
            ) {
              updateData.companyHint = companyHint;
            }

            const updated = await prisma.candidate.updateMany({
              where: {
                id: existing.id,
                tenantId,
                updatedAt: existing.updatedAt,
              },
              data: updateData,
            });
            if (updated.count === 1) {
              candidateId = existing.id;
              break;
            }
          }

          if (!candidateId) {
            // Optimistic-lock exhaustion means another writer (e.g. the
            // public-ingest outbox worker) is actively landing fresher data
            // on this row. Skipping mirrors the observation-order rule —
            // older evidence never overwrites newer — and the acquisition
            // receipt still holds the paid payload for replay. One hot row
            // must not fail a 300-candidate run (job-155 outage, round 2).
            console.warn(
              `[sourcing] Skipping ${linkedinId}: row contended past ${MAX_CANDIDATE_WRITE_ATTEMPTS} attempts (fresher writer wins)`,
            );
            return;
          }
          candidateMap.set(linkedinId, candidateId);
        } catch (error) {
          console.error(`[sourcing] Failed to upsert candidate ${linkedinId}:`, error);
          if (options?.failOnError) throw error;
        }
      })
    );
    const failed = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );
    if (failed) throw failed.reason;
  }

  return candidateMap;
}
