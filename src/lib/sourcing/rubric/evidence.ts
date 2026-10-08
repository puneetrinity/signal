import { z } from 'zod';
import { rankingHash } from './contracts';
import { normalize } from './taxonomy';
import type { EmploymentInterval } from './experience';

const term=z.string().min(1).max(500);
const field=z.enum(['title','skill','seniority','function','domain','city','country','work_arrangement','certification','language','education_requirement','work_eligibility']);
export const factSchema=z.object({
  field, value:term, ref:z.string().min(1).max(160),
  kind:z.enum(['profile_evidence','candidate_provided','verified_document']),
  sourceVersion:z.string().min(1).max(100), observedAt:z.string().datetime(),
  scope:z.enum(['public','organization']), organizationRef:z.string().nullable(),
  qualifier:z.string().max(160).optional(), validUntil:z.string().datetime().optional(), revoked:z.boolean().optional(),
}).strict().refine(v=>v.scope==='organization'?!!v.organizationRef:v.organizationRef===null,'Evidence scope mismatch');
export type EvidenceFact=z.infer<typeof factSchema>;
const roleSchema=z.object({title:z.string().max(500).optional(),employmentType:z.string().max(100).optional(),
  start:z.string().max(40).nullable().optional(),end:z.string().max(40).nullable().optional(),ongoing:z.boolean().optional()}).strict();
export const evidenceSchema=z.object({candidateId:z.string().min(1).max(200),organizationRef:z.string().regex(/^[1-9][0-9]*$/),
  // Frozen display provenance only. Never read by a criterion or comparator.
  presentationSource:z.enum(['pool','pool_enriched','discovered']).optional(),
  facts:z.array(factSchema).max(1000),employment:z.array(roleSchema).max(500),version:z.literal('rubric-evidence-v1'),
}).strict().superRefine((v,ctx)=>{
  if(v.facts.some(f=>f.scope==='organization'&&f.organizationRef!==v.organizationRef)) ctx.addIssue({code:z.ZodIssueCode.custom,message:'Foreign private evidence'});
  if(Buffer.byteLength(JSON.stringify(v),'utf8')>32768) ctx.addIssue({code:z.ZodIssueCode.custom,message:'Evidence too large'});
});
export type CanonicalEvidence=z.infer<typeof evidenceSchema>;
const record=(v:unknown):Record<string,unknown>=>v!==null && typeof v==='object' && !Array.isArray(v)?v as Record<string,unknown>:{};
const objects=(v:unknown)=>Array.isArray(v)?v.map(record):[];
const strings=(v:unknown):string[]=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'&&x.trim().length>0):[];
const text=(v:unknown):string|undefined=>typeof v==='string'&&v.trim()?v:undefined;

/** Only call after scoped identity/privacy admission. Same stored provider payload on
 * fresh and Memory paths; no headline, legacy keyword skills, snapshot hints or score. */
export function adaptProfile(input:{candidateId:string;organizationRef:string;profile:unknown;sourceVersion:string;observedAt:string;
  permittedFacts?:readonly EvidenceFact[]}):CanonicalEvidence {
  const profile=record(input.profile),basic=record(profile.basic_profile),details=record(record(profile.experience).employment_details);
  const facts:EvidenceFact[]=[], employment:EmploymentInterval[]=[];
  const add=(field:EvidenceFact['field'],raw:unknown,ref:string)=>{
    const value=text(raw); if(value) facts.push({field,value:normalize(value),ref,kind:'profile_evidence',sourceVersion:input.sourceVersion,
      observedAt:input.observedAt,scope:'public',organizationRef:null});
  };
  const nestedRoles=(['current','past'] as const).flatMap(lane=>objects(details[lane]).map((role,index)=>
    ({role,ref:`experience.employment_details.${lane}.${index}`,ongoing:lane==='current'})));
  // Older stored provider records use employer[]. Do not derive currentness from
  // list order or missing end dates. Prefer the nested record when both exist.
  const roles=nestedRoles.length?nestedRoles:objects(profile.employer).map((role,index)=>
    ({role,ref:`employer.${index}`,ongoing:role.is_current===true}));
  for(const {role,ref,ongoing} of roles) {
    const title=text(role.title);
    employment.push({...(title?{title}:{}),...(text(role.employment_type)?{employmentType:text(role.employment_type)}:{}),
      start:text(role.start_date)??null,end:text(role.end_date)??null,ongoing});
    add('title',title,ref+'.title');add('seniority',role.seniority_level,ref+'.seniority_level');
    add('function',role.function_category,ref+'.function_category');
    for(const domain of strings(role.company_industries)) add('domain',domain,ref+'.company_industries');
    add('domain',role.company_professional_network_industry,ref+'.company_professional_network_industry');
  }
  for(const skill of strings(record(profile.skills).professional_network_skills)) add('skill',skill,'skills.professional_network_skills');
  // A flat, explicitly structured skills array is evidence; extracted snippets
  // and descriptions never are. Nested data wins when both wrappers exist.
  if(!Array.isArray(record(profile.skills).professional_network_skills))
    for(const skill of strings(profile.skills)) add('skill',skill,'skills');
  const location=record(basic.location);
  add('city',location.city,'basic_profile.location.city');add('country',location.country,'basic_profile.location.country');
  for(const language of strings(basic.languages)) add('language',language,'basic_profile.languages');
  const schools=objects(record(profile.education).schools);
  const education=schools.length?schools.map((school,index)=>({degree:school.degree,field:school.field_of_study,ref:`education.schools.${index}`})):
    objects(profile.education_background).map((school,index)=>({degree:school.degree_name,field:school.field_of_study,ref:`education_background.${index}`}));
  for(const school of education) {
    const degree=text(school.degree);if(!degree)continue;
    const fact:EvidenceFact={field:'education_requirement',value:normalize(degree),ref:school.ref+'.degree',kind:'profile_evidence',
      sourceVersion:input.sourceVersion,observedAt:input.observedAt,scope:'public',organizationRef:null};
    const field=text(school.field);if(field)fact.qualifier=normalize(field);
    facts.push(fact);
  }
  // A typed upstream adapter supplies candidate-owned/verified facts; this function
  // rechecks scope, shape and size. It never promotes tenant evidence into public data.
  for(const fact of input.permittedFacts??[]) facts.push(factSchema.parse(fact));
  const unique=[...new Map(facts.map(f=>[rankingHash(f),f])).values()].sort((a,b)=>{
    const x=rankingHash(a),y=rankingHash(b);return x<y?-1:x>y?1:0;
  });
  return evidenceSchema.parse({candidateId:input.candidateId,organizationRef:input.organizationRef,
    facts:unique,employment,version:'rubric-evidence-v1'});
}

/** Select allowed, observed facts with scoped precedence. Missing conflicting
 * singleton facts stay unknown rather than picking whichever provider is first. */
export function evidenceFor(evidence:CanonicalEvidence,field:EvidenceFact['field'],allowed:readonly string[],asOf:string):EvidenceFact[] {
  const at=Date.parse(asOf);
  if(!Number.isFinite(at)) throw Error('RUBRIC_INVALID_AS_OF');
  let facts=evidence.facts.filter(f=>f.field===field&&allowed.includes(f.kind)&&Date.parse(f.observedAt)<=at);
  const precedence=(f:EvidenceFact)=>f.kind==='verified_document'?2:f.kind==='candidate_provided'?2:1;
  // Precedence resolves contradictory singleton facts. It must not interpret
  // a candidate's partial skills list as a denial of every other known skill.
  if(['city','country','work_arrangement','work_eligibility'].includes(field)) {
    const highest=Math.max(0,...facts.map(precedence));facts=facts.filter(f=>precedence(f)===highest);
    if(new Set(facts.map(f=>normalize(f.value))).size>1)return [];
  }
  return facts;
}
