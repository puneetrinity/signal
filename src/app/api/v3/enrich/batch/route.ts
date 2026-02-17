/**
 * POST /api/v3/enrich/batch
 *
 * Triggers batch enrichment for a list of candidate IDs.
 * Scope: enrich:batch
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyServiceJWT } from '@/lib/auth/service-jwt';
import { requireScope } from '@/lib/auth/service-scopes';
import { prisma } from '@/lib/prisma';
import { createEnrichmentSession } from '@/lib/enrichment/queue';

export async function POST(request: NextRequest) {
  const auth = await verifyServiceJWT(request);
  if (!auth.authorized) return auth.response;

  const scopeCheck = requireScope(auth.context, 'enrich:batch');
  if (!scopeCheck.authorized) return scopeCheck.response;

  const tenantId = auth.context.tenantId;

  const VALID_TRIGGERS = ['onOpen', 'onShortlist'] as const;
  type BatchTrigger = typeof VALID_TRIGGERS[number];

  let body: { candidateIds?: string[]; trigger?: string; priority?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  if (!body.trigger || !VALID_TRIGGERS.includes(body.trigger as BatchTrigger)) {
    return NextResponse.json(
      { success: false, error: `trigger must be one of: ${VALID_TRIGGERS.join(', ')}` },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.candidateIds) || body.candidateIds.length === 0) {
    return NextResponse.json(
      { success: false, error: 'candidateIds must be a non-empty array' },
      { status: 400 },
    );
  }

  // Dedupe
  const uniqueIds = [...new Set(body.candidateIds)];

  // Validate candidates exist and belong to tenant
  const validCandidates = await prisma.candidate.findMany({
    where: { id: { in: uniqueIds }, tenantId },
    select: { id: true },
  });
  const validIdSet = new Set(validCandidates.map((c) => c.id));

  // Cross-run dedupe: skip candidates with already queued/running sessions
  const validIds = uniqueIds.filter((id) => validIdSet.has(id));
  const activeSessions = validIds.length > 0
    ? await prisma.enrichmentSession.findMany({
        where: {
          candidateId: { in: validIds },
          tenantId,
          status: { in: ['queued', 'running'] },
        },
        select: { candidateId: true },
      })
    : [];
  const alreadyActiveIds = new Set(activeSessions.map((s) => s.candidateId));

  const submitted: { candidateId: string; sessionId: string }[] = [];
  const skipped: { candidateId: string; reason: string }[] = [];
  const errors: { candidateId: string; error: string }[] = [];

  for (const candidateId of uniqueIds) {
    if (!validIdSet.has(candidateId)) {
      errors.push({ candidateId, error: 'Candidate not found or not owned by tenant' });
      continue;
    }

    if (alreadyActiveIds.has(candidateId)) {
      skipped.push({ candidateId, reason: 'Session already queued or running' });
      continue;
    }

    try {
      const { sessionId } = await createEnrichmentSession(tenantId, candidateId, {
        priority: body.priority ?? 0,
      });
      submitted.push({ candidateId, sessionId });
    } catch (error) {
      errors.push({
        candidateId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return NextResponse.json({
    success: true,
    submitted,
    skipped,
    errors,
  });
}
