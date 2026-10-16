import { z } from 'zod';
import { measureSourcingStage } from '../stage-timings';
import { canonical, rankingContractSchema, type RankingContract } from './contracts';
import { type WithheldProfile, type CanonicalEvidence } from './evidence';
import { retryRankingBusy, RANKING_RETRY } from './contention';
import {runRankingComputation} from './ranking-compute-worker';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const uuid=z.string().uuid();
export const experienceEnvelopeSchema=z.object({
  version:z.literal('recorded-experience-v1'),asOf:z.string().datetime(),
  status:z.enum(['measured','bounded','incomplete','unavailable','uncertain_boundary']),
  lowerDays:z.number().int().nonnegative().nullable(),upperDays:z.number().int().nonnegative().nullable(),
  display:z.string().max(200),reason:z.string().max(100),
}).strict().superRefine((v,ctx)=>{
  if(['measured','bounded'].includes(v.status)?v.lowerDays===null||v.upperDays===null||v.lowerDays>v.upperDays:v.lowerDays!==null||v.upperDays!==null)
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid experience bounds'});
});
const assessmentSchema=z.object({criterionIds:z.array(uuid).min(1).max(12),labels:z.array(z.string().min(1).max(120)).min(1).max(12),subject:z.string().max(40),state:z.enum(['met','not_met','unknown']),
  mapped:z.boolean(),weight:z.union([z.literal(0),z.literal(1),z.literal(3)]),points:z.number().int().min(0).max(3),
  localPoints:z.number().int().min(0).max(3_000_000),refs:z.array(z.string().max(160)).max(1000),
}).strict();
export const rankingReadSchema=z.object({protocolVersion:z.literal(2),flowRunId:uuid,revisionId:uuid,contractHash:hash,outputHash:hash,
  asOf:z.string().datetime(),items:z.array(z.object({candidateId:z.string().min(1).max(200),N:z.number().int().min(0).max(36),
    D:z.number().int().min(0).max(36),L:z.number().int().min(0).max(36_000_000),assessments:z.array(assessmentSchema).max(12),
    eligibility:z.enum(['in_range','wider','unconstrained']),experience:experienceEnvelopeSchema,ordinal:z.number().int().min(1).max(100),
  }).strict()).max(100),
}).strict().superRefine((v,ctx)=>{
  if(new Set(v.items.map(i=>i.candidateId)).size!==v.items.length || v.items.some((i,index)=>(index>0&&i.ordinal<=v.items[index-1].ordinal)||i.N>i.D||i.experience.asOf!==v.asOf||
    i.N!==i.assessments.reduce((s,a)=>s+a.points,0)||i.D!==i.assessments.reduce((s,a)=>s+a.weight,0)||i.L!==i.assessments.reduce((s,a)=>s+a.localPoints,0)||
    new Set(i.assessments.flatMap(a=>a.criterionIds)).size!==i.assessments.flatMap(a=>a.criterionIds).length||
    i.assessments.some(a=>a.labels.length!==a.criterionIds.length||a.points!==(a.state==='met'?a.weight:0)||a.localPoints>a.points*1_000_000||(!a.mapped&&a.weight!==0))))
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid published ranking'});
  if(Buffer.byteLength(canonical(v),'utf8')>2_097_152) ctx.addIssue({code:z.ZodIssueCode.custom,message:'Ranking response too large'});
});
export type RankingRead=z.infer<typeof rankingReadSchema>;
type Query=(sql:string,args:unknown[])=>Promise<Array<Record<string,unknown>>>;
const statements={claim:'SELECT public.signal_ranking_claim($1,$2::uuid,$3::jsonb) result',
  finish:'SELECT public.signal_ranking_finish($1,$2::uuid,$3::uuid,$4::jsonb) result',
  read:'SELECT public.signal_ranking_read($1,$2::uuid,$3::uuid) result'} as const;
export type RankingSourceType='pool'|'pool_enriched'|'discovered';

/** Service-private. Callers must perform scoped identity and privacy admission
 * before claim, and a fresh privacy check before disclosing read results. */
export class RankingRepository {
  constructor(private readonly suppliedQuery?:Query){}
  private async call(operation:keyof typeof statements,args:unknown[]):Promise<unknown> {
    const query=this.suppliedQuery??(async(sql:string,values:unknown[])=>{
      const {prisma}=await import('@/lib/prisma');
      const args=values.map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v);
      if(operation==='read')return prisma.$queryRawUnsafe<Array<Record<string,unknown>>>(sql,...args);
      const {loadCandidatePrivacyConfig}=await import('@/lib/candidate-privacy/config');
      const staleMs=loadCandidatePrivacyConfig().staleMs;
      return prisma.$transaction(async transaction=>{
        // Set before the statement starts: routine SET statement_timeout alone
        // cannot bound its enclosing statement. SQL acquires/checks privacy only
        // after pure canonical preparation. Never take the lock here.
        await transaction.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
        await transaction.$executeRawUnsafe("SET LOCAL lock_timeout='2s'");
        await transaction.$executeRawUnsafe("SELECT set_config('signal.ranking_privacy_max_age_ms',$1,true)",String(staleMs));
        return transaction.$queryRawUnsafe<Array<Record<string,unknown>>>(sql,...args);
      },{maxWait:2000,timeout:35000});
    });
    const run=async()=>{const rows=await query(statements[operation],args);return rows[0]?.result??null;};
    return measureSourcingStage(`ranking_${operation}`,()=>operation==='read'?run():retryRankingBusy(operation,run));
  }
  async read(tenantId:string,flowRunId:string,revisionId:string):Promise<RankingRead> {
    const value=rankingReadSchema.parse(await this.call('read',[tenantId,flowRunId,revisionId]));
    if(value.flowRunId!==flowRunId||value.revisionId!==revisionId)throw Error('RANKING_OUTPUT_CONFLICT');
    return value;
  }
  async resume(input:{tenantId:string;flowRunId:string;contract:RankingContract;executionAttemptId:string;processingLeaseId:string}):Promise<RankingRead|null> {
    const contract=rankingContractSchema.parse(input.contract);
    const raw=await this.call('claim',[input.tenantId,input.flowRunId,{contractHash:contract.contractHash,
      executionAttemptId:input.executionAttemptId,processingLeaseId:input.processingLeaseId,evidence:null}]);
    if(raw===null)return null;
    return this.completeClaim(input.tenantId,input.flowRunId,contract,raw);
  }
  private async completeClaim(tenantId:string,flowRunId:string,contract:RankingContract,raw:unknown,
    expected?:{evidence:readonly CanonicalEvidence[];withheld:readonly WithheldProfile[]}):Promise<RankingRead> {
    const claim=await measureSourcingStage('ranking_compute',()=>runRankingComputation({kind:'claim',input:{contract,claim:raw,expected}}));
    if(claim.kind!=='computed')throw Error('RANKING_COMPUTE_INVALID');
    if(claim.state==='reserved') {
      const receipt=z.object({state:z.literal('ready'),revisionId:uuid,outputHash:hash,replayed:z.boolean()}).strict()
        .parse(await this.call('finish',[tenantId,flowRunId,claim.lease,claim.command]));
      if(receipt.revisionId!==claim.revisionId||receipt.outputHash!==claim.outputHash)throw Error('RANKING_OUTPUT_CONFLICT');
    }
    const read=await this.read(tenantId,flowRunId,claim.revisionId);
    if(read.contractHash!==contract.contractHash||(claim.state==='ready'&&read.outputHash!==claim.outputHash))throw Error('RANKING_OUTPUT_CONFLICT');
    return read;
  }
  async publish(input:{tenantId:string;flowRunId:string;contract:RankingContract;executionAttemptId:string;processingLeaseId:string;
    evidence:readonly CanonicalEvidence[];withheld?:readonly WithheldProfile[];sourceTypes:ReadonlyMap<string,RankingSourceType>}):Promise<RankingRead> {
    const prepared=await measureSourcingStage('ranking_prepare',()=>runRankingComputation({kind:'prepare',input:{...input,sourceTypes:[...input.sourceTypes]}}));
    if(prepared.kind!=='prepared')throw Error('RANKING_COMPUTE_INVALID');
    const {contract}=prepared;let {evidence,withheld,command}=prepared;
    let raw:unknown;
    for(let reprepare=0;;reprepare++){
      raw=await this.call('claim',[input.tenantId,input.flowRunId,command]);
      if(!raw||typeof raw!=='object'||(raw as {state?:unknown}).state!=='reprepare')break;
      z.object({state:z.literal('reprepare'),phase:z.literal('claim')}).strict().parse(raw);
      if(reprepare+1>=RANKING_RETRY.maxReprepare)throw Error('RANKING_PRIVACY_REPREPARE_EXHAUSTED');
      const {filterCandidateIdsBeforeLimit}=await import('@/lib/candidate-privacy/repository');
      const allowed=new Set(await filterCandidateIdsBeforeLimit(input.tenantId,[...evidence,...withheld].map(e=>e.candidateId)));
      // Keep each validated text paired with the exact object it represents.
      command={...command,evidenceCanonical:command.evidenceCanonical.filter((_,i)=>allowed.has(evidence[i].candidateId)),
        withheldCanonical:command.withheldCanonical.filter((_,i)=>allowed.has(withheld[i].candidateId))};
      evidence=evidence.filter(e=>allowed.has(e.candidateId));withheld=withheld.filter(e=>allowed.has(e.candidateId));
    }
    return this.completeClaim(input.tenantId,input.flowRunId,contract,raw,{evidence,withheld});
  }
}
