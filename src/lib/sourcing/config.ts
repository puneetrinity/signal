export interface SourcingConfig {
  targetCount: number;
  minGoodEnough: number;
  jobMaxEnrich: number;
  maxSerpQueries: number;
  initialEnrichCount: number;
  snapshotStaleDays: number;
  staleRefreshMaxPerRun: number;
  qualityTopK: number;
  qualityMinAvgFit: number;
  qualityThreshold: number;
  qualityMinCountAbove: number;
  dailySerpCapPerTenant: number;
  // Discovery + tier assembly
  minDiscoveryShareLowQuality: number;
  maxDiscoveryShare: number;
  minStrictMatchesBeforeExpand: number;
  bestMatchesMinFitScore: number;
  // Track classifier
  trackClassifierVersion: string;
  trackLowConfThreshold: number;
  trackBlendThreshold: number;
  trackGroqEnabled: boolean;
  trackGroqTimeoutMs: number;
  trackGroqMaxRetries: number;
  trackGroqCacheTtlDays: number;
  trackCbThreshold: number;
  trackCbWindowSec: number;
  trackCbCooldownSec: number;
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function parseFloatSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getSourcingConfig(): SourcingConfig {
  return {
    targetCount: parseIntSafe(process.env.TARGET_COUNT, 100),
    minGoodEnough: parseIntSafe(process.env.MIN_GOOD_ENOUGH, 30),
    jobMaxEnrich: parseIntSafe(process.env.JOB_MAX_ENRICH, 50),
    maxSerpQueries: parseIntSafe(process.env.MAX_SERP_QUERIES, 3),
    initialEnrichCount: parseIntSafe(process.env.INITIAL_ENRICH_COUNT, 20),
    snapshotStaleDays: parseIntSafe(process.env.SNAPSHOT_STALE_DAYS, 30),
    staleRefreshMaxPerRun: parseIntSafe(process.env.STALE_REFRESH_MAX_PER_RUN, 10),
    qualityTopK: parseIntSafe(process.env.SOURCE_QUALITY_TOP_K, 20),
    qualityMinAvgFit: clamp(parseFloatSafe(process.env.SOURCE_QUALITY_MIN_AVG_FIT, 0.45), 0, 1),
    qualityThreshold: clamp(parseFloatSafe(process.env.SOURCE_QUALITY_THRESHOLD, 0.55), 0, 1),
    qualityMinCountAbove: parseIntSafe(process.env.SOURCE_QUALITY_MIN_COUNT_ABOVE, 15),
    dailySerpCapPerTenant: parseIntSafe(process.env.SOURCE_DAILY_SERP_CAP_PER_TENANT, 0),
    // Discovery + tier assembly
    minDiscoveryShareLowQuality: clamp(parseFloatSafe(process.env.SOURCE_MIN_DISCOVERY_SHARE_LOW_QUALITY, 0.40), 0, 1),
    maxDiscoveryShare: clamp(parseFloatSafe(process.env.SOURCE_MAX_DISCOVERY_SHARE, 0.70), 0, 1),
    minStrictMatchesBeforeExpand: parseIntSafe(process.env.SOURCE_MIN_STRICT_MATCHES_BEFORE_EXPAND, 20),
    bestMatchesMinFitScore: clamp(parseFloatSafe(process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE, 0.45), 0, 1),
    // Track classifier
    trackClassifierVersion: process.env.TRACK_CLASSIFIER_VERSION || 'v1',
    trackLowConfThreshold: clamp(parseFloatSafe(process.env.TRACK_LOW_CONF_THRESHOLD, 0.60), 0, 1),
    trackBlendThreshold: clamp(parseFloatSafe(process.env.TRACK_BLEND_THRESHOLD, 0.15), 0, 1),
    trackGroqEnabled: process.env.TRACK_GROQ_ENABLED !== 'false',
    trackGroqTimeoutMs: parseIntSafe(process.env.TRACK_GROQ_TIMEOUT_MS, 1200),
    trackGroqMaxRetries: parseIntSafe(process.env.TRACK_GROQ_MAX_RETRIES, 1),
    trackGroqCacheTtlDays: parseIntSafe(process.env.TRACK_GROQ_CACHE_TTL_DAYS, 30),
    trackCbThreshold: parseIntSafe(process.env.TRACK_CB_THRESHOLD, 5),
    trackCbWindowSec: parseIntSafe(process.env.TRACK_CB_WINDOW_SEC, 300),
    trackCbCooldownSec: parseIntSafe(process.env.TRACK_CB_COOLDOWN_SEC, 60),
  };
}
