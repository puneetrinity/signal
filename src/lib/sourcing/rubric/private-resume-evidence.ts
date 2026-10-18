import { privateResumeHit, type PrivateResumeHit } from '../private-resume-contracts';
import { rankingHash } from './contracts';
import { evidenceSchema, type CanonicalEvidence, type EvidenceFact,
  employmentSourceSchema, evidenceBytes, EVIDENCE_MAX_BYTES, OversizedEvidenceError } from './evidence';

/** Called only after current Memory + Flow authority checks, never on search snippets. */
export function adaptPrivateResume(input:{candidateId:string; organizationRef:string;
  resume?:PrivateResumeHit; publicEvidence?:CanonicalEvidence;
  publicSource?:{observedAt:string;sourceVersion:string;sourceHash:string}}):CanonicalEvidence {
  const {candidateId,organizationRef}=input;
  const profile=input.publicEvidence?evidenceSchema.parse(input.publicEvidence):undefined;
  if(profile&&(profile.organizationRef!==organizationRef||profile.candidateId!==candidateId||profile.version!=='rubric-evidence-v1'))
    throw Error('RUBRIC_PRIVATE_SOURCE_CONFLICT');
  const resume=input.resume?privateResumeHit.parse(input.resume):undefined;
  if(resume&&resume.evidence.scope!==`org_${organizationRef}`)throw Error('RUBRIC_PRIVATE_SOURCE_CONFLICT');
  const facts:EvidenceFact[]=[...(profile?.facts??[])];
  const employmentSources=[];
  if(profile&&!input.publicSource)throw Error('RUBRIC_PRIVATE_SOURCE_CONFLICT');
  if(profile) employmentSources.push(employmentSourceSchema.parse({kind:'profile_evidence',scope:'public',
    organizationRef:null,...input.publicSource,
    referenceId:null,intervals:profile.employment}));
  if(resume) {
    const r=resume.evidence;
    const add=(field:EvidenceFact['field'],values:readonly (string|null)[])=>{
      for(const value of values)if(value!==null)facts.push({field,value,ref:`resume.${field}`,
        kind:'candidate_provided',scope:'organization',organizationRef,
        sourceVersion:resume.identity.sourceHash,observedAt:new Date(r.observedAt).toISOString()});
    };
    add('skill',r.skills); add('city',[r.location.city]); add('country',[r.location.country]);
    add('title',r.currentTitle?[r.currentTitle]:r.primaryTitles);
    add('seniority',[r.seniority]);add('domain',r.domains);add('function',r.functions);
    add('certification',r.certifications);
    if(r.employment?.length)employmentSources.push(employmentSourceSchema.parse({kind:'candidate_provided',
      scope:'organization',organizationRef,sourceVersion:resume.identity.sourceHash,
      sourceHash:resume.identity.sourceHash,observedAt:new Date(r.observedAt).toISOString(),
      referenceId:resume.identity.referenceId,intervals:r.employment.map(role=>({
        ...(role.title?{title:role.title}:{}),...(role.employmentType?{employmentType:role.employmentType}:{}),
        start:role.start??null,end:role.end??null,ongoing:role.ongoing,
      }))}));
    // Old extraction has no dated history. Never derive dates from stated years.
  }
  const unique=[...new Map(facts.map(f=>[rankingHash(f),f])).values()]
    .sort((a,b)=>Buffer.compare(Buffer.from(rankingHash(a)),Buffer.from(rankingHash(b))));
  const value={candidateId,organizationRef,version:'rubric-evidence-v2' as const,
    employment:[],employmentSources,facts:unique,...(resume?{resumeIdentity:resume.identity}:{})};
  const bytes=evidenceBytes({...value,presentationSource:'pool_enriched'});
  if(bytes>EVIDENCE_MAX_BYTES)throw new OversizedEvidenceError({candidateId,reason:'evidence_too_large',
    evidenceHash:rankingHash(value),bytes,limit:EVIDENCE_MAX_BYTES});
  return evidenceSchema.parse(value);
}
