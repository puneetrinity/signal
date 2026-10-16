import type {PrismaClient} from '@prisma/client';
import type {SourcingTimings} from './stage-timings';

// Parameterized, atomic merge: unrelated diagnostics survive. All four identity
// predicates are intentional; a released or superseded lease cannot write.
export const STAGE_TIMINGS_SQL=`UPDATE public.job_sourcing_requests
SET diagnostics=COALESCE(diagnostics,'{}'::jsonb) || jsonb_build_object('workerStageTimingV1',$1::jsonb)
WHERE id=$2 AND "tenantId"=$3 AND acquisition_generation=$4
  AND execution_attempt_id=$5 AND processing_lease_id=$6`;

export async function persistSourcingTimings(database:Pick<PrismaClient,'$transaction'>,
  identity:{requestId:string;tenantId:string;generation:number;executionAttemptId:string;processingLeaseId:string},
  timings:ReturnType<SourcingTimings['snapshot']>):Promise<boolean> {
  const changed=await database.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='1000ms'");
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
    return tx.$executeRawUnsafe(STAGE_TIMINGS_SQL,JSON.stringify(timings),identity.requestId,identity.tenantId,
      identity.generation,identity.executionAttemptId,identity.processingLeaseId);
  },{maxWait:1000,timeout:2000});
  return changed===1;
}
