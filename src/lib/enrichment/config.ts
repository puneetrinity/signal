/**
 * Shared enrichment configuration helpers.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('EnrichmentConfig');

export const DEFAULT_ENRICHMENT_MIN_CONFIDENCE = 0.25;
export const DEFAULT_TIER1_ENFORCE_MIN_CONFIDENCE = 0.83;

/**
 * Canonical confidence threshold used for discovery filtering and persistence guards.
 */
export function getEnrichmentMinConfidenceThreshold(
  source: string = 'Enrichment'
): number {
  const raw = process.env.ENRICHMENT_MIN_CONFIDENCE;
  if (!raw) return DEFAULT_ENRICHMENT_MIN_CONFIDENCE;

  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
    return parsed;
  }

  log.warn(
    { source, raw, default: DEFAULT_ENRICHMENT_MIN_CONFIDENCE },
    'Invalid ENRICHMENT_MIN_CONFIDENCE, using default'
  );
  return DEFAULT_ENRICHMENT_MIN_CONFIDENCE;
}

/**
 * Strict-subset Tier-1 enforce threshold used when ENRICHMENT_TIER1_ENFORCE=true.
 */
export function getTier1EnforceMinConfidenceThreshold(
  source: string = 'Tier1Enforce'
): number {
  const raw = process.env.ENRICHMENT_TIER1_ENFORCE_MIN_CONFIDENCE;
  if (!raw) return DEFAULT_TIER1_ENFORCE_MIN_CONFIDENCE;

  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
    return parsed;
  }

  log.warn(
    { source, raw, default: DEFAULT_TIER1_ENFORCE_MIN_CONFIDENCE },
    'Invalid ENRICHMENT_TIER1_ENFORCE_MIN_CONFIDENCE, using default'
  );
  return DEFAULT_TIER1_ENFORCE_MIN_CONFIDENCE;
}
