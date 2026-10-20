import { byteCompare, rankingContractSchema, type Criterion, type RankingContract } from './contracts';
import { evidenceFor, evidenceSchema, selectEmployment, type CanonicalEvidence, type EvidenceFact } from './evidence';
import { calculateExperience, experienceEligibility, experienceDisplay, isInternship, DAYS_PER_YEAR, type EmploymentInterval, type ExperienceRange, type ExperienceEligibility } from './experience';
import { atomicSkill, automaticallyMapped, canonicalDegree, canonicalLanguage, canonicalLocation, functionFamily, normalize, normalizedTitle, predicateKey, seniority, languageRequirement, educationRequirement, certificationRequirement, CEFR_LEVELS } from './taxonomy';
import { localMatch } from './lexical';
import { approvedSkillNames, normalizeSkillName } from './skill-alternatives';

export type AssessmentState='met'|'not_met'|'unknown';
export interface Assessment {criterionIds:string[];labels:string[];subject:Criterion['subject'];state:AssessmentState;mapped:boolean;weight:number;points:number;localPoints:number;refs:string[]}
// Per invocation only: cache the pure string transformation, never a privacy
// decision, fact eligibility or assessment. Bound memory even for distinct skills.
function skillNormalizer(){
  const names=new Map<string,string>();
  return(value:string)=>{
    const found=names.get(value);if(found!==undefined)return found;
    const normalized=normalizeSkillName(value);
    if(names.size>=4096)names.clear();
    names.set(value,normalized);return normalized;
  };
}
function assess(c:Criterion,e:CanonicalEvidence,asOf:string,normalizeSkill:(value:string)=>string):{state:AssessmentState;positive:string[];refs:string[]} {
  const result=(state:AssessmentState,facts:EvidenceFact[]=[])=>({state,positive:state==='met'?facts.map(f=>f.value):[],refs:facts.map(f=>f.ref)});
  if(!automaticallyMapped(c)) return result('unknown');
  const kind=c.subject==='location'?'city':c.subject==='relevant_work'?'function':c.subject;
  const allowed=c.evidenceKinds;
  const facts=evidenceFor(e,kind as EvidenceFact['field'],allowed,asOf);
  const r=c.requirement;
  if(c.subject==='skill' && r.kind==='accepted_skills') {
    const approved=new Set(approvedSkillNames(r));
    const matched=facts.filter(f=>approved.has(normalizeSkill(f.value)));
    return result(matched.length?'met':'unknown',matched);
  }
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
  return scoreWithContract(rankingContractSchema.parse(rawContract),rawEvidence,asOf,skillNormalizer());
}
function scoreWithContract(contract:RankingContract,rawEvidence:CanonicalEvidence,asOf:string,normalizeSkill:(value:string)=>string) {
  const evidence=evidenceSchema.parse(rawEvidence);
  if(evidence.version!==contract.adapterVersion)throw Error('RUBRIC_EVIDENCE_VERSION_MISMATCH');
  const groups=new Map<string,Criterion[]>();
  for(const c of contract.payload.criteria) {const key=predicateKey(c);groups.set(key,[...(groups.get(key)??[]),c]);}
  let range:ExperienceRange|null=null;
  const rangeCriterion=contract.payload.criteria.find(c=>c.subject==='experience_years');
  // This adapter's dated employment is provider-profile evidence. Do not use
  // it to satisfy (or exclude against) a criterion restricted to other kinds.
  const employment=selectEmployment(evidence,rangeCriterion?.evidenceKinds??['candidate_provided','profile_evidence'],asOf);
  const experience=calculateExperience(employment.intervals,asOf);
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
    const relevant=c.subject==='relevant_work'&&mapped&&c.requirement.kind==='text'?
      assessRelevantWorkSources(c.requirement.value,relevantWorkSources(evidence,c.evidenceKinds,asOf),asOf):null;
    if(c.subject==='experience_years'&&range) {
      if(['measured','bounded'].includes(experience.status)&&experience.lowerDays!==null&&experience.upperDays!==null) {
        const lo=experience.lowerDays/DAYS_PER_YEAR,hi=experience.upperDays/DAYS_PER_YEAR;
        state=lo>=range.minimum&&hi<=(range.maximum??Infinity)?'met':hi<range.minimum||lo>(range.maximum??Infinity)?'not_met':'unknown';
        if(state==='met') positive=['recorded employment'];refs=[employment.ref];
      }
    } else if(relevant) {
      state=relevant.state;
      if(state==='met') positive=relevant.titles;
      refs=[relevant.ref];
    } else ({state,positive,refs}=assess(c,evidence,asOf,normalizeSkill));
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
export type RequiredDuration={kind:'none'}|{kind:'years';years:number}|{kind:'unsupported'};
/**
 * Duration asked for by a relevant-work requirement. Only one plain number with "years"/"yrs" (optionally "+") is
 * understood. Written numbers, ranges, several numbers or implausible values are "unsupported" and must never be
 * read as "no duration" (that would silently weaken the approved criterion).
 */
export function requiredDuration(text:string):RequiredDuration {
  // Other time units ("60 months") and upper limits ("at most 5 years") are not parsed: they are unsupported, never
  // treated as no duration or as a minimum.
  if(/\b(?:months?|mos?|weeks?|wks?|days?|decades?)\b/i.test(text)) return {kind:'unsupported'};
  if(!/\b(?:years?|yrs?)\b/i.test(text)) return {kind:'none'};
  if(/\b(?:at\s+most|up\s+to|no\s+more\s+than|not\s+more\s+than|less\s+than|fewer\s+than|under|below|maximum|max)\b|<|≤/i.test(text)) return {kind:'unsupported'};
  const numbers=text.match(/\d+(?:\.\d+)?/g)??[];
  const range=/\d\s*(?:-|–|—|to)\s*\d/i.test(text);
  const m=/(?:^|[^\d.])(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/i.exec(text);
  const years=m?Number(m[1]):NaN;
  if(numbers.length!==1||range||!m||!Number.isInteger(years)||years<1||years>40) return {kind:'unsupported'};
  return {kind:'years',years};
}
/** Back-compat helper used by tests: years when understood, otherwise null. */
export function requiredYears(text:string):number|null {
  const d=requiredDuration(text);return d.kind==='years'?d.years:null;
}
type WorkResult={state:AssessmentState;titles:string[]};
/** One employment source, judged on its own dated roles (locked rules, see the finding doc). */
function assessWorkSource(family:string,years:number,intervals:readonly EmploymentInterval[],asOf:string):WorkResult {
  const roles=intervals.filter(r=>!isInternship(r));
  const matching=roles.filter(r=>typeof r.title==='string'&&functionFamily(r.title)===family);
  const titles=[...new Set(matching.map(r=>normalize(r.title!)))].sort();
  const minimumDays=years*DAYS_PER_YEAR;
  const measured=(e:ReturnType<typeof calculateExperience>)=>['measured','bounded'].includes(e.status)&&e.lowerDays!==null&&e.upperDays!==null;
  // Lower bound: only matching roles whose own dates are usable; an undated role never discards dated ones.
  const datedMatching=matching.filter(r=>measured(calculateExperience([r],asOf)));
  const lower=datedMatching.length?calculateExperience(datedMatching,asOf):null;
  if(lower&&measured(lower)&&lower.lowerDays!>=minimumDays) return {state:'met',titles};
  if(!roles.length) return {state:'unknown',titles};
  const possible=roles.filter(r=>typeof r.title!=='string'||functionFamily(r.title)===family||functionFamily(r.title)===null);
  if(!possible.length) return measured(calculateExperience(roles,asOf))?{state:'not_met',titles}:{state:'unknown',titles};
  const upper=calculateExperience(possible,asOf);
  return measured(upper)&&upper.upperDays!<minimumDays?{state:'not_met',titles}:{state:'unknown',titles};
}
/**
 * Employment sources this criterion may use, in precedence order (candidate-provided résumé, then profile), with the
 * same allowed evidence kinds and observation cutoff as experience selection, but WITHOUT requiring the whole source
 * to be fully dated (relevant work only needs its dated matching roles).
 */
export function relevantWorkSources(evidence:CanonicalEvidence,allowed:readonly string[],asOf:string):{intervals:EmploymentInterval[];ref:string}[] {
  if(evidence.version==='rubric-evidence-v1')
    return allowed.includes('profile_evidence')&&evidence.employment.length?[{intervals:evidence.employment,ref:'employment'}]:[];
  const out:{intervals:EmploymentInterval[];ref:string}[]=[];
  for(const kind of ['candidate_provided','profile_evidence']) {
    const source=evidence.employmentSources.find(s=>s.kind===kind&&allowed.includes(s.kind)&&Date.parse(s.observedAt)<=Date.parse(asOf));
    if(source&&source.intervals.length) out.push({intervals:source.intervals,ref:kind==='candidate_provided'?'resume.employment':'profile.employment'});
  }
  return out;
}
/**
 * Relevant work = dated employment in roles whose title is in the required role family. Across sources, in the same
 * precedence as experience (résumé, then profile): the first source that decides (met / not_met) is used; otherwise
 * unknown. Missing evidence is "unknown", never "not_met". Returns null when this rule does not
 * apply (no resolvable family, or a family-only requirement with no matching role) so the previous path is used.
 */
export function assessRelevantWorkSources(required:string,sources:readonly {intervals:EmploymentInterval[];ref:string}[],asOf:string):(WorkResult&{ref:string})|null {
  const family=functionFamily(required);
  if(family===null) return null;
  const duration=requiredDuration(required);
  if(duration.kind==='unsupported') return {state:'unknown',titles:[],ref:sources[0]?.ref??'employment'};
  if(duration.kind==='none') {
    for(const s of sources) {
      const titles=[...new Set(s.intervals.filter(r=>!isInternship(r)&&typeof r.title==='string'&&functionFamily(r.title)===family).map(r=>normalize(r.title!)))].sort();
      if(titles.length) return {state:'met',titles,ref:s.ref};
    }
    return null;
  }
  // Same preference as experience selection (résumé before profile): the first source that can decide (met or
  // not_met) is used; a source whose dates cannot decide falls through instead of hiding usable evidence.
  for(const s of sources) {
    const r=assessWorkSource(family,duration.years,s.intervals,asOf);
    if(r.state!=='unknown') return {...r,ref:s.ref};
  }
  return {state:'unknown',titles:[],ref:sources[0]?.ref??'employment'};
}
/** Single-source convenience (tests, v1). */
export function assessRelevantWork(required:string,intervals:readonly EmploymentInterval[],asOf:string):WorkResult|null {
  const r=assessRelevantWorkSources(required,intervals.length?[{intervals:[...intervals],ref:'employment'}]:[],asOf);
  return r&&{state:r.state,titles:r.titles};
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
  // Preserve the empty-pool behavior; nonempty pools validate the immutable
  // contract once, while every candidate still receives full evidence validation.
  const checked=pool.length?rankingContractSchema.parse(contract):contract;
  const normalizeSkill=skillNormalizer();
  const items=pool.map(e=>scoreWithContract(checked,e,asOf,normalizeSkill)).sort(compareRanking);
  const selected=items.filter(i=>eligible(i.eligibility)).slice(0,100).map((item,index)=>({...item,selectedOrdinal:index+1}));
  return {items,selected,shortfall:100-selected.length};
}
