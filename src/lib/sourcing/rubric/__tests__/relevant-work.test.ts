import {describe,it,expect} from 'vitest';
import {createRankingContract,type Criterion} from '../contracts';
import {adaptProfile} from '../evidence';
import {assessRelevantWork,requiredYears,scoreEvidence} from '../score';

// Locked rules: WAVE_5C_RELEVANT_WORK_CRITERION_FINDING_CLAUDE.md. Job 192 regression: every candidate scored
// "unknown" because only Crustdata function_category ("engineering") was consulted.
const asOf='2025-01-01T00:00:00.000Z';
const id=(n:number)=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const REQ='5+ years of professional frontend development experience';
const role=(title:string|undefined,start:string|null,end:string|null,extra:Record<string,unknown>={})=>
  ({...(title?{title}:{}),start_date:start,end_date:end,function_category:'Engineering',...extra});
const evidence=(candidateId:string,past:Record<string,unknown>[],current:Record<string,unknown>[]=[])=>adaptProfile({
  candidateId,organizationRef:'1',sourceVersion:'test-profile-v1',observedAt:asOf,
  profile:{basic_profile:{location:{city:'Bengaluru',country:'India'}},experience:{employment_details:{past,current}}}});
const contract=createRankingContract(id(50),'a'.repeat(64),{schemaVersion:3,compilerVersion:3,taxonomyVersion:3,criteria:[
  {id:id(1),label:REQ,class:'must_have',subject:'relevant_work',requirement:{kind:'text',value:REQ},evidenceKinds:['profile_evidence'],use:'assessment',provenance:{kind:'recruiter_edit'}} as Criterion,
]});
const state=(e:ReturnType<typeof evidence>)=>scoreEvidence(contract,e,asOf).assessments[0]!;

describe('relevant work from dated roles',()=>{
  it('reads N years from the requirement',()=>{
    expect(requiredYears(REQ)).toBe(5);
    expect(requiredYears('At least 3 yrs backend')).toBe(3);
    expect(requiredYears('7 years in frontend')).toBe(7);
    expect(requiredYears('frontend development')).toBeNull();
  });

  it('job 192 regression: category "engineering" + 6 years as Senior Frontend Developer is met (3 points)',()=>{
    const a=state(evidence('fe6',[role('Senior Frontend Developer','2019-01-01','2025-01-01')]));
    expect(a).toMatchObject({state:'met',points:3,weight:3});
  });

  it('counts overlapping frontend roles once',()=>{
    // Two concurrent frontend jobs covering the same 3 years must not add up to 6.
    const a=state(evidence('overlap',[role('Frontend Engineer','2022-01-01','2025-01-01'),role('Frontend Consultant','2022-01-01','2025-01-01')]));
    expect(a.state).toBe('not_met');
  });

  it('adds non-overlapping frontend roles across employers',()=>{
    const a=state(evidence('sum',[role('Frontend Engineer','2017-01-01','2020-01-01'),role('Senior Frontend Developer','2022-01-01','2025-01-01')]));
    expect(a.state).toBe('met');
  });

  it('total career length does not count: 10 years, only 2 in frontend roles, rest backend → not met',()=>{
    const a=state(evidence('career',[role('Backend Engineer','2015-01-01','2023-01-01'),role('Frontend Engineer','2023-01-01','2025-01-01')]));
    expect(a.state).toBe('not_met');
  });

  it('current title alone is not enough: a recent frontend role of 1 year with ambiguous earlier roles is unknown, not met',()=>{
    const a=state(evidence('ambiguous',[role('Software Engineer','2016-01-01','2024-01-01')],[role('Senior Frontend Developer','2024-01-01',null)]));
    expect(a.state).toBe('unknown');
    expect(a.points).toBe(0);
  });

  it('missing dates on a frontend role are "not enough information", never not met',()=>{
    const a=state(evidence('undated',[role('Frontend Engineer',null,null)]));
    expect(a.state).toBe('unknown');
  });

  it('a dated frontend role already proving 5+ years is met even if another role lacks dates',()=>{
    const a=state(evidence('partial',[role('Frontend Engineer','2018-01-01','2025-01-01'),role('Frontend Lead',null,null)]));
    expect(a.state).toBe('met');
  });

  it('internships do not count',()=>{
    const a=state(evidence('intern',[role('Frontend Intern','2018-01-01','2024-12-31',{employment_type:'Internship'})]));
    expect(a.state).not.toBe('met');
  });

  it('a requirement with no recognisable role family keeps the previous behaviour',()=>{
    expect(assessRelevantWork('5+ years of professional experience',[],asOf)).toBeNull();
  });
});

import {evidenceSchema} from '../evidence';
import {requiredDuration,relevantWorkSources,assessRelevantWorkSources} from '../score';

describe('R1: unsupported durations never weaken the requirement',()=>{
  const oneYear=[{title:'Frontend Engineer',start:'2024-01-01',end:'2025-01-01'}];
  it.each([
    ['At least five years of frontend development'],
    ['65 years of frontend development'],
    ['3-5 years of frontend development'],
    ['10 years total experience including 3 years frontend'],
    ['5 to 7 years of frontend development'],
    ['60 months of frontend experience'],
    ['18 months frontend development'],
    ['At most 5 years of frontend development'],
    ['Up to 5 years of frontend development'],
    ['No more than 5 years of frontend experience'],
    ['Less than 5 years of frontend experience'],
    ['Maximum 5 years of frontend experience'],
  ])('%s → unsupported → unknown, never met with 1 year',text=>{
    expect(requiredDuration(text).kind).toBe('unsupported');
    expect(assessRelevantWork(text,oneYear,asOf)!.state).toBe('unknown');
  });
  it('understands plain forms',()=>{
    expect(requiredDuration(REQ)).toEqual({kind:'years',years:5});
    expect(requiredDuration('At least 4 years of frontend development')).toEqual({kind:'years',years:4});
    expect(requiredDuration('frontend development')).toEqual({kind:'none'});
    expect(requiredDuration('Minimum 5 years of frontend development')).toEqual({kind:'years',years:5});
    expect(requiredDuration('5+ yrs frontend')).toEqual({kind:'years',years:5});
  });
});

describe('R2: newer evidence format (v2) keeps usable dated roles',()=>{
  const src=(kind:'candidate_provided'|'profile_evidence',intervals:Record<string,unknown>[],observedAt='2024-06-01T00:00:00.000Z')=>({
    kind,scope:kind==='candidate_provided'?'organization':'public',organizationRef:kind==='candidate_provided'?'1':null,
    sourceVersion:'1',sourceHash:'a'.repeat(64),observedAt,referenceId:kind==='candidate_provided'?'11111111-1111-4111-8111-111111111111':null,intervals});
  const v2=(sources:ReturnType<typeof src>[])=>evidenceSchema.parse({candidateId:'v2',organizationRef:'1',version:'rubric-evidence-v2',
    facts:[],employment:[],employmentSources:sources});
  const ALL=['candidate_provided','profile_evidence'];
  const judge=(e:ReturnType<typeof v2>,allowed=ALL)=>assessRelevantWorkSources(REQ,relevantWorkSources(e,allowed,asOf),asOf);
  const sevenYears={title:'Frontend Engineer',start:'2018-01-01',end:'2025-01-01'};
  const undated={title:'Frontend Lead',start:null,end:null};

  it('Codex repro: profile 7 dated frontend years + one undated role → met (was unknown)',()=>{
    expect(judge(v2([src('profile_evidence',[sevenYears,undated])]))).toMatchObject({state:'met',ref:'profile.employment'});
  });
  it('résumé only',()=>{
    expect(judge(v2([src('candidate_provided',[sevenYears])]))).toMatchObject({state:'met',ref:'resume.employment'});
  });
  it('both sources: a deciding résumé is preferred over the profile',()=>{
    const shortResume=src('candidate_provided',[{title:'Frontend Engineer',start:'2023-01-01',end:'2025-01-01'},{title:'Backend Engineer',start:'2015-01-01',end:'2023-01-01'}]);
    expect(judge(v2([src('profile_evidence',[sevenYears]),shortResume]))).toMatchObject({state:'not_met',ref:'resume.employment'});
  });
  it('both sources: an undecided résumé falls through to the profile',()=>{
    expect(judge(v2([src('profile_evidence',[sevenYears]),src('candidate_provided',[undated])]))).toMatchObject({state:'met',ref:'profile.employment'});
  });
  it('incomplete history everywhere → unknown',()=>{
    expect(judge(v2([src('profile_evidence',[undated])]))!.state).toBe('unknown');
  });
  it('disallowed evidence kinds and sources observed after as-of are ignored',()=>{
    expect(judge(v2([src('candidate_provided',[sevenYears])]),['profile_evidence'])!.state).toBe('unknown');
    expect(judge(v2([src('profile_evidence',[sevenYears],'2026-01-01T00:00:00.000Z')]))!.state).toBe('unknown');
  });
});
