import { byteCompare, rankingContractSchema, type Criterion, type RankingContract } from './contracts';
import { evidenceFor, evidenceSchema, type CanonicalEvidence, type EvidenceFact } from './evidence';
import { calculateExperience, experienceEligibility, experienceDisplay, DAYS_PER_YEAR, type ExperienceRange, type ExperienceEligibility } from './experience';
import { atomicSkill, automaticallyMapped, canonicalDegree, canonicalLanguage, canonicalLocation, functionFamily, normalize, normalizedTitle, predicateKey, seniority, languageRequirement, educationRequirement, certificationRequirement, CEFR_LEVELS } from './taxonomy';
import { localMatch } from './lexical';

export type AssessmentState='met'|'not_met'|'unknown';
export interface Assessment {criterionIds:string[];labels:string[];subject:Criterion['subject'];state:AssessmentState;mapped:boolean;weight:number;points:number;localPoints:number;refs:string[]}
function assess(c:Criterion,e:CanonicalEvidence,asOf:string):{state:AssessmentState;positive:string[];refs:string[]} {
  const result=(state:AssessmentState,facts:EvidenceFact[]=[])=>({state,positive:state==='met'?facts.map(f=>f.value):[],refs:facts.map(f=>f.ref)});
  if(!automaticallyMapped(c)) return result('unknown');
  const kind=c.subject==='location'?'city':c.subject==='relevant_work'?'function':c.subject;
  const allowed=c.evidenceKinds;
  const facts=evidenceFor(e,kind as EvidenceFact['field'],allowed,asOf);
  const r=c.requirement;
  if(c.subject==='title' && r.kind==='accepted_titles') {
    const approved=new Set(r.values.map(normalizedTitle).filter(Boolean));
    const matched=facts.filter(f=>{const title=normalizedTitle(f.value);return title!==null&&approved.has(title);});
    return result(matched.length?'met':'unknown',matched);
  }
  if(c.subject==='work_eligibility' && r.kind==='boolean') {
    const trusted=facts.filter(f=>f.kind!=='profile_evidence');
    if(r.value==='unknown'||!trusted.length) return result('unknown');
    const matches=trusted.filter(f=>normalize(f.value)===r.value);
    return result(matches.length?'met':trusted.every(f=>['yes','no'].includes(normalize(f.value)))?'not_met':'unknown',matches.length?matches:trusted);
  }
  if(r.kind!=='text') return result('unknown');
  const required=normalize(r.value);
  let matched:EvidenceFact[]=[];
  switch(c.subject) {
    case 'skill': matched=facts.filter(f=>atomicSkill(f.value)===atomicSkill(required));break;
    case 'seniority': {
      const wanted=seniority(required);
      const known=facts.map(f=>({fact:f,level:seniority(f.value)})).filter(x=>x.level!==null);
      // Different explicitly established tracks/levels are ambiguous, not a best-title guess.
      if(new Set(known.map(x=>JSON.stringify(x.level))).size>1) return result('unknown');
      matched=known.filter(x=>wanted&&x.level?.track===wanted.track&&x.level.level>=wanted.level).map(x=>x.fact);break;
    }
    case 'function':case 'relevant_work': matched=facts.filter(f=>functionFamily(f.value)!==null&&functionFamily(f.value)===functionFamily(required));break;
    case 'domain': matched=facts.filter(f=>normalize(f.value)===required);break;
    case 'location': {
      // Country comparison is typed; a city must also have an explicit country in the requirement.
      const parts=required.split(',').map(x=>x.trim());
      const countries=evidenceFor(e,'country',allowed,asOf);
      if(parts.length===2) {
        const country=countries.filter(f=>canonicalLocation(f.value,true)===canonicalLocation(parts[1],true));
        matched=facts.filter(f=>canonicalLocation(f.value)===canonicalLocation(parts[0]));
        if(!country.length||!matched.length) return result(countries.length&&facts.length?'not_met':'unknown');
        matched=[...matched,...country];
      } else {
        matched=countries.filter(f=>canonicalLocation(f.value,true)===canonicalLocation(required,true));
        if(!matched.length) return result('unknown');
      }
      break;
    }
    case 'certification': {
      const requirement=certificationRequirement(required);
      const found=facts.filter(f=>normalize(f.value)===requirement?.name&&
        (requirement.issuer===null||(f.qualifier!==undefined&&normalize(f.qualifier)===requirement.issuer)));
      matched=found.filter(f=>f.revoked!==true&&f.validUntil!==undefined&&Date.parse(f.validUntil)>=Date.parse(asOf));
      if(!matched.length&&found.some(f=>f.revoked===true||(f.validUntil!==undefined&&Date.parse(f.validUntil)<Date.parse(asOf)))) return result('not_met',found);
      break;
    }
    case 'language': {
      const requirement=languageRequirement(required);
      matched=facts.filter(f=>canonicalLanguage(f.value)===requirement?.name&&
        (requirement.level===null||(f.qualifier!==undefined&&CEFR_LEVELS.indexOf(normalize(f.qualifier) as typeof CEFR_LEVELS[number])>=requirement.level)));break;
    }
    case 'education_requirement': {
      const requirement=educationRequirement(required);
      matched=facts.filter(f=>canonicalDegree(f.value)===requirement?.degree&&
        (requirement.field===null||(f.qualifier!==undefined&&normalize(f.qualifier)===requirement.field)));break;
    }
  }
  return result(matched.length?'met':'unknown',matched);
}

export function scoreEvidence(rawContract:RankingContract,rawEvidence:CanonicalEvidence,asOf:string) {
  const contract=rankingContractSchema.parse(rawContract),evidence=evidenceSchema.parse(rawEvidence);
  const groups=new Map<string,Criterion[]>();
  for(const c of contract.payload.criteria) {const key=predicateKey(c);groups.set(key,[...(groups.get(key)??[]),c]);}
  let range:ExperienceRange|null=null;
  const rangeCriterion=contract.payload.criteria.find(c=>c.subject==='experience_years');
  // This adapter's dated employment is provider-profile evidence. Do not use
  // it to satisfy (or exclude against) a criterion restricted to other kinds.
  const permittedEmployment=!rangeCriterion||rangeCriterion.evidenceKinds.includes('profile_evidence')?evidence.employment:[];
  const experience=calculateExperience(permittedEmployment,asOf);
  if(rangeCriterion && (rangeCriterion.requirement.kind==='minimum_years'||rangeCriterion.requirement.kind==='experience_range')) {
    range={minimum:rangeCriterion.requirement.minimum,...(rangeCriterion.requirement.kind==='experience_range'?{maximum:rangeCriterion.requirement.maximum}:{})};
  }
  const assessments:Assessment[]=[];
  for(const candidates of groups.values()) {
    // Same predicate may have several IDs/classes. Retain all IDs; earn at most the maximum weight.
    const weightFor=(c:Criterion)=>automaticallyMapped(c)?c.class==='must_have'?3:c.class==='preferred'?1:0:0;
    const c=[...candidates].sort((a,b)=>weightFor(b)-weightFor(a)||byteCompare(a.id,b.id))[0];
    const weight=weightFor(c),mapped=automaticallyMapped(c);
    let state:AssessmentState='unknown',positive:string[]=[],refs:string[]=[];
    if(c.subject==='experience_years'&&range) {
      if(['measured','bounded'].includes(experience.status)&&experience.lowerDays!==null&&experience.upperDays!==null) {
        const lo=experience.lowerDays/DAYS_PER_YEAR,hi=experience.upperDays/DAYS_PER_YEAR;
        state=lo>=range.minimum&&hi<=(range.maximum??Infinity)?'met':hi<range.minimum||lo>(range.maximum??Infinity)?'not_met':'unknown';
        if(state==='met') positive=['recorded employment'];refs=['employment'];
      }
    } else ({state,positive,refs}=assess(c,evidence,asOf));
    const orderedCriteria=[...candidates].sort((a,b)=>byteCompare(a.id,b.id));
    assessments.push({criterionIds:orderedCriteria.map(x=>x.id),labels:orderedCriteria.map(x=>x.label),subject:c.subject,state,mapped,weight,
      points:state==='met'?weight:0,localPoints:state==='met'?weight*localMatch(c,positive):0,refs:[...new Set(refs)].sort()});
  }
  const skills=assessments.filter(a=>a.subject==='skill'&&a.criterionIds.some(id=>contract.payload.criteria.some(c=>c.id===id&&c.class==='must_have'))).map(a=>a.state);
  const eligibility=experienceEligibility(experience,range,skills);
  return {candidateId:evidence.candidateId,eligibility,experience:{...experience,display:experienceDisplay(experience,range)},
    N:assessments.reduce((sum,a)=>sum+a.points,0),D:assessments.reduce((sum,a)=>sum+a.weight,0),
    L:assessments.reduce((sum,a)=>sum+a.localPoints,0),assessments};
}
export type RankedEvidence=ReturnType<typeof scoreEvidence>;
export const eligible=(value:ExperienceEligibility)=>['in_range','wider','unconstrained'].includes(value);
const priority=(value:ExperienceEligibility)=>value==='wider'?1:eligible(value)?0:2;
export function compareRanking(a:RankedEvidence,b:RankedEvidence):number {
  return priority(a.eligibility)-priority(b.eligibility)||b.N-a.N||b.L-a.L||byteCompare(a.candidateId,b.candidateId);
}
export function rankEvidence(contract:RankingContract,pool:readonly CanonicalEvidence[],asOf:string) {
  if(pool.length>2000) throw Error('RUBRIC_POOL_TOO_LARGE');
  if(new Set(pool.map(p=>p.candidateId)).size!==pool.length) throw Error('RUBRIC_DUPLICATE_IDENTITY');
  const items=pool.map(e=>scoreEvidence(contract,e,asOf)).sort(compareRanking);
  const selected=items.filter(i=>eligible(i.eligibility)).slice(0,100).map((item,index)=>({...item,selectedOrdinal:index+1}));
  return {items,selected,shortfall:100-selected.length};
}
