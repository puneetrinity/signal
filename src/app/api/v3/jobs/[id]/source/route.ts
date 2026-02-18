/**
 * POST /api/v3/jobs/[id]/source
 *
 * Creates a sourcing request with idempotency, enqueues on the sourcing queue.
 * Scope: jobs:source
 */

import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { verifyServiceJWT } from '@/lib/auth/service-jwt';
import { requireScope } from '@/lib/auth/service-scopes';
import { getEnrichmentProviderStatus } from '@/lib/enrichment/provider';
import { prisma } from '@/lib/prisma';
import { getSourcingQueue } from '@/lib/sourcing/queue';
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
  }),
  callbackUrl: z.string().url(),
});

function computeJobContextHash(jobContext: Record<string, unknown>): string {
  const sorted = JSON.stringify(jobContext, Object.keys(jobContext).sort());
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

  // Idempotency check
  const existing = await prisma.jobSourcingRequest.findUnique({
    where: { tenantId_externalJobId_jobContextHash: { tenantId, externalJobId, jobContextHash } },
  });

  if (existing) {
    // Allow re-queue for terminal failure states
    const retryable = existing.status === 'failed' || existing.status === 'callback_failed';
    if (!retryable) {
      return NextResponse.json({
        success: true,
        requestId: existing.id,
        status: existing.status,
        idempotent: true,
      });
    }

    // Reset failed request and re-enqueue
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
        diagnostics: Prisma.JsonNull,
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
    };
    await queue.add('source', jobData, { jobId: existing.id });

    return NextResponse.json(
      {
        success: true,
        requestId: existing.id,
        status: 'queued',
        idempotent: false,
        retried: true,
      },
      { status: 202 },
    );
  }

  // Create new request
  const req = await prisma.jobSourcingRequest.create({
    data: {
      tenantId,
      externalJobId,
      jobContextHash,
      jobContext: body.jobContext,
      callbackUrl: body.callbackUrl,
      status: 'queued',
    },
  });

  // Enqueue
  const jobData: SourcingJobData = {
    requestId: req.id,
    tenantId,
    externalJobId,
    callbackUrl: body.callbackUrl,
  };
  await getSourcingQueue().add('source', jobData, { jobId: req.id });

  return NextResponse.json(
    {
      success: true,
      requestId: req.id,
      status: 'queued',
      idempotent: false,
    },
    { status: 202 },
  );
}
