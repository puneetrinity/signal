# V1 Crustdata + EnrichLayer Plan

## Goal

Build a standalone Signal V1 that:

1. takes structured job intent from Vanta
2. retrieves new candidates from Crustdata
3. falls back to Serper when needed
4. ranks all candidates inside Signal
5. enriches only the top shortlist with EnrichLayer
6. returns the final shortlist to Vanta

Active Graph is deferred to a later phase.

## Rules

- Signal remains the only final ranker.
- LinkedIn URL is the primary trusted identity anchor.
- GitHub and other third-party links are unverified signals until bridge verification confirms them.
- EnrichLayer runs only on the shortlist, not on the full discovered pool.

## V1 pipeline

1. Vanta submits structured job intent to Signal.
2. Signal builds a retrieval request from the job requirements.
3. Signal queries Crustdata for the main discovery set.
4. Signal uses Serper as fallback if discovery under-delivers.
5. Signal normalizes discovered results into a common candidate shape.
6. Signal ranks the combined candidate pool.
7. Signal enriches the top shortlist with:
   - EnrichLayer profile
   - EnrichLayer personal email
8. Signal verifies enrichment against the original candidate hints.
9. Signal returns the final shortlist to Vanta.

## Code scaffolding added here

- `src/lib/search/providers/crustdata.ts`
- `src/lib/enrichment/enrichlayer.ts`
- `src/lib/sourcing/v1-candidate.ts`
- `src/lib/sourcing/retrieval-plan.ts`
- `src/lib/sourcing/shortlist-enrichment.ts`

## Not done yet

- Crustdata query shaping from JD/job intent
- shortlist enrichment orchestration
- EnrichLayer verification wiring into scoring
- callback/result contract extension for recruiter-facing tags

## Defaults changed

- `SEARCH_PROVIDER` now defaults to `crustdata`
- `SEARCH_FALLBACK_PROVIDER` defaults to `serper` when primary is `crustdata`
