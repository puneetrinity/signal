import { fetchEnrichLayerPersonalEmail, fetchEnrichLayerProfile, type EnrichLayerEmailResponse, type EnrichLayerProfileResponse } from '@/lib/enrichment/enrichlayer';
import type { V1Candidate } from './v1-candidate';

export interface ShortlistEnrichmentResult {
  candidate: V1Candidate;
  profile: EnrichLayerProfileResponse | null;
  email: EnrichLayerEmailResponse | null;
  verificationRequired: boolean;
  emailAvailable: boolean;
  errors: string[];
}

export interface ShortlistEnrichmentOptions {
  maxCandidates?: number;
}

export async function enrichShortlistCandidates(
  candidates: V1Candidate[],
  options: ShortlistEnrichmentOptions = {},
): Promise<ShortlistEnrichmentResult[]> {
  const maxCandidates = Math.max(1, options.maxCandidates ?? 50);
  const shortlist = candidates.slice(0, maxCandidates);

  return Promise.all(
    shortlist.map(async (candidate): Promise<ShortlistEnrichmentResult> => {
      const errors: string[] = [];
      let profile: EnrichLayerProfileResponse | null = null;
      let email: EnrichLayerEmailResponse | null = null;

      try {
        profile = await fetchEnrichLayerProfile(candidate.linkedinUrl);
      } catch (error) {
        errors.push(
          error instanceof Error ? `profile:${error.message}` : 'profile:unknown_error',
        );
      }

      try {
        email = await fetchEnrichLayerPersonalEmail(candidate.linkedinUrl);
      } catch (error) {
        errors.push(
          error instanceof Error ? `email:${error.message}` : 'email:unknown_error',
        );
      }

      const emailAvailable = Boolean(
        email?.personal_emails?.length || email?.work_email,
      );

      return {
        candidate: {
          ...candidate,
          emailAvailable,
          outreachReady: emailAvailable,
        },
        profile,
        email,
        verificationRequired: true,
        emailAvailable,
        errors,
      };
    }),
  );
}
