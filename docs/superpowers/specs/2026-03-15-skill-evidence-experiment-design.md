# Skill Evidence Experiment Design

**Date**: 2026-03-15
**Phase**: 4 (after Location, Headline, Seniority)
**Scope**: Tech skills first (4A), then non-tech (4B)

## Recruiter Question

> "Can I trust that the candidate actually has evidence for the skills we're matching on?"

## What We're Measuring

For a given candidate + skill pair, how reliable is the evidence that the candidate actually has that skill?

### Metrics

1. **Precision** — when we say a candidate has skill X, how often is that actually supported by evidence?
2. **False attribution rate** — how often do we attribute a skill to someone who has no evidence for it?
3. **Recall** — when a candidate clearly has skill X in their headline/snippet, do we detect it?
4. **Evidence strength** — can we distinguish:
   - `explicit` — skill named directly ("React developer", "Python engineer")
   - `inferred` — skill implied by context ("built microservices on AWS" → Docker/K8s likely)
   - `absent` — no evidence

## Current Infrastructure

### Two Scoring Paths

**Path 1: Snapshot (enriched candidates)**
- LLM extracts skills from discovered platform data (GitHub repos, languages, etc.)
- Stored in `CandidateIntelligenceSnapshot.skillsNormalized: String[]`
- Matched via concept-expanded set intersection (`buildSkillMatchSet()`)
- Weighted: 0.8 * overlapRatio + 0.2 * domainMatch
- Method tag: `'snapshot'`

**Path 2: Text Fallback (non-enriched candidates)**
- Regex matching on `headlineHint + searchTitle + searchSnippet`
- Uses `getSkillSurfaceForms()` for alias-aware matching
- `buildSkillRegex()` handles boundary detection for C++, C#, .NET etc.
- Short alias allowlist (ts, js, go, pg, k8s) to prevent FPs
- Same 0.8/0.2 weighting
- Method tag: `'text_fallback'`

### Normalization

- `SKILL_ALIASES`: ~60 mappings (nodejs→node.js, ts→typescript, sfdc→salesforce, etc.)
- `SKILL_CONCEPT_SURFACE_FORMS`: ~30 concept families (microservices, enterprise sales, etc.)
- `canonicalizeSkill()`: lowercase + trim + alias resolution
- File: `src/lib/sourcing/jd-digest.ts`

### Track Weights

```
tech:     skill=0.45, role=0.15, seniority=0.25, freshness=0.15
non_tech: skill=0.25, role=0.30, seniority=0.30, freshness=0.15
blended:  skill=0.35, role=0.25, seniority=0.25, freshness=0.15
```

### Known Gaps

1. Non-tech snapshots have `skillsNormalized = []` — always falls back to text
2. No per-skill confidence (all skills in array treated equally)
3. Text fallback is regex-only — no semantic matching
4. ~60 aliases / ~30 concept families is narrow vs. the real skill universe
5. No skill evidence on Candidate table — only on snapshot or inferred at ranking time

## Phase 4A: Tech Skills

### What to Evaluate

Test the **text fallback path** first — this is where most candidates are scored (non-enriched), and it's the path we can improve without LLM cost.

For enriched candidates, the snapshot path is already high-quality (LLM-extracted from actual repos/languages). The text fallback is the weak link.

### Fixture Design

Each fixture represents a (headline, snippet, target_skills) triple with gold labels.

```jsonl
{"id": "sk_001", "headline": "Senior React Developer at Stripe", "snippet": "Building payment UIs with React, TypeScript and Node.js", "target_skills": ["react", "typescript", "node.js"], "gold": {"react": "explicit", "typescript": "explicit", "node.js": "explicit"}}
```

Gold labels per skill:
- `"explicit"` — skill is directly named in headline or snippet
- `"inferred"` — skill is strongly implied but not named
- `"absent"` — no evidence for this skill
- `"false_positive"` — text contains the word but doesn't indicate candidate skill

### Fixture Categories

**Core fixtures** (~20): straightforward cases across common tech stacks
- Frontend (React, Vue, Angular, TypeScript)
- Backend (Node.js, Python, Go, Java, Rust)
- Infrastructure (AWS, Docker, Kubernetes, Terraform)
- Data (PostgreSQL, Redis, Kafka, Spark)

**Adversarial fixtures** (~15): edge cases
- Symbol skills: C++, C#, .NET in various contexts
- Short aliases: TS, JS, Go (ambiguous with English words)
- Skill in company name not candidate skill ("works at GoLang Inc")
- Substring traps: "React Native" vs "React", "Node" vs "Node.js"
- Missing obvious skills (blank snippet, headline-only)
- Skill mentioned in negative context ("migrating away from Angular")

### Evaluator

`scripts/eval-skill-evidence-tech.ts`

For each fixture:
1. Concatenate headline + snippet into text bag
2. For each target skill, run current matching logic (`getSkillSurfaceForms()` + `buildSkillRegex()`)
3. Compare detected/not-detected against gold labels
4. Report per-skill and aggregate precision/recall/FP rate

### Success Criteria

- Precision >= 90% on explicit skills
- False positive rate <= 5%
- Recall >= 85% for explicit skills in text

## Phase 4B: Non-Tech Skills (Deferred)

Separate fixtures, evaluator, and metrics. Key differences:
- Skills are functions/domains (enterprise sales, customer success, product marketing)
- Labels are fuzzier
- Different taxonomy decisions needed
- Non-tech snapshots have empty skillsNormalized — text fallback is the only path

Will design after Phase 4A baseline is established.

## What Not to Do

- Do not change ranking weights before measuring
- Do not add new extraction logic before measuring what exists
- Do not mix tech and non-tech in one evaluator
- Do not jump to skill persistence (Candidate table field) before measuring quality
