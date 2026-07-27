/**
 * POST /api/v3/jobs/[id]/source
 *
 * Creates a sourcing request with idempotency, enqueues on the sourcing queue.
 * Scope: jobs:source
 */

import { createHash, randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyServiceJWT } from '@/lib/auth/service-jwt';
import { requireScope } from '@/lib/auth/service-scopes';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { toJsonValue } from '@/lib/prisma/json';
import { getSourcingQueue } from '@/lib/sourcing/queue/producer';
import { buildJobRequirements, type SourcingJobContextInput } from '@/lib/sourcing/jd-digest';
import { resolveTrack } from '@/lib/sourcing/track-resolver';
import { releaseAbandonedCrustdataReceiptPayloads } from '@/lib/sourcing/crustdata-acquisition';
import { decideSourcingRetry } from '@/lib/sourcing/request-retry';
import type { SourcingJobData } from '@/lib/sourcing/types';

const log = createLogger('SourcingSourceRoute');

const bodySchema = z.object({
  jobContext: z.object({
    jdDigest: z.string(),
    title: z.string().optional(),
    skills: z.array(z.string()).optional(),
    goodToHaveSkills: z.array(z.string()).optional(),
    location: z.string().optional(),
    experienceYears: z.number().optional(),
    experienceYearsMax: z.number().optional(),
    education: z.string().optional(),
    // Track hint fields — excluded from jobContextHash (see idempotency caveat below)
    jobTrackHint: z.enum(['auto', 'tech', 'non_tech']).optional(),
    jobTrackHintSource: z.enum(['system', 'user']).optional(),
    jobTrackHintReason: z.string().optional(),
    refresh: z.boolean().optional(),
    forceSourcing: z.boolean().optional(),
  }),
  callbackUrl: z.string().url(),
});

// Idempotency caveat: jobTrackHint, jobTrackHintSource, jobTrackHintReason, and
// TRACK_CLASSIFIER_VERSION are all excluded from jobContextHash. This means:
// - Same job context with different hints = same request (idempotent).
// - If the classifier version changes, existing requests are reused — the trackDecision
//   reflects the version at first resolution, not the current version.
const HASH_EXCLUDED_FIELDS = new Set(['jobTrackHint', 'jobTrackHintSource', 'jobTrackHintReason', 'refresh', 'forceSourcing']);

function computeJobContextHash(jobContext: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(jobContext).sort()) {
    if (!HASH_EXCLUDED_FIELDS.has(key)) filtered[key] = jobContext[key];
  }
  const sorted = JSON.stringify(filtered, Object.keys(filtered).sort());
  return createHash('sha256').update(sorted).digest('hex');
}

async function enqueueSourcingAttempt(jobData: SourcingJobData): Promise<void> {
  try {
    await getSourcingQueue().add('source', jobData, {
      jobId: `${jobData.requestId}-${jobData.executionAttemptId}`,
    });
  } catch (error) {
    // Queue submission is not transactional with the request row. Mark only
    // this still-queued attempt failed so the caller can retry the same paid
    // generation. If Redis accepted the job before reporting an error, its
    // execution fence becomes stale after the retry.
    await prisma.jobSourcingRequest
      .updateMany({
        where: {
          id: jobData.requestId,
          tenantId: jobData.tenantId,
          acquisitionGeneration: jobData.acquisitionGeneration,
          executionAttemptId: jobData.executionAttemptId,
          status: 'queued',
        },
        data: { status: 'failed' },
      })
      .catch((resetError) => {
        log.error(
          { requestId: jobData.requestId, error: resetError },
          'Failed to mark an unqueued sourcing attempt retryable',
        );
      });
    throw error;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyServiceJWT(request);
  if (!auth.authorized) return auth.response;

  const scopeCheck = requireScope(auth.context, 'jobs:source');
  if (!scopeCheck.authorized) return scopeCheck.response;



  // Parse body
  let body: z.infer<typeof bodySchema>;
  try {
    const raw = await request.json();
    body = bodySchema.parse(raw);
  } catch (err) {
    const message = err instanceof z.ZodError ? err.errors : 'Invalid request body';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }

  const { id: externalJobId } = await params;
  const tenantId = auth.context.tenantId;
  const jobContextHash = computeJobContextHash(body.jobContext as Record<string, unknown>);
  const executionAttemptId = randomUUID();

  // Resolve track (runs for both new requests and retries — fast deterministic path)
  const jobContext = body.jobContext as SourcingJobContextInput;
  const requirements = buildJobRequirements(jobContext);
  const hint = body.jobContext.jobTrackHint
    ? {
        jobTrackHint: body.jobContext.jobTrackHint,
        jobTrackHintSource: body.jobContext.jobTrackHintSource,
        jobTrackHintReason: body.jobContext.jobTrackHintReason,
      }
    : undefined;
  const trackDecision = await resolveTrack(jobContext, requirements, hint);

  const trackDecisionSummary = {
    track: trackDecision.track,
    confidence: trackDecision.confidence,
    method: trackDecision.method,
    classifierVersion: trackDecision.classifierVersion,
  };

  // Idempotency check
  const existing = await prisma.jobSourcingRequest.findUnique({
    where: { tenantId_externalJobId_jobContextHash: { tenantId, externalJobId, jobContextHash } },
  });

  if (existing) {
    // Allow re-queue for terminal failure states, or if refresh is explicitly requested
    const { retryable, startsNewAcquisition } = decideSourcingRetry({
      status: existing.status,
      callbackStatus: existing.callbackStatus,
      refreshRequested: body.jobContext.refresh === true,
      forceSourcingRequested: body.jobContext.forceSourcing === true,
    });
    if (!retryable) {
      // Return persisted trackDecision, not freshly computed one, for consistency with GET /results
      const existingDiag = existing.diagnostics as Record<string, unknown> | null;
      const persistedTrackDecision = existingDiag?.trackDecision ?? null;
      return NextResponse.json({
        success: true,
        requestId: existing.id,
        status: existing.status,
        idempotent: true,
        acquisitionGeneration: existing.acquisitionGeneration,
        executionAttemptId: existing.executionAttemptId,
        trackDecision: persistedTrackDecision,
      });
    }

    // Reset failed request and re-enqueue — persist trackDecision before enqueue
    const reset = await prisma.jobSourcingRequest.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        acquisitionGeneration: existing.acquisitionGeneration,
        executionAttemptId: existing.executionAttemptId,
        processingLeaseId: existing.processingLeaseId,
        callbackStatus: existing.callbackStatus,
      },
      data: {
        status: 'queued',
        completedAt: null,
        callbackAttempts: 0,
        lastCallbackError: null,
        callbackStatus: null,
        callbackSentAt: null,
        resultCount: null,
        qualityGateTriggered: false,
        queriesExecuted: 0,
        diagnostics: toJsonValue({ trackDecision }),
        jobContext: body.jobContext,
        callbackUrl: body.callbackUrl,
        executionAttemptId,
        processingLeaseId: null,
        // A failed/downstream retry keeps the paid acquisition generation and
        // reuses its receipts. The retry decision marks only an explicit new
        // sourcing run for another always-on Crustdata buy.
        ...(startsNewAcquisition
          ? { acquisitionGeneration: { increment: 1 } }
          : {}),
      },
    });

    if (reset.count !== 1) {
      const current = await prisma.jobSourcingRequest.findUnique({
        where: { id: existing.id },
      });
      const currentDiagnostics = current?.diagnostics as Record<
        string,
        unknown
      > | null;
      return NextResponse.json({
        success: true,
        requestId: existing.id,
        status: current?.status ?? existing.status,
        idempotent: true,
        acquisitionGeneration:
          current?.acquisitionGeneration ??
          existing.acquisitionGeneration,
        executionAttemptId:
          current?.executionAttemptId ??
          existing.executionAttemptId,
        trackDecision: currentDiagnostics?.trackDecision ?? null,
      });
    }

    const retriedRequest = await prisma.jobSourcingRequest.findUniqueOrThrow({
      where: { id: existing.id },
      select: { acquisitionGeneration: true },
    });
    if (startsNewAcquisition) {
      await releaseAbandonedCrustdataReceiptPayloads(
        tenantId,
        existing.id,
        existing.acquisitionGeneration,
      ).catch((error) => {
        log.warn(
          {
            requestId: existing.id,
            acquisitionGeneration: existing.acquisitionGeneration,
            error,
          },
          'Failed to release the explicitly abandoned Crustdata generation',
        );
      });
    }

    const jobData: SourcingJobData = {
      requestId: existing.id,
      tenantId,
      externalJobId,
      callbackUrl: body.callbackUrl,
      acquisitionGeneration: retriedRequest.acquisitionGeneration,
      executionAttemptId,
      resolvedTrack: trackDecision,
    };
    await enqueueSourcingAttempt(jobData);

    return NextResponse.json(
      {
        success: true,
        requestId: existing.id,
        status: 'queued',
        idempotent: false,
        retried: true,
        acquisitionGeneration: retriedRequest.acquisitionGeneration,
        executionAttemptId,
        trackDecision: trackDecisionSummary,
      },
      { status: 202 },
    );
  }

  // Create new request — persist trackDecision in diagnostics before enqueue
  const req = await prisma.jobSourcingRequest.create({
    data: {
      tenantId,
      externalJobId,
      jobContextHash,
      jobContext: body.jobContext,
      callbackUrl: body.callbackUrl,
      status: 'queued',
      diagnostics: toJsonValue({ trackDecision }),
      executionAttemptId,
    },
  });

  // Enqueue
  const jobData: SourcingJobData = {
    requestId: req.id,
    tenantId,
    externalJobId,
    callbackUrl: body.callbackUrl,
    acquisitionGeneration: req.acquisitionGeneration,
    executionAttemptId,
    resolvedTrack: trackDecision,
  };
  await enqueueSourcingAttempt(jobData);

  return NextResponse.json(
    {
      success: true,
      requestId: req.id,
      status: 'queued',
      idempotent: false,
      acquisitionGeneration: req.acquisitionGeneration,
      executionAttemptId,
      trackDecision: trackDecisionSummary,
    },
    { status: 202 },
  );
}
