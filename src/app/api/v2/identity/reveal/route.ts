/**
 * v2 Email Reveal API
 *
 * POST /api/v2/identity/reveal
 * - Extracts email from identity candidate evidence
 * - Only works for GitHub commit evidence
 * - Rate limited (10/hour per IP)
 * - Audited for compliance
 *
 * This is a sensitive action - emails are NOT stored in the database.
 * Each reveal fetches the email live from the source (GitHub commit).
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getGitHubClient, type CommitEmailEvidence } from '@/lib/enrichment/github';
import {
  withRateLimit,
  REVEAL_RATE_LIMIT,
  rateLimitHeaders,
} from '@/lib/rate-limit';
import { logIdentityAction } from '@/lib/audit';
import { withAuth, requireTenantId } from '@/lib/auth';

/**
 * Audit log entry for email reveal (uses centralized audit module)
 */
async function logRevealAction(
  identityCandidateId: string,
  candidateId: string,
  platform: string,
  platformId: string,
  success: boolean,
  metadata: Record<string, unknown>
): Promise<void> {
  await logIdentityAction(
    'identity.email_revealed',
    identityCandidateId,
    candidateId,
    {
      platform,
      platformId,
      success,
      ...metadata,
    }
  );
}

/**
 * Extract email from commit evidence
 */
async function extractEmailFromEvidence(
  evidence: CommitEmailEvidence[]
): Promise<{ email: string; source: CommitEmailEvidence } | null> {
  const github = getGitHubClient();

  // Try each piece of evidence until we find an email
  for (const ev of evidence) {
    if (ev.type === 'commit_email') {
      try {
        const email = await github.extractEmailFromCommit(
          ev.repoFullName,
          ev.commitSha
        );

        if (email) {
          return { email, source: ev };
        }
      } catch (error) {
        console.warn(
          `[v2/identity/reveal] Failed to extract email from commit ${ev.commitSha}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  return null;
}

/**
 * POST /api/v2/identity/reveal
 *
 * Reveal email from identity candidate evidence.
 *
 * Request body:
 * - identityCandidateId: string
 *
 * Response:
 * - email: string (the revealed email)
 * - confidence: number (identity confidence score)
 * - source: object (evidence source info)
 * - warning: string (if confidence is low)
 */
export async function POST(request: NextRequest) {
  // Auth check - recruiter role required for email reveal
  const authCheck = await withAuth('recruiter');
  if (!authCheck.authorized) {
    return authCheck.response;
  }
  const tenantId = requireTenantId(authCheck.context);

  // Rate limit by API key if authenticated, otherwise by IP
  const rateLimitKey = authCheck.context.apiKeyId || undefined;
  const rateLimitCheck = await withRateLimit(REVEAL_RATE_LIMIT, rateLimitKey);
  if (!rateLimitCheck.allowed) {
    return rateLimitCheck.response;
  }

  try {
    const body = await request.json();
    const { identityCandidateId } = body as { identityCandidateId?: string };

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
      include: {
        candidate: {
          select: {
            id: true,
            linkedinId: true,
            nameHint: true,
          },
        },
      },
    });

    if (!identityCandidate) {
      return NextResponse.json(
        { success: false, error: 'Identity candidate not found' },
        { status: 404 }
      );
    }

    // Check if platform supports email reveal
    if (identityCandidate.platform !== 'github') {
      await logRevealAction(
        identityCandidateId,
        identityCandidate.candidateId,
        identityCandidate.platform,
        identityCandidate.platformId,
        false,
        { error: 'unsupported_platform' }
      );

      return NextResponse.json(
        {
          success: false,
          error: `Email reveal not supported for platform: ${identityCandidate.platform}`,
        },
        { status: 400 }
      );
    }

    // Check if we have evidence
    const evidence = identityCandidate.evidence as CommitEmailEvidence[] | null;
    if (!evidence || evidence.length === 0) {
      await logRevealAction(
        identityCandidateId,
        identityCandidate.candidateId,
        identityCandidate.platform,
        identityCandidate.platformId,
        false,
        { error: 'no_evidence' }
      );

      return NextResponse.json(
        { success: false, error: 'No email evidence available for this identity' },
        { status: 400 }
      );
    }

    // Extract email from evidence
    console.log(
      `[v2/identity/reveal] Extracting email for ${identityCandidate.platformId} (${evidence.length} evidence items)`
    );

    const result = await extractEmailFromEvidence(evidence);

    if (!result) {
      await logRevealAction(
        identityCandidateId,
        identityCandidate.candidateId,
        identityCandidate.platform,
        identityCandidate.platformId,
        false,
        { error: 'extraction_failed', evidenceCount: evidence.length }
      );

      return NextResponse.json(
        {
          success: false,
          error: 'Could not extract email from evidence (may be noreply or private)',
        },
        { status: 404 }
      );
    }

    // Log successful reveal
    await logRevealAction(
      identityCandidateId,
      identityCandidate.candidateId,
      identityCandidate.platform,
      identityCandidate.platformId,
      true,
      {
        sourceCommit: result.source.commitSha,
        sourceRepo: result.source.repoFullName,
        // Note: We do NOT log the email itself for privacy
      }
    );

    // Build response with warnings
    const confidence = identityCandidate.confidence;
    const warnings: string[] = [];

    if (confidence < 0.7) {
      warnings.push(
        'Low confidence match - verify this identity belongs to the candidate before contacting'
      );
    }

    if (identityCandidate.hasContradiction) {
      warnings.push(
        `Contradiction detected: ${identityCandidate.contradictionNote || 'Review identity carefully'}`
      );
    }

    return NextResponse.json(
      {
        success: true,
        email: result.email,
        confidence,
        confidenceBucket: identityCandidate.confidenceBucket,
        source: {
          platform: identityCandidate.platform,
          platformId: identityCandidate.platformId,
          profileUrl: identityCandidate.profileUrl,
          commitUrl: result.source.commitUrl,
          authorName: result.source.authorName,
        },
        candidate: {
          id: identityCandidate.candidate.id,
          linkedinId: identityCandidate.candidate.linkedinId,
          nameHint: identityCandidate.candidate.nameHint,
        },
        warnings: warnings.length > 0 ? warnings : undefined,
        timestamp: Date.now(),
      },
      {
        headers: rateLimitHeaders(rateLimitCheck.result),
      }
    );
  } catch (error) {
    console.error('[v2/identity/reveal] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reveal email',
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/v2/identity/reveal - Info about reveal limits
 */
export async function GET() {
  return NextResponse.json({
    version: 'v2',
    endpoint: 'identity/reveal',
    description: 'Extract email from identity candidate evidence',
    rateLimit: {
      limit: REVEAL_RATE_LIMIT.limit,
      windowSeconds: REVEAL_RATE_LIMIT.windowSeconds,
      note: 'Stricter rate limit due to sensitive nature of email reveal',
    },
    supportedPlatforms: ['github'],
    evidenceTypes: ['commit_email'],
    notes: [
      'Emails are extracted live from source, not stored in database',
      'Each reveal is audited for compliance',
      'Low confidence matches include warnings',
    ],
  });
}
