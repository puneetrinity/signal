import type { Criterion } from './contracts';
export const normalize = (value:string):string => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
const skills:Readonly<Record<string,string>>={"nodejs":"node.js","reactjs":"react","react.js":"react","vuejs":"vue","vue.js":"vue","angularjs":"angular","angular.js":"angular","golang":"go","nextjs":"next.js","next js":"next.js","nuxtjs":"nuxt","nuxt.js":"nuxt","expressjs":"express","express.js":"express","fastapi":"fastapi","fast api":"fastapi","postgres":"postgresql","postgressql":"postgresql","mongo":"mongodb","k8s":"kubernetes","ts":"typescript","js":"javascript","cpp":"c++","dotnet":".net","dot net":".net","csharp":"c#","c sharp":"c#","sfdc":"salesforce","salesforce crm":"salesforce","salesforce.com":"salesforce"};
const levels={"ic":["intern","junior","mid","senior","staff","principal"],"management":["manager","director","vp","cxo"],"aliases":{"sr":"senior","sr.":"senior","svp":"vp","evp":"vp","ceo":"cxo","cto":"cxo","cfo":"cxo","coo":"cxo"},"ambiguous":["lead","head","associate"],"rule":"Comparable minimum within the same explicitly established track only; cross-track, multiple levels or ambiguous label -> unknown. Higher same-track level earns no extra points. Never place manager above principal. Exclude senior living/care/citizen/home phrases."} as const;
const languageAliases:Readonly<Record<string,string>>={"en":"english","hi":"hindi","es":"spanish","fr":"french","de":"german","pt":"portuguese","ar":"arabic","zh":"chinese"};
const educationAliases:Readonly<Record<string,string>>={"bachelor's":"bachelor","bachelors":"bachelor","master's":"master","masters":"master","ph.d.":"doctorate","phd":"doctorate"};
const locationAliases:Readonly<Record<string,string>>={"bangalore":"bengaluru","gurgaon":"gurugram","bombay":"mumbai","in":"india","us":"united states","usa":"united states","uk":"united kingdom","gb":"united kingdom"};
const levelPrefixes:readonly string[]=["senior","sr","sr.","junior","jr","jr.","staff","principal","lead","associate","mid-level","mid level","entry-level","entry level"];
const preserve:readonly string[]=["senior living","senior care","senior citizen","senior home","lead generation","principal investigator","staff nurse"];
export function normalizedTitle(raw:string):string|null {
  let value=normalize(raw);
  for(let i=0;i<20;i++) {
    if(preserve.some(p=>value===p || value.startsWith(p+' '))) return value;
    const prefix=levelPrefixes.find(p=>value.startsWith(p+' '));
    if(!prefix) return value && !levelPrefixes.includes(value) ? value : null;
    value=value.slice(prefix.length).trim();
  }
  return null;
}
export function atomicSkill(raw:string):string|null {
  const value=normalize(raw);
  if (!value || /[,;\n]|\b(?:and|or|with|required|experience|knowledge|proficient|expertise)\b/.test(value)) return null;
  return skills[value]??value;
}
export function seniority(raw:string):{track:'ic'|'management';level:number}|null {
  const value=normalize(raw);
  const canonical=(levels.aliases as Record<string,string>)[value]??value;
  for(const track of ['ic','management'] as const) {
    const index=(levels[track] as readonly string[]).indexOf(canonical);
    if(index>=0) return {track,level:index};
  }
  return null;
}
export function canonicalLanguage(raw:string):string {const value=normalize(raw);return languageAliases[value]??value;}
export function canonicalDegree(raw:string):string {const value=normalize(raw);return educationAliases[value]??value;}
export const CEFR_LEVELS=['a1','a2','b1','b2','c1','c2'] as const;
/** Bounded literal requirement grammars, not natural-language inference. */
export function languageRequirement(raw:string):{name:string;level:number|null}|null {
  const value=normalize(raw),match=/^(.+?)\s+(a1|a2|b1|b2|c1|c2)$/.exec(value);
  const name=canonicalLanguage(match?.[1]??value);
  if(!name||/[\d,;\[\]]|\b(?:fluent|native|business|and|or|with|required|proficiency)\b/.test(name))return null;
  return {name,level:match?CEFR_LEVELS.indexOf(match[2] as typeof CEFR_LEVELS[number]):null};
}
export function educationRequirement(raw:string):{degree:string;field:string|null}|null {
  const value=normalize(raw),parts=value.split(' in '),degree=canonicalDegree(parts[0]);
  if(parts.length>2||!['bachelor','master','doctorate','associate','diploma'].includes(degree))return null;
  const field=parts[1]??null;
  if(field!==null&&(!field||/[,;]|\b(?:and|or|with)\b/.test(field)))return null;
  return {degree,field};
}
export function certificationRequirement(raw:string):{name:string;issuer:string|null}|null {
  const value=normalize(raw),match=/^(.+?)\s+\[issuer:\s*([^\[\]]+)\]$/.exec(value);
  const name=match?.[1]??value,issuer=match?.[2]?.trim()??null;
  if(!name||/[\[\],;]|\b(?:and|or|with|issued by|from)\b/.test(name)||issuer==='')return null;
  return {name,issuer};
}
export function canonicalLocation(raw:string, country=false):string {
  const value=normalize(raw);
  // Short country aliases apply only when the field is explicitly a country.
  return value.length<=3 && !country ? value : locationAliases[value]??value;
}
type RoleFamily=string;
export const ROLE_PATTERNS: Array<{ family: RoleFamily; patterns: RegExp[] }> = [
  {
    family: 'devops',
    patterns: [/\bdevops\b/i, /\bsre\b/i, /\bsite reliability\b/i, /\bplatform engineer\b/i],
  },
  {
    family: 'fullstack',
    patterns: [/\bfull[- ]?stack\b/i, /\bfull stack\b/i],
  },
  {
    family: 'frontend',
    patterns: [/\bfront[- ]?end\b/i, /\bui engineer\b/i, /\breact\b/i, /\bangular\b/i],
  },
  {
    family: 'backend',
    patterns: [/\bback[- ]?end\b/i, /\bapi engineer\b/i, /\bserver[- ]?side\b/i],
  },
  {
    family: 'data',
    patterns: [/\bdata engineer\b/i, /\bdata scientist\b/i, /\bml engineer\b/i, /\banalytics\b/i],
  },
  {
    family: 'qa',
    patterns: [/\bqa\b/i, /\bquality assurance\b/i, /\btest automation\b/i, /\bselenium\b/i],
  },
  {
    family: 'security',
    patterns: [
      /\b(application|cloud|cyber|information)\s+security\b/i,
      /\bsecurity\s+(engineer|analyst|architect|lead|specialist|consultant)\b/i,
    ],
  },
  {
    family: 'mobile',
    patterns: [/\bandroid\b/i, /\bios\b/i, /\bmobile\b/i, /\breact native\b/i, /\bflutter\b/i],
  },
  // --- Non-tech role families ---
  // ORDER MATTERS: specific families before generic ones (first-match wins)
  {
    family: 'technical_account_manager',
    patterns: [
      /\btechnical account manager\b/i,
      /\btechnical account lead\b/i,
      /\btechnical customer success\b/i,
      /\btam\b/i,
    ],
  },
  {
    family: 'sales_engineer',
    patterns: [
      /\bsales engineer\b/i,
      /\bpre[- ]?sales engineer\b/i,
      /\bsolutions engineer\b/i,
    ],
  },
  {
    family: 'customer_success',
    patterns: [
      /\bcustomer success\b/i,
      /\bclient success\b/i,
      /\bcsm\b/i,
    ],
  },
  {
    family: 'account_executive',
    patterns: [
      /\baccount executive\b/i,
      /\benterprise sales\b/i,
      /\bsales executive\b/i,
      /\bregional sales\b/i,
    ],
  },
  {
    family: 'business_development',
    patterns: [
      /\bbusiness development\b/i,
      /\bbdr\b/i,
      /\bsdr\b/i,
      /\bsales development\b/i,
    ],
  },
  {
    family: 'account_manager',
    patterns: [
      /\baccount manager\b/i,
      /\bkey account\b/i,
      /\bclient manager\b/i,
      /\brelationship manager\b/i,
    ],
  },
];


export function functionFamily(raw:string):string|null {
  const matches=new Set(ROLE_PATTERNS.filter(p=>p.patterns.some(r=>r.test(raw))).map(p=>p.family));
  return matches.size===1?[...matches][0]:null;
}
export function predicateKey(c:Criterion):string {
  const r=c.requirement;
  let value:unknown=r;
  if(r.kind==='text') value=c.subject==='skill'?atomicSkill(r.value)??normalize(r.value):normalize(r.value);
  if(r.kind==='accepted_titles') value=[...new Set(r.values.map(normalizedTitle))].sort();
  return JSON.stringify([c.subject,value]);
}
export function automaticallyMapped(c:Criterion):boolean {
  if(c.evidenceKinds.every(k=>k==='recruiter_judgement') || ['responsibility','leadership','availability'].includes(c.subject)) return false;
  const r=c.requirement;
  if(c.subject==='experience_years') return r.kind==='minimum_years'||r.kind==='experience_range';
  if(c.subject==='title') return r.kind==='accepted_titles' && r.values.some(v=>normalizedTitle(v)!==null);
  if(c.subject==='work_eligibility') return r.kind==='boolean';
  if(r.kind!=='text') return false;
  if(c.subject==='skill') return atomicSkill(r.value)!==null;
  if(c.subject==='seniority') return seniority(r.value)!==null;
  if(c.subject==='language') return languageRequirement(r.value)!==null;
  if(c.subject==='education_requirement') return educationRequirement(r.value)!==null;
  if(c.subject==='certification') return certificationRequirement(r.value)!==null;
  if(c.subject==='function'||c.subject==='relevant_work') return functionFamily(r.value)!==null;
  if(c.subject==='location') return r.value.split(',').length<=2 && !/[;\n]|\b(?:or|and|remote|hybrid)\b/i.test(r.value);
  // Compound constraints have no typed comparator; require explicit supported atomic evidence.
  return !/[,;\n]|\b(?:and|or|with|at least|required|experience in)\b/i.test(r.value);
}
