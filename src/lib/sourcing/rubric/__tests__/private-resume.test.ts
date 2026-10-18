import { describe, expect, it } from 'vitest';
import { createRankingContract, rankingVersions } from '../contracts';
import { evidenceSchema, selectEmployment, adaptProfile } from '../evidence';
import { scoreEvidence } from '../score';
import { adaptPrivateResume } from '../private-resume-evidence';

const asOf='2026-10-18T00:00:00.000Z';
const source=(kind:'candidate_provided'|'profile_evidence',start:string|null,end='2025-01-01')=>({
  kind,scope:kind==='candidate_provided'?'organization':'public',
  organizationRef:kind==='candidate_provided'?'32':null,sourceVersion:'1',sourceHash:'a'.repeat(64),
  observedAt:'2026-01-01T00:00:00.000Z',referenceId:kind==='candidate_provided'?'11111111-1111-4111-8111-111111111111':null,
  intervals:[{start,end,title:'Engineer'}],
});
const evidence=(sources:ReturnType<typeof source>[])=>evidenceSchema.parse({candidateId:'c1',organizationRef:'32',
  version:'rubric-evidence-v2',facts:[],employment:[],employmentSources:sources});
describe('versioned resume ranking evidence',()=>{
  it('selects the complete resume even when the public history would earn more',()=>{
    const e=evidence([source('profile_evidence','2010-01-01'),source('candidate_provided','2020-01-01')]);
    expect(selectEmployment(e,['candidate_provided','profile_evidence'],asOf)).toEqual({
      ref:'resume.employment',intervals:[{start:'2020-01-01',end:'2025-01-01',title:'Engineer'}]});
  });
  it('falls back to complete profile dates, never combines incomplete histories',()=>{
    const e=evidence([source('candidate_provided',null),source('profile_evidence','2010-01-01')]);
    expect(selectEmployment(e,['candidate_provided','profile_evidence'],asOf).ref).toBe('profile.employment');
    expect(selectEmployment(e,['candidate_provided'],asOf).intervals).toEqual([]);
    expect(selectEmployment(evidence([source('candidate_provided',null),source('profile_evidence',null)]),
      ['candidate_provided','profile_evidence'],asOf).intervals).toEqual([]);
  });
  it('rejects duplicate, foreign or unlabelled employment',()=>{
    expect(()=>evidence([source('candidate_provided','2020'),source('candidate_provided','2010')])).toThrow();
    expect(()=>evidence([{...source('candidate_provided','2020'),organizationRef:'5'}])).toThrow();
    expect(evidenceSchema.safeParse({...evidence([]),employment:[{start:'2020',end:'2025'}]}).success).toBe(false);
  });
  it('retains historical contract versions and rejects mixed evidence versions',()=>{
    expect(rankingVersions(3).adapterVersion).toBe('rubric-evidence-v1');
    expect(rankingVersions(4).adapterVersion).toBe('rubric-evidence-v2');
    const payload={schemaVersion:3,compilerVersion:3,taxonomyVersion:3,criteria:[{
      id:'22222222-2222-4222-8222-222222222222',label:'Python',class:'must_have',subject:'skill',
      requirement:{kind:'accepted_skills',primary:'Python',alternatives:[]},
      evidenceKinds:['candidate_provided','profile_evidence'],use:'assessment',provenance:{kind:'recruiter_edit'},
    }]};
    const old=createRankingContract('11111111-1111-4111-8111-111111111111','a'.repeat(64),payload);
    expect(()=>scoreEvidence(old,evidence([]),asOf)).toThrow('RUBRIC_EVIDENCE_VERSION_MISMATCH');
    const current=createRankingContract(old.briefVersionId,old.materialHash,{...payload,schemaVersion:4,compilerVersion:4,taxonomyVersion:4});
    expect(scoreEvidence(current,evidence([]),asOf).N).toBe(0);
  });
  it('upgrades profile evidence without changing its facts or inventing resume history',()=>{
    const profile=adaptProfile({candidateId:'c1',organizationRef:'32',profile:{skills:['Python']},
      sourceVersion:'1',observedAt:asOf});
    const v2=adaptPrivateResume({candidateId:'c1',organizationRef:'32',publicEvidence:profile,
      publicSource:{observedAt:asOf,sourceVersion:'1',sourceHash:'a'.repeat(64)}});
    expect(v2.facts).toEqual(profile.facts);
    expect(selectEmployment(v2,['candidate_provided'],asOf).intervals).toEqual([]);
  });
});
