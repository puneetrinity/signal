/**
 * Sourcing Queue (BullMQ)
 *
 * Dedicated queue for v3 sourcing jobs. Mirrors enrichment queue pattern.
 */

import { randomUUID } from 'crypto';
import { Worker, Job, DelayedError } from 'bullmq';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { toJsonValue } from '@/lib/prisma/json';
import { deliverCallback } from '../callback';
import { runSourcingOrchestrator } from '../orchestrator';
import type { SourcingJobData, SourcingJobResult, SourcingCallbackPayload } from '../types';
import type { SourcingJobContextInput } from '../jd-digest';
import {buildJobRequirements} from '../jd-digest';
import {resolveTrack} from '../track-resolver';
import {canResumeGovernedPurchase} from '../request-retry';
import { requireHealthyCandidatePrivacyContext } from '@/lib/candidate-privacy/repository';
import {GovernedRepository,runGovernedPreview,flushGovernedEvidence} from '../governed-authority';
import { RankingRepository } from '../rubric/repository';
import type {GovernedSource} from '../governed-contracts';
import {z} from 'zod';

const log = createLogger('SourcingQueue');

export * from './producer';
import { getRedisConnection, getSourcingQueue, SOURCING_QUEUE_NAME } from './producer';

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

export async function processSourcingJob(
  job: Job<SourcingJobData, SourcingJobResult>,
  token?: string,
): Promise<SourcingJobResult> {
  if(job.data.kind==='preview') {
    const data=z.object({kind:z.literal('preview'),tenantId:z.string().min(1).max(160),previewId:z.string().uuid()}).strict().parse(job.data);
    const start=Date.now();
    // Preview work never reaches orchestration, candidate materialization or
    // outreach. Its only durable result is count evidence in its own table.
    if(start-job.timestamp>15*60_000) return {requestId:data.previewId,status:'failed',candidateCount:0,durationMs:0,error:'PREVIEW_QUEUE_EXPIRED'};
    const result=await runGovernedPreview(new GovernedRepository(),getRedisConnection(),data.tenantId,data.previewId);
    if(result.state==='waiting') {
      await job.moveToDelayed(Date.now()+Math.max(1000,result.retryAfterMs),token);
      throw new DelayedError();
    }
    return {requestId:data.previewId,status:result.state==='unknown'?'failed':'complete',candidateCount:0,durationMs:Date.now()-start};
  }
  // Legacy producers omit kind. Preserve their pre-claim privacy refusal;
  // governed admissions explicitly enqueue kind:'source'. This discriminator
  // changes failure handling only, never database execution authority.
  const legacyPrivacyChecked=job.data.kind!=='source';
  if(legacyPrivacyChecked)await requireHealthyCandidatePrivacyContext();
  const { requestId, tenantId, externalJobId, callbackUrl } = job.data;
  const startTime = Date.now();
  const processingLeaseId = randomUUID();
  const routeFence = {
    acquisitionGeneration: job.data.acquisitionGeneration,
    executionAttemptId: job.data.executionAttemptId,
  };

  log.info({ jobId: job.id, requestId, tenantId, externalJobId }, 'Processing sourcing job');

  const executionFence = { ...routeFence, processingLeaseId };
  let governed=false;
  let ownsLease=false;
  let rcClaimInFlight=false;
  let rcClaimInput:{tenantId:string;requestId:string;generation:number;executionAttemptId:string;processingLeaseId:string;resumeToken:string|null}|null=null;
  let rcIdentity:{tenantId:string;flowRunId:string;executionAttemptId:string;processingLeaseId:string}|null=null;
  let rcHeartbeat:ReturnType<typeof setInterval>|undefined;
  try {
    // Claim only the execution attempt that the source route enqueued. A stale
    // worker from an older refresh/retry must not mutate the current request.
    let rcClaim:'unmanaged'|'claimed'|'rejected'='unmanaged';
    if(process.env.RC_SKILLS_ENABLED==='true' && job.data.kind==='source'){
      const {RcRepository}=await import('../rc-skills/repository');
      const resumeToken=job.name?.startsWith('rc-resume-')?job.name.slice('rc-resume-'.length):null;
      rcClaimInput={tenantId,requestId,generation:routeFence.acquisitionGeneration!,
        executionAttemptId:routeFence.executionAttemptId!,processingLeaseId,resumeToken};
      rcClaimInFlight=true;
      rcClaim=(await new RcRepository().claimExecution(rcClaimInput)).state;
      rcClaimInFlight=false;
    }
    const claimed = rcClaim!=='unmanaged'?{count:rcClaim==='claimed'?1:0}:await prisma.jobSourcingRequest.updateMany({
      where: {
        id: requestId,
        tenantId,
        acquisitionGeneration: routeFence.acquisitionGeneration,
        executionAttemptId: routeFence.executionAttemptId,
        status: { in: ['queued', 'processing'] },
      },
      data: { status: 'processing', processingLeaseId },
    });
    if (claimed.count !== 1) {
      log.info(
        { jobId: job.id, requestId, routeFence },
        'Ignoring superseded sourcing execution',
      );
      return {
        requestId,
        status: 'failed',
        candidateCount: 0,
        durationMs: Date.now() - startTime,
        error: 'Sourcing execution was superseded',
      };
    }
    ownsLease=true;
    const jobRequest = await prisma.jobSourcingRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const jobContext = jobRequest.jobContext as unknown as SourcingJobContextInput;
    const governedCommand=await new GovernedRepository().call<GovernedSource>('execution',[tenantId,requestId,jobContext,executionFence]);
    governed=Boolean(governedCommand);
    // Acquire only execution metadata before this gate. No candidate reads,
    // provider calls or orchestration may run without healthy privacy state.
    // A failed gate must use the same bounded retry/terminal callback path as
    // any other failure, including after an already-paid acquisition.
    if(!legacyPrivacyChecked)await requireHealthyCandidatePrivacyContext();
    if(governedCommand?.protocolVersion===2) {
      const resumed=await new RankingRepository().resume({tenantId,flowRunId:governedCommand.flowRunId,
        contract:governedCommand.rankingContract,executionAttemptId:job.data.executionAttemptId!,processingLeaseId});
      if(resumed) {
        // Recovery starts from the sealed input, before pool retrieval, model
        // resolution or any acquisition code can run again.
        await deliverCallback(requestId,tenantId,callbackUrl,{version:1,requestId,externalJobId,
          acquisitionGeneration:executionFence.acquisitionGeneration,executionAttemptId:executionFence.executionAttemptId,
          status:'complete',candidateCount:resumed.items.length},true,executionFence);
        return {requestId,status:'complete',candidateCount:resumed.items.length,durationMs:Date.now()-startTime};
      }
      if(process.env.RC_SKILLS_ENABLED==='true' && governedCommand.rankingContract.payload.schemaVersion===3){
        const {RcRepository}=await import('../rc-skills/repository');
        const rc=new RcRepository(),identity={tenantId,flowRunId:governedCommand.flowRunId,
          executionAttemptId:job.data.executionAttemptId!,processingLeaseId};
        const admission=await rc.admit(identity,requestId,executionFence.acquisitionGeneration!,governedCommand.rankingContract.contractHash);
        if(admission.enabled){
          rcIdentity=identity;
          let beating=false;
          rcHeartbeat=setInterval(()=>{
            if(beating)return;beating=true;
            void rc.heartbeat(identity).catch(()=>log.warn({requestId},'RC heartbeat requires recovery')).finally(()=>{beating=false;});
          },15000);rcHeartbeat.unref();
          const snapshot=await rc.read(tenantId,governedCommand.flowRunId);
          if(snapshot?.baseline){
            const {completeRcRanking}=await import('../rc-skills/worker');
            const ranked=await completeRcRanking(identity,governedCommand.rankingContract);
            await deliverCallback(requestId,tenantId,callbackUrl,{version:1,requestId,externalJobId,
              acquisitionGeneration:executionFence.acquisitionGeneration,executionAttemptId:executionFence.executionAttemptId,
              status:'complete',candidateCount:ranked.items.length},true,executionFence);
            return {requestId,status:'complete',candidateCount:ranked.items.length,durationMs:Date.now()-startTime};
          }
        }
      }
    }
    const resolvedTrack=job.data.resolvedTrack??(governed?await resolveTrack(jobContext,buildJobRequirements(jobContext)):undefined);
    if(governed && resolvedTrack) {
      const observed=jobRequest.diagnostics && typeof jobRequest.diagnostics==='object' && !Array.isArray(jobRequest.diagnostics)?jobRequest.diagnostics:{};
      const saved=await prisma.jobSourcingRequest.updateMany({where:{id:requestId,tenantId,...executionFence,status:'processing'},
        data:{diagnostics:toJsonValue({...observed,trackDecision:resolvedTrack})}});
      if(saved.count!==1)throw Error('GOVERNED_EXECUTION_STALE');
    }
    const orchestratorResult = await runSourcingOrchestrator(
      requestId,
      tenantId,
      jobContext,
      resolvedTrack,
      job.data.acquisitionGeneration,
      job.data.executionAttemptId,
      processingLeaseId,
    );
    const candidateCount = orchestratorResult.candidateCount;

    if (orchestratorResult.ranking) {
      // The ranking routine publishes items, completes the request and queues
      // its callback in ONE transaction. Never run the legacy completion writer
      // over that sealed publication, even when this worker is retried.
      const ranking = orchestratorResult.ranking;
      const sealed = await new RankingRepository().read(tenantId, ranking.flowRunId, ranking.revisionId);
      const complete = await prisma.jobSourcingRequest.count({where:{id:requestId,tenantId,
        ...executionFence,status:'complete',resultCount:sealed.items.length}});
      if (!governed || complete !== 1 || sealed.outputHash !== ranking.outputHash || candidateCount !== sealed.items.length)
        throw Error('RANKING_OUTPUT_CONFLICT');
      await deliverCallback(requestId,tenantId,callbackUrl,{version:1,requestId,externalJobId,
        acquisitionGeneration:executionFence.acquisitionGeneration,executionAttemptId:executionFence.executionAttemptId,
        status:'complete',candidateCount},true,executionFence);
      return {requestId,status:'complete',candidateCount,durationMs:Date.now()-startTime};
    }

    if(governedCommand?.protocolVersion===2)throw Error('RANKING_PUBLICATION_REQUIRED');
    // Transition processing → complete
    const durationMs = Date.now() - startTime;
    const completed = await prisma.jobSourcingRequest.updateMany({
      where: {
        id: requestId,
        tenantId,
        acquisitionGeneration: executionFence.acquisitionGeneration,
        executionAttemptId: executionFence.executionAttemptId,
        processingLeaseId: executionFence.processingLeaseId,
        status: 'processing',
      },
      data: {
        status: 'complete',
        callbackStatus: 'pending',
        callbackSentAt: null,
        completedAt: new Date(),
        resultCount: candidateCount,
        qualityGateTriggered: orchestratorResult.qualityGateTriggered,
        queriesExecuted: orchestratorResult.queriesExecuted,
        diagnostics: toJsonValue({
          // Preserve trackDecision written at enqueue time
          ...(resolvedTrack ? { trackDecision: resolvedTrack } : {}),
          avgFitTopK: orchestratorResult.avgFitTopK,
          countAboveThreshold: orchestratorResult.countAboveThreshold,
          strictTopKCount: orchestratorResult.strictTopKCount,
          strictCoverageRate: orchestratorResult.strictCoverageRate,
          discoveryReason: orchestratorResult.discoveryReason,
          discoverySkippedReason: orchestratorResult.discoverySkippedReason,
          discoveryTelemetry: orchestratorResult.discoveryTelemetry,
          discoveryShortfallRate: orchestratorResult.discoveryShortfallRate,
          discoveredCount: orchestratorResult.discoveredCount,
          poolCount: orchestratorResult.poolCount,
          snapshotReuseCount: orchestratorResult.snapshotReuseCount,
          snapshotStaleServedCount: orchestratorResult.snapshotStaleServedCount,
          strictMatchedCount: orchestratorResult.strictMatchedCount,
          expandedCount: orchestratorResult.expandedCount,
          expansionReason: orchestratorResult.expansionReason,
          requestedLocation: orchestratorResult.requestedLocation,
          skillScoreDiagnostics: orchestratorResult.skillScoreDiagnostics,
          locationHintCoverage: orchestratorResult.locationHintCoverage,
          strictDemotedCount: orchestratorResult.strictDemotedCount,
          strictRescuedCount: orchestratorResult.strictRescuedCount,
          strictRescueApplied: orchestratorResult.strictRescueApplied,
          strictRescueMinFitScoreUsed: orchestratorResult.strictRescueMinFitScoreUsed,
          locationMatchCounts: orchestratorResult.locationMatchCounts,
          demotedStrictWithCityMatch: orchestratorResult.demotedStrictWithCityMatch,
          strictBeforeDemotion: orchestratorResult.strictBeforeDemotion,
          countryGuardFilteredCount: orchestratorResult.countryGuardFilteredCount,
          countryGuardSerpLocaleSkippedCount: orchestratorResult.countryGuardSerpLocaleSkippedCount,
          twoLayerPool: orchestratorResult.twoLayerPool,
          relaxationLadder: orchestratorResult.relaxationLadder ?? null,
          crustdataAcquisition:
            orchestratorResult.crustdataAcquisition ?? null,
          selectedSnapshotTrack: orchestratorResult.selectedSnapshotTrack,
          locationCoverageTriggered: orchestratorResult.locationCoverageTriggered,
          noveltySuppressedCount: orchestratorResult.noveltySuppressedCount,
          noveltyWindowDays: orchestratorResult.noveltyWindowDays,
          noveltyKey: orchestratorResult.noveltyKey,
          noveltyHint: orchestratorResult.noveltyHint,
          discoveredOrphanCount: orchestratorResult.discoveredOrphanCount,
          effectiveStrategy: orchestratorResult.effectiveStrategy,
          executionPath: orchestratorResult.executionPath,
          sourceMetrics: orchestratorResult.sourceMetrics ?? null,
          publicMemory: orchestratorResult.publicMemory,
          dynamicQueryBudgetUsed: orchestratorResult.dynamicQueryBudgetUsed,
          minDiscoveryPerRunApplied: orchestratorResult.minDiscoveryPerRunApplied,
          minDiscoveredInOutputApplied: orchestratorResult.minDiscoveredInOutputApplied,
          discoveredPromotedCount: orchestratorResult.discoveredPromotedCount,
          discoveredPromotedInTopCount: orchestratorResult.discoveredPromotedInTopCount,
          unknownLocationPromotedCount: orchestratorResult.unknownLocationPromotedCount,
          discoveredPromotionRejections: orchestratorResult.discoveredPromotionRejections,
          discoveredDeferredFromFrontLoad: orchestratorResult.discoveredDeferredFromFrontLoad,
          unknownLocationAssemblyCapRejected: orchestratorResult.unknownLocationAssemblyCapRejected,
          unknownLocationPoolCapRejected: orchestratorResult.unknownLocationPoolCapRejected,
          unknownLocationPoolAssembledCount: orchestratorResult.unknownLocationPoolAssembledCount,
          unknownLocationDiscoveredAssembledCount: orchestratorResult.unknownLocationDiscoveredAssembledCount,
          unknownLocationPenaltyApplied: orchestratorResult.unknownLocationPenaltyApplied,
          unknownLocationPoolPenaltyApplied: orchestratorResult.unknownLocationPoolPenaltyApplied,
          nonTechLocationMismatchPenaltyApplied: orchestratorResult.nonTechLocationMismatchPenaltyApplied,
          unknownLocationTop20DemotedInitial: orchestratorResult.unknownLocationTop20DemotedInitial,
          unknownLocationTop20DemotedFinal: orchestratorResult.unknownLocationTop20DemotedFinal,
          roleGuardTop20Demoted: orchestratorResult.roleGuardTop20Demoted,
          roleGuardNoReplacementCount: orchestratorResult.roleGuardNoReplacementCount,
          roleGuardEpsilonBlockedCount: orchestratorResult.roleGuardEpsilonBlockedCount,
          skillFloorTop20Demoted: orchestratorResult.skillFloorTop20Demoted,
          skillFloorBypassCount: orchestratorResult.skillFloorBypassCount,
          skillFloorNoReplacementCount: orchestratorResult.skillFloorNoReplacementCount,
          skillFloorEpsilonBlockedCount: orchestratorResult.skillFloorEpsilonBlockedCount,
          eligibleTechRoleCount: orchestratorResult.eligibleTechRoleCount,
          eligibleTechSkillCount: orchestratorResult.eligibleTechSkillCount,
          preGuardLowRoleTop20: orchestratorResult.preGuardLowRoleTop20,
          preGuardLowSkillTop20: orchestratorResult.preGuardLowSkillTop20,
          postGuardLowRoleTop20: orchestratorResult.postGuardLowRoleTop20,
          postGuardLowSkillTop20: orchestratorResult.postGuardLowSkillTop20,
          techTop20Thresholds: orchestratorResult.techTop20Thresholds,
          roleResolutionMetrics: orchestratorResult.roleResolutionMetrics,
          locationResolutionMetrics: orchestratorResult.locationResolutionMetrics,
        }),
      },
    });
    if (completed.count !== 1) {
      log.info(
        { jobId: job.id, requestId, executionFence },
        'Discarding completion from superseded sourcing execution',
      );
      return {
        requestId,
        status: 'failed',
        candidateCount: 0,
        durationMs,
        error: 'Sourcing execution was superseded',
      };
    }

    // Deliver callback
    const payload: SourcingCallbackPayload = {
      version: 1,
      requestId,
      externalJobId,
      acquisitionGeneration: executionFence.acquisitionGeneration,
      executionAttemptId: executionFence.executionAttemptId,
      status: 'complete',
      candidateCount,
    };
    await deliverCallback(
      requestId,
      tenantId,
      callbackUrl,
      payload,
      true,
      executionFence,
    );

    const result: SourcingJobResult = {
      requestId,
      status: 'complete',
      candidateCount,
      durationMs,
    };

    log.info({ jobId: job.id, requestId, durationMs }, 'Sourcing job completed');
    return result;
  } catch (err) {
    if(!ownsLease && rcClaimInFlight){
      if(job.attemptsMade+1<Math.min(job.opts.attempts??1,3)||!rcClaimInput)throw err;
      // Last attempt reconciles a lost response through the SAME token fence.
      // Never fall back to a raw request claim unless RC proves it unmanaged.
      const {RcRepository}=await import('../rc-skills/repository');
      const recovered=await new RcRepository().claimExecution(rcClaimInput);
      if(recovered.state==='rejected')throw err;
      if(recovered.state==='claimed'){
        ownsLease=true;
        governed=Boolean(await new GovernedRepository().call('boundCommand',[tenantId,requestId]));
      }
    }
    if(!ownsLease) {
      if(job.attemptsMade+1<(job.opts.attempts??1))throw err;
      // Last retry: reconcile a failed claim only if the row is still queued
      // without a lease, or our exact claim committed but its response was lost.
      // Never steal another worker's lease. If the DB is still unavailable this
      // throws (visible failed queue job), never a false successful completion.
      const recovered=await prisma.jobSourcingRequest.updateMany({where:{id:requestId,tenantId,...routeFence,
        OR:[{status:'queued',processingLeaseId:null},{status:'processing',processingLeaseId}]},
        data:{status:'processing',processingLeaseId}});
      if(recovered.count!==1)throw err;
      governed=Boolean(await new GovernedRepository().call('boundCommand',[tenantId,requestId]));
    }
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    const durationMs = Date.now() - startTime;

    if(governed){
      // A publication can commit before a later read/callback fails. Never
      // turn that durable success into cancellation or a swallowed supersession.
      const published=await prisma.jobSourcingRequest.findFirst({where:{id:requestId,tenantId,
        ...executionFence,status:'complete'},select:{resultCount:true}});
      if(published) {
        log.warn({requestId,error:errorMsg},'Recovering callback after committed sourcing publication');
        await deliverCallback(requestId,tenantId,callbackUrl,{version:1,requestId,externalJobId,
          acquisitionGeneration:executionFence.acquisitionGeneration,executionAttemptId:executionFence.executionAttemptId,
          status:'complete',candidateCount:published.resultCount??0},true,executionFence);
        return {requestId,status:'complete',candidateCount:published.resultCount??0,durationMs};
      }
      if(process.env.RC_SKILLS_ENABLED==='true'){
        const {RcRepository}=await import('../rc-skills/repository');
        const rc=new RcRepository();
        // A retry may fail its privacy gate before RC admission. Find its
        // existing durable run without reading candidate evidence on this path.
        if(!rcIdentity){
          const bound=await new GovernedRepository().call<GovernedSource>('boundCommand',[tenantId,requestId]);
          if(bound?.protocolVersion===2 && bound.rankingContract.payload.schemaVersion===3 && await rc.progress(tenantId,bound.flowRunId))
            rcIdentity={tenantId,flowRunId:bound.flowRunId,executionAttemptId:job.data.executionAttemptId!,processingLeaseId};
        }
        if(rcIdentity){
          const recovery=await rc.failure(rcIdentity,job.attemptsMade,job.opts.attempts??1);
          if(recovery.state==='cancelled'){
            await flushGovernedEvidence(new GovernedRepository(),tenantId,requestId).catch(()=>undefined);
            return {requestId,status:'failed',candidateCount:0,durationMs,error:'GOVERNED_CANCELLED_NO_DISPATCH'};
          }
          if(recovery.state==='retry')throw err;
          throw Error('RC_RECOVERY_PENDING');
        }
      }
      // Retry only recovery of an already completed purchase, never a new
      // generation or an ambiguous provider dispatch. The acquisition layer
      // reuses its durable exact receipt; three attempts bound this recovery.
      const receipts=await prisma.crustdataAcquisitionReceipt.findMany({where:{tenantId,sourcingRequestId:requestId,acquisitionGeneration:1},select:{slot:true,status:true}});
      if(canResumeGovernedPurchase(job.attemptsMade,job.opts.attempts??1,receipts)) {
        const retry=await prisma.jobSourcingRequest.updateMany({where:{id:requestId,tenantId,...executionFence,status:'processing'},
          data:{status:'queued',processingLeaseId:null}});
        if(retry.count===1)throw err;
      }
      try{
        const repository=new GovernedRepository(),cancelled=await repository.call('cancel',[tenantId,requestId,executionFence]);
        if(cancelled){
          await flushGovernedEvidence(repository,tenantId,requestId).catch(()=>undefined);
          // The durable pending callback repairs a lost accounting ack. The
          // cancellation has fenced this lease; do not rewrite it below.
          return {requestId,status:'failed',candidateCount:0,durationMs,error:'GOVERNED_CANCELLED_NO_DISPATCH'};
        }
      }catch{log.warn({requestId},'Governed cancellation not proven; retaining allowance');}
    }

    const failed = await prisma.jobSourcingRequest.updateMany({
      where: {
        id: requestId,
        tenantId,
        acquisitionGeneration: executionFence.acquisitionGeneration,
        executionAttemptId: executionFence.executionAttemptId,
        processingLeaseId: executionFence.processingLeaseId,
        status: 'processing',
      },
      data: {
        status: 'failed',
        ...(governed?{callbackStatus:'pending',completedAt:new Date()}:{}),
        qualityGateTriggered: false,
        queriesExecuted: 0,
        // Keep enqueue-time and asynchronously reconciled diagnostics. The
        // public-ingest receipts can settle after the sourcing run itself fails.
      },
    });
    if (failed.count === 1) {
      // Persist the failure reason durably — worker logs rotate in seconds
      // and neither Signal nor Flow stored it anywhere (the job-155 outage
      // was diagnosed blind for lack of this). jsonb merge preserves the
      // enqueue-time and async-reconciled diagnostics.
      await prisma.$executeRaw`
        UPDATE "job_sourcing_requests"
        SET "diagnostics" = COALESCE("diagnostics", '{}'::jsonb) || jsonb_build_object(
          'failure', jsonb_build_object(
            'error', ${errorMsg}::text,
            'at', ${new Date().toISOString()}::text,
            'durationMs', ${durationMs}
          )
        )
        WHERE "id" = ${requestId} AND "tenantId" = ${tenantId}
      `.catch((persistErr: unknown) => {
        log.warn({ requestId, err: String(persistErr) }, 'Could not persist failure diagnostics');
      });
    }
    if (failed.count !== 1) {
      log.info(
        { jobId: job.id, requestId, executionFence },
        'Ignoring failure from superseded sourcing execution',
      );
      return {
        requestId,
        status: 'failed',
        candidateCount: 0,
        durationMs,
        error: 'Sourcing execution was superseded',
      };
    }

    // Attempt failure callback
    const failPayload: SourcingCallbackPayload = {
      version: 1,
      requestId,
      externalJobId,
      acquisitionGeneration: executionFence.acquisitionGeneration,
      executionAttemptId: executionFence.executionAttemptId,
      status: 'failed',
      candidateCount: 0,
      error: errorMsg,
    };
    await deliverCallback(
      requestId,
      tenantId,
      callbackUrl,
      failPayload,
      false,
      executionFence,
    ).catch((cbErr) => {
      log.error({ requestId, error: cbErr }, 'Failed to deliver failure callback');
    });

    log.error({ jobId: job.id, requestId, error: errorMsg }, 'Sourcing job failed');

    return {
      requestId,
      status: 'failed',
      candidateCount: 0,
      durationMs,
      error: errorMsg,
    };
  } finally {
    if(rcHeartbeat)clearInterval(rcHeartbeat);
  }
}

// ---------------------------------------------------------------------------
// Worker singleton
// ---------------------------------------------------------------------------

let sourcingWorker: Worker<SourcingJobData, SourcingJobResult> | null = null;

export function startSourcingWorker(options?: {
  concurrency?: number;
}): Worker<SourcingJobData, SourcingJobResult> {
  if (sourcingWorker) return sourcingWorker;

  sourcingWorker = new Worker<SourcingJobData, SourcingJobResult>(
    SOURCING_QUEUE_NAME,
    processSourcingJob,
    {
      connection: getRedisConnection(),
      concurrency: options?.concurrency || 2,
    },
  );

  sourcingWorker.on('completed', (job, result) => {
    log.info({ jobId: job.id, requestId: result.requestId }, 'Job completed');
  });

  sourcingWorker.on('failed', (job, error) => {
    log.error({ jobId: job?.id, error: error.message }, 'Job failed');
  });

  sourcingWorker.on('error', (error) => {
    log.error({ error }, 'Worker error');
  });

  log.info('Sourcing worker started');
  return sourcingWorker;
}

export async function stopSourcingWorker(): Promise<void> {
  if (sourcingWorker) {
    await sourcingWorker.close();
    sourcingWorker = null;
    log.info('Sourcing worker stopped');
  }
}

// ---------------------------------------------------------------------------
// Stats + cleanup
// ---------------------------------------------------------------------------

export async function getSourcingQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getSourcingQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

export async function cleanupSourcingQueue(): Promise<void> {
  await stopSourcingWorker();

  const queueClient = getSourcingQueue();
  if (queueClient) {
    await queueClient.close();
  }

  const redis = getRedisConnection();
  if (redis) {
    await redis.quit();
  }

  log.info('Sourcing queue cleaned up');
}
