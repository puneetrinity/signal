ALTER TABLE "job_sourcing_requests"
  ADD COLUMN IF NOT EXISTS "acquisition_generation" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "execution_attempt_id" TEXT,
  ADD COLUMN IF NOT EXISTS "processing_lease_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "job_sourcing_requests_id_tenantId_key"
  ON "job_sourcing_requests"("id", "tenantId");

CREATE TABLE IF NOT EXISTS "crustdata_acquisition_receipts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourcingRequestId" TEXT NOT NULL,
    "acquisitionGeneration" INTEGER NOT NULL,
    "slot" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'started',
    "requestFingerprint" TEXT NOT NULL,
    "requestInput" JSONB NOT NULL,
    "requestMetadata" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "effectsAppliedAt" TIMESTAMP(3),
    "effectMetadata" JSONB,
    "memory_ingested_at" TIMESTAMP(3),
    "memory_ingest_metadata" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crustdata_acquisition_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crustdata_acquisition_receipts_generation_check"
      CHECK ("acquisitionGeneration" > 0),
    CONSTRAINT "crustdata_acquisition_receipts_slot_check"
      CHECK ("slot" IN ('exact', 'spill')),
    CONSTRAINT "crustdata_acquisition_receipts_status_check"
      CHECK ("status" IN ('started', 'complete', 'uncertain', 'released'))
);

ALTER TABLE "crustdata_acquisition_receipts"
  ADD COLUMN IF NOT EXISTS "memory_ingested_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "memory_ingest_metadata" JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS "crustdata_receipts_request_generation_slot_key"
  ON "crustdata_acquisition_receipts"("tenantId", "sourcingRequestId", "acquisitionGeneration", "slot");

DO $$ BEGIN
  ALTER TABLE "crustdata_acquisition_receipts"
    ADD CONSTRAINT "crustdata_acquisition_receipts_sourcingRequestId_tenantId_fkey"
    FOREIGN KEY ("sourcingRequestId", "tenantId")
    REFERENCES "job_sourcing_requests"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_sourcing_requests"
    ADD CONSTRAINT "job_sourcing_requests_acquisition_generation_check"
    CHECK ("acquisition_generation" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
