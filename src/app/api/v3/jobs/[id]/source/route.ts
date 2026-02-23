/**
 * POST /api/v3/jobs/[id]/source
 *
 * Creates a sourcing request with idempotency, enqueues on the sourcing queue.
 * Scope: jobs:source
 */

import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyServiceJWT } from '@/lib/auth/service-jwt';
import { requireScope } from '@/lib/auth/service-scopes';
import { getEnrichmentProviderStatus } from '@/lib/enrichment/provider';
import { prisma } from '@/lib/prisma';
import { toJsonValue } from '@/lib/prisma/json';
import { getSourcingQueue } from '@/lib/sourcing/queue';
import { buildJobRequirements, type SourcingJobContextInput } from '@/lib/sourcing/jd-digest';
import { resolveTrack } from '@/lib/sourcing/track-resolver';
import type { SourcingJobData } from '@/lib/sourcing/types';

const bodySchema = z.object({
  jobContext: z.object({
    jdDigest: z.string(),
    title: z.string().optional(),
    skills: z.array(z.string()).optional(),
    goodToHaveSkills: z.array(z.string()).optional(),
    location: z.string().optional(),
    experienceYears: z.number().optional(),
    education: z.string().optional(),
    // Track hint fields — excluded from jobContextHash (see idempotency caveat below)
    jobTrackHint: z.enum(['auto', 'tech', 'non_tech']).optional(),
    jobTrackHintSource: z.enum(['system', 'user']).optional(),
    jobTrackHintReason: z.string().optional(),
  }),
  callbackUrl: z.string().url(),
});

// Idempotency caveat: jobTrackHint, jobTrackHintSource, jobTrackHintReason, and
// TRACK_CLASSIFIER_VERSION are all excluded from jobContextHash. This means:
// - Same job context with different hints = same request (idempotent).
// - If the classifier version changes, existing requests are reused — the trackDecision
//   reflects the version at first resolution, not the current version.
const HASH_EXCLUDED_FIELDS = new Set(['jobTrackHint', 'jobTrackHintSource', 'jobTrackHintReason']);

function computeJobContextHash(jobContext: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(jobContext).sort()) {
    if (!HASH_EXCLUDED_FIELDS.has(key)) filtered[key] = jobContext[key];
  }
  const sorted = JSON.stringify(filtered, Object.keys(filtered).sort());
  return createHash('sha256').update(sorted).digest('hex');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyServiceJWT(request);
  if (!auth.authorized) return auth.response;

  const scopeCheck = requireScope(auth.context, 'jobs:source');
  if (!scopeCheck.authorized) return scopeCheck.response;

  const providerStatus = getEnrichmentProviderStatus();
  if (providerStatus.provider !== 'langgraph' || !providerStatus.enabled) {
    return NextResponse.json(
      {
        success: false,
        error: `Enrichment provider not available: ${providerStatus.reason ?? 'provider is not langgraph'}`,
      },
      { status: 400 },
    );
  }

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
    // Allow re-queue for terminal failure states
    const retryable = existing.status === 'failed' || existing.status === 'callback_failed';
    if (!retryable) {
      // Return persisted trackDecision, not freshly computed one, for consistency with GET /results
      const existingDiag = existing.diagnostics as Record<string, unknown> | null;
      const persistedTrackDecision = existingDiag?.trackDecision ?? null;
      return NextResponse.json({
        success: true,
        requestId: existing.id,
        status: existing.status,
        idempotent: true,
        trackDecision: persistedTrackDecision,
      });
    }

    // Reset failed request and re-enqueue — persist trackDecision before enqueue
    await prisma.jobSourcingRequest.update({
      where: { id: existing.id },
      data: {
        status: 'queued',
        completedAt: null,
        callbackAttempts: 0,
        lastCallbackError: null,
        resultCount: null,
        qualityGateTriggered: false,
        queriesExecuted: 0,
        diagnostics: toJsonValue({ trackDecision }),
      },
    });

    // Remove stale BullMQ job (completed/failed jobs linger per retention settings)
    const queue = getSourcingQueue();
    const staleJob = await queue.getJob(existing.id);
    if (staleJob) await staleJob.remove();

    const jobData: SourcingJobData = {
      requestId: existing.id,
      tenantId,
      externalJobId,
      callbackUrl: body.callbackUrl,
      resolvedTrack: trackDecision,
    };
    await queue.add('source', jobData, { jobId: existing.id });

    return NextResponse.json(
      {
        success: true,
        requestId: existing.id,
        status: 'queued',
        idempotent: false,
        retried: true,
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
    },
  });

  // Enqueue
  const jobData: SourcingJobData = {
    requestId: req.id,
    tenantId,
    externalJobId,
    callbackUrl: body.callbackUrl,
    resolvedTrack: trackDecision,
  };
  await getSourcingQueue().add('source', jobData, { jobId: req.id });

  return NextResponse.json(
    {
      success: true,
      requestId: req.id,
      status: 'queued',
      idempotent: false,
      trackDecision: trackDecisionSummary,
    },
    { status: 202 },
  );
}
