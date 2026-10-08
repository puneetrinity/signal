import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {checkRankingSource,rankingSourceTokens} from '../../../../../scripts/check-rubric-ranking.mjs';
import {createRankingContract,rankingContractSchema,rankingHash} from '../contracts';
const id='10000000-0000-4000-8000-000000000001';
const payload={schemaVersion:2,compilerVersion:2,taxonomyVersion:2,criteria:[{id,label:'Role',class:'preferred',subject:'title',
 requirement:{kind:'accepted_titles',values:['Backend Engineer','Backend Developer']},evidenceKinds:['profile_evidence'],use:'assessment',provenance:{kind:'recruiter_edit'}}]};
describe('ranking contract binding',()=>{
 it('binds the approved payload and source-neutral projection',()=>{
  const c=createRankingContract(id,'a'.repeat(64),payload);
  expect(c.policyVersion).toBe('rubric-range-v1');expect(c.payload.schemaVersion).toBe(2);
  expect(rankingContractSchema.parse(c)).toEqual(c);
  expect(c.contractHash).toMatch(/^[a-f0-9]{64}$/);
 });
 it('rejects silent alternative edits, hash changes and old schemas',()=>{
  const c=createRankingContract(id,'a'.repeat(64),payload);
  expect(()=>rankingContractSchema.parse({...c,materialHash:'b'.repeat(64)})).toThrow();
  const changed=structuredClone(c);changed.payload.criteria[0].label='different';
  expect(()=>rankingContractSchema.parse(changed)).toThrow();
  expect(()=>createRankingContract(id,'a'.repeat(64),{...payload,schemaVersion:1})).toThrow();
 });
 it('excludes notes, labels and provenance from matching, but binds them in the contract',()=>{
  const a=createRankingContract(id,'a'.repeat(64),payload),b=createRankingContract(id,'a'.repeat(64),{...payload,criteria:[{...payload.criteria[0],note:'Job-related clarification',label:'Role title'}]});
  expect(a.projectionText).toBe(b.projectionText);expect(a.contractHash).not.toBe(b.contractHash);
 });
 it('refuses oversized alternatives, duplicate normalized titles, maximum-only and protected notes',()=>{
  const c=payload.criteria[0];
  for(const requirement of [{kind:'accepted_titles',values:Array(21).fill('Backend Engineer')},
     {kind:'accepted_titles',values:['Backend Engineer',' backend engineer ']},{kind:'experience_range',maximum:10}]) {
    expect(()=>createRankingContract(id,'a'.repeat(64),{...payload,criteria:[{...c,requirement}]})).toThrow();
  }
  expect(()=>createRankingContract(id,'a'.repeat(64),{...payload,criteria:[{...c,note:'Married only'}]})).toThrow();
 });
 it('canonical hashing is independent of JSON object key insertion order',()=>{
  expect(rankingHash({b:1,a:2})).toBe(rankingHash({a:2,b:1}));
 });
 it('supports fractional years and byte-ordered Unicode without source-dependent hashing',()=>{
  const criteria=[{...payload.criteria[0],subject:'experience_years',requirement:{kind:'minimum_years',minimum:1e-7}}];
  const c=createRankingContract(id,'a'.repeat(64),{...payload,criteria});
  expect(c.projectionText).toContain('0.0000001');
  expect(rankingContractSchema.parse(c)).toEqual(c);
  expect(()=>createRankingContract(id,'a'.repeat(64),{...payload,criteria:criteria.map(x=>({...x,evidenceKinds:['candidate_provided']}))})).toThrow();
 });
});
describe('rubric source guard mutation checks',()=>{
 const read=(path:string)=>readFileSync(path,'utf8');
 it('accepts the current ranking authority',()=>expect(()=>checkRankingSource(process.cwd(),read)).not.toThrow());
 for(const [path,tokens] of Object.entries(rankingSourceTokens))for(const token of tokens as string[])
  it(`refuses removed ranking fence ${path} / ${token}`,()=>{
   expect(()=>checkRankingSource(process.cwd(),(p:string)=>p===path?read(p).split(token).join('REMOVED'):read(p))).toThrow();
  });
});
