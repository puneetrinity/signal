import { z } from 'zod';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .refine(v => v !== '00000000-0000-0000-0000-000000000000');
const integerId = z.number().int().min(1).max(2_147_483_647);
const requestId = z.string().min(1).max(200).refine(v => !!v.trim() && !/[\x00-\x1f\x7f]/.test(v));
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const privateResumeTenant = z.string().regex(/^org_[1-9][0-9]{0,9}$/)
  .refine(v => Number(v.slice(4)) <= 2_147_483_647);
export const privateResumeIdentity = z.object({
  candidateId: uuid, referenceId: uuid, applicationId: integerId, applicationJobId: integerId,
  resumeVersionId: uuid, sourceId: uuid, generationId: uuid, sourceHash: hash,
}).strict();
export type PrivateResumeIdentity = z.infer<typeof privateResumeIdentity>;
export const publicApplicantRequest=z.object({version:z.literal(1),requestId,
 publicIds:z.array(uuid).min(1).max(100)}).strict().refine(v=>new Set(v.publicIds).size===v.publicIds.length);
export const publicApplicantResponse=z.object({version:z.literal(1),requestId,
 results:z.array(z.object({publicId:uuid,isApplicant:z.boolean()}).strict()).min(1).max(100)}).strict();
export const privateResumeSearch = z.object({
  version: z.literal(1), requestId, externalJobId: integerId, flowRunId: uuid, artifactHash: hash,
  query: z.string().min(1).max(2000).refine(v => !!v.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)),
  limit: z.number().int().min(1).max(100),
}).strict();
export const privateResumeRevalidation = z.object({version: z.literal(1), requestId,
  externalJobId: integerId, items: z.array(privateResumeIdentity).min(1).max(100),
}).strict().refine(v => new Set(v.items.map(x => JSON.stringify(x))).size === v.items.length);
const name = (max: number) => z.string().min(1).max(max).refine(v => !!v.trim()
  && !/[\x00-\x1f\x7f]|@|https?:\/\/|www\.|gs:\/\/|(?:\d[ .()+-]*){9,}/i.test(v));
const facts = z.object({
  version: z.literal(1), kind: z.literal('candidate_provided'), scope: privateResumeTenant,
  sourceVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  observedAt: z.string().datetime({offset:true}), skills: z.array(name(120)).max(100),
  employment: z.array(z.object({title:name(200).nullable().optional(),employmentType:name(100).nullable().optional(),
    start:z.string().regex(/^(19|20|21)\d{2}(-\d{2}(-\d{2})?)?$/).nullable().optional(),
    end:z.string().regex(/^(19|20|21)\d{2}(-\d{2}(-\d{2})?)?$/).nullable().optional(),
    ongoing:z.boolean(),
  }).strict()).max(20).optional(),
  location: z.object({city: name(200).nullable(), country: name(200).nullable()}).strict(),
  currentTitle: name(500).nullable(), seniority: name(100).nullable(),
  primaryTitles: z.array(name(500)).max(3), domains: z.array(name(500)).max(10),
  functions: z.array(name(500)).max(10), certifications: z.array(name(500)).max(10),
  industries: z.array(name(500)).max(10),
}).strict();
export const privateResumeHit = z.object({identity: privateResumeIdentity,
  linkedPublicId: uuid.nullable(), distance: z.number().finite(), evidence: facts}).strict();
export type PrivateResumeHit = z.infer<typeof privateResumeHit>;
export const privateResumeSearchResponse = z.object({version:z.literal(1), requestId,
  results:z.array(privateResumeHit).max(100), retrievalLimit:z.literal(100), saturated:z.boolean(),
  counts:z.object({returned:z.number().int().min(0).max(100),
    withheldInvalidEvidence:z.number().int().min(0).max(100)}).strict(),
}).strict();
export const privateResumeRevalidationResponse = z.object({version:z.literal(1), requestId,
  results:z.array(z.object({identity:privateResumeIdentity,
    decision:z.enum(['allow','same_job','privacy_restricted','source_changed','not_found','unavailable']),
  }).strict()).min(1).max(100),
}).strict();
