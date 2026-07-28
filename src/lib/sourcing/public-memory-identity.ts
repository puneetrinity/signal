import type { GlobalPoolSearchResult } from './activegraph-client';
import { extractLinkedInIdFromUrl } from './discovery';
import type { CandidateForRanking } from './ranking-new';

type CandidateIdentityInput = Partial<CandidateForRanking> & {
  id?: string;
  linkedinUrl?: string | null;
};

export function candidatePublicIdentityKey(
  candidate: CandidateIdentityInput,
): string {
  return candidatePublicIdentityKeys(candidate)[0] ?? `id:${candidate.id ?? ''}`;
}

export function candidatePublicIdentityKeys(
  candidate: CandidateIdentityInput,
): string[] {
  const keys: string[] = [];
  const personId = candidate.crustdata?.crustdata_person_id;
  if (personId != null) keys.push(`cid:${personId}`);
  const profileUrl =
    candidate.crustdata?.social_handles?.professional_network_identifier
      ?.profile_url;
  const url =
    candidate.linkedinUrl ??
    profileUrl ??
    (candidate.id?.includes('linkedin.com') ? candidate.id : null);
  const slug = url ? extractLinkedInIdFromUrl(url) : null;
  if (slug) keys.push(`li:${slug.toLowerCase()}`);
  keys.push(`id:${candidate.id ?? ''}`);
  return Array.from(new Set(keys));
}

export function expectedGlobalCandidateIdForCandidate(
  candidate: CandidateIdentityInput,
  expectedByIdentity: Map<string, string>,
): string | null {
  for (const key of candidatePublicIdentityKeys(candidate)) {
    const expected = expectedByIdentity.get(key);
    if (expected) return expected;
  }
  return null;
}

export interface ExpectedGlobalIdentityReceipts {
  expectedByIdentity: Map<string, string>;
  conflictedIdentityKeys: Set<string>;
}

export function addExpectedGlobalIdentityReceipt(
  receipts: ExpectedGlobalIdentityReceipts,
  key: string,
  globalCandidateId: string,
): void {
  if (receipts.conflictedIdentityKeys.has(key)) return;
  const existing = receipts.expectedByIdentity.get(key);
  if (existing && existing !== globalCandidateId) {
    receipts.expectedByIdentity.delete(key);
    receipts.conflictedIdentityKeys.add(key);
    return;
  }
  receipts.expectedByIdentity.set(key, globalCandidateId);
}

export function buildExpectedGlobalIdentityReceipts(
  results: GlobalPoolSearchResult[],
): ExpectedGlobalIdentityReceipts {
  const receipts: ExpectedGlobalIdentityReceipts = {
    expectedByIdentity: new Map(),
    conflictedIdentityKeys: new Set(),
  };
  for (const result of results) {
    for (const key of candidatePublicIdentityKeys({
        id: result.linkedin_url ?? result.linkedin_id ?? result.id,
        linkedinUrl: result.linkedin_url,
        crustdata: result.crustdata_profile,
      })) {
      addExpectedGlobalIdentityReceipt(receipts, key, result.id);
    }
  }
  return receipts;
}
