# Ranking Defaults Reference

Current scoring weights, guards, and thresholds for the sourcing ranking system.

**Last verified:** 2026-03-15

---

## Score Weights

Candidates are scored as a weighted sum of skill, role, seniority, freshness, and optional location components. Weights vary by track.

### Base weights (before location boost)

| Component | Tech | Non-tech | Blended |
|-----------|-----:|--------:|--------:|
| Skill | 0.45 | 0.25 | 0.35 |
| Role | 0.15 | 0.30 | 0.25 |
| Seniority | 0.25 | 0.30 | 0.25 |
| Freshness | 0.15 | 0.15 | 0.15 |

Source: `src/lib/sourcing/ranking.ts:396-399`

### Location boost

Location boost redistributes weight from all other components proportionally.

| Track | Default | Env var |
|-------|--------:|---------|
| Tech | 0.10 | `SOURCE_LOCATION_BOOST_WEIGHT_TECH` |
| Blended | 0.08 | `SOURCE_LOCATION_BOOST_WEIGHT_BLENDED` |
| Non-tech | 0.03 | `SOURCE_LOCATION_BOOST_WEIGHT_NON_TECH` |

Source: `src/lib/sourcing/config.ts:202-212`

### Effective tech weights (with 0.10 location boost)

| Component | Effective |
|-----------|----------:|
| Skill | 0.405 |
| Role | 0.135 |
| Seniority | 0.225 |
| Freshness | 0.135 |
| Location | 0.100 |

### Effective non-tech weights (with 0.03 location boost)

| Component | Effective |
|-----------|----------:|
| Skill | 0.2425 |
| Role | 0.291 |
| Seniority | 0.291 |
| Freshness | 0.1455 |
| Location | 0.030 |

---

## Assembly Thresholds

| Setting | Default | Env var | Purpose |
|---------|--------:|---------|---------|
| Best-match floor | 0.45 | `SOURCE_BEST_MATCHES_MIN_FIT_SCORE` | Strict candidates below this are demoted to expanded |
| Strict rescue floor | 0.30 | `SOURCE_STRICT_RESCUE_MIN_FIT_SCORE` | Rescued stricts must exceed this |
| Fit epsilon | 0.03 | `SOURCE_FIT_SCORE_EPSILON` | Score differences below this are ties |
| Unknown-location penalty | 0.85 | `SOURCE_UNKNOWN_LOCATION_PENALTY_MULTIPLIER` | Post-rank multiplier for unknown-location candidates |

Source: `src/lib/sourcing/config.ts:148-226`

---

## Top-20 Guards

| Guard | Default | Env var | Effect |
|-------|--------:|---------|--------|
| Tech guards enabled | true | `SOURCE_TECH_TOP20_GUARDS_ENABLED` | Enables role/skill cleanup |
| Tech role min | 0.35 | `SOURCE_TECH_TOP20_ROLE_MIN` | Below → violation (unknown tech roles score 0.30) |
| Tech role cap | 1 | `SOURCE_TECH_TOP20_ROLE_CAP` | Max low-role candidates in top-20 |
| Tech skill min | 0.10 | `SOURCE_TECH_TOP20_SKILL_MIN` | Below → violation |
| Unknown-location cap | 10% tech / 15% non-tech | — | Limits unknown-location in top-20 |

Source: `src/lib/sourcing/config.ts:229-232`, `orchestrator.ts:1336`, `rerank.ts:244`

### Tech best_matches admission

Strict tech candidates are demoted to expanded_location if **either**:
- `fitScore < bestMatchesMinFitScore` (0.45)
- `skillScore < techTop20SkillMin` (0.10)

This applies in initial assembly (`orchestrator.ts:1045`) and rerank (`rerank.ts:232`).

---

## Seniority

- Raw `seniorityScore` computed from band distance
- `effectiveSeniorityScore` = dampened when role is a mismatch
- Both exposed in FitBreakdown and v3 API

Source: `src/lib/sourcing/ranking.ts:441-487`

---

## Location Classification

Candidates are classified into location tiers that drive assembly policy:

| Tier | Meaning |
|------|---------|
| `city_exact` | Exact city match |
| `city_alias` | City alias match |
| `country_only` | Country matches, city doesn't |
| `unknown_location` | No location data |
| `none` | No match |

`strict_location` = `city_exact` or `city_alias`
`expanded_location` = `country_only` or `unknown_location`

Source: `src/lib/sourcing/ranking.ts:266`

---

## What is NOT yet in ranking

- **Currentness** — shared helper at `src/lib/search/currentness.ts`, not yet wired into scoring
- **Identity/Reachability** — no signal in ranking
- **Contactability** — no signal in ranking

---

## Interpretation

- **Tech**: skill-first. Role matters but less than skill. Location is a soft boost.
- **Non-tech**: role and seniority dominate. Location is a small tiebreaker (0.03).
- **Strict location**: main structural gate. Numeric location boost only differentiates within a tier.
