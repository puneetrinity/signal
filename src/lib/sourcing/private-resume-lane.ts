import type {GovernedSource} from './governed-contracts';
import {readPrivateResumes,revalidatePrivateResumes,checkPublicApplicants} from './private-resume-client';
import {checkFlowResumeEligibility,eligibilityItems} from './private-resume-flow-client';
import type {PrivateResumeHit,PrivateResumeIdentity} from './private-resume-contracts';

type RankedCommand=Extract<GovernedSource,{protocolVersion:2}>;
export interface ResumeLaneContext {tenantId:string;requestId:string;executionAttemptId:string;command:RankedCommand}
const defaults={read:readPrivateResumes,revalidate:revalidatePrivateResumes,flow:checkFlowResumeEligibility};
export type ResumeLaneDependencies=typeof defaults;

function requireContext(input:ResumeLaneContext) {
 const {command}=input;
 if(command.rankingContract.payload.schemaVersion!==4 || input.tenantId!==`org_${command.organizationRef}`)
  throw Error('PRIVATE_RETRIEVAL_AUTHORITY');
 if(!/^vanta:jobs:[1-9][0-9]*$/.test(command.externalJobId))throw Error('PRIVATE_RETRIEVAL_AUTHORITY');
 const id=Number(command.externalJobId.slice('vanta:jobs:'.length));
 if(!Number.isSafeInteger(id)||id<1||id>2147483647)throw Error('PRIVATE_RETRIEVAL_AUTHORITY');
 return id;
}

/** No fallback on unavailable authority; never turn a failed check into an empty lane. */
export async function revalidateResumeLane(input:ResumeLaneContext,hits:readonly PrivateResumeHit[],
 deadlineAt:number,dependencies:ResumeLaneDependencies=defaults,revisionId=input.command.briefVersionId) {
 const identities=await revalidateResumeIdentities(input,hits.map(hit=>hit.identity),deadlineAt,dependencies,revisionId);
 const keys=new Set(identities.map(identity=>identity.candidateId));
 return hits.filter(hit=>keys.has(hit.identity.candidateId));
}

export async function revalidateResumeIdentities(input:ResumeLaneContext,identities:readonly PrivateResumeIdentity[],
 deadlineAt:number,dependencies:ResumeLaneDependencies=defaults,revisionId=input.command.briefVersionId) {
 const externalJobId=requireContext(input);
 if(Date.now()>=deadlineAt)throw Error('PRIVATE_RETRIEVAL_UNAVAILABLE');
 if(identities.length===0)return [];
 const memory=await dependencies.revalidate({version:1,requestId:input.requestId,externalJobId,
  items:[...identities]},input.tenantId,{deadlineAt});
 if(memory.results.some(item=>item.decision==='unavailable'))throw Error('PRIVATE_RETRIEVAL_UNAVAILABLE');
 const allowed=identities.filter((_,index)=>memory.results[index]?.decision==='allow');
 if(allowed.length===0)return [];
 const flow=await dependencies.flow(input.tenantId,input.executionAttemptId,{
  version:1,flowRunId:input.command.flowRunId,revisionId,requestId:input.requestId,
  externalJobId,items:eligibilityItems(allowed),
 },{baseUrl:input.command.callbackUrl,deadlineAt});
 if(Date.now()>=deadlineAt)throw Error('PRIVATE_RETRIEVAL_UNAVAILABLE');
 if(flow.results.some(item=>item.decision==='unavailable'))throw Error('PRIVATE_RETRIEVAL_UNAVAILABLE');
 return allowed.filter((_,index)=>flow.results[index]?.decision==='allow');
}

export async function readResumeLane(input:ResumeLaneContext,deadlineAt:number,dependencies:ResumeLaneDependencies=defaults) {
 const externalJobId=requireContext(input),context=input.command.queryArtifact.jobContext;
 if(Date.now()>=deadlineAt)throw Error('PRIVATE_RETRIEVAL_UNAVAILABLE');
 const query=[context.title,context.location,...context.skills,...context.goodToHaveSkills].join('\n').slice(0,2000);
 const result=await dependencies.read({version:1,requestId:input.requestId,externalJobId,
  flowRunId:input.command.flowRunId,artifactHash:input.command.artifactHash,query,limit:100},input.tenantId,{deadlineAt});
 return revalidateResumeLane(input,result.results,deadlineAt,dependencies);
}

/** Bound public-ID membership checks, independent of semantic resume recall. */
export async function publicApplicantIds(input:ResumeLaneContext,ids:readonly string[],deadlineAt:number,
 check=checkPublicApplicants):Promise<Set<string>> {
 requireContext(input);const unique=[...new Set(ids)];
 if(unique.length>2000)throw Error('PRIVATE_RETRIEVAL_AUTHORITY');
 const applicants=new Set<string>();
 for(let offset=0;offset<unique.length;offset+=100) {
  if(Date.now()>=deadlineAt)throw Error('PRIVATE_RETRIEVAL_UNAVAILABLE');
  const result=await check({version:1,requestId:input.requestId,publicIds:unique.slice(offset,offset+100)},input.tenantId,{deadlineAt});
  for(const item of result.results)if(item.isApplicant)applicants.add(item.publicId);
 }
 return applicants;
}
