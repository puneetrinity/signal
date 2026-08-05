# Signal database bootstrap

Signal has two database paths. Do not interchange them.

## Existing database

Application and worker start commands run:

```bash
npx prisma migrate deploy
```

This is the only production upgrade path. Never resolve migrations manually
and never use schema push against a shared database.

## Genuinely empty database

Set `DATABASE_URL` and `DIRECT_URL` to the same direct PostgreSQL database,
then explicitly opt in:

```bash
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
4. Start Signal normally so `prisma migrate deploy` confirms no pending work.
5. Run the application smoke tests before switching traffic.

## Drift monitoring

The weekly `Signal production schema drift` workflow compares production with
`prisma/schema.prisma`. It requires the GitHub secret
`SIGNAL_SCHEMA_AUDIT_DATABASE_URL`, whose URL username must be
`signal_debug_ro`. The workflow fails when the secret is absent or drift is
found. It never changes the database.

After adding any migration, verify both paths:

1. Upgrade a production-shaped disposable database with `prisma migrate deploy`.
2. Bootstrap an empty database, then confirm the new migration was applied and
   Prisma reports zero drift.
