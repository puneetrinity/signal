# Future Work: Identity & Reachability Experiment

Status: future work — no implementation now
Priority: after currentness field is complete

---

## 1. Goal

Define the recruiter question this experiment answers:

1. **Can we confidently identify the right person?** — given SERP results, bridge tiers, and enrichment signals, how often does the system correctly resolve a candidate's identity?
2. **Can we act on that result?** — once identified, does the recruiter have a usable path to contact (LinkedIn URL, email, phone)?

These are two distinct sub-questions. Identity accuracy matters even without contact info, and contact info is worthless without correct identity.

## 2. Metrics to evaluate later

| Metric | Definition |
|--------|------------|
| Identity found rate | % of sourced candidates where the system resolves at least one identity link (LinkedIn, GitHub, email) |
| Actionable profile rate | % of sourced candidates where the resolved identity includes a usable contact path (verified LinkedIn URL, email, or phone) |
| Tier-1 precision | % of Tier-1 auto-confirmed identities that are actually correct (manual audit) |
| Reveal/contact usefulness | % of reveal/contact outputs that are valid and usable (not placeholder, not junk, not outdated) |

## 3. Scope

This is post-ranking, post-currentness work. It does not affect ranking logic or sourcing quality directly. It affects recruiter trust and outreach success rate.

Current experiment field order:
1. Location — complete
2. Headline/Title — complete
3. Seniority — complete
4. Tech Skills — v1 deployed
5. Non-Tech Skills — v1 deployed
6. Currentness — next
7. **Identity/Reachability — this doc (later)**

## 4. Likely data sources

| Source | What it provides |
|--------|-----------------|
| `IdentityCandidate` | Bridge-discovered identity links (LinkedIn, GitHub, etc.) with confidence and signal metadata |
| `ConfirmedIdentity` | Persisted confirmed identities, often originating from strict Tier-1 enforce or human confirmation |
| v2 review queue | Tier-2 candidates requiring human review — raw bridge tiers and review data exposed |
| v3 results `identitySummary` | Summarized identity state returned to Vanta (`bestBridgeTier`, `maxIdentityConfidence`, `hasConfirmedIdentity`, `needsReview`, `platforms`, `displayStatus`, `lastIdentityCheckAt`) |
| Reveal/contact outputs | Contact info from enrichment or reveal flows, if stored |

## 5. Candidate evaluator ideas

| Script | Purpose |
|--------|---------|
| `scripts/eval-identity-quality.ts` | Offline evaluator: given fixture set of (candidate, SERP data, expected identity), measure identity resolution accuracy |
| `scripts/eval-reveal-usefulness.ts` | Offline evaluator: given fixture set of (reveal output, expected usefulness label), measure contact quality |
| `scripts/audit-identity-prod.ts` | Prod audit: sample real Tier-1/Tier-2 candidates, check identity correctness against manual review |

## 6. Fixture ideas

| Dataset | Purpose | Type |
|---------|---------|------|
| Same-name ambiguity | Two or more people with identical names, different identities | adversarial |
| Correct Tier-1 confirmed | Known-correct auto-confirmed identities | core |
| Wrong Tier-1 auto | Cases where auto-confirm would be wrong (name collision, stale LinkedIn) | adversarial |
| Tier-2 review-worthy | Matches that should trigger human review, not auto-confirm | core |
| Reveal returns valid contact | Reveal/contact output is a real, usable email or phone | core |
| Reveal returns junk | Placeholder, generic, outdated, or unusable contact info | adversarial |

## 7. Known open questions

- **Evaluation surface is not settled.** v2 exposes raw bridge tiers and review data; v3 exposes a summarized `identitySummary`. Fixture and evaluator design depends on whether we evaluate against raw `IdentityCandidate`/`ConfirmedIdentity` records or against the v3 `identitySummary` output. This is the first design decision to make when this work starts.
- Exact integration surface for Vanta (what Vanta consumes vs what Signal exposes) needs deeper discussion when this work starts.
- Whether reveal/contact outputs are reliably stored today or need new persistence before evaluation can begin.
- Whether Tier-1 enforce threshold (currently 0.83) should be part of the experiment sweep or held constant.

## 8. Not doing now

- No implementation work
- No ranking dependency or ranking changes
- No v2 payload redesign
- No fixture creation until currentness experiment is complete
- No changes to Tier-1 enforce logic
