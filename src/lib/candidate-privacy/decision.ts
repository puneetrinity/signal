import { randomUUID } from 'node:crypto';
import type { CandidatePrivacyMemoryClient } from './memory-client';
import { HttpCandidatePrivacyMemoryClient } from './memory-client';
import { isCandidatePrivacyDisposableTestAdapter } from './config';
import {
  anchorToEligibilitySubject,
  decisionAllowsDiscoverUse,
  type CandidatePrivacyAnchor,
} from './models';
import {
  CandidatePrivacyAdmissionProof,
  CandidatePrivacyRestrictedError,
  CandidatePrivacyUnavailableError,
  requireHealthyCandidatePrivacyContext,
} from './repository';

export interface CandidatePrivacyAdmissionAnchor {
  key: string;
  linkedinUrl?: string | null;
  signalCandidateId?: string | null;
  globalCandidateId?: string | null;
}

export async function createCandidateAdmissionProofs(
  anchors: CandidatePrivacyAdmissionAnchor[],
  client?: CandidatePrivacyMemoryClient,
): Promise<Map<string, CandidatePrivacyAdmissionProof>> {
  if (anchors.length === 0) return new Map();
  if (isCandidatePrivacyDisposableTestAdapter()) {
    return new Map(anchors.map((anchor) => [
      anchor.key,
      CandidatePrivacyAdmissionProof.issue({
        requestRef: randomUUID(),
        generation: BigInt(1),
        cursor: BigInt(0),
        decision: 'allow',
      }),
    ]));
  }
  const resolvedClient = client ?? new HttpCandidatePrivacyMemoryClient();
  const context = await requireHealthyCandidatePrivacyContext();
  const highWaterBefore = await resolvedClient.readHighWater();
  if (BigInt(highWaterBefore) !== context.cursor) {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_conflict');
  }

  const requestRefByKey = new Map<string, string>();
  const subjects = anchors.map((anchor) => {
    const requestRef = randomUUID();
    requestRefByKey.set(anchor.key, requestRef);
    const model: CandidatePrivacyAnchor = {
      requestRef,
      linkedinUrl: anchor.linkedinUrl,
      signalCandidateId: anchor.signalCandidateId,
      globalCandidateId: anchor.globalCandidateId,
    };
    return anchorToEligibilitySubject(model);
  });
  const decisions = new Map<
    string,
    Awaited<ReturnType<CandidatePrivacyMemoryClient['eligibilityBatch']>> extends Map<string, infer Decision>
      ? Decision
      : never
  >();
  for (let index = 0; index < subjects.length; index += 200) {
    const batch = await resolvedClient.eligibilityBatch(subjects.slice(index, index + 200));
    for (const [requestRef, decision] of batch) {
      if (decisions.has(requestRef)) {
        throw new CandidatePrivacyUnavailableError('candidate_privacy_conflict');
      }
      decisions.set(requestRef, decision);
    }
  }
  const highWaterAfter = await resolvedClient.readHighWater();
  if (
    highWaterAfter !== highWaterBefore ||
    BigInt(highWaterAfter) !== context.cursor
  ) {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_conflict');
  }

  const proofs = new Map<string, CandidatePrivacyAdmissionProof>();
  for (const anchor of anchors) {
    const requestRef = requestRefByKey.get(anchor.key);
    const decision = requestRef ? decisions.get(requestRef) : undefined;
    if (!requestRef || !decision) {
      throw new CandidatePrivacyUnavailableError('candidate_privacy_conflict');
    }
    if (decision === 'review') continue;
    if (!decisionAllowsDiscoverUse(decision)) continue;
    proofs.set(anchor.key, CandidatePrivacyAdmissionProof.issue({
      requestRef,
      generation: context.generation,
      cursor: context.cursor,
      decision,
    }));
  }
  return proofs;
}

export async function requireNewCandidateAllowed(
  anchor: CandidatePrivacyAdmissionAnchor,
  client?: CandidatePrivacyMemoryClient,
): Promise<CandidatePrivacyAdmissionProof> {
  const proof = (await createCandidateAdmissionProofs([anchor], client)).get(
    anchor.key,
  );
  if (!proof) {
    throw new CandidatePrivacyRestrictedError('candidate_privacy_restricted');
  }
  return proof;
}
