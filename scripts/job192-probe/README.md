# Job 192 preparation-only diagnostic replay

LOCAL OPERATOR TOOL; not part of a deployed worker. Requires independent review and exact execution approval.
Only target: org_32, request `21e28b02-06f1-4f26-9906-615049b945da`, purchase `cmvfcajtq0001pk1zdcum9xt7`.

## What it does

`preview` reads a consistent Discover snapshot with an owner connection defaulted to read-only. It emits only
fixed IDs, counts, hashes and expiry. `probe` requires the exact approval hash within 15 minutes, rechecks the
snapshot, and spends that approval in a private fsynced local ledger before any Memory call.

It uses the pinned production mapper, packet builder, privacy checks and preparation method. It does not run
the orchestrator or enqueue any worker. Only HTTPS Memory privacy and public-identity READ endpoints are
allowed (maximum 12 requests, redirects refused). There are no Crustdata, Groq, RC, ingest or callback calls.

The preparation uses the real runtime-role Prisma transaction with the original 2-second acquisition and
5-second transaction limits. Even successful preparation ends by throwing a sentinel inside the transaction.
Thus it makes **transient SQL writes that are always rolled back**, not a read-only operation. The uncommitted
packets cannot be delivered by maintenance. There is no COMMIT success path, automatic retry, queue restart,
lease reset, RC start, search refund, status callback or result delivery.

An independent readback must match the original full snapshot. If anything differs, the command refuses and
requires manual review. Disconnect or crash rolls back the transaction; `.spent` persists and the same approval
cannot run again, even after restart or copying the plan. Never delete the spent ledger to retry.

## Limits on interpretation

- Fresh Memory identity lookup is used, not an unrecoverable historical in-memory identity map. A failed lookup
  refuses the probe instead of using production's fail-open identity fallback.
- `requirements.topSkills=[]` changes only the mapper's ranking snapshot; the real packet builder ignores that
  field. The mapping test proves packet-byte parity for differing snapshot skill guesses on a synthetic input.
- One execution-fence query is added inside the transaction. That adds latency: a probe timeout alone is not
  proof of the exact historical timing. The network route may also differ from the worker's production route.
- A successful probe intentionally leaves job 192 unresolved. Actual delivery/recovery needs separate design
  and approval. Do not use the job190 recovery tool on job192.

## Connection and execution gates

No production connection has been attempted by this tool. Verified TLS remains a separate prerequisite.
It expects an independently authenticated localhost tunnel to the exact Discover database, plus that database's
trusted CA. It DOES NOT create a tunnel or weaken verification. Both clients verify the CA and the localhost
certificate identity; Prisma uses `sslmode=require`, `sslaccept=strict`, and `sslcert=<CA path>`.
Live driver/tunnel verification remains required before execution; local option tests are not a TLS handshake proof.

Run from this worktree with reviewed production source unchanged from `8e927642ca40d3814f4526a14428e8a993192567`.
The source check rejects production-source, migration and package-lock drift. Use an allowlisted environment,
not a full dump of a production service's variables. No secret values in argv or logs.

Required environment:
- `NODE_ENV=production`, `LOG_LEVEL=silent`.
- `JOB192_READ_OWNER_URL`, `JOB192_RUNTIME_URL`: same localhost port/database, different owner/runtime users;
  no URL query parameters. Owner is used for read-only snapshots only; runtime executes the rollback probe.
- `JOB192_CA_FILE`, `JOB192_EXPECTED_DATABASE`, `JOB192_EXPECTED_OWNER`, `JOB192_EXPECTED_ROLE`, `JOB192_TARGET_ID`.
- `JOB192_LEDGER_DIR`: persistent operator-owned mode-0700 directory, fixed in the approved plan fingerprint.
- `ACTIVEGRAPH_URL`: trusted HTTPS Memory origin; `SIGNAL_JWT_PRIVATE_KEY` and appropriate kid/audience/privacy
  settings. All SIGNAL_/ACTIVEGRAPH_ settings are bound into the plan's hash, never emitted.
- No Redis configuration, disposable privacy adapter, or paid-provider keys. Never disable TLS validation globally.

`node --import tsx scripts/job192-probe/cli.mjs preview`

Operator saves that JSON in a mode-0600 plan file. User approves its exact hash. Then, and only then:

`node --import tsx scripts/job192-probe/cli.mjs probe /absolute/private/plan.json APPROVED_HASH`

No command in this README authorises a production run. Coordinate safe credentials after the earlier exposure.

## Local checks

```
node scripts/job192-probe/core.test.mjs
node scripts/job192-probe/operator.test.mjs
NODE_ENV=production LOG_LEVEL=silent node --import tsx scripts/job192-probe/mapping.test.mjs
RUN_SIGNAL_IMMUTABLE_POSTGRES=1 SIGNAL_IMMUTABLE_TEST_ADMIN_URL=<disposable-local-admin-url> npx vitest run src/lib/sourcing/__tests__/immutable-memory-ingest-postgres.integration.test.ts
```

21 operator/mapping checks and 20 full-migration PG16 tests pass. PG17 independent recheck, actual CLI + secure
transport + real Memory privacy integration, and production diagnosis remain unproven. No production build
or hosted-CI claim: this adds operator scripts and one test change, not a service or migration change.
