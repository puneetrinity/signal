import type { z } from 'zod';
import { evidenceBytes, EVIDENCE_MAX_BYTES } from './rubric/evidence';
import { signPrivateResumeSourcingJWT } from './activegraph-auth';
import { privateResumeSearch, privateResumeTenant, privateResumeRevalidation,
  privateResumeSearchResponse, privateResumeRevalidationResponse } from './private-resume-contracts';
import {publicApplicantRequest,publicApplicantResponse} from './private-resume-contracts';

export class PrivateResumeReadError extends Error {
  constructor(readonly code: 'invalid_contract'|'unavailable'|'unauthorized'|'deadline') {
    super(`PRIVATE_RESUME_${code.toUpperCase()}`);
  }
}
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
interface Options { deadlineAt: number; fetch?: typeof fetch; baseUrl?: string }

async function post(path: 'search'|'revalidate'|'public-applicants', tenant: string,
  body: { requestId: string }, cap: number, options: Options): Promise<unknown> {
  if (!privateResumeTenant.safeParse(tenant).success) throw new PrivateResumeReadError('invalid_contract');
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > cap) throw new PrivateResumeReadError('invalid_contract');
  const remaining = Math.min(9_000, options.deadlineAt-Date.now());
  if (!Number.isFinite(remaining) || remaining <= 0) throw new PrivateResumeReadError('deadline');
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      reject(new PrivateResumeReadError('deadline'));
    }, remaining);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const token = await signPrivateResumeSourcingJWT(tenant, body.requestId);
      if (controller.signal.aborted) throw new PrivateResumeReadError('deadline');
      const base = options.baseUrl ?? process.env.ACTIVEGRAPH_URL;
      if (!base) throw new PrivateResumeReadError('unavailable');
      const response = await (options.fetch ?? fetch)(`${base.replace(/\/$/,'')}/organization-candidates/sourcing/${path}`, {
        method:'POST', headers:{authorization:`Bearer ${token}`, 'content-type':'application/json'},
        body:encoded, signal:controller.signal, redirect:'error',
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new PrivateResumeReadError(response.status===401||response.status===403?'unauthorized':'unavailable');
      }
      if (!response.body) throw new PrivateResumeReadError('invalid_contract');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new PrivateResumeReadError('invalid_contract');
        chunks.push(chunk.value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
      catch { throw new PrivateResumeReadError('invalid_contract'); }
    })()]);
  } catch (error) {
    if (error instanceof PrivateResumeReadError) throw error;
    throw new PrivateResumeReadError('unavailable');
  } finally {
    clearTimeout(timer!);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}

export async function readPrivateResumes(raw: z.input<typeof privateResumeSearch>, tenant: string, options: Options) {
  const request = privateResumeSearch.safeParse(raw);
  if (!request.success) throw new PrivateResumeReadError('invalid_contract');
  const parsed = privateResumeSearchResponse.safeParse(await post('search', tenant, request.data, 16*1024, options));
  if (!parsed.success) throw new PrivateResumeReadError('invalid_contract');
  const value = parsed.data;
  const keys = value.results.map(v => v.linkedPublicId ? `public:${v.linkedPublicId}` : `private:${v.identity.candidateId}`);
  if (value.requestId !== request.data.requestId || value.results.length > request.data.limit
    || value.counts.returned !== value.results.length
    || value.counts.returned+value.counts.withheldInvalidEvidence > request.data.limit
    || new Set(keys).size !== keys.length
    || value.results.some(v => v.evidence.scope !== tenant || v.identity.applicationJobId===request.data.externalJobId
      || evidenceBytes(v.evidence)>EVIDENCE_MAX_BYTES)) {
    throw new PrivateResumeReadError('invalid_contract');
  }
  return value;
}

export async function revalidatePrivateResumes(raw: z.input<typeof privateResumeRevalidation>, tenant: string, options: Options) {
  const request = privateResumeRevalidation.safeParse(raw);
  if (!request.success) throw new PrivateResumeReadError('invalid_contract');
  const parsed = privateResumeRevalidationResponse.safeParse(await post('revalidate', tenant, request.data, 64*1024, options));
  if (!parsed.success || parsed.data.requestId !== request.data.requestId
    || parsed.data.results.length !== request.data.items.length
    || parsed.data.results.some((v,i) => JSON.stringify(v.identity) !== JSON.stringify(request.data.items[i]))) {
    throw new PrivateResumeReadError('invalid_contract');
  }
  return parsed.data;
}

export async function checkPublicApplicants(raw:z.input<typeof publicApplicantRequest>,tenant:string,options:Options) {
 const request=publicApplicantRequest.safeParse(raw);
 if(!request.success)throw new PrivateResumeReadError('invalid_contract');
 const response=publicApplicantResponse.safeParse(await post('public-applicants',tenant,request.data,16*1024,options));
 if(!response.success||response.data.requestId!==request.data.requestId||response.data.results.length!==request.data.publicIds.length
  ||response.data.results.some((item,index)=>item.publicId!==request.data.publicIds[index]))throw new PrivateResumeReadError('invalid_contract');
 return response.data;
}
