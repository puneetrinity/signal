export interface SourcingConfig {
  targetCount: number;
  minGoodEnough: number;
  jobMaxEnrich: number;
  maxSerpQueries: number;
  minDiscoveryPerRun: number;
  minDiscoveredInOutput: number;
  discoveredPromotionMinFitScore: number;
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
  strictRescueCount: number;
  strictRescueMinFitScore: number;
  countryGuardEnabled: boolean;
  // Discovery query generation + adaptive budget
  queryGenMode: 'deterministic' | 'hybrid';
  queryGroqTimeoutMs: number;
  queryGroqMaxRetries: number;
  adaptiveMinStrictAttempts: number;
  adaptiveStrictMinYield: number;
  adaptiveMinFallbackAttempts: number;
  adaptiveFallbackMinYield: number;
  // Location coverage + novelty + discovered enrich + dynamic budget
  locationCoverageFloor: number;
  noveltyWindowDays: number;
  noveltyEnabled: boolean;
  discoveredEnrichReserve: number;
  discoveredOrphanEnrichReserve: number;
  dynamicQueryMultiplier: number;
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

function parseNonNegativeIntSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
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
  const rawQueryMode = (process.env.SOURCING_QUERY_GEN_MODE || 'deterministic').toLowerCase();
  const queryGenMode: SourcingConfig['queryGenMode'] =
    rawQueryMode === 'hybrid' ? 'hybrid' : 'deterministic';

  return {
    targetCount: parseIntSafe(process.env.TARGET_COUNT, 100),
    minGoodEnough: parseIntSafe(process.env.MIN_GOOD_ENOUGH, 30),
    jobMaxEnrich: parseIntSafe(process.env.JOB_MAX_ENRICH, 50),
    maxSerpQueries: parseIntSafe(process.env.MAX_SERP_QUERIES, 3),
    minDiscoveryPerRun: parseNonNegativeIntSafe(process.env.SOURCE_MIN_DISCOVERY_PER_RUN, 20),
    minDiscoveredInOutput: parseNonNegativeIntSafe(process.env.SOURCE_MIN_DISCOVERED_IN_OUTPUT, 15),
    discoveredPromotionMinFitScore: clamp(
      parseFloatSafe(process.env.SOURCE_DISCOVERED_PROMOTION_MIN_FIT_SCORE, 0.45),
      0,
      1,
    ),
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
    strictRescueCount: parseIntSafe(process.env.SOURCE_STRICT_RESCUE_COUNT, 5),
    strictRescueMinFitScore: clamp(parseFloatSafe(process.env.SOURCE_STRICT_RESCUE_MIN_FIT_SCORE, 0.30), 0, 1),
    countryGuardEnabled: process.env.SOURCE_COUNTRY_GUARD_ENABLED !== 'false',
    // Discovery query generation + adaptive budget
    queryGenMode,
    queryGroqTimeoutMs: parseIntSafe(process.env.SOURCING_QUERY_GROQ_TIMEOUT_MS, 1500),
    queryGroqMaxRetries: parseIntSafe(process.env.SOURCING_QUERY_GROQ_MAX_RETRIES, 1),
    adaptiveMinStrictAttempts: parseIntSafe(process.env.SOURCING_ADAPTIVE_MIN_STRICT_ATTEMPTS, 2),
    adaptiveStrictMinYield: clamp(parseFloatSafe(process.env.SOURCING_ADAPTIVE_STRICT_MIN_YIELD, 0.12), 0, 1),
    adaptiveMinFallbackAttempts: parseIntSafe(process.env.SOURCING_ADAPTIVE_MIN_FALLBACK_ATTEMPTS, 2),
    adaptiveFallbackMinYield: clamp(parseFloatSafe(process.env.SOURCING_ADAPTIVE_FALLBACK_MIN_YIELD, 0.05), 0, 1),
    // Location coverage + novelty + discovered enrich + dynamic budget
    locationCoverageFloor: clamp(parseFloatSafe(process.env.SOURCE_LOCATION_COVERAGE_FLOOR, 0.40), 0, 1),
    noveltyWindowDays: parseIntSafe(process.env.SOURCE_NOVELTY_WINDOW_DAYS, 21),
    noveltyEnabled: process.env.SOURCE_NOVELTY_ENABLED === 'true',
    discoveredEnrichReserve: parseIntSafe(process.env.SOURCE_DISCOVERED_ENRICH_RESERVE, 5),
    discoveredOrphanEnrichReserve: parseIntSafe(process.env.SOURCE_DISCOVERED_ORPHAN_ENRICH_RESERVE, 10),
    dynamicQueryMultiplier: clamp(parseIntSafe(process.env.SOURCE_DYNAMIC_QUERY_MULTIPLIER, 2), 1, 5),
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
