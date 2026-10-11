import { z } from 'zod';
import { rankingHash } from '../rubric/contracts';
import { RC_LIMITS } from './config';

export const rcHashSchema=z.string().regex(/^[a-f0-9]{64}$/);
export const rcTimeSchema=z.string().datetime({offset:true}).max(40)
  .refine(v=>(v.match(/\.(\d+)/)?.[1]?.length??0)<=6,'Timestamp precision exceeds database precision');
/** Preserve provider/database microseconds; Date alone silently loses the last three. */
export function rcTimestampMicros(value:string):bigint {
  rcTimeSchema.parse(value);
  const fraction=(value.match(/\.(\d+)/)?.[1]??'').padEnd(6,'0');
  return BigInt(Date.parse(value))*BigInt(1000)+BigInt(fraction.slice(3));
}
function formatMicros(micros:bigint):string {
  let milliseconds=micros/BigInt(1000),remainder=micros%BigInt(1000);
  if(remainder<BigInt(0)){milliseconds-=BigInt(1);remainder+=BigInt(1000);}
  const tail=String(remainder).padStart(3,'0');
  return new Date(Number(milliseconds)).toISOString().replace(/Z$/,tail+'Z');
}
export const rcCanonicalTime=(value:string):string=>formatMicros(rcTimestampMicros(value));
export const rcValidUntil=(upstreamAt:string):string=>formatMicros(
  rcTimestampMicros(upstreamAt)+BigInt(RC_LIMITS.horizonDays)*BigInt(86_400_000_000));
export const rcSkillsSchema=z.array(z.string().min(1).max(RC_LIMITS.skillCharacters)
  .refine(v=>v.trim().length>0 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v),'Invalid skill label')).max(RC_LIMITS.maxSkills);
export const observationBodySchema=z.object({
  version:z.literal(1), outcome:z.enum(['success','no_skills','not_found','unusable_age']),
  identityHash:rcHashSchema, skills:rcSkillsSchema, upstreamAt:rcTimeSchema.nullable(),
  observedAt:rcTimeSchema, validUntil:rcTimeSchema.nullable(),
  timestampSource:z.literal('check_last_update'),
}).strict();
export const observationSchema=observationBodySchema.extend({contentHash:rcHashSchema}).superRefine((v,ctx)=>{
  const {contentHash,...body}=v;
  if([v.upstreamAt,v.validUntil,v.observedAt].some(t=>t!==null&&!rcTimeSchema.safeParse(t).success))return;
  if([v.upstreamAt,v.validUntil,v.observedAt].some(t=>t!==null&&rcCanonicalTime(t)!==t)) {
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Observation times must be canonical UTC microseconds'});
  }
  const upstream=v.upstreamAt===null?null:rcTimestampMicros(v.upstreamAt);
  const valid=v.validUntil===null?null:rcTimestampMicros(v.validUntil);
  const observed=rcTimestampMicros(v.observedAt);
  if(Buffer.byteLength(JSON.stringify(v),'utf8')>65_536 || contentHash!==rankingHash(body) ||
    (v.outcome==='success'
      ? !v.skills.length || upstream===null || valid===null || upstream>observed ||
        valid!==upstream+BigInt(RC_LIMITS.horizonDays)*BigInt(86_400_000_000) || valid<observed
      : v.skills.length!==0 || valid!==null)) {
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid RC observation'});
  }
});
export type SkillObservation=z.infer<typeof observationSchema>;
export function createObservation(body:z.infer<typeof observationBodySchema>):SkillObservation {
  const parsed=observationBodySchema.parse(body);
  const canonical={...parsed,observedAt:rcCanonicalTime(parsed.observedAt),
    upstreamAt:parsed.upstreamAt===null?null:rcCanonicalTime(parsed.upstreamAt),
    validUntil:parsed.validUntil===null?null:rcCanonicalTime(parsed.validUntil)};
  return observationSchema.parse({...canonical,contentHash:rankingHash(canonical)});
}
export const cacheReadSchema=z.object({version:z.literal(1),candidateIds:z.array(z.string().uuid()).max(100)})
  .strict().refine(v=>new Set(v.candidateIds.map(id=>id.toLowerCase())).size===v.candidateIds.length,'Duplicate candidate identity');
export const cacheFinishSchema=z.object({
  version:z.literal(1),globalCandidateId:z.string().uuid(),originRun:z.string().uuid(),
  originAttempt:z.string().uuid(),observation:observationSchema,
}).strict().refine(v=>Buffer.byteLength(JSON.stringify(v),'utf8')<=65_536,'Request too large');
export const rcProgressSchema=z.object({
  version:z.literal(1),state:z.enum(['enriching_skills','partial','complete','stalled','closed_unrecoverable']),
  processed:z.number().int().min(0).max(300),total:z.number().int().min(0).max(300),
  updatedAt:rcTimeSchema,notificationDelivered:z.boolean(),
  safeReason:z.enum(['working','skills_unavailable','rate_unavailable','deadline','recovery_pending','closed']),
}).strict().refine(v=>v.processed<=v.total,'Invalid progress');
export type RcProgress=z.infer<typeof rcProgressSchema>;

export const rcOutcomeSchema=z.object({
  kind:z.enum(['eligible','success','no_skills','not_found','unusable_age','cached','restricted','failed','uncertain']),
  upstreamAt:rcTimeSchema.nullable(),retryableFree:z.boolean(),
  safeCode:z.enum(['ok','unauthorized','rate_limited','restricted','transport','invalid_response','identity_mismatch','credits_breach','deadline']),
  quota:z.object({minuteLimit:z.number().int().min(1).max(1_000_000).nullable(),
    minuteLeft:z.number().int().nonnegative().max(1_000_000).nullable(),
    resetAt:rcTimeSchema.nullable(),retryAfterMs:z.number().int().min(0).max(86_400_000).nullable(),
    dailyLeft:z.number().int().nonnegative().safe().nullable()}).strict(),
}).strict();
export const rcFinishBodySchema=z.object({version:z.literal(1),outcome:rcOutcomeSchema,
  observation:observationSchema.nullable(),observedCredits:z.number().int().nonnegative().safe().nullable(),
}).strict().superRefine((v,ctx)=>{
  const kind=v.outcome.kind,obs=v.observation;
  if((['success','no_skills','not_found','unusable_age','cached'].includes(kind))!==(obs!==null)||
    (obs!==null&&kind!=='cached'&&kind!==obs.outcome)||
    (kind==='eligible'&&v.outcome.upstreamAt===null)||
    (v.outcome.retryableFree&&(kind!=='failed'||v.observedCredits!==0)))
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid outcome transition'});
});
export const rcFinishSchema=rcFinishBodySchema.innerType().extend({outcomeHash:rcHashSchema}).superRefine((v,ctx)=>{
  const {outcomeHash,...body}=v;
  if(!rcFinishBodySchema.safeParse(body).success||rankingHash(body)!==outcomeHash||Buffer.byteLength(JSON.stringify(v))>65_536)
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid outcome commitment'});
});
export type RcFinish=z.infer<typeof rcFinishSchema>;
export function createRcFinish(raw:z.input<typeof rcFinishBodySchema>):RcFinish {
  const body=rcFinishBodySchema.parse(raw);return rcFinishSchema.parse({...body,outcomeHash:rankingHash(body)});
}
