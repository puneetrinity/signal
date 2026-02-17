export interface SourcingConfig {
  targetCount: number;
  minGoodEnough: number;
  jobMaxEnrich: number;
  maxSerpQueries: number;
  initialEnrichCount: number;
  snapshotStaleDays: number;
  staleRefreshMaxPerRun: number;
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
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
  };
}
