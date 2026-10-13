import { rankingHash, byteCompare } from '../rubric/contracts';
import { evidenceSchema, factSchema, evidenceBytes, EVIDENCE_MAX_BYTES, OversizedEvidenceError,
  type CanonicalEvidence } from '../rubric/evidence';
import { normalizeSkillName } from '../rubric/skill-alternatives';
import { observationSchema, type SkillObservation } from './contracts';

/** The caller resolves public identity and checks privacy before this pure adapter.
 * Existing candidate-owned and provider facts are unioned, never overwritten.
 */
export function addRcSkills(rawEvidence:CanonicalEvidence, rawObservation:SkillObservation,
  expectedIdentityHash:string, asOf:string):CanonicalEvidence {
  const evidence=evidenceSchema.parse(rawEvidence),observation=observationSchema.parse(rawObservation);
  if(observation.identityHash!==expectedIdentityHash)throw Error('RC_EVIDENCE_IDENTITY_CONFLICT');
  const at=Date.parse(asOf);
  if(!Number.isFinite(at))throw Error('RC_EVIDENCE_AS_OF_INVALID');
  if(observation.outcome!=='success' || observation.validUntil===null ||
    Date.parse(observation.validUntil)<at || Date.parse(observation.observedAt)>at) return evidence;
  const additions=observation.skills.map(value=>factSchema.parse({
    field:'skill',value:normalizeSkillName(value),ref:'profile.skills',kind:'profile_evidence',
    scope:'public',organizationRef:null,sourceVersion:observation.contentHash,
    observedAt:observation.observedAt,validUntil:observation.validUntil,
  }));
  // Preserve last-value deduplication, and reuse each fingerprint for sorting.
  const keyed=new Map([...evidence.facts,...additions].map(fact=>[rankingHash(fact),fact] as const));
  const facts=[...keyed.entries()].sort((a,b)=>byteCompare(a[0],b[0])).map(entry=>entry[1]);
  const result={...evidence,facts};
  const bytes=evidenceBytes({...result,presentationSource:'pool_enriched'});
  if(bytes>EVIDENCE_MAX_BYTES)throw new OversizedEvidenceError({
    candidateId:evidence.candidateId,reason:'evidence_too_large',evidenceHash:rankingHash(result),
    bytes,limit:EVIDENCE_MAX_BYTES,
  });
  return evidenceSchema.parse(result);
}
