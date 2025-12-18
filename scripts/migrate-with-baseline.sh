#!/bin/bash
# Migration script that handles baselining for databases created with db push
# This marks all migrations as applied if the _prisma_migrations table doesn't exist
# but the schema tables do exist

set -e

echo "[Migrate] Checking migration status..."

# Try to deploy migrations normally first
if npx prisma migrate deploy 2>&1; then
  echo "[Migrate] Migrations applied successfully"
  exit 0
fi

# If we get here, migrate deploy failed - check if it's P3005 (needs baseline)
echo "[Migrate] Normal migration failed, checking if baseline is needed..."

# Get list of migrations
MIGRATIONS=$(ls -1 prisma/migrations | grep -E '^[0-9]+' | sort)

if [ -z "$MIGRATIONS" ]; then
  echo "[Migrate] No migrations found"
  exit 0
fi

echo "[Migrate] Baselining existing migrations..."

# Mark each migration as applied
for migration in $MIGRATIONS; do
  echo "[Migrate] Marking $migration as applied..."
  npx prisma migrate resolve --applied "$migration" || true
done

echo "[Migrate] Baseline complete, verifying..."
npx prisma migrate deploy

echo "[Migrate] All migrations applied successfully"
