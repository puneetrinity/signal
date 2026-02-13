/**
 * v2 Identity Confirmation API
 *
 * POST /api/v2/identity/confirm
 * - Confirms an identity candidate as a verified identity
 * - Creates ConfirmedIdentity record (can now store PII)
 * - Optionally stores contact info extracted from evidence
 * - Rate limited and audited
 *
 * DELETE /api/v2/identity/confirm
 * - Rejects an identity candidate
 * - Updates status to 'rejected'
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getGitHubClient, type CommitEmailEvidence } from '@/lib/enrichment/github';
import {
  withRateLimit,
  CONFIRM_RATE_LIMIT,
  rateLimitHeaders,
} from '@/lib/rate-limit';
import { logIdentityAction } from '@/lib/audit';
import { withAuth, requireTenantId } from '@/lib/auth';
import { createSummaryOnlySession } from '@/lib/enrichment/queue';
import type { EnrichmentRunTrace } from '@/lib/enrichment/graph/types';
import { getTenantSettings } from '@/lib/tenant/settings';

/**
 * Confirmation method types
 */
type ConfirmationMethod =
  | 'recruiter_manual' // Recruiter manually confirmed
  | 'recruiter_with_email' // Recruiter confirmed and requested email storage
  | 'auto_high_confidence'; // Auto-confirmed due to very high confidence

/**
 * Audit log entry for confirmation action (uses centralized audit module)
 */
async function logConfirmAction(
  action: 'identity.confirmed' | 'identity.rejected',
  identityCandidateId: string,
  candidateId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await logIdentityAction(
    action,
    identityCandidateId,
    candidateId,
    metadata
  );
}

/**
 * Check if LangGraph enrichment is enabled
 */
function isLangGraphEnabled(): boolean {
  return process.env.USE_LANGGRAPH_ENRICHMENT === 'true';
}

/**
 * Check if summary is stale and trigger regeneration if needed.
 * Returns regeneration info or null if not needed.
 */
async function checkAndTriggerSummaryRegeneration(
  tenantId: string,
  candidateId: string
): Promise<{ sessionId: string; jobId: string; reason: string } | null> {
  // Only auto-trigger if LangGraph is enabled
  if (!isLangGraphEnabled()) {
    return null;
  }

  try {
    // Get current confirmed identities
    const confirmedIdentities = await prisma.confirmedIdentity.findMany({
      where: { candidateId },
      select: { platform: true, platformId: true },
      orderBy: [{ platform: 'asc' }, { platformId: 'asc' }],
    });

    if (confirmedIdentities.length === 0) {
      return null;
    }

    // Compute current identity key (same format as summary generator)
    const currentIdentityKey = confirmedIdentities
      .map((ci) => `${ci.platform}:${ci.platformId}`)
      .join('|');

    // Get the latest completed session for this candidate
    const latestSession = await prisma.enrichmentSession.findFirst({
      where: {
        candidateId,
        status: 'completed',
        summary: { not: null },
      },
      orderBy: { completedAt: 'desc' },
      select: { id: true, runTrace: true },
    });

    // Check if summary exists and if it's stale
    if (latestSession?.runTrace) {
      const runTrace = latestSession.runTrace as unknown as EnrichmentRunTrace;
      const summaryMeta = runTrace.final?.summaryMeta;

      if (summaryMeta?.identityKey === currentIdentityKey && summaryMeta?.mode === 'verified') {
        // Summary is up-to-date with verified status
        console.log(
          `[v2/identity/confirm] Summary already verified with matching identity key`
        );
        return null;
      }

      // Determine staleness reason
      let reason: string;
      if (!summaryMeta) {
        reason = 'no_summary_meta';
      } else if (summaryMeta.mode !== 'verified') {
        reason = 'summary_is_draft';
      } else {
        reason = 'identity_set_changed';
      }

      console.log(
        `[v2/identity/confirm] Summary stale (${reason}), triggering regeneration`
      );

      // Trigger summary-only regeneration (tenant-scoped)
      const { sessionId, jobId } = await createSummaryOnlySession(tenantId, candidateId, {
        priority: 5, // Higher priority for user-triggered actions
      });

      return { sessionId, jobId, reason };
    }

    // No existing summary, trigger one if we have confirmed identities
    console.log(
      `[v2/identity/confirm] No existing summary, triggering verified summary generation`
    );

    const { sessionId, jobId } = await createSummaryOnlySession(tenantId, candidateId, {
      priority: 5,
    });

    return { sessionId, jobId, reason: 'no_existing_summary' };
  } catch (error) {
    console.error(
      '[v2/identity/confirm] Error checking/triggering summary regeneration:',
      error
    );
    // Don't fail the confirmation if regeneration fails
    return null;
  }
}

/**
 * Extract and format contact info from evidence
 */
async function extractContactInfo(
  platform: string,
  evidence: CommitEmailEvidence[] | null
): Promise<{ email?: string; source?: string; sourceUrl?: string } | null> {
  if (platform !== 'github' || !evidence || evidence.length === 0) {
    return null;
  }

  const github = getGitHubClient();

  for (const ev of evidence) {
    if (ev.type === 'commit_email') {
      try {
        const email = await github.extractEmailFromCommit(
          ev.repoFullName,
          ev.commitSha
        );

        if (email) {
          return {
            email,
            source: 'github_commit',
            sourceUrl: ev.commitUrl,
          };
        }
      } catch (error) {
        console.warn(
          `[v2/identity/confirm] Failed to extract email from commit:`,
          error
        );
      }
    }
  }

  return null;
}

/**
 * POST /api/v2/identity/confirm
 *
 * Confirm an identity candidate.
 *
 * Request body:
 * - identityCandidateId: string
 * - method: 'recruiter_manual' | 'recruiter_with_email'
 * - note?: string (optional confirmation note)
 * - storeContactInfo?: boolean (whether to extract and store email)
 */
export async function POST(request: NextRequest) {
  // Auth check - recruiter role required for confirmation
  const authCheck = await withAuth('recruiter');
  if (!authCheck.authorized) {
    return authCheck.response;
  }
  const tenantId = requireTenantId(authCheck.context);

  // Rate limit by userId (all requests are now Clerk-authenticated)
  const rateLimitKey = authCheck.context.userId || undefined;
  const rateLimitCheck = await withRateLimit(CONFIRM_RATE_LIMIT, rateLimitKey);
  if (!rateLimitCheck.allowed) {
    return rateLimitCheck.response;
  }

  try {
    const body = await request.json();
    const {
      identityCandidateId,
      method = 'recruiter_manual',
      note,
      storeContactInfo = false,
    } = body as {
      identityCandidateId?: string;
      method?: ConfirmationMethod;
      note?: string;
      storeContactInfo?: boolean;
    };

    // Validate input
    if (!identityCandidateId) {
      return NextResponse.json(
        { success: false, error: 'identityCandidateId is required' },
        { status: 400 }
      );
    }

    // Fetch identity candidate - must belong to tenant
    const identityCandidate = await prisma.identityCandidate.findFirst({
      where: { id: identityCandidateId, tenantId },
    });

    if (!identityCandidate) {
      return NextResponse.json(
        { success: false, error: 'Identity candidate not found' },
        { status: 404 }
      );
    }

    // Check if already confirmed
    if (identityCandidate.status === 'confirmed') {
      return NextResponse.json(
        { success: false, error: 'Identity already confirmed' },
        { status: 400 }
      );
    }

    // Check if rejected
    if (identityCandidate.status === 'rejected') {
      return NextResponse.json(
        { success: false, error: 'Identity was previously rejected' },
        { status: 400 }
      );
    }

    // Enforce tenant-level policy before any contact extraction/storage.
    if (storeContactInfo) {
      const settings = await getTenantSettings(tenantId);
      if (!settings.allowContactStorage) {
        return NextResponse.json(
          {
            success: false,
            error: 'Contact storage is disabled for this tenant',
          },
          {
            status: 403,
            headers: rateLimitHeaders(rateLimitCheck.result),
          }
        );
      }
    }

    // Extract contact info if requested
    let contactInfo = null;
    if (storeContactInfo) {
      contactInfo = await extractContactInfo(
        identityCandidate.platform,
        identityCandidate.evidence as CommitEmailEvidence[] | null
      );
    }

    // Create confirmed identity
    const userId = authCheck.context.userId;
    const confirmedBy = userId ? `recruiter:${userId}:${method}` : `recruiter:${method}`;

    const confirmedIdentity = await prisma.confirmedIdentity.create({
      data: {
        tenantId,
        candidateId: identityCandidate.candidateId,
        platform: identityCandidate.platform,
        platformId: identityCandidate.platformId,
        profileUrl: identityCandidate.profileUrl,
        contactInfo: contactInfo ? JSON.parse(JSON.stringify(contactInfo)) : undefined,
        confirmedBy,
        confirmationNote: note,
        identityCandidateId: identityCandidate.id,
      },
    });

    // Update identity candidate status
    await prisma.identityCandidate.update({
      where: { id: identityCandidateId },
      data: { status: 'confirmed' },
    });

    // Update candidate confidence score if this is the highest
    const candidate = await prisma.candidate.findUnique({
      where: { id: identityCandidate.candidateId },
      select: { confidenceScore: true },
    });

    if (
      !candidate?.confidenceScore ||
      identityCandidate.confidence > candidate.confidenceScore
    ) {
      await prisma.candidate.update({
        where: { id: identityCandidate.candidateId },
        data: { confidenceScore: identityCandidate.confidence },
      });
    }

    // Audit log
    await logConfirmAction(
      'identity.confirmed',
      identityCandidateId,
      identityCandidate.candidateId,
      {
        method,
        platform: identityCandidate.platform,
        platformId: identityCandidate.platformId,
        confidence: identityCandidate.confidence,
        contactInfoStored: !!contactInfo,
        // Note: We do NOT log the actual email for privacy
      }
    );

    console.log(
      `[v2/identity/confirm] Confirmed ${identityCandidate.platform}:${identityCandidate.platformId} for candidate ${identityCandidate.candidateId}`
    );

    // Check if summary needs regeneration and trigger if needed (tenant-scoped)
    const summaryRegeneration = await checkAndTriggerSummaryRegeneration(
      tenantId,
      identityCandidate.candidateId
    );

    return NextResponse.json(
      {
        success: true,
        confirmedIdentity: {
          id: confirmedIdentity.id,
          platform: confirmedIdentity.platform,
          platformId: confirmedIdentity.platformId,
          profileUrl: confirmedIdentity.profileUrl,
          confirmedAt: confirmedIdentity.confirmedAt,
          confirmedBy: confirmedIdentity.confirmedBy,
          hasContactInfo: !!contactInfo,
        },
        candidate: {
          id: identityCandidate.candidateId,
        },
        summaryRegeneration: summaryRegeneration
          ? {
              triggered: true,
              sessionId: summaryRegeneration.sessionId,
              jobId: summaryRegeneration.jobId,
              reason: summaryRegeneration.reason,
            }
          : { triggered: false },
        timestamp: Date.now(),
      },
      {
        headers: rateLimitHeaders(rateLimitCheck.result),
      }
    );
  } catch (error) {
    console.error('[v2/identity/confirm] Error:', error);

    // Handle unique constraint violation (already confirmed via different path)
    if (
      error instanceof Error &&
      error.message.includes('Unique constraint')
    ) {
      return NextResponse.json(
        { success: false, error: 'Identity already confirmed for this candidate' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to confirm identity',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/v2/identity/confirm
 *
 * Reject an identity candidate.
 *
 * Request body:
 * - identityCandidateId: string
 * - reason?: string (optional rejection reason)
 */
export async function DELETE(request: NextRequest) {
  // Auth check - recruiter role required for rejection
  const authCheck = await withAuth('recruiter');
  if (!authCheck.authorized) {
    return authCheck.response;
  }
  const tenantId = requireTenantId(authCheck.context);

  // Rate limit by userId (all requests are now Clerk-authenticated)
  const rateLimitKey = authCheck.context.userId || undefined;
  const rateLimitCheck = await withRateLimit(CONFIRM_RATE_LIMIT, rateLimitKey);
  if (!rateLimitCheck.allowed) {
    return rateLimitCheck.response;
  }

  try {
    const body = await request.json();
    const { identityCandidateId, reason } = body as {
      identityCandidateId?: string;
      reason?: string;
    };

    // Validate input
    if (!identityCandidateId) {
      return NextResponse.json(
        { success: false, error: 'identityCandidateId is required' },
        { status: 400 }
      );
    }

    // Fetch identity candidate - must belong to tenant
    const identityCandidate = await prisma.identityCandidate.findFirst({
      where: { id: identityCandidateId, tenantId },
    });

    if (!identityCandidate) {
      return NextResponse.json(
        { success: false, error: 'Identity candidate not found' },
        { status: 404 }
      );
    }

    // Check if already processed
    if (identityCandidate.status !== 'unconfirmed') {
      return NextResponse.json(
        {
          success: false,
          error: `Identity already ${identityCandidate.status}`,
        },
        { status: 400 }
      );
    }

    // Update status to rejected
    await prisma.identityCandidate.update({
      where: { id: identityCandidateId },
      data: {
        status: 'rejected',
        contradictionNote: reason
          ? `Rejected: ${reason}`
          : identityCandidate.contradictionNote,
      },
    });

    // Audit log
    await logConfirmAction(
      'identity.rejected',
      identityCandidateId,
      identityCandidate.candidateId,
      {
        platform: identityCandidate.platform,
        platformId: identityCandidate.platformId,
        reason,
      }
    );

    console.log(
      `[v2/identity/confirm] Rejected ${identityCandidate.platform}:${identityCandidate.platformId} for candidate ${identityCandidate.candidateId}`
    );

    return NextResponse.json(
      {
        success: true,
        message: 'Identity rejected',
        identityCandidateId,
        timestamp: Date.now(),
      },
      {
        headers: rateLimitHeaders(rateLimitCheck.result),
      }
    );
  } catch (error) {
    console.error('[v2/identity/confirm] DELETE Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to reject identity',
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/v2/identity/confirm - Info about confirmation endpoints
 */
export async function GET() {
  return NextResponse.json({
    version: 'v2',
    endpoint: 'identity/confirm',
    methods: {
      POST: {
        description: 'Confirm an identity candidate as verified',
        body: {
          identityCandidateId: 'string (required)',
          method: "'recruiter_manual' | 'recruiter_with_email' (default: recruiter_manual)",
          note: 'string (optional)',
          storeContactInfo: 'boolean (default: false) - whether to extract and store email',
        },
      },
      DELETE: {
        description: 'Reject an identity candidate',
        body: {
          identityCandidateId: 'string (required)',
          reason: 'string (optional)',
        },
      },
    },
    rateLimit: {
      limit: CONFIRM_RATE_LIMIT.limit,
      windowSeconds: CONFIRM_RATE_LIMIT.windowSeconds,
    },
    notes: [
      'Contact info is only stored if storeContactInfo=true',
      'All actions are audited for compliance',
      'Confirmed identities are immutable (cannot be unconfirmed)',
    ],
  });
}
