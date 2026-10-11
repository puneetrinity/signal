import { createHash } from 'node:crypto';
import { z } from 'zod';
import { rankingContractSchema } from './rubric/contracts';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const text = z.string().min(1).max(160);
export const governedContextSchema = z.object({
  title: text, location: text, jdDigest: z.string().min(1).max(65536),
  skills: z.array(text).max(12), goodToHaveSkills: z.array(text).max(12),
  experienceYears: z.number().min(0).max(80).optional(),
}).strict();
export const governedArtifactSchema = z.object({
  compilerVersion: z.literal('1'), digestVersion: z.literal(3),
  jobContext: governedContextSchema,
  criterionMap: z.array(z.object({ criterionId: uuid, use: z.enum(['retrieval','assessment']), field: z.string().max(160).nullable() }).strict()).min(1).max(12),
  briefVersionId: uuid, materialHash: hash, sourceHash: hash, digestBasisHash: hash, queryHash: hash, previewQueryHash: hash,
}).strict();
const legacySourceSchema = z.object({
  protocolVersion: z.literal(1), flowRunId: uuid, organizationRef: z.string().regex(/^[1-9][0-9]*$/),
  externalJobId: z.string().regex(/^vanta:jobs:[1-9][0-9]*$/),
  briefVersionId: uuid, materialHash: hash, artifactHash: hash, compilerVersion: z.literal('1'),
  queryArtifact: governedArtifactSchema, callbackUrl: z.string().url().max(2048),
}).strict();
export const governedSourceSchema = z.discriminatedUnion('protocolVersion', [
  legacySourceSchema,
  legacySourceSchema.extend({ protocolVersion: z.literal(2), rankingContract: rankingContractSchema }).strict(),
]).superRefine((value, ctx) => {
  if (value.queryArtifact.briefVersionId !== value.briefVersionId || value.queryArtifact.materialHash !== value.materialHash ||
      value.queryArtifact.queryHash !== value.artifactHash || artifactHash(value.queryArtifact) !== value.artifactHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Artifact binding mismatch' });
  }
  if (value.protocolVersion === 2 && (value.rankingContract.briefVersionId !== value.briefVersionId ||
      value.rankingContract.materialHash !== value.materialHash)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Ranking binding mismatch' });
  }
});
export type GovernedSource = z.infer<typeof governedSourceSchema>;
export const governedPreviewSchema = z.object({ protocolVersion: z.literal(1), previewId: uuid, artifactHash: hash, queryArtifact: governedArtifactSchema }).strict()
  .refine(v => v.artifactHash === v.queryArtifact.queryHash && artifactHash(v.queryArtifact) === v.artifactHash, 'Artifact binding mismatch');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`;
  const text = JSON.stringify(value); if (text === undefined) throw Error('GOVERNED_NON_JSON'); return text;
}
export function governedHash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function artifactHash(value: z.infer<typeof governedArtifactSchema>): string {
  return governedHash({ compilerVersion: value.compilerVersion, digestVersion: value.digestVersion,
    jobContext: value.jobContext, criterionMap: value.criterionMap, previewQueryHash: value.previewQueryHash });
}
export function governedEnabled(env: Readonly<Record<string,string|undefined>> = process.env): boolean {
  const raw = env.FLOW_SOURCING_V1_ENABLED;
  if (raw !== undefined && raw !== 'true' && raw !== 'false') throw Error('GOVERNED_CONFIGURATION_INVALID');
  return raw === 'true';
}
export function parseGovernedSource(raw: unknown, expected: { externalJobId: string; callbackUrl: string; production: boolean }): GovernedSource {
  if (Buffer.byteLength(canonical(raw), 'utf8') > 131072) throw Error('GOVERNED_BODY_TOO_LARGE');
  const command = governedSourceSchema.parse(raw);
  if (command.externalJobId !== expected.externalJobId || command.callbackUrl !== expected.callbackUrl) throw Error('GOVERNED_TARGET_MISMATCH');
  const callback = new URL(command.callbackUrl);
  if (callback.username || callback.password || callback.hash ||
      (expected.production ? callback.protocol !== 'https:' : !['https:','http:'].includes(callback.protocol))) throw Error('GOVERNED_TARGET_MISMATCH');
  return command;
}

export async function readSourcingBody(request:Request):Promise<unknown> {
  if(!request.body)throw new SyntaxError('GOVERNED_INVALID_COMMAND');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;if(bytes>131072)throw Error('GOVERNED_BODY_TOO_LARGE');chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}

/** Missing, fractional, negative and nonnumeric totals are unknown, never zero. */
export function previewObservation(body: unknown, creditsHeader: string | null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('GOVERNED_PREVIEW_INVALID');
  const raw = (body as Record<string,unknown>).total_count;
  const count = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  const credits = creditsHeader !== null && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(creditsHeader) ? Number(creditsHeader) : NaN;
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isFinite(credits) || credits < 0 || credits > 0.03) throw Error('GOVERNED_PREVIEW_EVIDENCE_UNAVAILABLE');
  const relation = (body as Record<string,unknown>).total_count_relation;
  if (relation !== undefined && !['eq','gte','approximate'].includes(String(relation))) throw Error('GOVERNED_PREVIEW_INVALID');
  return { count, countRelation: relation === undefined ? 'approximate' : relation as 'eq'|'gte'|'approximate', creditsUsed: credits };
}
