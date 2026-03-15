# Phase 4B: Non-Tech Skill Evidence Experiment

## Problem

Non-tech candidates (sales, customer success, marketing, operations) almost never have `skillsNormalized` in their snapshots. Ranking always falls back to text matching on headline + snippet for skill scoring.

Current non-tech skill taxonomy covers only:
- Sales/GTM: salesforce, enterprise sales, outbound, pipeline management, consultative selling
- Customer success/TAM: customer success, stakeholder management, integrations, apis

Missing high-value non-tech domains:
- Product marketing, content marketing, growth marketing
- Demand generation, lead generation
- Revenue operations (RevOps), sales operations
- Business operations, strategy & operations
- People operations, talent acquisition
- Finance, FP&A
- Legal, compliance

## Structural difference from tech

| Dimension | Tech (4A) | Non-tech (4B) |
|-----------|-----------|---------------|
| Snapshot path | Often available | Almost never |
| Skill weight | 0.45 | 0.25 |
| Fallback frequency | ~40% of candidates | ~95% of candidates |
| Ambiguity risk | Homograph words (go, rust) | Broad business language overlap |
| Key FP source | English words matching tech names | Generic terms matching specific functions |

## Scope

Explicit text evidence only. Not soft inference from career context.

"Enterprise sales" in a headline = evidence. "Works at a sales company" without mentioning the function = not evidence.

## Approach

Mirror Phase 4A methodology:

1. **Fixtures** — gold-labeled (headline, snippet, target_skills, gold) pairs
2. **Evaluator** — replicates text fallback matching, reports precision/recall/FP rate
3. **Baseline** — measure current coverage gaps
4. **Fix** — add missing aliases and concept surface forms
5. **Guard** — identify non-tech ambiguous terms needing context rules

## Fixture categories

### Core (~20 fixtures)
Straightforward non-tech profiles with clear function signals:
- Account executives, SDRs, BDRs
- Customer success managers, TAMs
- Product marketing managers, content marketers
- RevOps analysts, sales ops
- HR/people ops, talent acquisition
- Finance, FP&A analysts

### Adversarial (~15 fixtures)
Cases where business language creates false positives:
- "Management" (generic) vs "account management" (specific skill)
- "Operations" (generic) vs "revenue operations" (specific function)
- "Strategy" (generic) vs "go-to-market strategy" (specific)
- "Growth" (generic) vs "growth marketing" (specific)
- "Partner" (job title) vs "partner management" (skill)
- Cross-domain confusion: tech PM vs product marketing

## Success criteria

- Recall >= 95% on explicit labels
- Precision >= 90% on detected matches
- FP rate <= 5% on non-explicit labels

## Key risk

Non-tech business language is inherently more ambiguous than tech terms. "Management", "operations", "strategy", "growth" appear everywhere. The alias/concept system must be precise enough to match multi-word phrases without triggering on their individual component words.

## Files

- `research/datasets/skill-evidence-nontech-core.jsonl`
- `research/datasets/skill-evidence-nontech-adversarial.jsonl`
- `scripts/eval-skill-evidence-nontech.ts`
