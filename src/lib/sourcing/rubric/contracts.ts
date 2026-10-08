import { createHash } from 'node:crypto';
import { z } from 'zod';
export const BRIEF_VERSION = 2;
// Wire copy of Flow's closed brief contract. Cross-repository tests must assert parity.
export const criterionClasses = ['must_have', 'preferred', 'disqualifier', 'evidence_required'] as const;
export const criterionSubjects = ['title', 'seniority', 'experience_years', 'skill', 'domain', 'function', 'location', 'certification', 'language', 'education_requirement', 'relevant_work', 'responsibility', 'leadership', 'availability', 'work_eligibility'] as const;
export const reasonCodes = ['clarification_typo', 'hm_client_feedback', 'role_scope_changed', 'seniority_changed', 'skills_changed', 'location_changed', 'compensation_changed', 'sourcing_quality_volume', 'market_availability', 'application_interview_evidence', 'policy_compliance', 'other'] as const;
export const timingCodes = ['before_sourcing', 'after_results', 'after_review', 'after_interview', 'after_close_reopen', 'unknown'] as const;
export const requesterKinds = ['recruiter', 'hiring_manager'] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = (max: number) => z.string().trim().min(1).max(max);
export function hasBannedCriterionText(text:string,subject?:string):boolean {
  // Only typed experience criteria may describe an approved maximum. Age stays banned.
  if (subject === 'experience_years') text = text.replace(/\bmaximum\s+experience\b/gi, 'experience');
  return /^\s*(?:age|male|female)\s*$/i.test(text)
    || /\b(?:overqualified|under\s*\d{2}|maximum\s+(?:age|experience)|age\s*(?:limit|range|under|below|between|above|over|[<>=]|\d+)|aged\s+\d+|young|youthful|gender|(?:male|female)\s+(?:only|candidates?|applicants?|workers?|engineers?|preferred|required)|(?:only|prefer|preferred|require|required)\s+(?:male|female)|ethnicity|race(?!\s+conditions?\b)|religion|caste|marital|(?:un)?married|pregnan\w*|disabil\w*|nationality|national\s+origin|native(?:[ -]|\s+(?:\w+\s+){0,2})speaker|mother\s+tongue|recent\s+grad\w*|graduation\s+year|career\s+gaps?|elite\s+(?:school|college)|college\s+name|do.not.poach)\b/i.test(text)
    || (subject!=='work_eligibility' && /\b(?:citizenship|citizens?)\b/i.test(text));
}
const criterion = z.object({
  id: z.string().uuid(),
  label: boundedText(120),
  class: z.enum(criterionClasses),
  subject: z.enum(criterionSubjects),
  requirement: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), value: boundedText(500) }).strict(),
    z.object({ kind: z.literal('minimum_years'), minimum: z.number().finite().min(0).max(80) }).strict(),
    z.object({ kind: z.literal('experience_range'), minimum: z.number().finite().min(0).max(80), maximum: z.number().finite().min(0).max(80) }).strict(),
    z.object({ kind: z.literal('accepted_titles'), values: z.array(boundedText(120)).min(1).max(20) }).strict(),
    z.object({ kind: z.literal('boolean'), value: z.enum(['yes', 'no', 'unknown']) }).strict(),
  ]),
  evidenceKinds: z.array(z.enum(['candidate_provided', 'verified_document', 'profile_evidence', 'recruiter_judgement'])).min(1).max(4),
  use: z.enum(['assessment', 'retrieval', 'both']),
  provenance: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('jd'), sourceHash: hash, start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal('recruiter_edit') }).strict(),
  ]),
  note: z.string().max(300).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.subject === 'experience_years') !== ['minimum_years','experience_range'].includes(value.requirement.kind)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Experience needs a minimum or approved range' });
  }
  if (value.requirement.kind === 'experience_range' && value.requirement.minimum > value.requirement.maximum) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Maximum must not be below minimum' });
  }
  if (value.requirement.kind === 'accepted_titles' && (value.subject !== 'title' ||
      new Set(value.requirement.values.map(v => v.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' '))).size !== value.requirement.values.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Accepted titles must be unique and belong to title criterion' });
  }
  if(value.subject==='experience_years' && value.class==='disqualifier') {
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Experience cannot be a disqualifier'});
  }
  if (['responsibility', 'leadership', 'availability'].includes(value.subject) &&
      (value.use !== 'assessment' || value.evidenceKinds.some(k => k !== 'recruiter_judgement'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Recruiter-judged criterion is assessment only' });
  }
  if (value.subject === 'work_eligibility' && value.evidenceKinds.some(k => !['candidate_provided', 'verified_document'].includes(k))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Work eligibility needs candidate-provided or verified evidence' });
  }
  const texts = [value.label, value.requirement.kind === 'text' ? value.requirement.value : '', value.note??'',
    ...(value.requirement.kind === 'accepted_titles' ? value.requirement.values : [])];
  if (texts.some(text=>hasBannedCriterionText(text,value.subject))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsupported criterion' });
  }
});
export const briefPayloadSchema = z.object({
  schemaVersion: z.union([z.literal(1),z.literal(2)]), compilerVersion: z.union([z.literal(1),z.literal(2)]), taxonomyVersion: z.union([z.literal(1),z.literal(2)]),
  criteria: z.array(criterion).min(1).max(12),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.criteria.map(c => c.id)).size !== value.criteria.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate criterion ID' });
  if (value.schemaVersion !== value.compilerVersion || value.schemaVersion !== value.taxonomyVersion) ctx.addIssue({code:z.ZodIssueCode.custom,message:'Mixed brief versions'});
  for (const c of value.criteria) {
    if (value.schemaVersion === 1 && ['experience_range','accepted_titles'].includes(c.requirement.kind)) ctx.addIssue({code:z.ZodIssueCode.custom,message:'Historical brief shape cannot change'});
    if (value.schemaVersion === 2 && c.subject === 'title' && c.requirement.kind !== 'accepted_titles') ctx.addIssue({code:z.ZodIssueCode.custom,message:'Title needs approved alternatives'});
    if (value.schemaVersion === 2 && c.subject === 'experience_years' && !c.evidenceKinds.includes('profile_evidence')) ctx.addIssue({code:z.ZodIssueCode.custom,message:'Experience calculation requires profile employment evidence'});
    if (value.schemaVersion === 2 && ['experience_years','title'].includes(c.subject) && c.use !== 'assessment') ctx.addIssue({code:z.ZodIssueCode.custom,message:'Scoring titles and experience are assessed after retrieval'});
  }
  if (value.schemaVersion === 2) for (const subject of ['title','experience_years']) {
    if (value.criteria.filter(c=>c.subject===subject).length>1) ctx.addIssue({code:z.ZodIssueCode.custom,message:'Duplicate title or experience criterion'});
  }
});
export type BriefPayload = z.infer<typeof briefPayloadSchema>;
/** Historical v1 remains readable; only an explicit new v2 save may be approved for ranking. */
export const currentBriefPayloadSchema = briefPayloadSchema.refine(v=>v.schemaVersion===BRIEF_VERSION, 'Review and save the updated brief');

export const POLICY_VERSION = 'rubric-range-v1' as const;
export const TAXONOMY_VERSION = 'rubric-taxonomy-v3' as const;
export const ADAPTER_VERSION = 'rubric-evidence-v1' as const;
export const LOCAL_MATCH_VERSION = 'rubric-local-match-v3' as const;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort(byteCompare).map(k => JSON.stringify(k) + ':' + canonical((value as Record<string,unknown>)[k])).join(',') + '}';
  if(typeof value==='number') {
    if(!Number.isFinite(value))throw Error('RUBRIC_NON_JSON');
    const raw=String(value),parts=/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(raw);
    if(parts) {
      const integral=parts[2]!,digits=integral+(parts[3]??''),point=integral.length+Number(parts[4]);
      return parts[1]+(point<=0?'0.'+'0'.repeat(-point)+digits:
        point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));
    }
  }
  const result = JSON.stringify(value); if (result === undefined) throw Error('RUBRIC_NON_JSON'); return result;
}
export const byteCompare=(a:string,b:string):number=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'));
export function rankingHash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function rankingProjection(payload: BriefPayload): string {
  // Notes, source spans, JD and labels cannot affect matching. Criterion IDs remain bound in payload.
  return canonical(payload.criteria.map(c => ({subject:c.subject,class:c.class,requirement:c.requirement,evidenceKinds:c.evidenceKinds})).sort((a,b) => {
    return byteCompare(canonical(a),canonical(b));
  }));
}
const rankingContractBody = z.object({
  schemaVersion:z.literal(1), briefVersionId:z.string().uuid(), materialHash:hash,
  policyVersion:z.literal(POLICY_VERSION), taxonomyVersion:z.literal(TAXONOMY_VERSION),
  adapterVersion:z.literal(ADAPTER_VERSION), localMatchVersion:z.literal(LOCAL_MATCH_VERSION),
  payload:currentBriefPayloadSchema, projectionText:z.string().max(20000), projectionHash:hash,
}).strict();
export const rankingContractSchema = rankingContractBody.extend({contractHash:hash}).superRefine((v,ctx)=>{
  const {contractHash,...body}=v;
  if (rankingHash(body)!==contractHash || v.projectionText!==rankingProjection(v.payload) ||
      rankingHash(v.projectionText)!==v.projectionHash || Buffer.byteLength(canonical(v),'utf8')>32768) {
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Ranking contract binding mismatch'});
  }
});
export type RankingContract = z.infer<typeof rankingContractSchema>;
export type Criterion = BriefPayload['criteria'][number];
export function createRankingContract(briefVersionId:string, materialHash:string, rawPayload:unknown):RankingContract {
  const payload=currentBriefPayloadSchema.parse(rawPayload), projectionText=rankingProjection(payload);
  const body={schemaVersion:1 as const,briefVersionId,materialHash,policyVersion:POLICY_VERSION,taxonomyVersion:TAXONOMY_VERSION,
    adapterVersion:ADAPTER_VERSION,localMatchVersion:LOCAL_MATCH_VERSION,payload,projectionText,projectionHash:rankingHash(projectionText)};
  return rankingContractSchema.parse({...body,contractHash:rankingHash(body)});
}
