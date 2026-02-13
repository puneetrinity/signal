/**
 * Shared enrichment configuration helpers.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('EnrichmentConfig');

export const DEFAULT_ENRICHMENT_MIN_CONFIDENCE = 0.25;

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
