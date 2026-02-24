# Track Classifier — Weekly Monitor Checklist

Run weekly (or before/after config changes like enabling Groq).

DB: `postgresql://postgres:***@crossover.proxy.rlwy.net:18271/railway`

---

## 1. Track Split: % tech / non_tech / blended

```sql
SELECT
  diagnostics::jsonb -> 'trackDecision' ->> 'track' AS track,
  COUNT(*) AS cnt,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM job_sourcing_requests
WHERE "requestedAt" >= NOW() - INTERVAL '7 days'
  AND diagnostics::jsonb -> 'trackDecision' IS NOT NULL
GROUP BY 1
ORDER BY cnt DESC;
```

**Expect**: Majority tech (mirrors current job mix). Non-tech should be non-zero if real non-tech jobs are submitted.

## 2. Low-Confidence Rate: % confidence < threshold

```sql
SELECT
  COUNT(*) FILTER (WHERE (diagnostics::jsonb -> 'trackDecision' ->> 'confidence')::numeric < 0.60) AS low_conf,
  COUNT(*) AS total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE (diagnostics::jsonb -> 'trackDecision' ->> 'confidence')::numeric < 0.60) / NULLIF(COUNT(*), 0), 1) AS low_conf_pct
FROM job_sourcing_requests
WHERE "requestedAt" >= NOW() - INTERVAL '7 days'
  AND diagnostics::jsonb -> 'trackDecision' IS NOT NULL;
```

**Expect**: < 10% low confidence. If high, keyword taxonomy may need expansion.

## 3. Source Latency p95 (before/after Groq enable)

Not directly in DB — check Railway logs or add structured log query:

```
[TrackResolver] resolveTrack completed
```

Alternatively, compare `resolvedAt` timestamp vs `requestedAt`:

```sql
SELECT
  PERCENTILE_CONT(0.95) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (
      (diagnostics::jsonb -> 'trackDecision' ->> 'resolvedAt')::timestamptz - "requestedAt"
    ))
  ) AS p95_resolve_sec
FROM job_sourcing_requests
WHERE "requestedAt" >= NOW() - INTERVAL '7 days'
  AND diagnostics::jsonb -> 'trackDecision' ->> 'resolvedAt' IS NOT NULL;
```

**Expect**: < 50ms deterministic-only. < 1500ms with Groq (timeout is 1200ms).

## 4. Error/Fallback Rate (Groq failures)

```sql
SELECT
  diagnostics::jsonb -> 'trackDecision' ->> 'method' AS method,
  COUNT(*) AS cnt
FROM job_sourcing_requests
WHERE "requestedAt" >= NOW() - INTERVAL '7 days'
  AND diagnostics::jsonb -> 'trackDecision' IS NOT NULL
GROUP BY 1
ORDER BY cnt DESC;
```

**Expect** (Groq disabled): 100% `deterministic`.
**Expect** (Groq enabled): Mostly `deterministic`, some `deterministic+groq` for low-confidence cases. Zero `groq`-only (not a valid method).

If `deterministic` count is unexpectedly high when Groq is enabled, check circuit breaker:

```
Redis keys: track:groq:cb:failures, track:groq:cb:open_until
```

## 5. Recruiter Quality Proxy: Shortlist Rate by Track

Requires downstream shortlist data. Placeholder query (adapt when shortlist tracking is available):

```sql
-- Stub: join with shortlist/feedback table when available
SELECT
  diagnostics::jsonb -> 'trackDecision' ->> 'track' AS track,
  COUNT(*) AS total_requests,
  -- COUNT(*) FILTER (WHERE shortlisted) AS shortlisted,
  -- ROUND(100.0 * shortlisted / total_requests, 1) AS shortlist_pct
  'N/A — awaiting shortlist tracking' AS shortlist_rate
FROM job_sourcing_requests
WHERE "requestedAt" >= NOW() - INTERVAL '7 days'
  AND diagnostics::jsonb -> 'trackDecision' IS NOT NULL
GROUP BY 1;
```

---

## Rollback / Kill Switches

| Action | How |
|--------|-----|
| Disable Groq fallback | `TRACK_GROQ_ENABLED=false` on signal + sourcing worker |
| Force all-tech (pre-classifier behavior) | Remove all `TRACK_*` env vars (defaults to tech, conf 0.30) |
| Circuit breaker stuck open | Delete Redis keys `track:groq:cb:*` |
