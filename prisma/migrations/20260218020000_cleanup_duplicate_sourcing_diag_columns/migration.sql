-- Canonicalize sourcing diagnostics columns to snake_case.
-- Some environments ended up with duplicate camelCase columns:
--   "qualityGateTriggered", "queriesExecuted"
-- while Prisma now maps to:
--   quality_gate_triggered, queries_executed

ALTER TABLE "job_sourcing_requests"
ADD COLUMN IF NOT EXISTS "quality_gate_triggered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "queries_executed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "diagnostics" JSONB;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'job_sourcing_requests'
      AND column_name = 'qualityGateTriggered'
  ) THEN
    EXECUTE '
      UPDATE "job_sourcing_requests"
      SET "quality_gate_triggered" = COALESCE("quality_gate_triggered", false)
        OR COALESCE("qualityGateTriggered", false)
    ';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'job_sourcing_requests'
      AND column_name = 'queriesExecuted'
  ) THEN
    EXECUTE '
      UPDATE "job_sourcing_requests"
      SET "queries_executed" = GREATEST(
        COALESCE("queries_executed", 0),
        COALESCE("queriesExecuted", 0)
      )
    ';
  END IF;
END $$;

ALTER TABLE "job_sourcing_requests"
DROP COLUMN IF EXISTS "qualityGateTriggered",
DROP COLUMN IF EXISTS "queriesExecuted";
