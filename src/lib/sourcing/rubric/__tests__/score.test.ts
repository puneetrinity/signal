import {describe,it,expect} from 'vitest';
import {createRankingContract,type Criterion} from '../contracts';
import {adaptProfile,type CanonicalEvidence} from '../evidence';
import {rankEvidence,scoreEvidence} from '../score';
import {normalizedTitle} from '../taxonomy';
const asOf='2025-01-01T00:00:00.000Z';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const criterion=(n:number,subject:Criterion['subject'],requirement:Criterion['requirement'],cls:Criterion['class']='must_have'):Criterion=>({id:id(n),label:subject,class:cls,subject,requirement,evidenceKinds:['profile_evidence'],use:'assessment',provenance:{kind:'recruiter_edit'}});
const criteria=[criterion(1,'title',{kind:'accepted_titles',values:['Backend Engineer','Backend Developer']},'preferred'),
  criterion(2,'experience_years',{kind:'experience_range',minimum:6,maximum:10}),
  criterion(3,'skill',{kind:'text',value:'Java'}),criterion(4,'skill',{kind:'text',value:'Kafka'})];
const contract=(items=criteria)=>createRankingContract(id(50),'a'.repeat(64),{schemaVersion:2,compilerVersion:2,taxonomyVersion:2,criteria:items});
function evidence(candidateId:string,years=8,skills=['Java','Kafka'],title='Senior Backend Engineer'):CanonicalEvidence {
  return adaptProfile({candidateId,organizationRef:'1',sourceVersion:'test-profile-v1',observedAt:asOf,profile:{
    skills:{professional_network_skills:skills},basic_profile:{headline:'Principal Rust Engineer',location:{city:'Bengaluru',country:'India'}},
    experience:{employment_details:{past:[{title,start_date:`${2025-years}-01-01`,end_date:'2025-01-01'}]}}
  }});
}
describe('governed rubric scoring',()=>{
  it('unions positive skill evidence across candidate and provider sources',()=>{
    const e=evidence('a',11);
    const own={...e.facts.find(f=>f.field==='skill')!,value:'SQL',kind:'candidate_provided' as const};
    const c=contract(criteria.map(item=>({...item,evidenceKinds:['profile_evidence','candidate_provided']})));
    expect(scoreEvidence(c,{...e,facts:[...e.facts,own]},asOf)).toMatchObject({N:7,eligibility:'wider'});
  });
  it.each(['nested','employer'])('scores real provider-shaped %s timestamp history',wrapper=>{
    const role={title:'Senior Backend Engineer',start_date:'2017-01-01T00:00:00',end_date:'2025-01-01T00:00:00',is_current:false};
    const profile={skills:{professional_network_skills:['Java','Kafka']},...(wrapper==='nested'?{experience:{employment_details:{past:[role]}}}:{employer:[role]})};
    const e=adaptProfile({candidateId:'provider',organizationRef:'1',sourceVersion:'provider-shape',observedAt:asOf,profile});
    expect(scoreEvidence(contract(),e,asOf)).toMatchObject({N:10,eligibility:'in_range'});
  });
  it('scores only met criteria with 3:1 and no bonus beyond the range',()=>{
    const result=scoreEvidence(contract(),evidence('a'),asOf);
    expect(result).toMatchObject({N:10,D:10,L:10_000_000,eligibility:'in_range'});
    expect(scoreEvidence(contract(),evidence('b',9),asOf).N).toBe(result.N);
    const wider=scoreEvidence(contract(),evidence('c',11),asOf);
    expect(wider).toMatchObject({N:7,eligibility:'wider'});
    expect(wider.assessments.find(a=>a.subject==='experience_years')?.state).toBe('not_met');
  });
  it('keeps in-range above stronger wider matches and never pads the delivered list',()=>{
    const result=rankEvidence(contract(),[evidence('wider',11),evidence('inside',8,[]),evidence('outside',16)],asOf);
    expect(result.selected.map(x=>x.candidateId)).toEqual(['inside','wider']);
    expect(result.shortfall).toBe(98);expect(result.items).toHaveLength(3);
  });
  it('never lets a stronger wider candidate displace the hundredth in-range candidate',()=>{
    const inside=Array.from({length:100},(_,i)=>evidence(`inside-${i}`,8,[]));
    const result=rankEvidence(contract(),[evidence('wider',11),...inside],asOf);
    expect(result.selected).toHaveLength(100);
    expect(result.selected.every(x=>x.eligibility==='in_range')).toBe(true);
  });
  it('refuses an experience rule whose evidence cannot support employment calculation',()=>{
    for(const kind of ['candidate_provided','verified_document','recruiter_judgement'] as const){
      expect(()=>contract(criteria.map(item=>item.subject==='experience_years'?{...item,evidenceKinds:[kind]}:item))).toThrow('Experience calculation requires profile employment evidence');
    }
  });
  it('unknown skills cannot admit wider candidates, and JavaScript is not Java',()=>{
    const candidate=evidence('a',11,['JavaScript','Kafka']);
    const result=scoreEvidence(contract(),candidate,asOf);
    expect(result.eligibility).toBe('wider_skills_not_established');
    expect(result.assessments.find(a=>a.criterionIds.includes(id(3)))?.state).toBe('unknown');
  });
  it('deduplicates predicates, giving must-have weight once and retaining explanation IDs',()=>{
    const result=scoreEvidence(contract([...criteria,criterion(5,'skill',{kind:'text',value:'Java'},'preferred')]),evidence('a'),asOf);
    expect(result.D).toBe(10);expect(result.N).toBe(10);
    expect(result.assessments.find(a=>a.criterionIds.includes(id(3)))?.criterionIds).toEqual([id(3),id(5)]);
  });
  it('does not score disqualifier flags or human-only criteria',()=>{
    const extra=criterion(5,'skill',{kind:'text',value:'Java'},'disqualifier');
    expect(scoreEvidence(contract([extra]),evidence('a'),asOf)).toMatchObject({N:0,D:0,L:0});
  });
  it('preserves functional prefixes, no unapproved title equivalence or skill inference',()=>{
    expect(normalizedTitle('Senior Staff Backend Engineer')).toBe('backend engineer');
    expect(normalizedTitle('Senior Living Specialist')).toBe('senior living specialist');
    expect(normalizedTitle('Lead Generation Specialist')).toBe('lead generation specialist');
    expect(normalizedTitle('Engineer (Intern)')).not.toBe('engineer');
    const onlyEngineer=contract([criterion(1,'title',{kind:'accepted_titles',values:['Backend Engineer']},'preferred'),criterion(3,'skill',{kind:'text',value:'Rust'})]);
    expect(scoreEvidence(onlyEngineer,evidence('a',8,[],'Backend Developer'),asOf)).toMatchObject({N:0,L:0});
    expect(scoreEvidence(onlyEngineer,evidence('b',8,[],'Senior Rust Engineer'),asOf)).toMatchObject({N:0,L:0});
  });
  it('uses ID only after all meaningful keys and ignores input sequence',()=>{
    expect(rankEvidence(contract(),[evidence('z'),evidence('a')],asOf).selected.map(x=>x.candidateId)).toEqual(['a','z']);
  });
  it('does not infer scope or title from headlines or unrelated provider fields',()=>{
    const a=evidence('same');
    const b={...a,...{headline:'Java Kafka',semanticSimilarity:1,contactAvailable:true}};
    // Closed normalized schema refuses accidental unreviewed fields instead of scoring them.
    expect(()=>scoreEvidence(contract(),b,asOf)).toThrow();
    const payload={experience:{employment_details:{past:[{title:'Marketing Manager',start_date:'2017-01-01',end_date:'2025-01-01'}]}},basic_profile:{headline:'Backend Engineer'}};
    const raw=(headline:string)=>adaptProfile({candidateId:'same',organizationRef:'1',sourceVersion:'x',observedAt:asOf,profile:{...payload,basic_profile:{headline}}});
    expect(scoreEvidence(contract(),raw('Backend Engineer'),asOf)).toEqual(scoreEvidence(contract(),raw('Marketing Manager'),asOf));
  });
  it('rejects duplicate identities and overflowing pools rather than pre-ranking a subset',()=>{
    const a=evidence('a');expect(()=>rankEvidence(contract(),[a,a],asOf)).toThrow('RUBRIC_DUPLICATE_IDENTITY');
    expect(()=>rankEvidence(contract(),Array(2001).fill(a),asOf)).toThrow('RUBRIC_POOL_TOO_LARGE');
  });
  it('compares explicit CEFR proficiency without guessing fluent or native levels',()=>{
    const c=contract([criterion(1,'language',{kind:'text',value:'English B2'})]);
    const e=evidence('a');
    const fact={...e.facts[0],field:'language' as const,value:'en',qualifier:'C1'};
    expect(scoreEvidence(c,{...e,facts:[fact]},asOf).N).toBe(3);
    for(const qualifier of ['B1','fluent',undefined])expect(scoreEvidence(c,{...e,facts:[{...fact,qualifier}]},asOf).N).toBe(0);
  });
  it('requires the exact degree and field, not a higher degree or a school',()=>{
    const c=contract([criterion(1,'education_requirement',{kind:'text',value:'bachelor in computer science'})]);
    const e=evidence('a'),fact={...e.facts[0],field:'education_requirement' as const,value:'bachelors',qualifier:'Computer Science'};
    expect(scoreEvidence(c,{...e,facts:[fact]},asOf).N).toBe(3);
    expect(scoreEvidence(c,{...e,facts:[{...fact,value:'master'}]},asOf).N).toBe(0);
    expect(scoreEvidence(c,{...e,facts:[{...fact,qualifier:undefined}]},asOf).N).toBe(0);
  });
  it('requires an explicit matching issuer and current validity for credentials',()=>{
    const c=contract([criterion(1,'certification',{kind:'text',value:'Test license [issuer: Example board]'})]);
    const e=evidence('a'),fact={...e.facts[0],field:'certification' as const,value:'Test license',qualifier:'Example board',validUntil:'2027-01-01T00:00:00.000Z'};
    expect(scoreEvidence(c,{...e,facts:[fact]},asOf).N).toBe(3);
    expect(scoreEvidence(c,{...e,facts:[{...fact,qualifier:'Different board'}]},asOf).N).toBe(0);
    expect(scoreEvidence(c,{...e,facts:[{...fact,revoked:true}]},asOf).assessments[0].state).toBe('not_met');
    expect(scoreEvidence(c,{...e,facts:[{...fact,validUntil:undefined}]},asOf).assessments[0].state).toBe('unknown');
  });
  it('source display metadata cannot affect eligibility, scores or order',()=>{
    const e=evidence('same');
    expect(scoreEvidence(contract(),{...e,presentationSource:'pool'},asOf)).toEqual(scoreEvidence(contract(),{...e,presentationSource:'discovered'},asOf));
  });
});
