import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {createRankingContract,rankingHash} from '../src/lib/sourcing/rubric/contracts';
import {adaptProfile,evidenceSchema} from '../src/lib/sourcing/rubric/evidence';
import {rankEvidence,eligible,type RankedEvidence} from '../src/lib/sourcing/rubric/score';
import {automaticallyMapped} from '../src/lib/sourcing/rubric/taxonomy';

// Offline only: this module imports no database, Memory or provider client.
const inputSchema=z.object({schemaVersion:z.literal(1),synthetic:z.boolean(),asOf:z.string().datetime(),jobs:z.array(z.object({
 jobId:z.string().min(1),poolBasis:z.enum(['full-synthetic','full-pool','served-top100-only']),payload:z.unknown(),
 candidates:z.array(z.object({candidateId:z.string(),organizationRef:z.string(),profile:z.unknown()}).strict()).max(2000).optional(),
 evidence:z.array(evidenceSchema).max(2000).optional(),expectedSelectedIds:z.array(z.string()).optional(),
 baselineIds:z.array(z.string()).optional(),unavailableReason:z.string().optional(),
}).strict()).max(100)}).strict();
const key=(i:RankedEvidence)=>JSON.stringify([i.eligibility,i.N,i.L]);
function groups(items:RankedEvidence[],keyOf:(i:RankedEvidence)=>string){
 const bins=new Map<string,number[]>();items.forEach((item,index)=>bins.set(keyOf(item),[...(bins.get(keyOf(item))??[]),index+1]));
 return [...bins.values()];
}
function overlap(a:string[],b:string[],k:number){
  const before=new Set(b.slice(0,k)),after=a.slice(0,k);
  const afterSet=new Set(after);
  return {retained:after.filter(id=>before.has(id)).length,baselineCount:before.size,newCount:after.length,
   entrants:after.filter(id=>!before.has(id)),exits:[...before].filter(id=>!afterSet.has(id)),
   displacement:after.filter(id=>before.has(id)).map(candidateId=>({candidateId,before:b.indexOf(candidateId)+1,after:a.indexOf(candidateId)+1}))};
}
function spearman(x:number[],y:number[]):number|null{
 if(x.length<3)return null;
 const ranks=(a:number[])=>a.map(v=>{const lower=a.filter(n=>n<v).length,equal=a.filter(n=>n===v).length;return lower+(equal+1)/2;});
 const a=ranks(x),b=ranks(y),mean=(x.length+1)/2;
 const numerator=a.reduce((sum,v,i)=>sum+(v-mean)*(b[i]-mean),0);
 const denominator=Math.sqrt(a.reduce((sum,v)=>sum+(v-mean)**2,0)*b.reduce((sum,v)=>sum+(v-mean)**2,0));
 return denominator===0?null:numerator/denominator;
}
export function evaluateOffline(raw:unknown){
 const input=inputSchema.parse(raw);
 return {synthetic:input.synthetic,asOf:input.asOf,activationApproved:false,reports:input.jobs.map(job=>{
  if(job.unavailableReason)return {jobId:job.jobId,unavailableReason:job.unavailableReason};
  if(Boolean(job.candidates)===Boolean(job.evidence))throw Error('Exactly one evidence source required');
  const contract=createRankingContract('20000000-0000-4000-8000-000000000099',rankingHash(job.payload),job.payload);
  const pool=job.evidence??job.candidates!.map(c=>adaptProfile({...c,profile:c.profile,sourceVersion:'offline-explicit-input-v1',observedAt:input.asOf}));
  const ranked=rankEvidence(contract,pool,input.asOf),selected=ranked.selected,allEligible=ranked.items.filter(i=>eligible(i.eligibility));
  const ids=selected.map(i=>i.candidateId);
  if(job.expectedSelectedIds&&JSON.stringify(ids)!==JSON.stringify(job.expectedSelectedIds))throw Error('Synthetic selection mismatch: '+job.jobId);
  const primary=groups(selected,i=>String(i.N)),final=groups(selected,key),fullFinal=groups(allEligible,key);
  const largestPrimary=Math.max(0,...primary.map(g=>g.length)),largestFinal=Math.max(0,...final.map(g=>g.length));
  const scoredCriteria=contract.payload.criteria.filter(c=>c.class==='must_have'||c.class==='preferred');
  const mapped=scoredCriteria.filter(automaticallyMapped).length;
  const mappedShare=scoredCriteria.length?mapped/scoredCriteria.length:0;
  const primaryShare=selected.length?largestPrimary/selected.length:null;
  const cutoff=(position:number)=>job.poolBasis==='served-top100-only'&&position===100?null:
    fullFinal.filter(g=>g[0]<=position&&g[g.length-1]>position).map(g=>({from:g[0],to:g[g.length-1],size:g.length}));
  const misses=(k:number)=>selected.slice(0,k).filter(i=>i.assessments.some(a=>a.state==='not_met'&&a.criterionIds.some(id=>
    contract.payload.criteria.some(c=>c.id===id&&c.class==='must_have')))).length;
  const richness=(lane:string)=>{
   const candidates=pool.filter(e=>lane==='all'||e.presentationSource===lane);
   const scores=candidates.map(e=>ranked.items.find(i=>i.candidateId===e.candidateId)!.N);
   const populated=candidates.map(e=>new Set([...e.facts.map(f=>f.field),...(e.employment.length?['employment']:[])]).size);
   const rho=spearman(scores,populated);
   return {count:candidates.length,rho,requiresReview:rho===null?null:Math.abs(rho)>0.30};
  };
  return {jobId:job.jobId,poolBasis:job.poolBasis,contractHash:contract.contractHash,inputCount:pool.length,
   delivered:selected.length,shortfall:ranked.shortfall,mappedShare,largestPrimaryGroup:largestPrimary,primaryShare,
   largestFinalGroup:largestFinal,finalTiedShare:selected.length?final.filter(g=>g.length>1).reduce((sum,g)=>sum+g.length,0)/selected.length:null,
   groups:Object.fromEntries(['in_range','wider','unconstrained'].map(group=>[group,selected.filter(i=>i.eligibility===group).length])),
   top20Boundary:cutoff(20),top100Boundary:cutoff(100),provenMustHaveMisses:{top20:misses(20),top100:misses(100)},
   prelaunchReview:{mappedBelowHalf:mappedShare<0.5,primaryGroupOverHalf:primaryShare===null?null:primaryShare>0.5,empty:selected.length===0},
   movement:job.baselineIds?{top20:overlap(ids,job.baselineIds,20),top100:overlap(ids,job.baselineIds,100)}:null,
   retrievalCoverage:job.baselineIds&&job.poolBasis!=='served-top100-only'?Object.fromEntries([20,100].map(k=>{
    const baseline=job.baselineIds!.slice(0,k),retrieved=baseline.filter(id=>pool.some(e=>e.candidateId===id)).length;
    return ['top'+k,{baselineCount:baseline.length,retrieved,share:baseline.length?retrieved/baseline.length:null}];
   })):null,
   selectedIds:ids,
   criterionCoverage:contract.payload.criteria.map(c=>({criterionId:c.id,subject:c.subject,mapped:automaticallyMapped(c),
    states:Object.fromEntries(['met','not_met','unknown'].map(state=>[state,ranked.items.filter(i=>i.assessments.some(a=>a.criterionIds.includes(c.id)&&a.state===state)).length]))})),
   evidenceCoverageByLane:Object.fromEntries(['pool','pool_enriched','discovered'].map(lane=>{
    const evidence=pool.filter(e=>e.presentationSource===lane),items=ranked.items.filter(i=>evidence.some(e=>e.candidateId===i.candidateId));
    return [lane,{count:evidence.length,withStructuredSkills:evidence.filter(e=>e.facts.some(f=>f.field==='skill')).length,
     withEmployment:evidence.filter(e=>e.employment.length>0).length,unknownAssessments:items.reduce((sum,i)=>sum+i.assessments.filter(a=>a.state==='unknown').length,0)}];
   })),
   evidenceRichness:Object.fromEntries(['all','pool','pool_enriched','discovered'].map(lane=>[lane,richness(lane)])),
   unknownCoverage:ranked.items.reduce((sum,i)=>sum+i.assessments.filter(a=>a.state==='unknown').length,0),
   top20:selected.slice(0,20).map((i,index)=>({candidateId:i.candidateId,rank:index+1,previousRank:job.baselineIds?.indexOf(i.candidateId)===-1?null:
     job.baselineIds?job.baselineIds.indexOf(i.candidateId)+1:null,eligibility:i.eligibility,experience:i.experience,N:i.N,D:i.D,L:i.L,
     finalTieSize:fullFinal.find(g=>g.includes(index+1))?.length??1,assessments:i.assessments})),
   limits:['Offline result is not activation approval.','Synthetic skills do not establish RC coverage.',
     'Top-list overlap is not relevance recall; human usefulness review remains required.',
     ...(job.poolBasis==='served-top100-only'?['Full-pool recall and position-100 exclusions cannot be inferred.']:[])],
  };
 })};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length&&!(args.length===2&&args[0]==='--input'))throw Error('Use --input LOCAL_OFFLINE_JSON, or the default synthetic fixture');
 const path=resolve(args[1]??'research/fixtures/rubric-ranking-v1.json');
 const text=readFileSync(path,'utf8');if(Buffer.byteLength(text)>64*1024*1024)throw Error('Offline fixture too large');
 console.log(JSON.stringify(evaluateOffline(JSON.parse(text)),null,2));
}
