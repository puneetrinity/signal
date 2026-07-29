# Crustdata retry idempotency

Crustdata Person Search purchases are scoped to a sourcing request acquisition
generation. Each generation has at most one `exact` receipt and one optional
`spill` receipt. Receipts are tenant-scoped and are never read across sourcing
requests.

## Generation rules

- A new sourcing request starts at generation 1.
- A failed/downstream retry keeps the generation and reuses completed receipts.
  This includes Signal's `complete` + callback-`failed` state. Flow's normal
  `forceSourcing` retry also keeps the failed generation.
- Explicit `refresh` on a failed/downstream request, or `refresh` /
  `forceSourcing` after a successfully delivered run, increments the generation
  and performs a new always-on buy.
- Refresh is not allowed while the request is queued, processing, or waiting for
  its completion callback.

An execution-attempt ID is separate from the acquisition generation. Each BullMQ
processor delivery also claims a unique processing lease. Queue processing,
candidate replacement, ladder effects, callbacks, and terminal request writes
use all three values as a fence. A stalled delivery can be replaced without
letting its late writes overwrite the replacement.

Terminal and progress callbacks carry the acquisition generation and execution
attempt in both the signed JWT and callback body. Flow persists the execution
identity returned by `/source`, rejects body/claim mismatches, retries callbacks
that race ahead of its local state, and ignores callbacks from abandoned older
generations. It rechecks the identity before the terminal run-state write so a
timed-out handler cannot later mark a newer run failed.

## Receipt states

- `started`: persisted before the provider request is dispatched.
- `complete`: contains the paid provider response and can be replayed.
- `uncertain`: the provider request threw after dispatch may have begun.
- `released`: the completion callback was delivered and the large response
  payload was cleared.

Crustdata does not document a request idempotency key for Person Search. There is
an unavoidable crash window after the provider may have charged but before the
response can be persisted. A `started` receipt is therefore never reclaimed
automatically, and an `uncertain` receipt is never retried within the same
generation. This intentionally trades availability for protection against a
duplicate charge. After the request reaches `failed`, explicit `refresh: true`
starts a new generation and is the operator-approved recovery path;
`forceSourcing` alone remains a same-generation retry.

Receipt replay carries the original provider observation timestamp into candidate
storage. It neither extends Stage-2 freshness nor overwrites a newer public
profile acquired by another run.

Receipt payloads remain available while downstream work or callback delivery can
still fail. All paid profiles are synchronously confirmed in Memory and that
receipt-local completion is persisted before the terminal callback can run.
Memory confirmation requires a `created` or `matched` resolution with both a
canonical candidate ID and a durable source-record ID matching the submitted
Signal candidate. An HTTP 2xx carrying `review_required` is not confirmation
and leaves the receipt replayable.
Memory receives the original provider observation timestamp, so delayed internal
retries do not make old evidence look fresh. A successful completion callback
changes only Memory-confirmed receipts to `released` and clears their JSON
payloads. Callback redelivery uses the same cleanup path, and each
callback-redelivery cycle also sweeps delivered requests, so a transient cleanup
failure is retried opportunistically.

Starting a new generation explicitly abandons the prior failed generation and
releases any completed payload from it even if its Memory ingest was incomplete.
`started` and `uncertain` receipts retain their audit record but have no reusable
response payload to clear.

This release point depends on Flow returning a non-2xx response when terminal
callback processing fails. The companion Flow ACK fix must ship with this change;
without it, a downstream processing error acknowledged as HTTP 200 would look
delivered to Signal and release the replay payload too early.

Callback failure writes are conditional on the callback not already being
delivered. Concurrent redelivery workers may make duplicate idempotent HTTP
attempts. Flow locks and rechecks the execution identity around candidate
mutations, and terminal state is monotonic: once one delivery commits
`completed`, a slower same-execution failure cannot downgrade it. A late failure
also cannot revert Signal's callback state from `delivered` or invalidate a
released receipt.

## Deployment

Both `npm start` and `npm run worker:sourcing` run `prisma migrate deploy` and
stop if it fails before starting their service. Concurrent deploy commands are
serialized by Prisma's PostgreSQL migration advisory lock. The worker does not
have an in-memory fallback: missing receipt storage must fail the run rather than
permit an unreceipted paid call.

Flow's callback-fencing/ACK companion and Memory's observation-ordering API must
deploy first. The Signal API and sourcing worker then change the queue contract
together: pause new sourcing submissions, drain active sourcing jobs, deploy the
receipt-aware worker before the API, and resume only after both services are
healthy. A mixed-version window must not serve sourcing traffic.

The historical Signal migration chain assumes a baselined database containing
`job_sourcing_requests`; it cannot currently bootstrap an empty database. This
migration does not repair that pre-existing clean-install debt.
