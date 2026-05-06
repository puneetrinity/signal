import { fetchEnrichLayerPersonalEmail, fetchEnrichLayerProfile, type EnrichLayerEmailResponse, type EnrichLayerProfileResponse } from '@/lib/enrichment/enrichlayer';
import { fetchReverseContactSignals, getReverseContactStatus, type ReverseContactSignalResult } from '@/lib/enrichment/reversecontact';
import type { V1Candidate } from './v1-candidate';

export interface ShortlistEnrichmentResult {
  candidate: V1Candidate;
  profile: EnrichLayerProfileResponse | null;
  email: EnrichLayerEmailResponse | null;
  reverseContact: ReverseContactSignalResult | null;
  verificationRequired: boolean;
  emailAvailable: boolean;
  activeSeeker: boolean | null;
  outreachReady: boolean;
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
      let reverseContact: ReverseContactSignalResult | null = null;
      const reverseContactEnabled = getReverseContactStatus().enabled;

      const [profileResult, emailResult, reverseContactResult] = await Promise.allSettled([
        fetchEnrichLayerProfile(candidate.linkedinUrl),
        fetchEnrichLayerPersonalEmail(candidate.linkedinUrl),
        reverseContactEnabled
          ? fetchReverseContactSignals(candidate.linkedinUrl)
          : Promise.resolve(null),
      ]);

      if (profileResult.status === 'fulfilled') {
        profile = profileResult.value;
      } else {
        errors.push(
          profileResult.reason instanceof Error
            ? `profile:${profileResult.reason.message}`
            : 'profile:unknown_error',
        );
      }

      if (emailResult.status === 'fulfilled') {
        email = emailResult.value;
      } else {
        errors.push(
          emailResult.reason instanceof Error
            ? `email:${emailResult.reason.message}`
            : 'email:unknown_error',
        );
      }

      if (reverseContactResult.status === 'fulfilled') {
        reverseContact = reverseContactResult.value;
      } else {
        errors.push(
          reverseContactResult.reason instanceof Error
            ? `reversecontact:${reverseContactResult.reason.message}`
            : 'reversecontact:unknown_error',
        );
      }

      const emailAvailable = Boolean(
        email?.personal_emails?.length || email?.work_email,
      );
      const activeSeeker = reverseContact?.activeSeeker ?? null;
      const outreachReady = emailAvailable;

      return {
        candidate: {
          ...candidate,
          emailAvailable,
          activeSeeker: activeSeeker ?? undefined,
          outreachReady,
        },
        profile,
        email,
        reverseContact,
        verificationRequired: true,
        emailAvailable,
        activeSeeker,
        outreachReady,
        errors,
      };
    }),
  );
}
