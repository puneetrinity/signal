/**
 * Non-tech enrichment graph node.
 *
 * Runs after computeSnapshot (tech). Gated on ENRICHMENT_NONTECH_ENABLED.
 * Reads existing data from DB (candidate + identities + tech snapshot),
 * runs extractors → scoring, persists to CandidateIntelligenceSnapshot
 * with track: 'non-tech'.
 *
 * Never touches identity confidence, bridge tier, or merge logic.
 */

import { prisma } from '@/lib/prisma';
import { toJsonValue } from '@/lib/prisma/json';
import { createLogger } from '@/lib/logger';
import { getNonTechConfig } from '../config';
import { getSourcingConfig } from '@/lib/sourcing/config';
import {
  extractCompanyAlignment,
  extractSeniorityValidation,
  extractFreshness,
  extractSerpContext,
  extractContradictions,
} from './extractors';
import { scoreNonTech } from './scoring';
import type { EnrichmentState, PartialEnrichmentState } from '../graph/types';
import type { NonTechSignals } from './types';

const log = createLogger('NonTechNode');

export async function nonTechEnrichmentNode(
  state: EnrichmentState,
): Promise<PartialEnrichmentState> {
  const config = getNonTechConfig();
  if (!config.enabled) {
    return {};
  }

  try {
    // Load candidate data
    const candidate = await prisma.candidate.findUnique({
      where: { id: state.candidateId },
      select: {
        companyHint: true,
        headlineHint: true,
        locationHint: true,
        searchTitle: true,
        searchSnippet: true,
        searchMeta: true,
        lastEnrichedAt: true,
      },
    });

    if (!candidate) {
      log.warn({ candidateId: state.candidateId }, 'Candidate not found for non-tech enrichment');
      return {};
    }

    // Load identity records
    const identities = await prisma.identityCandidate.findMany({
      where: {
        candidateId: state.candidateId,
        tenantId: state.tenantId,
      },
      select: {
        platform: true,
        confidence: true,
        hasContradiction: true,
        contradictionNote: true,
        updatedAt: true,
      },
    });

    // Load existing tech snapshot for freshness reference
    const techSnapshot = await prisma.candidateIntelligenceSnapshot.findUnique({
      where: {
        candidateId_tenantId_track: {
          candidateId: state.candidateId,
          tenantId: state.tenantId,
          track: 'tech',
        },
      },
      select: {
        computedAt: true,
        staleAfter: true,
      },
    });

    // Extract signals
    const companyAlignment = extractCompanyAlignment(candidate, identities);
    const seniorityValidation = extractSeniorityValidation(candidate);
    const freshness = extractFreshness(candidate, techSnapshot, config);
    const serpContext = extractSerpContext(candidate);
    const contradictions = extractContradictions(identities);

    const signals: NonTechSignals = {
      companyAlignment,
      seniorityValidation,
      freshness,
      serpContext,
      contradictions,
    };

    // Score
    const score = scoreNonTech(signals, config);

    // Persist as non-tech snapshot
    const staleDays = getSourcingConfig().snapshotStaleDays;
    const now = new Date();
    const staleAfter = new Date(now.getTime() + staleDays * 24 * 60 * 60 * 1000);

    await prisma.candidateIntelligenceSnapshot.upsert({
      where: {
        candidateId_tenantId_track: {
          candidateId: state.candidateId,
          tenantId: state.tenantId,
          track: 'non-tech',
        },
      },
      create: {
        candidateId: state.candidateId,
        tenantId: state.tenantId,
        track: 'non-tech',
        skillsNormalized: [],
        roleType: null,
        seniorityBand: seniorityValidation.normalizedBand,
        location: null,
        activityRecencyDays: freshness.ageDays,
        computedAt: now,
        staleAfter,
        sourceSessionId: state.sessionId,
        sourceFingerprint: null,
        signalsJson: toJsonValue({
          signals,
          score,
          config: {
            minCorroboration: config.minCorroboration,
            maxSourceAgeDays: config.maxSourceAgeDays,
            seniorityMinConf: config.seniorityMinConf,
            scoreFloor: config.scoreFloor,
          },
        }),
      },
      update: {
        seniorityBand: seniorityValidation.normalizedBand,
        activityRecencyDays: freshness.ageDays,
        computedAt: now,
        staleAfter,
        sourceSessionId: state.sessionId,
        signalsJson: toJsonValue({
          signals,
          score,
          config: {
            minCorroboration: config.minCorroboration,
            maxSourceAgeDays: config.maxSourceAgeDays,
            seniorityMinConf: config.seniorityMinConf,
            scoreFloor: config.scoreFloor,
          },
        }),
      },
    });

    log.info(
      {
        candidateId: state.candidateId,
        sessionId: state.sessionId,
        tier: score.tier,
        overallScore: score.overallScore,
        shadow: config.shadow,
      },
      'Non-tech snapshot computed',
    );
  } catch (error) {
    log.warn(
      { error, candidateId: state.candidateId, sessionId: state.sessionId },
      'Non-tech enrichment failed (non-blocking)',
    );
  }

  return {};
}
