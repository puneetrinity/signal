import {createHash} from 'node:crypto';
import {z} from 'zod';
import {normalizeSourcedCandidateLinkedInUrl} from '../sourced-candidate-adapter';
import {byteCompare} from '../rubric/contracts';
import {RC_LIMITS} from './config';

const id=z.string().min(1).max(200);
const identitySchema=z.object({candidateId:id,globalCandidateId:z.string().uuid(),url:z.string().max(2048)}).strict();
export type RcIdentity=z.infer<typeof identitySchema>&{identityHash:string};
export type RcPurchaseMember=RcIdentity&{receiptId:string};
export interface RcPurchaseReceipt {
  id:string;tenantId:string;sourcingRequestId:string;acquisitionGeneration:number;
  slot:'exact'|'spill';status:string;result:unknown;
}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export const rcIdentityHash=(url:string):string=>createHash('sha256').update(normalizeSourcedCandidateLinkedInUrl(url)).digest('hex');

/** Resolve only existing public identities. Neither a source label nor a skill,
 * experience or ranking score establishes paid-lookup membership. SQL repeats
 * receipt membership validation before storing any member or dispatching work.
 */
export function rcPublicIdentities(rows:readonly z.infer<typeof identitySchema>[]):RcIdentity[] {
  const candidates=new Set<string>(),globals=new Set<string>(),identities=new Set<string>();
  return rows.map(raw=>{
    const row=identitySchema.parse(raw),url=normalizeSourcedCandidateLinkedInUrl(row.url);
    const globalCandidateId=row.globalCandidateId.toLowerCase(),identityHash=rcIdentityHash(url);
    if(candidates.has(row.candidateId)||globals.has(globalCandidateId)||identities.has(identityHash))
      throw Error('RC_IDENTITY_CONFLICT');
    candidates.add(row.candidateId);globals.add(globalCandidateId);identities.add(identityHash);
    return {...row,globalCandidateId,url,identityHash};
  }).sort((a,b)=>byteCompare(a.candidateId,b.candidateId));
}

export function deriveRcPurchaseMembers(input:{tenantId:string;requestId:string;generation:number;
  receipts:readonly RcPurchaseReceipt[];identities:readonly RcIdentity[]}):RcPurchaseMember[] {
  if(!/^org_[1-9][0-9]*$/.test(input.tenantId)||!id.safeParse(input.requestId).success||
    !Number.isSafeInteger(input.generation)||input.generation<1||input.receipts.length>2)
    throw Error('RC_RECEIPTS_INVALID');
  const identities=rcPublicIdentities(input.identities.map(({identityHash:ignored,...row})=>{
    if(ignored!==rcIdentityHash(row.url))throw Error('RC_IDENTITY_CONFLICT');return row;
  }));
  const byHash=new Map(identities.map(row=>[row.identityHash,row]));
  const receiptIds=new Set<string>(),slots=new Set<string>(),purchased=new Map<string,string>();
  // Stable slot order makes overlap choose the original exact receipt on replay.
  const receipts=[...input.receipts].sort((a,b)=>byteCompare(a.slot,b.slot));
  for(const receipt of receipts){
    if(!id.safeParse(receipt.id).success||receipt.tenantId!==input.tenantId||receipt.sourcingRequestId!==input.requestId||
      receipt.acquisitionGeneration!==input.generation||receipt.status!=='complete'||
      !['exact','spill'].includes(receipt.slot)||receiptIds.has(receipt.id)||slots.has(receipt.slot))
      throw Error('RC_RECEIPT_BINDING_CONFLICT');
    receiptIds.add(receipt.id);slots.add(receipt.slot);
    const profiles=object(receipt.result).profiles;
    if(!Array.isArray(profiles)||profiles.length>RC_LIMITS.newlyPurchased)throw Error('RC_RECEIPT_PAYLOAD_INVALID');
    for(const profile of profiles){
      const raw=object(object(object(profile).social_handles).professional_network_identifier).profile_url;
      // Unusable public anchors cannot authorize an RC call. Preserve the paid
      // receipt elsewhere; this is not permission to discard purchased profiles.
      if(typeof raw!=='string')continue;
      let hash:string;try{hash=rcIdentityHash(raw);}catch{continue;}
      if(!purchased.has(hash))purchased.set(hash,receipt.id);
    }
  }
  // Count the complete receipt union, not merely the subset that materialized.
  if(purchased.size>RC_LIMITS.newlyPurchased)throw Error('RC_PURCHASE_LIMIT');
  return [...purchased].flatMap(([hash,receiptId])=>{
    const identity=byHash.get(hash);return identity?[{...identity,receiptId}]:[];
  }).sort((a,b)=>byteCompare(a.identityHash,b.identityHash));
}
