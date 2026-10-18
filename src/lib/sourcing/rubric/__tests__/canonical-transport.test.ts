import {describe,it,expect} from 'vitest';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {canonical,createRankingContract,rankingHash} from '../contracts';
import {evidenceV1Schema as evidenceSchema,withheldProfileSchema,evidenceBytes} from '../evidence';
import {computeRankingMessage} from '../ranking-compute-worker';
import {rankEvidence} from '../score';
import {checkRankingSource} from '../../../../../scripts/check-rubric-ranking.mjs';

const manifest=JSON.parse(readFileSync('scripts/rubric-layout-contract.json','utf8'));
export function transportCorpus(){
 const id='10000000-0000-4000-8000-000000000001',skillId='10000000-0000-4000-8000-000000000002',asOf='2026-10-01T00:00:00.000Z';
 const skill={id:skillId,label:'Python',subject:'skill',class:'must_have',use:'assessment',evidenceKinds:['profile_evidence'],provenance:{kind:'recruiter_edit'},requirement:{kind:'accepted_skills',primary:'Python',alternatives:[]}};
 const range={id,label:'Experience',subject:'experience_years',class:'must_have',use:'assessment',evidenceKinds:['profile_evidence'],provenance:{kind:'recruiter_edit'},requirement:{kind:'experience_range',minimum:6,maximum:10}};
 const contract=createRankingContract(id,'a'.repeat(64),{schemaVersion:3,compilerVersion:3,taxonomyVersion:3,criteria:[range,skill]});
 const evidence=[['in_range','2019-10-01',true],['wider','2021-10-01',true],['outside_experience_range','2000-10-01',true],['experience_unavailable',null,true],['uncertain_boundary','2020',true],['wider_skills_not_established','2021-10-01',false]].map(([candidateId,start,hasSkill])=>evidenceSchema.parse({
  candidateId,organizationRef:'1',presentationSource:'pool',version:'rubric-evidence-v1',employment:start?[{start,ongoing:true,title:'Engineer'}]:[],facts:hasSkill?[{field:'skill',value:'Python',ref:'skill',kind:'profile_evidence',sourceVersion:'fixture',observedAt:asOf,scope:'public',organizationRef:null}]:[]}));
 const unconstrained=createRankingContract(id,'a'.repeat(64),{schemaVersion:3,compilerVersion:3,taxonomyVersion:3,criteria:[skill]});
 const items=[...rankEvidence(contract,evidence,asOf).items,...rankEvidence(unconstrained,[{...evidence[0],candidateId:'unconstrained'}],asOf).items]
  .map((item,index)=>({...item,ordinal:index+1,selectedOrdinal:['in_range','wider','unconstrained'].includes(item.eligibility)?index+1:null,sourceType:'pool'}));
 return {evidence,items};
}
function unwrap(schema:z.ZodTypeAny):z.ZodTypeAny {
 while(schema instanceof z.ZodEffects||schema instanceof z.ZodOptional||schema instanceof z.ZodNullable){
  schema=schema instanceof z.ZodEffects?schema.innerType():schema.unwrap();
 }
 return schema;
}
function checkShape(schema:z.ZodTypeAny,kind:string){
 const raw=unwrap(schema);expect(raw).toBeInstanceOf(z.ZodObject);
 const shape=(raw as z.AnyZodObject).shape,expected=manifest.layouts[kind];
 expect(Object.keys(shape).sort()).toEqual(Object.keys(expected));
 for(const [key,field] of Object.entries(shape) as [string,z.ZodTypeAny][]){
  const d=expected[key],inner=unwrap(field);
  expect(field.isOptional(),kind+'.'+key).toBe(d.optional===true);
  expect(field.isNullable(),kind+'.'+key).toBe(d.nullable===true);
  if(inner instanceof z.ZodArray){
   expect(d.type).toBe('array');expect(inner._def.maxLength?.value).toBe(d.max);
   checkShape(inner.element,d.kind);
  }else if(inner instanceof z.ZodString){
   expect(d.type).toBe('string');
   for(const rule of inner._def.checks){
    if(rule.kind==='min')expect(d.min).toBe(rule.value);
    if(rule.kind==='max')expect(d.max).toBe(rule.value);
    if(rule.kind==='regex')expect(d.pattern).toBe(rule.regex.source);
    if(rule.kind==='datetime')expect(d.date).toBe(true);
   }
  }else if(inner instanceof z.ZodEnum){expect(d.type).toBe('string');expect(d.enum).toEqual(inner.options);}
  else if(inner instanceof z.ZodLiteral){
   if(typeof inner.value==='number'){expect(d.type).toBe('number');expect(d.min).toBe(inner.value);expect(d.max).toBe(inner.value);}
   else expect(d.enum).toEqual([inner.value]);
  }else if(inner instanceof z.ZodNumber){
   expect(d.type).toBe('number');for(const rule of inner._def.checks){if(rule.kind==='min')expect(d.min).toBe(rule.value);if(rule.kind==='max')expect(d.max).toBe(rule.value);}
  }else expect(inner).toBeInstanceOf(z.ZodBoolean);
 }
}
describe('reviewed canonical transport boundary',()=>{
 it('derives every evidence field, optionality, scalar type and bound from the real Zod schemas',()=>{
  checkShape(evidenceSchema,'evidence');checkShape(withheldProfileSchema,'withheld');
  expect(manifest.datetimePattern).toBe(z.datetimeRegex({precision:null,offset:false,local:false}).source.replaceAll('\\d','[0-9]'));
 });
 it('schema mutations cannot be approved by refreshing only a source hash',()=>{
  const shape=(unwrap(evidenceSchema) as z.AnyZodObject).shape;
  const {candidateId,...rest}=shape;void candidateId;
  for(const changed of [{...rest,renamed:z.string()},{...shape,candidateId:z.number()},
   {...shape,candidateId:z.string().nullable()},{...shape,candidateId:z.string().optional()}])
   expect(()=>checkShape(z.object(changed),'evidence')).toThrow();
 });
 it('pins real scorer output for all seven eligibility codes (weaker than a runtime result schema)',()=>{
  const corpus=transportCorpus();
  expect(new Set(corpus.items.map(i=>i.eligibility))).toEqual(new Set(manifest.layouts.item.eligibility.enum));
  for(const item of corpus.items){
   expect(Object.keys(item).sort()).toEqual(Object.keys(manifest.layouts.item));
   expect(Object.keys(item.experience).sort()).toEqual(Object.keys(manifest.layouts.experience));
   for(const a of item.assessments)expect(Object.keys(a).sort()).toEqual(Object.keys(manifest.layouts.assessment));
  }
  expect(rankingHash(corpus)).toBe(manifest.goldenCorpusSha256);
 });
 it('source checks require deliberate rebinding, never startup assets',()=>{
  expect(()=>checkRankingSource()).not.toThrow();
  const read=(p:string)=>readFileSync(p,'utf8');
  for(const path of Object.keys(manifest.sourcePins))expect(()=>checkRankingSource(process.cwd(),p=>read(p)+(p===path?'\n// drift':''))).toThrow('Ranking layout source changed');
  expect(()=>checkRankingSource(process.cwd(),p=>p==='scripts/rubric-layout-contract.json'?(()=>{throw Error('missing manifest')})():read(p))).toThrow('missing manifest');
 });
 it('production import and catalog checks work without a layout file or source tree',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ranking-startup-no-layout-'));
  try{
   const path=join(directory,'guard.mjs');writeFileSync(path,readFileSync('scripts/check-rubric-ranking.mjs'));
   const script=`const m=await import(${JSON.stringify(pathToFileURL(path).href)});let calls=0;await m.assertRankingCatalog({$queryRawUnsafe:async()=>++calls===1?[{digest:m.RANKING_CATALOG_SHA256}]:[{ok:true}]});if(calls!==2)throw Error('catalog not checked');`;
   const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:directory,encoding:'utf8'});
   expect(child.stderr).toBe('');expect(child.status).toBe(0);
  }finally{rmSync(directory,{recursive:true,force:true});}
 });
 it('tags both writes, retains objects separately and never changes semantic fingerprints',()=>{
  const id='10000000-0000-4000-8000-000000000001',asOf='2026-10-01T00:00:00.000Z';
  const contract=createRankingContract(id,'a'.repeat(64),{schemaVersion:3,compilerVersion:3,taxonomyVersion:3,criteria:[{
   id,label:'Skill',subject:'skill',class:'must_have',use:'assessment',evidenceKinds:['profile_evidence'],provenance:{kind:'recruiter_edit'},requirement:{kind:'accepted_skills',primary:'Python',alternatives:[]}}]});
  const evidence=evidenceSchema.parse({candidateId:'person',organizationRef:'1',version:'rubric-evidence-v1',employment:[],facts:[]});
  const prepared=computeRankingMessage({kind:'prepare',input:{contract,executionAttemptId:id,processingLeaseId:id,evidence:[evidence],sourceTypes:[['person','pool']]}});
  if(prepared.kind!=='prepared')throw Error('prepare');
  expect(prepared.command).not.toHaveProperty('evidence');expect(prepared.command.evidenceCanonical).toEqual(prepared.evidence.map(canonical));
  const inputHash=rankingHash({asOf,contractHash:contract.contractHash,evidence:prepared.evidence});
  const result=computeRankingMessage({kind:'claim',input:{contract,expected:prepared,claim:{state:'reserved_compact',revisionId:id,lease:id,asOf,inputHash,contractHash:contract.contractHash}}});
  if(result.kind!=='computed'||result.state!=='reserved')throw Error('compute');
  expect(result.command).not.toHaveProperty('items');
  expect(rankingHash({inputHash,items:result.command.itemsCanonical.map(t=>JSON.parse(t))})).toBe(result.outputHash);
 });
 it('physical bound accommodates maximally escaped text without raising semantic limits',()=>{
  for(const value of ['"\\\n\t','雪😀',String.fromCharCode(...Array.from({length:31},(_,i)=>i+1))]){
   const objects=Array.from({length:2000},(_,i)=>({candidateId:String(i),value:value.repeat(100)}));
   expect(evidenceBytes({evidenceCanonical:objects.map(canonical)})).toBeLessThanOrEqual(2*evidenceBytes({evidence:objects})+65_536);
  }
 });
});
