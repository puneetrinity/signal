/**
 * Snapshot computation node — extracts CandidateIntelligenceSnapshot from enrichment state.
 *
 * Runs after persistSummary. Non-blocking: errors are logged but never fail the run.
 */

import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { normalizeSeniorityFromText } from '@/lib/taxonomy/seniority';
import { getSourcingConfig } from '@/lib/sourcing/config';
import type { EnrichmentState, PartialEnrichmentState } from './types';

const log = createLogger('SnapshotNode');

/**
 * Identity safety invariant: stale-refresh re-runs the full enrichment graph,
 * which re-persists identities via persistResultsNode. The identity *logic*
 * (thresholds, bridge tier rules, scoring formulas) stays unchanged — only the
 * snapshot metadata is recomputed here. This is by design.
 */
export async function computeSnapshotNode(
  state: EnrichmentState,
): Promise<PartialEnrichmentState> {
  try {
    const staleDays = getSourcingConfig().snapshotStaleDays;
    const now = new Date();
    const staleAfter = new Date(now.getTime() + staleDays * 24 * 60 * 60 * 1000);

    const structured = state.summaryStructured as Record<string, unknown> | null;
    const skills = Array.isArray(structured?.skills)
      ? (structured.skills as string[])
      : [];

    const hints = state.hints;
    const seniorityBand = normalizeSeniorityFromText(hints?.headlineHint);

    // Build fingerprint from summaryMeta or identity keys
    const meta = state.summaryMeta as Record<string, unknown> | null;
    let sourceFingerprint: string | null = null;
    if (meta?.identityKey && typeof meta.identityKey === 'string') {
      sourceFingerprint = meta.identityKey;
    } else if (state.identitiesFound.length > 0) {
      sourceFingerprint = state.identitiesFound
        .map((id) => `${id.platform}:${id.platformId}`)
        .sort()
        .join(',');
    }

    await prisma.candidateIntelligenceSnapshot.upsert({
      where: {
        candidateId_tenantId_track: {
          candidateId: state.candidateId,
          tenantId: state.tenantId,
          track: 'tech',
        },
      },
      create: {
        candidateId: state.candidateId,
        tenantId: state.tenantId,
        track: 'tech',
        skillsNormalized: skills,
        roleType: hints?.roleType ?? null,
        seniorityBand,
        location: hints?.locationHint ?? null,
        activityRecencyDays: 0,
        computedAt: now,
        staleAfter,
        sourceSessionId: state.sessionId,
        sourceFingerprint,
      },
      update: {
        skillsNormalized: skills,
        roleType: hints?.roleType ?? null,
        seniorityBand,
        location: hints?.locationHint ?? null,
        activityRecencyDays: 0,
        computedAt: now,
        staleAfter,
        sourceSessionId: state.sessionId,
        sourceFingerprint,
      },
    });

    log.info(
      { candidateId: state.candidateId, sessionId: state.sessionId, skillCount: skills.length },
      'Snapshot computed',
    );
  } catch (error) {
    log.warn(
      { error, candidateId: state.candidateId, sessionId: state.sessionId },
      'Snapshot computation failed (non-blocking)',
    );
  }

  return {};
}
