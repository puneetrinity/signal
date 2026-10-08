import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {describe,it,expect,vi} from 'vitest';
import * as digest from '../../jd-digest';
import * as hints from '../../hint-sanitizer';
import * as seniority from '@/lib/taxonomy/seniority';
import * as roles from '@/lib/taxonomy/role-service';
import * as locations from '@/lib/taxonomy/location-service';
import * as education from '@/lib/taxonomy/education';
import {rankCandidates,type CandidateForRanking} from '../../ranking-new';
import {evaluateOffline} from '../../../../../scripts/eval-rubric-ranking';
import {adaptProfile} from '../evidence';
import {scoreEvidence} from '../score';
import {createRankingContract,rankingHash} from '../contracts';

describe('ranking boundary and synthetic replay',()=>{
 it('executes the actual budget-refusal branch: protocol2 cannot fall through into legacy publication',()=>{
  const source=readFileSync('src/lib/sourcing/orchestrator.ts','utf8');
  const body=source.match(/if \(!budget.allowed \|\| budget.maxQueries <= 0\) \{([\s\S]*?)\n    \} else \{/)?.[1];
  expect(body).toBeTruthy();
  for(const protocolVersion of [undefined,1,2]){
   const context={governedCommand:protocolVersion?{protocolVersion}:undefined,budget:{skippedReason:'cap'},
     discoverySkippedReason:null,log:{warn(){}},requestId:'fixture',tenantId:'fixture',discoveryReason:'fixture',config:{dailySerpCapPerTenant:0}};
   if(protocolVersion===2)expect(()=>runInNewContext(body!,context)).toThrow('GOVERNED_DISCOVERY_BUDGET_REFUSED');
   else {runInNewContext(body!,context);expect(context.discoverySkippedReason).toBe('cap');}
  }
 });
 it.each(['tech','non_tech','blended'] as const)('matches the shipped full legacy score/order/components for %s',track=>{
  // The shipped file is frozen by both this hash and the authoring boundary.
  // Read it directly so a shallow CI checkout needs no historical Git objects.
  const baseline=readFileSync('src/lib/sourcing/ranking-new.ts','utf8');
  expect(createHash('sha256').update(baseline).digest('hex'))
   .toBe('cddea0f8f18126e33528530b04755fe75c5b7dc3389f0b724db45c800fac685f');
  const compiled=ts.transpileModule(baseline,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const dependencies:Record<string,unknown>={'./jd-digest':digest,'./hint-sanitizer':hints,
    '@/lib/taxonomy/seniority':seniority,'@/lib/taxonomy/role-service':roles,'@/lib/taxonomy/location-service':locations,'@/lib/taxonomy/education':education};
  const old={} as {rankCandidates:typeof rankCandidates};
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-07T00:00:00.000Z'));
  try {
   runInNewContext(compiled,{exports:old,Date,console:{log(){},warn(){}},require(name:string){
    if(!(name in dependencies))throw Error('UNEXPECTED_LEGACY_DEPENDENCY');return dependencies[name];}});
   const candidates:CandidateForRanking[]=Array.from({length:125},(_,i)=>({id:`fixture-${String(i).padStart(3,'0')}`,
    headlineHint:i%3?'Backend Engineer':'Account Executive',searchTitle:null,searchSnippet:null,
    locationHint:i%4?'Bengaluru, India':'Mumbai, India',enrichmentStatus:i%5?'completed':'pending',lastEnrichedAt:null,
    semanticSimilarity:i%3?i/125:undefined,crustdata:{basic_profile:{location:{full_location:i%4?'Bengaluru, India':'Mumbai, India'}},
     experience:{employment_details:{current:[{title:i%3?'Senior Backend Engineer':'Senior Account Executive',function_category:i%3?'Engineering':'Sales',seniority_level:'Senior',start_date:'2019-01-01'}],past:[]}}}} as CandidateForRanking));
   const requirements={title:'Backend Engineer',roleFamily:'backend' as const,topSkills:['python'],location:'Bengaluru, India',seniorityLevel:'senior',domain:'Software',experienceYears:6,experienceYearsMax:10,education:null,
    titleSearchTerms:['Backend Engineer'],adjacentBuckets:[['Platform Engineer']],adjacentLocations:[]};
   const options={track,fitScoreEpsilon:3,semanticSimilarityWeight:4};
   const expected=old.rankCandidates(candidates,requirements,options);
   expect(rankCandidates(candidates,requirements,options)).toEqual(expected);
   expect(rankCandidates(candidates.filter((_,i)=>i%7!==0),requirements,options))
    .toEqual(old.rankCandidates(candidates.filter((_,i)=>i%7!==0),requirements,options));
   expect(expected).toHaveLength(125);
  }finally{vi.useRealTimers();}
 });
 it('keeps the shipped legacy ranking implementation byte-for-byte unchanged',()=>{
  expect(createHash('sha256').update(readFileSync('src/lib/sourcing/ranking-new.ts')).digest('hex'))
   .toBe('cddea0f8f18126e33528530b04755fe75c5b7dc3389f0b724db45c800fac685f');
 });
 it('evaluates technical and non-tech fixtures without network or activation',()=>{
  const report=evaluateOffline(JSON.parse(readFileSync('research/fixtures/rubric-ranking-v1.json','utf8')));
  expect(report.synthetic).toBe(true);expect(report.activationApproved).toBe(false);
  expect(report.reports.map(r=>'delivered' in r?r.delivered:null)).toEqual([2,3]);
 });
 it('preserves scoring when a profile gains unrelated content or changes provider wrapper',()=>{
  const fixture=JSON.parse(readFileSync('research/fixtures/rubric-ranking-v1.json','utf8'));
  const job=fixture.jobs[0],candidate=job.candidates[0];
  const contract=createRankingContract('20000000-0000-4000-8000-000000000099',rankingHash(job.payload),job.payload);
  const input={candidateId:'same',organizationRef:'1',sourceVersion:'test',observedAt:fixture.asOf};
  const base=scoreEvidence(contract,adaptProfile({...input,profile:candidate.profile}),fixture.asOf);
  const enriched=structuredClone(candidate.profile);
  enriched.basic_profile={headline:'Principal Rust Engineer',name:'SYNTHETIC',email:'unused@example.invalid',summary:'Unrelated biography'};
  enriched.skills.professional_network_skills.push('Rust','Java','Java');
  expect(scoreEvidence(contract,adaptProfile({...input,profile:enriched}),fixture.asOf)).toEqual(base);
  const flat=adaptProfile({...input,profile:{employer:candidate.profile.experience.employment_details.past.map((r:object)=>({...r,is_current:false})),
   skills:candidate.profile.skills.professional_network_skills}});
  const flatScore=scoreEvidence(contract,flat,fixture.asOf);
  expect([flatScore.N,flatScore.D,flatScore.L,flatScore.eligibility,flatScore.experience])
   .toEqual([base.N,base.D,base.L,base.eligibility,base.experience]);
 });
 it('reports mapped coverage only over scoring criteria and separates retrieval from reordered overlap',()=>{
  const fixture=JSON.parse(readFileSync('research/fixtures/rubric-ranking-v1.json','utf8'));
  const job=fixture.jobs[0];delete job.expectedSelectedIds;
  const first=job.payload.criteria[0];
  job.payload.criteria=[first,...Array.from({length:3},(_,i)=>({...first,id:`10000000-0000-4000-8000-00000000008${i}`,class:'evidence_required',subject:'responsibility',
   requirement:{kind:'text',value:'Review architecture'},evidenceKinds:['recruiter_judgement'],use:'assessment'}))];
  job.baselineIds=[...job.candidates.map((c:{candidateId:string})=>c.candidateId),'missing-fixture'];
  const report=evaluateOffline(fixture).reports[0];
  if(!('mappedShare' in report))throw Error('Missing report');
  expect(report.mappedShare).toBe(1);expect(report.prelaunchReview?.mappedBelowHalf).toBe(false);
  expect(report.retrievalCoverage?.top100.retrieved).toBe(job.candidates.length);
  expect(report.movement?.top100.exits).toContain('missing-fixture');
  expect(report.criterionCoverage).toHaveLength(4);
  job.poolBasis='served-top100-only';
  const limited=evaluateOffline(fixture).reports[0];
  if(!('retrievalCoverage' in limited))throw Error('Missing report');
  expect(limited.retrievalCoverage).toBeNull();expect(limited.top100Boundary).toBeNull();
 });
});
