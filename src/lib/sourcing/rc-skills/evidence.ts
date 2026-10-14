import { rankingHash, byteCompare } from '../rubric/contracts';
import { evidenceSchema, factSchema, evidenceBytes, EVIDENCE_MAX_BYTES, OversizedEvidenceError,
  type CanonicalEvidence } from '../rubric/evidence';
import { normalizeSkillName } from '../rubric/skill-alternatives';
import { observationSchema, type SkillObservation } from './contracts';
import type {RcSnapshot} from './repository';
import type {WithheldProfile} from '../rubric/evidence';

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

export function mergeSealedRcEvidence(snapshot:RcSnapshot):{evidence:CanonicalEvidence[];withheld:WithheldProfile[]}{
 if(!snapshot.sealedAt||!snapshot.baseline)throw Error('RC_SEAL_REQUIRED');
 const observations=new Map(snapshot.baseline.cache.map(c=>[c.identityHash,c.observation]));
 for(const attempt of snapshot.attempts){
  const raw=attempt.outcome?.observation;
  if(raw&&['success','no_data','no_dispatch'].includes(attempt.state)){
   const observation=observationSchema.parse(raw);
   if(observation.identityHash!==attempt.identityHash)throw Error('RC_IDENTITY_CONFLICT');
   const prior=observations.get(attempt.identityHash);
   if(!prior||observation.outcome==='success'&&(prior.outcome!=='success'||Date.parse(observation.upstreamAt!)>Date.parse(prior.upstreamAt!)))
    observations.set(attempt.identityHash,observation);
  }
 }
 const identities=new Map(snapshot.baseline.identities.map(i=>[i.candidateId,i.identityHash]));
 const withheld=[...snapshot.baseline.withheld],evidence:CanonicalEvidence[]=[];
 for(const original of snapshot.baseline.evidence){
  const identityHash=identities.get(original.candidateId),observation=identityHash?observations.get(identityHash):undefined;
  try{evidence.push(observation&&identityHash?addRcSkills(original,observation,identityHash,snapshot.sealedAt):original);}
  catch(error){if(!(error instanceof OversizedEvidenceError))throw error;withheld.push(error.record);}
 }
 return {evidence,withheld};
}
