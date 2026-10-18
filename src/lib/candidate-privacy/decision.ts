import { randomUUID } from 'node:crypto';
import type { CandidatePrivacyMemoryClient } from './memory-client';
import { HttpCandidatePrivacyMemoryClient } from './memory-client';
import { isCandidatePrivacyDisposableTestAdapter } from './config';
import {
  anchorToEligibilitySubject,
  decisionAllowsDiscoverUse,
  privacyDecisionSchema,
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
  privateCandidate?: { tenantId: string; candidateId: string };
}

export async function createCandidateAdmissionProofs(
  anchors: CandidatePrivacyAdmissionAnchor[],
  client?: CandidatePrivacyMemoryClient,
  deadlineAt?: number,
): Promise<Map<string, CandidatePrivacyAdmissionProof>> {
  const remaining=()=>{
    const ms=deadlineAt===undefined?undefined:deadlineAt-Date.now();
    if(ms!==undefined&&(!Number.isFinite(ms)||ms<=0))throw new CandidatePrivacyUnavailableError('candidate_privacy_unavailable');
    return ms;
  };
  remaining();
  if (anchors.length === 0) return new Map();
  if (new Set(anchors.map((anchor) => anchor.key)).size !== anchors.length) {
    throw new CandidatePrivacyUnavailableError('candidate_privacy_conflict');
  }
  if (isCandidatePrivacyDisposableTestAdapter()) {
    return new Map(anchors.map((anchor) => [
      anchor.key,
      CandidatePrivacyAdmissionProof.issue({
        requestRef: randomUUID(),
        generation: BigInt(1),
        cursor: BigInt(0),
        decision: 'allow',
        ...(anchor.privateCandidate ? {privateCandidate:anchor.privateCandidate} : {}),
      }),
    ]));
  }
  const resolvedClient = client ?? new HttpCandidatePrivacyMemoryClient(undefined,
    deadlineAt===undefined?fetch:async(url,init)=>{
      const deadline=AbortSignal.timeout(Math.max(1,Math.floor(remaining()!)));
      return fetch(url,{...init,signal:init?.signal?AbortSignal.any([init.signal,deadline]):deadline});
    });
  const context = await requireHealthyCandidatePrivacyContext();
  remaining();
  const highWaterBefore = await resolvedClient.readHighWater();
  remaining();
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
      privateCandidate: anchor.privateCandidate,
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
    remaining();
    const requested = subjects.slice(index, index + 200);
    const expected = new Set(requested.map((subject) => subject.request_ref));
    const batch = await resolvedClient.eligibilityBatch(requested);
    remaining();
    if (batch.size !== expected.size) {
      throw new CandidatePrivacyUnavailableError('candidate_privacy_conflict');
    }
    for (const [requestRef, decision] of batch) {
      if (!expected.has(requestRef) || decisions.has(requestRef)
        || !privacyDecisionSchema.safeParse(decision).success) {
        throw new CandidatePrivacyUnavailableError('candidate_privacy_conflict');
      }
      decisions.set(requestRef, decision);
    }
  }
  const highWaterAfter = await resolvedClient.readHighWater();
  remaining();
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
    if (!decisionAllowsDiscoverUse(decision) && !(anchor.privateCandidate && decision === 'block_global')) continue;
    proofs.set(anchor.key, CandidatePrivacyAdmissionProof.issue({
      requestRef,
      generation: context.generation,
      cursor: context.cursor,
      decision: anchor.privateCandidate && decision === 'block_global' ? 'allow' : decision,
      ...(anchor.privateCandidate ? {privateCandidate:anchor.privateCandidate} : {}),
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
