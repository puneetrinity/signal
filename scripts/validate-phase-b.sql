-- Phase B Validation Queries
-- Run after completing 30-50 enrichments across cohorts

-- ============================================
-- 0) Baseline filter (last 7 days, completed/failed only)
-- ============================================
WITH sessions AS (
  SELECT *
  FROM enrichment_sessions
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
    AND status IN ('completed','failed')
    AND "runTrace" IS NOT NULL
)
SELECT COUNT(*) AS total_sessions FROM sessions;

-- ============================================
-- 1) Core outcome metrics
-- ============================================
-- 0-identities rate + avg queries + avg platforms
WITH sessions AS (
  SELECT *
  FROM enrichment_sessions
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
    AND status IN ('completed','failed')
    AND "runTrace" IS NOT NULL
)
SELECT
  COUNT(*) AS runs,
  AVG((("runTrace"->'final'->>'totalQueriesExecuted')::int)) AS avg_queries,
  AVG((("runTrace"->'final'->>'platformsQueried')::int)) AS avg_platforms,
  AVG((("runTrace"->'final'->>'platformsWithHits')::int)) AS avg_platforms_with_hits,
  AVG((("runTrace"->'final'->>'identitiesPersisted')::int)) AS avg_identities_persisted,
  AVG(CASE WHEN ("runTrace"->'final'->>'identitiesPersisted')::int = 0 THEN 1 ELSE 0 END)::float AS zero_identities_rate
FROM sessions;

-- bestConfidence distribution (p50/p90)
WITH sessions AS (
  SELECT
    NULLIF(("runTrace"->'final'->>'bestConfidence')::float, NULL) AS best_conf
  FROM enrichment_sessions
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
    AND status IN ('completed','failed')
    AND "runTrace" IS NOT NULL
)
SELECT
  COUNT(*) AS runs,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY best_conf) AS p50_best_conf,
  percentile_cont(0.90) WITHIN GROUP (ORDER BY best_conf) AS p90_best_conf
FROM sessions
WHERE best_conf IS NOT NULL;

-- ============================================
-- 2) Provider mix + rate-limited rate
-- ============================================
-- How often each provider appears in providersUsed
WITH sessions AS (
  SELECT "runTrace"
  FROM enrichment_sessions
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
    AND status IN ('completed','failed')
    AND "runTrace" IS NOT NULL
),
expanded AS (
  SELECT
    p.key AS provider,
    (p.value)::int AS platforms_count
  FROM sessions
  CROSS JOIN LATERAL jsonb_each_text("runTrace"->'final'->'providersUsed') p
)
SELECT
  provider,
  SUM(platforms_count) AS platform_mentions
FROM expanded
GROUP BY provider
ORDER BY platform_mentions DESC;

-- Rate-limited providers frequency
WITH sessions AS (
  SELECT "runTrace"
  FROM enrichment_sessions
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
    AND status IN ('completed','failed')
    AND "runTrace" IS NOT NULL
),
expanded AS (
  SELECT jsonb_array_elements_text("runTrace"->'final'->'rateLimitedProviders') AS provider
  FROM sessions
  WHERE "runTrace"->'final' ? 'rateLimitedProviders'
)
SELECT provider, COUNT(*) AS runs_rate_limited
FROM expanded
GROUP BY provider
ORDER BY runs_rate_limited DESC;

-- ============================================
-- 3) Platform hit-rate + "budget burners"
-- ============================================
-- Per-platform hit rate (identitiesFound > 0)
WITH sessions AS (
  SELECT "runTrace"
  FROM enrichment_sessions
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
    AND status IN ('completed','failed')
    AND "runTrace" IS NOT NULL
),
platforms AS (
  SELECT
    p.key AS platform,
    (p.value->>'identitiesFound')::int AS identities_found,
    (p.value->>'queriesExecuted')::int AS queries_executed
  FROM sessions
  CROSS JOIN LATERAL jsonb_each("runTrace"->'platformResults') p
)
SELECT
  platform,
  COUNT(*) AS runs_queried,
  SUM(CASE WHEN identities_found > 0 THEN 1 ELSE 0 END) AS runs_with_hits,
  ROUND(SUM(CASE WHEN identities_found > 0 THEN 1 ELSE 0 END)::numeric / COUNT(*), 4) AS hit_rate,
  AVG(queries_executed)::numeric(10,2) AS avg_queries_when_queried
FROM platforms
GROUP BY platform
ORDER BY hit_rate DESC, runs_queried DESC;

-- Platforms that burn queries with no hits
WITH sessions AS (
  SELECT "runTrace"
  FROM enrichment_sessions
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
    AND status IN ('completed','failed')
    AND "runTrace" IS NOT NULL
),
platforms AS (
  SELECT
    p.key AS platform,
    (p.value->>'identitiesFound')::int AS identities_found,
    (p.value->>'queriesExecuted')::int AS queries_executed
  FROM sessions
  CROSS JOIN LATERAL jsonb_each("runTrace"->'platformResults') p
)
SELECT
  platform,
  SUM(CASE WHEN identities_found = 0 THEN queries_executed ELSE 0 END) AS total_queries_wasted,
  SUM(queries_executed) AS total_queries,
  ROUND(
    SUM(CASE WHEN identities_found = 0 THEN queries_executed ELSE 0 END)::numeric
    / NULLIF(SUM(queries_executed),0),
    4
  ) AS wasted_ratio
FROM platforms
GROUP BY platform
HAVING SUM(queries_executed) > 0
ORDER BY wasted_ratio DESC, total_queries_wasted DESC;

-- ============================================
-- 4) Gate regression / rejection spikes
-- ============================================
-- Rejected queries by platform (requires diagnostics in platformResults)
WITH diag AS (
  SELECT
    p.key AS platform,
    (p.value->'diagnostics'->>'queriesAttempted')::int AS attempted,
    (p.value->'diagnostics'->>'queriesRejected')::int AS rejected
  FROM enrichment_sessions s
  CROSS JOIN LATERAL jsonb_each(s."runTrace"->'platformResults') p
  WHERE s."createdAt" > NOW() - INTERVAL '7 days'
    AND s.status IN ('completed','failed')
    AND s."runTrace" IS NOT NULL
    AND (p.value ? 'diagnostics')
)
SELECT
  platform,
  AVG(rejected::numeric / NULLIF(attempted,0))::numeric(10,4) AS avg_reject_rate,
  SUM(rejected) AS total_rejected,
  SUM(attempted) AS total_attempted
FROM diag
GROUP BY platform
ORDER BY avg_reject_rate DESC, total_rejected DESC;

-- ============================================
-- 5) Normalization regression check
-- ============================================
-- ASCII-only names that triggered _folded (regression signal)
SELECT
  id,
  "createdAt",
  "runTrace"->'seed'->>'nameHint' AS name_hint,
  "runTrace"->'final'->'variantStats'->'executed'->'raw' AS executed_variants
FROM enrichment_sessions
WHERE "createdAt" > NOW() - INTERVAL '7 days'
  AND status IN ('completed','failed')
  AND "runTrace"->'final'->'variantStats'->'executed'->'raw' @> '["name:full_folded"]'
  AND ("runTrace"->'seed'->>'nameHint') ~ '^[\x00-\x7F]+$'
ORDER BY "createdAt" DESC;

-- ============================================
-- 6) Variant stats summary (canonical aggregation)
-- ============================================
WITH sessions AS (
  SELECT "runTrace"
  FROM enrichment_sessions
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
    AND status IN ('completed','failed')
    AND "runTrace" IS NOT NULL
    AND "runTrace"->'final'->'variantStats' IS NOT NULL
)
SELECT
  'executed' AS type,
  v.key AS canonical_variant,
  SUM((v.value)::int) AS total_count
FROM sessions
CROSS JOIN LATERAL jsonb_each_text("runTrace"->'final'->'variantStats'->'executed'->'canonical') v
GROUP BY v.key

UNION ALL

SELECT
  'rejected' AS type,
  v.key AS canonical_variant,
  SUM((v.value)::int) AS total_count
FROM sessions
CROSS JOIN LATERAL jsonb_each_text("runTrace"->'final'->'variantStats'->'rejected'->'canonical') v
GROUP BY v.key

ORDER BY type, total_count DESC;
