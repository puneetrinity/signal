# Contact Enrichment Rollout

Contact enrichment is durable and shortlist-triggered. The HTTP route creates,
reads, or revalidates an operation; provider spend happens in the sourcing
worker.

Deploy in this order:

1. Deploy Memory with `/contact-evidence/lookup` and
   `/contact-evidence/record`, including `contact:read` and `contact:write`
   service scopes.
2. Deploy Signal with the migration and
   `CONTACT_ENRICHMENT_WORKER_ENABLED=false`. Verify that the route returns
   `202 pending`, validates the tenant candidate/job appearance, and creates
   one idempotent operation.
3. Deploy Flow compatibility code with
   `CONTACT_RESOLUTION_RECOVERY_ENABLED=false`. Each production Flow
   entrypoint runs the fail-closed schema migrator before runtime code, so
   migration 014-equivalent bootstrap DDL must succeed before the service
   starts. Flow must sign `contact:write` and send
   `{ "trigger": "shortlist", "jobId": "vanta:jobs:<id>" }`. Do not deploy
   this send-time revalidation path against the legacy Signal contact route.
4. Configure `SIGNAL_PUBLIC_BASE_URL` and provider keys, then enable the
   Signal worker. Verify Memory-first lookup, signed webhook delivery, and
   provider request persistence before any spend.
5. Enable Flow's `CONTACT_RESOLUTION_RECOVERY_ENABLED=true` only after Signal
   terminal and pending responses have been verified.

Rollback by disabling the two worker flags. Pending operations remain durable
and no provider request is repeated automatically from an ambiguous start.
A lost FullEnrich start response is reported as
`202 provider_recovery_pending`; only a correctly signed delayed webhook may
recover it. EnrichLayer ambiguity has no recovery channel and remains a
terminal `409`.
