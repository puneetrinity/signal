# Offline Eval Harness + Bridge Tiering Reliability

> **Status: LOCKED** — All CI gates passing as of 2025-12-23
> **Tier-1 Enforce: LIVE** — Rolled out 2026-02-15, 210 sessions, 100% precision

## Done

- [x] **Offline eval harness operational** (replay-mode, deterministic, CI-friendly)
- [x] **CI gate threshold display bug fixed**
- [x] **Tier-1 detection surface expanded**
  - [x] Regex boundaries now include punctuation: `[/?#\s)\]}"',\.;:]`
  - [x] Detection scans title/snippet/url (as applicable)
- [x] **URL decoding hardened**
  - [x] Iterative decode loop (max 3 passes) for URL-encoded + double-encoded strings
- [x] **Tier-aware scoring calibrated**
  - [x] Tier-1 strict + no contradictions gets **+0.08 score boost**
- [x] **CI gates passing**
  - [x] Auto-merge precision: **100%** (>= 98%)
  - [x] Tier-1 detection recall: **88.9%** (>= 85%)
  - [x] Persisted identity rate: **75.0%** (>= 50%)
- [x] **Tier-1 strict-subset enforcement** (2026-02-15)
  - [x] Enforce predicate: `linkedin_url_in_bio` or `linkedin_url_in_blog` + conf >= 0.83 + no contradiction
  - [x] Non-qualifying Tier-1 downgraded to Tier-2 when enforce is on
  - [x] Shadow telemetry: `tier1Shadow`, `tier1Gap`, `enforceReasonCounts` in run trace
  - [x] Kill switch: `ENRICHMENT_TIER1_ENFORCE=false`
  - [x] Production rollout: 210 sessions, 30/30 enforced correct, 0 failures

## Current metrics (eval)

| Metric | Value | Threshold |
|--------|-------|-----------|
| Tier-1 recall | **88.9%** (8/9 expected Tier-1 detected) | >= 85% |
| Auto-merge precision | **100%** | >= 98% |
| Persisted identity rate | **75%** (15/20 candidates) | >= 50% |
| Query cost | **94 total / 20 candidates** (**4.7 avg**) | — |

---

## Optional next improvements (not required, but high leverage)

- [ ] Add a **fixture generator** to sample anonymized production traces → JSONL fixtures
- [ ] Add **tier-specific contradiction analytics** (Tier-1 contradiction should stay near zero)
- [ ] Add a **threshold sweep job** (nightly) to propose better tier2 cap/thresholds
- [ ] Expand fixtures with adversarial cases (team pages, generic handles, redirect URLs)

---

## CI Gating Strategy

**Current (fast, 20 fixtures):**
```bash
npm run eval  # ~30ms, runs in CI on every PR
```

**Future (regression suite):**
- Keep core fixtures small (20-50) for fast CI
- Add `eval:full` script for nightly runs with larger fixture set (200+)
- Gate PRs on core fixtures; nightly catches regressions in extended set
- Alert on Tier-1 contradiction rate > 1%

---

## Key files

| File | Purpose |
|------|---------|
| `eval/fixtures/candidates.jsonl` | Test fixtures with mock search/GitHub data |
| `eval/config.json` | Thresholds and eval configuration |
| `scripts/eval-enrichment.ts` | Eval runner CLI |
| `src/lib/enrichment/bridge-discovery.ts` | Core bridge discovery with Tier-1 boost + enforce predicate |
| `src/lib/enrichment/bridge-types.ts` | Tier/signal types, `TIER_1_ENFORCE_SIGNALS` |
| `src/lib/enrichment/config.ts` | Threshold configuration (enforce min confidence) |
| `src/lib/enrichment/scoring.ts` | Confidence scoring logic |
