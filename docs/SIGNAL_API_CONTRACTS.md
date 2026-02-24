# Signal API Contracts (Canonical — Phase 4)

Frozen before Phase 5 VantaHire integration. Any change requires a version bump.

---

## Auth: RS256 Service JWT

All `/api/v3/*` routes require an RS256-signed JWT in the `Authorization: Bearer <token>` header.

### Inbound JWT (VantaHire → Signal)

```
Header: { alg: "RS256", typ: "JWT", kid: "<key-id>" }
Payload:
  iss: "vantahire"          (required, verified)
  aud: "signal"             (required, verified)
  sub: string               (required — e.g. "vantahire-api")
  tenant_id: string         (required — tenant isolation key)
  scopes: string            (required — space-delimited, e.g. "jobs:source enrich:batch")
  jti: string               (required — unique per request, replay-guarded via Redis)
  actor_type: string         (optional — defaults to "service")
  request_id: string         (optional — for tracing)
  iat: number               (required)
  nbf: number               (required)
  exp: number               (required — TTL for jti dedup)
```

### Error Responses

| Condition | Status | Error |
|-----------|--------|-------|
| No/missing Authorization header | 401 | `Missing or invalid Authorization header` |
| Malformed/invalid token | 401 | `Invalid token: <reason>` |
| Wrong `aud` | 403 | `Invalid token: unexpected "aud" claim value` |
| Wrong `iss` | 403 | `Invalid token: unexpected "iss" claim value` |
| Missing required scope | 403 | `Missing required scope: <scope>` |
| Replayed `jti` | 401 | `Token already used (replay detected)` |
| Redis unavailable | 503 | `Service temporarily unavailable (replay guard offline)` |

---

## 1. POST /api/v3/jobs/:id/source

Triggers a sourcing run for a job. Idempotent on `(tenantId, externalJobId, jobContextHash)`.

**Scope:** `jobs:source`

### Request

```
POST /api/v3/jobs/{externalJobId}/source
Content-Type: application/json

{
  "jobContext": {
    "jdDigest": string,          // required — JD summary text
    "location": string?,         // optional
    "experienceYears": number?,  // optional
    "education": string?,        // optional
    "jobTrackHint": "auto" | "tech" | "non_tech"?,  // optional — track classification hint
    "jobTrackHintSource": "system" | "user"?,        // optional — who set the hint
    "jobTrackHintReason": string?                    // optional — why the hint was set
  },
  "callbackUrl": string          // required — valid URL, receives callback on completion
}
```

**Note:** `jobTrackHint`, `jobTrackHintSource`, and `jobTrackHintReason` are excluded from `jobContextHash`. Same job context with different hints = same request (idempotent).

### Response — New Request (202)

```json
{
  "success": true,
  "requestId": "cmlq707lw0000p75gzhj3ij99",
  "status": "queued",
  "idempotent": false,
  "trackDecision": {
    "track": "tech",
    "confidence": 0.92,
    "method": "deterministic",
    "classifierVersion": "v1"
  }
}
```

### Response — Idempotent Hit (200)

Returned when an active/completed request exists with the same `(tenantId, externalJobId, jobContextHash)`.

```json
{
  "success": true,
  "requestId": "cmlq707lw0000p75gzhj3ij99",
  "status": "complete",
  "idempotent": true,
  "trackDecision": {
    "track": "tech",
    "confidence": 0.92,
    "method": "deterministic",
    "classifierVersion": "v1"
  }
}
```

### Response — Retry (202)

Returned when a `failed` or `callback_failed` request exists. Re-queues the request.

```json
{
  "success": true,
  "requestId": "cmlq707lw0000p75gzhj3ij99",
  "status": "queued",
  "idempotent": false,
  "retried": true,
  "trackDecision": {
    "track": "tech",
    "confidence": 0.92,
    "method": "deterministic",
    "classifierVersion": "v1"
  }
}
```

### Status Lifecycle

```
queued → processing → complete → callback_sent
                    ↘ failed
                       callback_failed
```

`failed` and `callback_failed` are retryable via re-POST.

---

## 2. GET /api/v3/jobs/:id/results

Returns sourcing results for a job. Returns the most recent request by default.

**Scope:** `jobs:results`

### Request

```
GET /api/v3/jobs/{externalJobId}/results
GET /api/v3/jobs/{externalJobId}/results?requestId=<id>
```

### Response (200)

```json
{
  "success": true,
  "requestId": "cmlq707lw0000p75gzhj3ij99",
  "externalJobId": "test-job",
  "status": "complete",
  "requestedAt": "2026-02-17T05:58:46.917Z",
  "completedAt": "2026-02-17T05:58:47.228Z",
  "resultCount": 12,
  "trackDecision": {
    "track": "tech",
    "confidence": 0.92,
    "method": "deterministic",
    "classifierVersion": "v1",
    "deterministicSignals": {
      "techScore": 0.94,
      "nonTechScore": 0.06,
      "matchedTechKeywords": ["react", "typescript", "software engineer"],
      "matchedNonTechKeywords": [],
      "roleFamilySignal": "frontend"
    },
    "resolvedAt": "2026-02-17T05:58:46.920Z"
  },
  "candidates": [
    {
      "candidateId": "cmll077tb006gqp5gqtgqltr9",
      "fitScore": 0.85,
      "fitBreakdown": {
        "skillScore": 0.9,
        "roleScore": 0.85,
        "seniorityScore": 0.8,
        "activityFreshnessScore": 0.7
      },
      "matchTier": "best_matches",
      "locationMatchType": "city_exact",
      "sourceType": "pool_enriched",
      "enrichmentStatus": "completed",
      "rank": 1,
      "candidate": {
        "id": "cmll077tb006gqp5gqtgqltr9",
        "linkedinUrl": "https://linkedin.com/in/example",
        "linkedinId": "example",
        "nameHint": "Jane Doe",
        "headlineHint": "Senior Software Engineer",
        "locationHint": "San Francisco, CA",
        "companyHint": "Acme Corp",
        "searchSnippet": "Senior Software Engineer at Acme Corp...",
        "enrichmentStatus": "completed",
        "confidenceScore": 0.92,
        "lastEnrichedAt": "2026-02-17T06:16:01.000Z"
      },
      "snapshot": {
        "skillsNormalized": ["react", "typescript", "node.js"],
        "roleType": "engineer",
        "seniorityBand": "senior",
        "location": "San Francisco, CA",
        "computedAt": "2026-02-17T06:16:01.887Z",
        "staleAfter": "2026-03-19T06:16:01.887Z"
      },
      "freshness": {
        "snapshotAgeDays": 3,
        "staleServed": false,
        "lastEnrichedAt": "2026-02-17T06:16:01.000Z"
      },
      "professionalValidation": {
        "tier": 1,
        "overallScore": 0.87,
        "topReasons": ["All gates passed"],
        "freshness": {
          "lastValidatedAt": "2026-02-17T06:16:01.000Z",
          "stale": false
        },
        "contradictions": 0
      }
    }
  ],
  "groupCounts": {
    "bestMatches": 14,
    "broaderPool": 86,
    "strictMatchedCount": 14,
    "expandedCount": 86,
    "expansionReason": "insufficient_strict_location_matches",
    "requestedLocation": "Delhi, India"
  },
  "snapshotStats": {
    "totalWithSnapshot": 10,
    "staleCount": 2,
    "avgAgeDays": 12.3
  }
}
```

### Track Decision Fields

| Field | Type | Notes |
|-------|------|-------|
| `trackDecision` | `object \| null` | null for pre-classifier requests |
| `trackDecision.track` | `"tech" \| "non_tech" \| "blended"` | Resolved job track |
| `trackDecision.confidence` | `number` | 0.0 – 1.0 |
| `trackDecision.method` | `"deterministic" \| "groq" \| "deterministic+groq"` | How the decision was made |
| `trackDecision.classifierVersion` | `string` | e.g. `"v1"` |
| `trackDecision.deterministicSignals` | `object` | Keyword scoring details |
| `trackDecision.groqResult` | `object \| undefined` | Present only when Groq was consulted |
| `trackDecision.hintUsed` | `object \| undefined` | Present only when an explicit hint was provided |
| `trackDecision.resolvedAt` | `string` | ISO 8601 |

### Field Reference

| Field | Type | Notes |
|-------|------|-------|
| `fitScore` | `number \| null` | null for discovered (not yet ranked) candidates |
| `fitBreakdown` | `object \| null` | `{skillScore, roleScore, seniorityScore, activityFreshnessScore}` |
| `matchTier` | `"best_matches" \| "broader_pool" \| null` | Recruiter-facing location tier grouping |
| `locationMatchType` | `"city_exact" \| "city_alias" \| "country_only" \| "none" \| null` | How location matched |
| `sourceType` | `string` | `pool_enriched`, `pool`, or `discovered` |
| `enrichmentStatus` | `string` | `pending`, `completed`, `failed` |
| `rank` | `number` | 1-based, lower = better |
| `candidate.searchSnippet` | `string \| null` | SERP snippet from discovery search |
| `snapshot` | `object \| null` | null if no enrichment has run |
| `freshness.snapshotAgeDays` | `number \| null` | days since snapshot was computed |
| `freshness.staleServed` | `boolean` | true if snapshot was stale when served |
| `freshness.lastEnrichedAt` | `string \| null` | ISO 8601 |
| `professionalValidation` | `object \| null` | null if no non-tech snapshot exists or shadow mode is on |
| `groupCounts` | `object` | Request-level tier split metadata |
| `groupCounts.bestMatches` | `number` | Candidates in best-matches group |
| `groupCounts.broaderPool` | `number` | Candidates in broader-pool group |
| `groupCounts.strictMatchedCount` | `number` | Candidates in strict_location tier |
| `groupCounts.expandedCount` | `number` | Candidates in expanded_location tier |
| `groupCounts.expansionReason` | `string \| null` | `"insufficient_strict_location_matches"`, `"strict_low_quality"`, or null |
| `groupCounts.requestedLocation` | `string \| null` | Original location from job context |
| `groupCounts.strictDemotedCount` | `number` | Strict-location candidates demoted below fitScore floor (default 0) |
| `snapshotStats` | `object` | Request-level snapshot diagnostics |
| `diagnostics.skillScoreDiagnostics` | `object \| undefined` | `{withSnapshotSkills, usingTextFallback, avgSkillScoreBySourceType}` — skill scoring path breakdown |
| `diagnostics.locationHintCoverage` | `number \| undefined` | Fraction of scored (non-discovered) assembled candidates with a meaningful, non-noisy location hint (0.0–1.0) |

### Professional Validation Fields

| Field | Type | Notes |
|-------|------|-------|
| `tier` | `1 \| 2 \| 3` | 1 = all gates pass, 2 = soft fail, 3 = hard fail |
| `overallScore` | `number` | 0.0 – 1.0 composite score |
| `topReasons` | `string[]` | Human-readable gate pass/fail reasons |
| `freshness.lastValidatedAt` | `string \| null` | ISO 8601 |
| `freshness.stale` | `boolean \| null` | true if data is stale |
| `contradictions` | `number` | Count of identity contradictions |

### Snapshot Stats Fields

| Field | Type | Notes |
|-------|------|-------|
| `totalWithSnapshot` | `number` | Candidates with a tech snapshot |
| `staleCount` | `number` | Candidates with stale snapshots |
| `avgAgeDays` | `number \| null` | Average snapshot age in days, null if no snapshots |

### Snapshot Fields

| Field | Type | Source |
|-------|------|--------|
| `skillsNormalized` | `string[]` | LLM-extracted from enrichment |
| `roleType` | `string \| null` | `engineer`, `data_scientist`, `researcher`, `founder`, `designer`, `general` |
| `seniorityBand` | `string \| null` | `intern`, `junior`, `mid`, `senior`, `staff`, `principal`, `lead`, `manager`, `director`, `vp`, `cxo` |
| `location` | `string \| null` | From candidate hints |
| `computedAt` | `string` | ISO 8601 — when snapshot was computed |
| `staleAfter` | `string` | ISO 8601 — `computedAt + SNAPSHOT_STALE_DAYS` |

### 404 Response

```json
{
  "success": false,
  "error": "Sourcing request not found"
}
```

---

## 3. POST /api/v3/enrich/batch

Triggers batch enrichment for a list of candidate IDs.

**Scope:** `enrich:batch`

### Request

```
POST /api/v3/enrich/batch
Content-Type: application/json

{
  "candidateIds": ["id1", "id2", "id3"],  // required — non-empty array
  "trigger": "onOpen" | "onShortlist",      // required
  "priority": number?                       // optional — BullMQ priority (default 0)
}
```

### Response (200)

```json
{
  "success": true,
  "submitted": [
    { "candidateId": "id1", "sessionId": "uuid-1" }
  ],
  "skipped": [
    { "candidateId": "id2", "reason": "Session already queued or running" }
  ],
  "errors": [
    { "candidateId": "id3", "error": "Candidate not found or not owned by tenant" }
  ]
}
```

### Validation Errors (400)

```json
{ "success": false, "error": "trigger must be one of: onOpen, onShortlist" }
{ "success": false, "error": "candidateIds must be a non-empty array" }
{ "success": false, "error": "Invalid JSON body" }
```

### Behavior

- Deduplicates `candidateIds` before processing
- Validates candidates exist and belong to the JWT's `tenant_id`
- Skips candidates with already `queued` or `running` enrichment sessions (cross-run dedupe)
- Each submitted candidate gets a new enrichment session at the given priority

---

## 4. Callback (Signal → VantaHire)

Delivered after a sourcing run completes. Signal POSTs to the `callbackUrl` provided in the source request.

### Callback JWT (outbound from Signal)

```
Header: { alg: "RS256", kid: "v1" }
Payload:
  iss: "signal"
  aud: "vantahire"
  sub: "sourcing"
  tenant_id: string
  request_id: string
  scopes: "callbacks:write"
  jti: string (unique UUID)
  iat: number
  exp: now + 5m
```

VantaHire verifies using Signal's public key (the public half of `SIGNAL_JWT_PRIVATE_KEY`).

### Callback Body

```
POST {callbackUrl}
Authorization: Bearer <signed-jwt>
Content-Type: application/json

{
  "version": 1,
  "requestId": "cmlq707lw0000p75gzhj3ij99",
  "externalJobId": "job-123",
  "status": "complete" | "partial" | "failed",
  "candidateCount": 12,
  "enrichedCount": 5,
  "error": "..."  // only present when status is "failed"
}
```

### Retry Semantics

| Attempt | Delay Before |
|---------|-------------|
| 1 | none |
| 2 | 1s |
| 3 | 5s |

- **Max attempts:** 3
- **Request timeout:** 10s per attempt
- **Success:** any 2xx response → status becomes `callback_sent`
- **Failure:** all attempts fail → status becomes `callback_failed`
- **Retryable:** Re-POST to `/api/v3/jobs/:id/source` with same context re-queues the whole run

### VantaHire Callback Endpoint Requirements

- Accept POST with `Content-Type: application/json`
- Verify the `Authorization: Bearer` JWT using Signal's public key
- Verify `iss: "signal"`, `aud: "vantahire"`, `scopes` includes `callbacks:write`
- Return 2xx to acknowledge receipt
- Non-2xx or timeout triggers retry

---

## Environment Variables

### Signal Web/API

| Var | Required | Notes |
|-----|----------|-------|
| `VANTAHIRE_JWT_PUBLIC_KEY` | Yes | RSA public key PEM — verifies inbound VantaHire JWTs |

### Sourcing Worker

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `SIGNAL_JWT_PRIVATE_KEY` | Yes | — | RSA private key PEM — signs callback JWTs |
| `SIGNAL_JWT_ACTIVE_KID` | No | `v1` | Key ID in JWT header |
| `TARGET_COUNT` | No | `100` | Target candidates per sourcing run |
| `MIN_GOOD_ENOUGH` | No | `30` | Min enriched candidates before aggressive discovery |
| `JOB_MAX_ENRICH` | No | `50` | Discovery cap when pool is weak |
| `MAX_SERP_QUERIES` | No | `3` | Max SERP queries per discovery run |
| `INITIAL_ENRICH_COUNT` | No | `20` | Auto-enrich top N unenriched candidates |
| `SNAPSHOT_STALE_DAYS` | No | `30` | Days until snapshot is considered stale |
| `STALE_REFRESH_MAX_PER_RUN` | No | `10` | Max stale candidates re-enriched per run |
| `SOURCING_WORKER_CONCURRENCY` | No | `2` | BullMQ worker concurrency |

### Track Classifier

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `TRACK_CLASSIFIER_VERSION` | No | `v1` | Versioning for auditability |
| `TRACK_LOW_CONF_THRESHOLD` | No | `0.60` | Below this → Groq fallback |
| `TRACK_BLEND_THRESHOLD` | No | `0.15` | Score margin below which → blended |
| `TRACK_GROQ_ENABLED` | No | `true` | Kill switch for Groq (`false` to disable) |
| `TRACK_GROQ_TIMEOUT_MS` | No | `1200` | Per-attempt timeout |
| `TRACK_GROQ_MAX_RETRIES` | No | `1` | One retry on failure |
| `TRACK_GROQ_CACHE_TTL_DAYS` | No | `30` | Redis cache TTL |
| `TRACK_CB_THRESHOLD` | No | `5` | Failures to open circuit breaker |
| `TRACK_CB_WINDOW_SEC` | No | `300` | Rolling failure window |
| `TRACK_CB_COOLDOWN_SEC` | No | `60` | How long circuit stays open |
