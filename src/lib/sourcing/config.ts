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
  };
}
