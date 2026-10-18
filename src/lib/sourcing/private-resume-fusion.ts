import { byteCompare } from './rubric/contracts';
import { privateResumeHit, privateResumeTenant, type PrivateResumeHit } from './private-resume-contracts';

export interface LegacyPrivateEntry<T> { candidateId:string; globalCandidateId:string|null; value:T }
export type FusedPrivateEntry<T> =
  | {kind:'managed'; key:string; resume:PrivateResumeHit}
  | {kind:'legacy'; key:string; legacy:T};

/** Equal-weight RRF(k=60), exact integer fractions; never fuzzy name/email joins. */
export function fusePrivateResumes<T>(tenantId:string,managed:readonly PrivateResumeHit[],
  legacy:readonly LegacyPrivateEntry<T>[],limit:number):FusedPrivateEntry<T>[] {
  privateResumeTenant.parse(tenantId);
  if(!Number.isInteger(limit)||limit<1||limit>300||managed.length>100||legacy.length>300)
    throw Error('PRIVATE_RETRIEVAL_BOUNDS');
  const entries=new Map<string,{entry:FusedPrivateEntry<T>; numerator:bigint; denominator:bigint}>();
  const managedKeys=new Map<string,string>();
  for(const raw of managed) {
    const hit=privateResumeHit.parse(raw);
    if(hit.evidence.scope!==tenantId)throw Error('PRIVATE_RETRIEVAL_TENANT');
    const key=`${tenantId}:candidate:${hit.identity.candidateId}`;
    if(managedKeys.has(key))throw Error('PRIVATE_RETRIEVAL_DUPLICATE');
    managedKeys.set(key,key);
    if(hit.linkedPublicId) {
      const link=`${tenantId}:global:${hit.linkedPublicId}`;
      if(managedKeys.has(link))throw Error('PRIVATE_RETRIEVAL_DUPLICATE');
      managedKeys.set(link,key);
    }
  }
  const add=(key:string,entry:FusedPrivateEntry<T>,position:number)=>{
    const d=BigInt(60+position),old=entries.get(key);
    if(old){old.numerator=old.numerator*d+old.denominator;old.denominator*=d;}
    else entries.set(key,{entry,numerator:BigInt(1),denominator:d});
  };
  managed.forEach((hit,index)=>{
    const key=`${tenantId}:candidate:${hit.identity.candidateId}`;
    add(key,{kind:'managed',key,resume:hit},index+1);
  });
  const seen=new Set<string>();
  legacy.forEach((item,index)=>{
    if(!item.candidateId.trim())throw Error('PRIVATE_RETRIEVAL_IDENTITY');
    const link=item.globalCandidateId?`${tenantId}:global:${item.globalCandidateId}`:null;
    const own=`${tenantId}:candidate:${item.candidateId}`;
    const key=managedKeys.get(own)??(link?managedKeys.get(link):undefined)??link??own;
    if(seen.has(key))throw Error('PRIVATE_RETRIEVAL_DUPLICATE');
    seen.add(key);add(key,{kind:'legacy',key,legacy:item.value},index+1);
  });
  return [...entries.values()].sort((a,b)=>{
    const diff=b.numerator*a.denominator-a.numerator*b.denominator;
    return diff<BigInt(0)?-1:diff>BigInt(0)?1:byteCompare(a.entry.key,b.entry.key);
  }).slice(0,limit).map(x=>x.entry);
}
