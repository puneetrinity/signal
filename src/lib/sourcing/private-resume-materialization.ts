import type { Prisma } from '@prisma/client';
import { privateResumeHit, privateResumeTenant, type PrivateResumeHit } from './private-resume-contracts';

/** Caller must hold current Memory + Flow eligibility; no provider identity is created. */
export async function materializePrivateResume(db:Pick<Prisma.TransactionClient,'$queryRaw'>,
  tenantId:string,raw:PrivateResumeHit):Promise<string> {
  privateResumeTenant.parse(tenantId);
  const hit=privateResumeHit.parse(raw);
  if(hit.evidence.scope!==tenantId)throw Error('PRIVATE_CANDIDATE_TENANT');
  const payload={identity:hit.identity,linkedPublicId:hit.linkedPublicId,observedAt:hit.evidence.observedAt};
  const rows=await db.$queryRaw<Array<{id:string}>>`
    SELECT public.signal_private_candidate_materialize(${tenantId},${JSON.stringify(payload)}::jsonb) AS id
  `;
  if(!Array.isArray(rows)||rows.length!==1||!rows[0]||typeof rows[0].id!=='string'||!rows[0].id.trim())throw Error('PRIVATE_CANDIDATE_UNAVAILABLE');
  return rows[0].id;
}
