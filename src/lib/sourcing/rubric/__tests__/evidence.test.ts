import {describe,it,expect} from 'vitest';
import {adaptProfile,evidenceFor,type EvidenceFact} from '../evidence';
const asOf='2025-01-01T00:00:00.000Z';
const base={candidateId:'a',organizationRef:'1',sourceVersion:'test',observedAt:asOf};
const fact=(value:string,scope:EvidenceFact['scope']='organization'):EvidenceFact=>({field:'city',value,ref:'candidate.city',kind:'candidate_provided',
  sourceVersion:'v1',observedAt:asOf,scope,organizationRef:scope==='organization'?'1':null});
describe('scoped minimal evidence',()=>{
  it('omits names, headline, contacts, legacy text-extracted skills and total-year hints',()=>{
    const e=adaptProfile({...base,profile:{basic_profile:{name:'PRIVATE',headline:'Java',email:'secret'},years_of_experience_raw:20,
      snapshot:{skillsNormalized:['Java']},summary:'Kafka expert'}});
    expect(e.facts).toEqual([]);expect(e.employment).toEqual([]);expect(JSON.stringify(e)).not.toContain('PRIVATE');
  });
  it('accepts only structured skills and keeps source metadata',()=>{
    const e=adaptProfile({...base,profile:{skills:{professional_network_skills:['Golang']}}});
    expect(e.facts[0]).toMatchObject({field:'skill',value:'golang',sourceVersion:'test',scope:'public'});
  });
  it('candidate evidence outranks provider observation without becoming public',()=>{
    const e=adaptProfile({...base,profile:{basic_profile:{location:{city:'Pune'}}},permittedFacts:[fact('Bengaluru')]});
    expect(evidenceFor(e,'city',['profile_evidence','candidate_provided'],asOf)).toEqual([fact('Bengaluru')]);
    expect(()=>adaptProfile({...base,profile:{},permittedFacts:[{...fact('Pune'),organizationRef:'2'}]})).toThrow();
  });
  it('same-precedence singleton conflicts and future observations remain unknown',()=>{
    const e=adaptProfile({...base,profile:{},permittedFacts:[fact('Pune'),fact('Bengaluru')]});
    expect(evidenceFor(e,'city',['candidate_provided'],asOf)).toEqual([]);
    const later=adaptProfile({...base,profile:{},permittedFacts:[{...fact('Pune'),observedAt:'2026-01-01T00:00:00Z'}]});
    expect(evidenceFor(later,'city',['candidate_provided'],asOf)).toEqual([]);
  });
});
