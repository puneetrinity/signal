export interface SourcingConfig {
  targetCount: number;
  minGoodEnough: number;
  jobMaxEnrich: number;
  maxSerpQueries: number;
  // Stage-2 exclusion: skip re-buying people refreshed within freshDays.
  excludeKnownEnabled: boolean;
  excludeKnownFreshDays: number;
  excludeKnownMax: number;
  // Stage-3 two-layer pool read: slim full-pool projection (Layer 1) keeps
  // gates/dedup/metrics truthful at any pool size; only vector top-N plus the
  // recent-K embedding-lag lane (Layer 2) is hydrated and ranked.
  twoLayerPoolEnabled: boolean;
  poolRecentK: number;
  poolLayer1Cap: number;
  poolFallbackHydrateCap: number;
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
  countryGuardSerpLocaleEnabled: boolean;
  fitScoreEpsilon: number;
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
  // Role classifier (Groq LLM fallback for role family detection)
  roleGroqEnabled: boolean;
  roleGroqShadowMode: boolean;
  roleGroqTimeoutMs: number;
  roleGroqMaxRetries: number;
  roleGroqCacheTtlDays: number;
  roleCbThreshold: number;
  roleCbWindowSec: number;
  roleCbCooldownSec: number;
  // Location canonicalization (Groq LLM fallback)
  locationGroqEnabled: boolean;
  locationGroqShadowMode: boolean;
  locationGroqTimeoutMs: number;
  locationGroqMaxRetries: number;
  locationGroqCacheTtlDays: number;
  locationCbThreshold: number;
  locationCbWindowSec: number;
  locationCbCooldownSec: number;
  // Post-enrichment rerank
  rerankAfterEnrichment: boolean;
  rerankDelayMs: number;
  // Location soft boost (track-specific)
  locationBoostWeightTech: number;
  locationBoostWeightBlended: number;
  locationBoostWeightNonTech: number;
  // Sourcing strategy
  sourcingStrategy: 'pool_first' | 'discovery_first' | 'adaptive';
  // Unknown-location controls
  unknownLaneFitFloorNonTech: number;
  unknownLocationPenaltyMultiplier: number;
  nonTechLocationMismatchPenaltyMultiplier: number;
  unknownAssemblyDiscoveredReserveTech: number;
  // Top-20 quality guards (tech only)
  techTop20GuardsEnabled: boolean;
  techTop20RoleMin: number;
  techTop20RoleCap: number;
  techTop20SkillMin: number;
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

// Back-compat scale migration. fit/role/skill thresholds were historically expressed as 0-1
// fractions, but fitScore is 0-100 and component scores (roleScore 0-15, skillScore 0-25) use
// their own maxima. Any value in (0,1] is treated as a LEGACY FRACTION of `maxScale` and upgraded;
// values already on-scale pass through. This keeps old Railway 0-1 env overrides working after the
// scale fix — without it, a stale `SOURCE_QUALITY_THRESHOLD=0.55` would silently stay broken.
function scaleThreshold(raw: number, maxScale: number): number {
  const v = raw > 0 && raw <= 1 ? raw * maxScale : raw;
  return clamp(v, 0, maxScale);
}

export function getSourcingConfig(): SourcingConfig {
  const rawQueryMode = (process.env.SOURCING_QUERY_GEN_MODE || 'deterministic').toLowerCase();
  const queryGenMode: SourcingConfig['queryGenMode'] =
    rawQueryMode === 'hybrid' ? 'hybrid' : 'deterministic';

  const globalLocationBoostWeight = clamp(
    parseFloatSafe(process.env.SOURCE_LOCATION_BOOST_WEIGHT, 0),
    0,
    0.20,
  );

  return {
    targetCount: parseIntSafe(process.env.TARGET_COUNT, 100),
    minGoodEnough: parseIntSafe(process.env.MIN_GOOD_ENOUGH, 30),
    jobMaxEnrich: parseIntSafe(process.env.JOB_MAX_ENRICH, 50),
    maxSerpQueries: parseIntSafe(process.env.MAX_SERP_QUERIES, 3),
    excludeKnownEnabled: process.env.SOURCE_EXCLUDE_KNOWN_ENABLED !== 'false',
    excludeKnownFreshDays: parseIntSafe(process.env.SOURCE_EXCLUDE_KNOWN_FRESH_DAYS, 14),
    excludeKnownMax: parseIntSafe(process.env.SOURCE_EXCLUDE_KNOWN_MAX, 2000),
    twoLayerPoolEnabled: process.env.SOURCE_TWO_LAYER_POOL_ENABLED === 'true',
    poolRecentK: parseIntSafe(process.env.SOURCE_POOL_RECENT_K, 150),
    poolLayer1Cap: parseIntSafe(process.env.SOURCE_POOL_LAYER1_CAP, 50000),
    poolFallbackHydrateCap: parseIntSafe(process.env.SOURCE_POOL_FALLBACK_HYDRATE_CAP, 2000),
    minDiscoveryPerRun: parseNonNegativeIntSafe(process.env.SOURCE_MIN_DISCOVERY_PER_RUN, 20),
    minDiscoveredInOutput: parseNonNegativeIntSafe(process.env.SOURCE_MIN_DISCOVERED_IN_OUTPUT, 15),
    discoveredPromotionMinFitScore: scaleThreshold(
      parseFloatSafe(process.env.SOURCE_DISCOVERED_PROMOTION_MIN_FIT_SCORE, 45),
      100,
    ),
    initialEnrichCount: parseIntSafe(process.env.INITIAL_ENRICH_COUNT, 20),
    snapshotStaleDays: parseIntSafe(process.env.SNAPSHOT_STALE_DAYS, 30),
    staleRefreshMaxPerRun: parseIntSafe(process.env.STALE_REFRESH_MAX_PER_RUN, 10),
    qualityTopK: parseIntSafe(process.env.SOURCE_QUALITY_TOP_K, 20),
    qualityMinAvgFit: scaleThreshold(parseFloatSafe(process.env.SOURCE_QUALITY_MIN_AVG_FIT, 45), 100),
    qualityThreshold: scaleThreshold(parseFloatSafe(process.env.SOURCE_QUALITY_THRESHOLD, 55), 100),
    qualityMinCountAbove: parseIntSafe(process.env.SOURCE_QUALITY_MIN_COUNT_ABOVE, 15),
    dailySerpCapPerTenant: parseIntSafe(process.env.SOURCE_DAILY_SERP_CAP_PER_TENANT, 0),
    // Discovery + tier assembly
    minDiscoveryShareLowQuality: clamp(parseFloatSafe(process.env.SOURCE_MIN_DISCOVERY_SHARE_LOW_QUALITY, 0.40), 0, 1),
    maxDiscoveryShare: clamp(parseFloatSafe(process.env.SOURCE_MAX_DISCOVERY_SHARE, 0.70), 0, 1),
    minStrictMatchesBeforeExpand: parseIntSafe(process.env.SOURCE_MIN_STRICT_MATCHES_BEFORE_EXPAND, 20),
    bestMatchesMinFitScore: scaleThreshold(parseFloatSafe(process.env.SOURCE_BEST_MATCHES_MIN_FIT_SCORE, 60), 100),
    strictRescueCount: parseIntSafe(process.env.SOURCE_STRICT_RESCUE_COUNT, 5),
    strictRescueMinFitScore: scaleThreshold(parseFloatSafe(process.env.SOURCE_STRICT_RESCUE_MIN_FIT_SCORE, 30), 100),
    countryGuardEnabled: process.env.SOURCE_COUNTRY_GUARD_ENABLED !== 'false',
    countryGuardSerpLocaleEnabled: process.env.SOURCE_COUNTRY_GUARD_SERP_LOCALE_ENABLED === 'true',
    // epsilon is a fitScore *delta* (0-100 scale); legacy 0.03 upgrades to 3 points.
    fitScoreEpsilon: clamp(scaleThreshold(parseFloatSafe(process.env.SOURCE_FIT_SCORE_EPSILON, 3), 100), 0, 20),
    // Discovery query generation + adaptive budget
    queryGenMode,
    queryGroqTimeoutMs: parseIntSafe(process.env.SOURCING_QUERY_GROQ_TIMEOUT_MS, 2500),
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
    // Role classifier (Groq LLM fallback for role family detection)
    roleGroqEnabled: process.env.ROLE_GROQ_ENABLED === 'true',
    roleGroqShadowMode: process.env.ROLE_GROQ_SHADOW_MODE !== 'false',
    roleGroqTimeoutMs: parseIntSafe(process.env.ROLE_GROQ_TIMEOUT_MS, 1500),
    roleGroqMaxRetries: parseIntSafe(process.env.ROLE_GROQ_MAX_RETRIES, 1),
    roleGroqCacheTtlDays: parseIntSafe(process.env.ROLE_GROQ_CACHE_TTL_DAYS, 30),
    roleCbThreshold: parseIntSafe(process.env.ROLE_CB_THRESHOLD, 5),
    roleCbWindowSec: parseIntSafe(process.env.ROLE_CB_WINDOW_SEC, 300),
    roleCbCooldownSec: parseIntSafe(process.env.ROLE_CB_COOLDOWN_SEC, 60),
    // Location canonicalization (Groq LLM fallback)
    locationGroqEnabled: process.env.LOCATION_GROQ_ENABLED === 'true',
    locationGroqShadowMode: process.env.LOCATION_GROQ_SHADOW_MODE !== 'false',
    locationGroqTimeoutMs: parseIntSafe(process.env.LOCATION_GROQ_TIMEOUT_MS, 1500),
    locationGroqMaxRetries: parseIntSafe(process.env.LOCATION_GROQ_MAX_RETRIES, 1),
    locationGroqCacheTtlDays: parseIntSafe(process.env.LOCATION_GROQ_CACHE_TTL_DAYS, 30),
    locationCbThreshold: parseIntSafe(process.env.LOCATION_CB_THRESHOLD, 5),
    locationCbWindowSec: parseIntSafe(process.env.LOCATION_CB_WINDOW_SEC, 300),
    locationCbCooldownSec: parseIntSafe(process.env.LOCATION_CB_COOLDOWN_SEC, 60),
    // Post-enrichment rerank
    rerankAfterEnrichment: process.env.SOURCE_RERANK_AFTER_ENRICHMENT !== 'false',
    rerankDelayMs: clamp(parseIntSafe(process.env.SOURCE_RERANK_DELAY_MS, 90_000), 10_000, 300_000),
    // Location soft boost (track-specific; fallback to global env for backward compatibility)
    locationBoostWeightTech: clamp(
      parseFloatSafe(process.env.SOURCE_LOCATION_BOOST_WEIGHT_TECH, globalLocationBoostWeight || 0.10),
      0,
      0.20,
    ),
    locationBoostWeightBlended: clamp(
      parseFloatSafe(process.env.SOURCE_LOCATION_BOOST_WEIGHT_BLENDED, globalLocationBoostWeight || 0.08),
      0,
      0.20,
    ),
    locationBoostWeightNonTech: clamp(
      parseFloatSafe(process.env.SOURCE_LOCATION_BOOST_WEIGHT_NON_TECH, globalLocationBoostWeight || 0.03),
      0,
      0.15,
    ),
    // Sourcing strategy: pool_first | discovery_first | adaptive (default)
    sourcingStrategy: (() => {
      const raw = (process.env.SOURCE_STRATEGY || 'adaptive').toLowerCase();
      if (raw === 'pool_first') return 'pool_first' as const;
      if (raw === 'discovery_first') return 'discovery_first' as const;
      return 'adaptive' as const;
    })(),
    // Unknown-location controls
    unknownLaneFitFloorNonTech: scaleThreshold(parseFloatSafe(process.env.SOURCE_UNKNOWN_LANE_FIT_FLOOR_NON_TECH, 40), 100),
    unknownLocationPenaltyMultiplier: clamp(parseFloatSafe(process.env.SOURCE_UNKNOWN_LOCATION_PENALTY_MULTIPLIER, 0.85), 0.5, 1),
    nonTechLocationMismatchPenaltyMultiplier: clamp(
      parseFloatSafe(process.env.SOURCE_NON_TECH_LOCATION_MISMATCH_PENALTY_MULTIPLIER, 0.75),
      0.4,
      1,
    ),
    unknownAssemblyDiscoveredReserveTech: parseNonNegativeIntSafe(process.env.SOURCE_UNKNOWN_ASSEMBLY_DISCOVERED_RESERVE_TECH, 2),
    // Top-20 quality guards (tech only)
    techTop20GuardsEnabled: process.env.SOURCE_TECH_TOP20_GUARDS_ENABLED !== 'false',
    techTop20RoleMin: scaleThreshold(parseFloatSafe(process.env.SOURCE_TECH_TOP20_ROLE_MIN, 5.25), 15), // vs roleScore 0-15
    techTop20RoleCap: clamp(parseNonNegativeIntSafe(process.env.SOURCE_TECH_TOP20_ROLE_CAP, 1), 0, 5),
    techTop20SkillMin: scaleThreshold(parseFloatSafe(process.env.SOURCE_TECH_TOP20_SKILL_MIN, 2.5), 25), // vs skillScore 0-25
  };
}

export function getLocationBoostWeight(config: SourcingConfig, track?: string): number {
  switch (track) {
    case 'tech':
      return config.locationBoostWeightTech;
    case 'blended':
      return config.locationBoostWeightBlended;
    case 'non_tech':
      return config.locationBoostWeightNonTech;
    default:
      return config.locationBoostWeightTech;
  }
}
