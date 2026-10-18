import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import {randomUUID} from 'node:crypto';
import {checkPublicApplicants} from './private-resume-client';
import {z} from 'zod';

/** Check current stored identity, including an applicant's verified public link. */
export async function requirePublicContactCandidate(
  tenantId: string, candidateId: string,
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma,
  options: { allowUnlinked?: boolean } = {},
): Promise<void> {
  const rows = await db.$queryRaw<Array<{allowed:boolean}>>`
    SELECT public.signal_private_contact_allowed(${tenantId},${candidateId}) AS allowed
  `;
  if (rows.length !== 1 || rows[0].allowed !== true) {
    throw new Error('candidate_contact_ineligible');
  }
  if(/^org_[1-9][0-9]*$/.test(tenantId)) {
    const links=await db.$queryRaw<Array<{publicId:string}>>`
      SELECT "globalCandidateId" AS "publicId" FROM public.candidate_global_links
      WHERE "tenantId"=${tenantId} AND "candidateId"=${candidateId} LIMIT 2
    `;
    // Admission may wait for graph sync. Paid dispatch keeps the strict default:
    // no verified link means applicant membership cannot yet be checked.
    if(links.length===0 && options.allowUnlinked===true)return;
    if(links.length!==1||!z.string().uuid().safeParse(links[0]?.publicId).success)throw Error('candidate_contact_ineligible');
    const result=await checkPublicApplicants({version:1,requestId:randomUUID(),publicIds:[links[0].publicId]},
      tenantId,{deadlineAt:Date.now()+5000});
    if(result.results[0].isApplicant)throw Error('candidate_contact_ineligible');
  }
}
