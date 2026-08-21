# Signal database schema control

Signal has three deliberately separate paths. Do not interchange their
credentials or flags.

## Existing database

Application and worker starts run only the read-only readiness assertion:

```bash
npm run start
npm run worker:sourcing
```

They require the restricted `DATABASE_URL`, `SIGNAL_SCHEMA_TARGET_ID` and
`SIGNAL_SCHEMA_ENVIRONMENT`. They refuse pending, failed, unknown or
checksum-mismatched Prisma history and never apply/resolve a migration.

Production upgrades use the manual one-shot release service defined by
`railway.schema-release.json`. Its `npm run db:migrate:release` command requires
the dedicated `DIRECT_URL`, exact target identity and the one-run
`SIGNAL_MIGRATION_APPLY=1` flag. Never put those values on a runtime service.
Never resolve migrations manually and never use schema push against a shared
database.

## Genuinely empty database

This path is development/disaster-recovery tooling, not production adoption.
Set both URLs to the same loopback/socket disposable `*_test` or
`*_disposable` database, then explicitly opt in:

```bash
SIGNAL_SCHEMA_ENVIRONMENT=development \
SIGNAL_SCHEMA_DISPOSABLE_SINGLE_CREDENTIAL=1 \
SIGNAL_BOOTSTRAP_EMPTY_DATABASE=1 npm run db:bootstrap-empty
```

The command acquires a database advisory lock before inspecting the `public`
schema. It refuses any table, view, sequence, function, trigger, custom type,
or Prisma migration ledger. It validates the immutable baseline and migration
checksums, applies the baseline transactionally, resolves only the migrations
listed in the baseline manifest, and finally applies newer migrations.

If any stage fails, discard and recreate the empty database. Do not attempt to
repair a partial bootstrap or mark additional migrations as applied.

## Staging and disaster recovery

1. Create a new empty PostgreSQL database.
2. Restore data only when the recovery procedure calls for it. A restored
   database is not empty and must not use the baseline command.
3. For a fresh schema, run the guarded bootstrap once.
4. Establish a new non-production target identity through the separately
   controlled schema-control procedure.
5. Run read-only schema readiness and application smoke tests before switching
   traffic.

## Drift monitoring

The weekly `Signal production schema drift` workflow compares production with
`prisma/schema.prisma`. It requires the GitHub secret
`SIGNAL_SCHEMA_AUDIT_DATABASE_URL`, whose URL username must be
`signal_debug_ro`. The workflow fails when the secret is absent or drift is
found. It never changes the database.

After appending any migration and its checksum-lock entry, verify both paths:

1. Upgrade a production-shaped disposable database with the release wrapper.
2. Bootstrap an empty database, then confirm the new migration was applied and
   Prisma reports zero drift.
