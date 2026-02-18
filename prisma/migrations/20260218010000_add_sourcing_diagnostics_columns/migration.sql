ALTER TABLE "job_sourcing_requests"
ADD COLUMN IF NOT EXISTS "quality_gate_triggered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "queries_executed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "diagnostics" JSONB;
