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

// ---------------------------------------------------------------------------
// Non-tech professional validation config
// ---------------------------------------------------------------------------

export function isNonTechEnabled(): boolean {
  return process.env.ENRICHMENT_NONTECH_ENABLED === 'true';
}

export function isNonTechShadow(): boolean {
  return process.env.ENRICHMENT_NONTECH_SHADOW !== 'false'; // default true
}

export function isNonTechEnforce(): boolean {
  return process.env.ENRICHMENT_NONTECH_ENFORCE === 'true';
}

export const DEFAULT_NONTECH_MIN_CORROBORATION = 2;
export const DEFAULT_NONTECH_MAX_SOURCE_AGE_DAYS = 180;
export const DEFAULT_NONTECH_SENIORITY_MIN_CONF = 0.8;
export const DEFAULT_NONTECH_SCORE_FLOOR = 0.80;

function parseNonTechFloat(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  log.warn({ envVar, raw, default: fallback }, `Invalid ${envVar}, using default`);
  return fallback;
}

function parseNonTechInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  log.warn({ envVar, raw, default: fallback }, `Invalid ${envVar}, using default`);
  return fallback;
}

export interface NonTechConfig {
  enabled: boolean;
  shadow: boolean;
  enforce: boolean;
  minCorroboration: number;
  maxSourceAgeDays: number;
  seniorityMinConf: number;
  scoreFloor: number;
}

export function getNonTechConfig(): NonTechConfig {
  return {
    enabled: isNonTechEnabled(),
    shadow: isNonTechShadow(),
    enforce: isNonTechEnforce(),
    minCorroboration: parseNonTechInt('ENRICHMENT_NONTECH_MIN_CORROBORATION', DEFAULT_NONTECH_MIN_CORROBORATION),
    maxSourceAgeDays: parseNonTechInt('ENRICHMENT_NONTECH_MAX_SOURCE_AGE_DAYS', DEFAULT_NONTECH_MAX_SOURCE_AGE_DAYS),
    seniorityMinConf: parseNonTechFloat('ENRICHMENT_NONTECH_SENIORITY_MIN_CONF', DEFAULT_NONTECH_SENIORITY_MIN_CONF),
    scoreFloor: parseNonTechFloat('ENRICHMENT_NONTECH_SCORE_FLOOR', DEFAULT_NONTECH_SCORE_FLOOR),
  };
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
