/**
 * Non-tech professional validation scoring.
 *
 * Deterministic tier assignment with strict gate order:
 *   1. corroboration >= minCorroboration → fail = Tier 3
 *   2. contradictions === 0 → fail = Tier 3
 *   3. freshnessDays <= maxSourceAgeDays → fail = Tier 2
 *   4. seniorityConfidence >= seniorityMinConf → fail = Tier 2
 *   5. overallScore >= scoreFloor → fail = Tier 2
 *
 * All gates pass = Tier 1.
 */

import type { NonTechConfig } from '../config';
import type { NonTechSignals, NonTechScore, NonTechGateResults } from './types';

function computeSerpContextScore(
  signals: NonTechSignals,
  maxSourceAgeDays: number,
): number {
  let score = 0;
  const serpAgeDays = signals.serpContext.ageDays;
  if (serpAgeDays !== null) {
    const freshnessWindow = Math.max(1, maxSourceAgeDays);
    const freshnessRatio = Math.max(0, 1 - serpAgeDays / freshnessWindow);
    score += freshnessRatio * 0.07;
  }

  if (signals.serpContext.locationConsistency === 'match') score += 0.03;
  else if (signals.serpContext.locationConsistency === 'mismatch') score -= 0.03;

  return Math.max(0, Math.min(0.10, score));
}

function computeOverallScore(
  signals: NonTechSignals,
  maxSourceAgeDays: number,
): number {
  let score = 0;

  // Company corroboration: up to 0.35
  const corrobCapped = Math.min(signals.companyAlignment.corroborationCount, 5);
  score += (corrobCapped / 5) * 0.35;

  // Seniority confidence: up to 0.20
  score += signals.seniorityValidation.confidence * 0.20;

  // Freshness: up to 0.25 (inversely proportional to age)
  if (signals.freshness.ageDays !== null && !signals.freshness.stale) {
    // 0 days = full score, maxSourceAgeDays days = 0
    const freshnessWindow = Math.max(1, maxSourceAgeDays);
    const freshnessRatio = Math.max(0, 1 - signals.freshness.ageDays / freshnessWindow);
    score += freshnessRatio * 0.25;
  }

  // No contradictions bonus: 0.20
  if (signals.contradictions.count === 0) {
    score += 0.20;
  }

  // Lightweight SERP-stage signal: recency + locale/location consistency.
  score += computeSerpContextScore(signals, maxSourceAgeDays);

  const bounded = Math.max(0, Math.min(1, score));
  return Math.round(bounded * 100) / 100;
}

export function scoreNonTech(
  signals: NonTechSignals,
  config: NonTechConfig,
): NonTechScore {
  const overallScore = computeOverallScore(signals, config.maxSourceAgeDays);

  const gateResults: NonTechGateResults = {
    corroboration: signals.companyAlignment.corroborationCount >= config.minCorroboration,
    contradictions: signals.contradictions.count === 0,
    freshness: !signals.freshness.stale,
    seniorityConfidence: signals.seniorityValidation.confidence >= config.seniorityMinConf,
    scoreFloor: overallScore >= config.scoreFloor,
  };

  const topReasons: string[] = [];
  let tier: 1 | 2 | 3;

  // Hard fails → Tier 3
  if (!gateResults.corroboration) {
    tier = 3;
    topReasons.push(`Corroboration ${signals.companyAlignment.corroborationCount} < ${config.minCorroboration}`);
  } else if (!gateResults.contradictions) {
    tier = 3;
    topReasons.push(`${signals.contradictions.count} contradiction(s) found`);
  }
  // Soft fails → Tier 2
  else if (!gateResults.freshness) {
    tier = 2;
    topReasons.push(`Data age ${signals.freshness.ageDays}d > ${config.maxSourceAgeDays}d`);
  } else if (!gateResults.seniorityConfidence) {
    tier = 2;
    topReasons.push(`Seniority confidence ${signals.seniorityValidation.confidence} < ${config.seniorityMinConf}`);
  } else if (!gateResults.scoreFloor) {
    tier = 2;
    topReasons.push(`Score ${overallScore} < floor ${config.scoreFloor}`);
  }
  // All pass → Tier 1
  else {
    tier = 1;
    topReasons.push('All gates passed');
  }

  return { tier, overallScore, topReasons, gateResults };
}
