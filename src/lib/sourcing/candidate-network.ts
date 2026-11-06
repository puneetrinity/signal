/** Native, candidate-confirmed publications. Never a synthetic provider profile. */
import { z } from 'zod';
import { rankingHash } from './rubric/contracts';
import type {Prisma} from '@prisma/client';
import {candidatePublicIdentityKeys} from './public-memory-identity';

const uuid = z.string().uuid();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const clean = (limit: number) => z.string().max(limit).refine(value =>
  !/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/iu.test(value) && !/\+?\d[\d ().-]{7,}\d/u.test(value),
  'Network contact value refused');
const date = z.object({value:z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/),
  precision:z.enum(['year','month','day'])}).strict().nullable();
const dates={start:date,end:date,current:z.boolean()};
export const networkFactsSchema=z.object({
  displayName:clean(200),headline:clean(300),
  currentLocation:z.object({city:clean(200),countryCode:z.string().regex(/^[A-Z]{2}$/),displayCountry:clean(200)}).strict().nullable(),
  skills:z.array(clean(100)).max(200),
  employment:z.array(z.object({employer:clean(200),title:clean(200),...dates}).strict()).max(200),
  education:z.array(z.object({institution:clean(200),qualification:clean(300),...dates}).strict()).max(50),
}).strict();
export const networkAuthoritySchema=z.object({subjectId:uuid,publicationId:uuid,
  profileVersion:revision,preferenceVersion:revision,consentRevision:revision,contentHash:hash}).strict();
export const networkHitSchema=networkAuthoritySchema.extend({
  kind:z.literal('candidate_network'),identity:z.string(),globalCandidateId:uuid,encoderVersion:z.literal(1),
  observedAt:z.string().datetime({offset:true}),facts:networkFactsSchema,similarity:z.number().finite().min(-1).max(1),
}).strict().superRefine((hit,ctx)=>{
  if(hit.identity!==`network:${hit.subjectId}` || rankingHash(hit.facts)!==hit.contentHash)
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Network publication binding mismatch'});
});
export type NetworkHit=z.infer<typeof networkHitSchema>;
// Ephemeral service evidence: never serialized into cards, immutable snapshots,
// ranking facts or contact authorities. Only revalidation may populate it.
const resultKeys=new WeakMap<NetworkHit,string>();

/** Reuse existing public LinkedIn keys, without merging any records. Prefer the
 * existing provider result: a self-asserted URL cannot replace somebody else's
 * provider card. Ambiguous many-to-one claims are left separate. Private
 * applicant rows must never be supplied as providers. */
export function deduplicateNetworkAgainstProviders(hits:NetworkHit[],providers:Array<{linkedinUrl?:string|null}>):NetworkHit[] {
  const providerCounts=new Map<string,number>(),networkCounts=new Map<string,number>();
  for(const provider of providers)for(const key of candidatePublicIdentityKeys(provider).filter(key=>key.startsWith('li:')))
    providerCounts.set(key,(providerCounts.get(key)??0)+1);
  for(const hit of hits){const key=resultKeys.get(hit);if(key)networkCounts.set(key,(networkCounts.get(key)??0)+1);}
  return hits.filter(hit=>{const key=resultKeys.get(hit);
    return !key||providerCounts.get(key)!==1||networkCounts.get(key)!==1;});
}
export function networkSourcingEnabled(env:Record<string,string|undefined>=process.env):boolean {
  const value=env.CANDIDATE_NETWORK_SOURCING_ENABLED;
  if(value!==undefined&&value!=='true'&&value!=='false')throw Error('NETWORK_CONFIGURATION_INVALID');
  return value==='true';
}

/** Same immutable subject/generation only. A claimed LinkedIn URL or email is
 * deliberately not a dedup key. Contradictory authority is refused, not merged. */
export function deduplicateNetworkHits(values:unknown[]):NetworkHit[] {
  const seen=new Map<string,NetworkHit>();
  const globalOwners=new Map<string,string>();
  for(const value of values){
    const hit=networkHitSchema.parse(value),prior=seen.get(hit.identity);
    const owner=globalOwners.get(hit.globalCandidateId);
    if(owner&&owner!==hit.subjectId)throw Error('NETWORK_IDENTITY_CONFLICT');
    if(prior&&rankingHash({...prior,similarity:0})!==rankingHash({...hit,similarity:0}))
      throw Error('NETWORK_PUBLICATION_CONFLICT');
    globalOwners.set(hit.globalCandidateId,hit.subjectId);
    if(!prior||hit.similarity>prior.similarity)seen.set(hit.identity,hit);
  }
  return [...seen.values()];
}

export function revalidatedNetworkHits(hits:NetworkHit[],raw:unknown):NetworkHit[] {
  const response=z.object({schemaVersion:z.literal(1),publications:z.array(networkAuthoritySchema).max(500),
    resultKeys:z.array(networkAuthoritySchema.extend({linkedinUrl:z.string().max(2048)
      .regex(/^https:\/\/linkedin\.com\/in\/[A-Za-z0-9_%~-]+$/)}).strict()).max(500).optional()}).strict().parse(raw);
  const requested=new Map(hits.map(hit=>[hit.publicationId,hit]));
  const allowed=new Set<string>();
  for(const authority of response.publications){
    const hit=requested.get(authority.publicationId);
    if(!hit||allowed.has(authority.publicationId)||rankingHash(networkAuthoritySchema.parse({
      subjectId:hit.subjectId,publicationId:hit.publicationId,profileVersion:hit.profileVersion,
      preferenceVersion:hit.preferenceVersion,consentRevision:hit.consentRevision,contentHash:hit.contentHash,
    }))!==rankingHash(authority))throw Error('NETWORK_AUTHORITY_CONFLICT');
    allowed.add(authority.publicationId);
  }
  const keyed=new Set<string>();
  for(const item of response.resultKeys??[]){
    const {linkedinUrl,...authority}=item;
    const hit=requested.get(item.publicationId);
    if(!hit||!allowed.has(item.publicationId)||keyed.has(item.publicationId)
      ||rankingHash(networkAuthoritySchema.parse(authority))!==rankingHash(networkAuthoritySchema.parse({
        subjectId:hit.subjectId,publicationId:hit.publicationId,profileVersion:hit.profileVersion,
        preferenceVersion:hit.preferenceVersion,consentRevision:hit.consentRevision,contentHash:hit.contentHash,
      })))throw Error('NETWORK_AUTHORITY_CONFLICT');
    keyed.add(item.publicationId);
  }
  return hits.filter(hit=>allowed.has(hit.publicationId)).map(hit=>{
    // New object prevents an old key surviving a later receipt with no key.
    const validated={...hit};
    const item=response.resultKeys?.find(item=>item.publicationId===hit.publicationId);
    const key=item&&candidatePublicIdentityKeys({linkedinUrl:item.linkedinUrl}).find(key=>key.startsWith('li:'));
    if(key)resultKeys.set(validated,key);
    return validated;
  });
}

/** Only after service publication validation and the existing privacy proof.
 * SQL owns tenant identity uniqueness and immutable publication snapshots. */
export async function materializeNetworkPublication(db:Pick<Prisma.TransactionClient,'$queryRaw'>,
  tenantId:string,raw:NetworkHit):Promise<string> {
  if(!/^org_[1-9][0-9]*$/.test(tenantId))throw Error('NETWORK_TENANT_INVALID');
  const hit=networkHitSchema.parse(raw);
  const rows=await db.$queryRaw<Array<{id:string}>>`
    SELECT public.signal_network_candidate_materialize(${tenantId},${JSON.stringify(hit)}::jsonb) AS id`;
  if(rows.length!==1||typeof rows[0]?.id!=='string'||!rows[0].id)throw Error('NETWORK_MATERIALIZATION_INVALID');
  return rows[0].id;
}
