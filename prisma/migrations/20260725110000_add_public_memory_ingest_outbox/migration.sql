CREATE TABLE "public_memory_ingest_outbox" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "signalCandidateId" TEXT NOT NULL,
  "sourcingRequestId" TEXT,
  "localCandidateId" TEXT,
  "payload" JSONB NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "globalCandidateId" TEXT,
  "lastErrorCode" TEXT,
  "acknowledgedAt" TIMESTAMP(3),
  "linkedAt" TIMESTAMP(3),
  "linkAttempts" INTEGER NOT NULL DEFAULT 0,
  "linkNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "linkLastErrorCode" TEXT,
  "linkDeadAt" TIMESTAMP(3),
  "payloadCompactedAt" TIMESTAMP(3),
  "diagnosticsRecordedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "public_memory_ingest_outbox_status_check"
    CHECK ("status" IN ('pending', 'processing', 'succeeded', 'dead')),
  CONSTRAINT "public_memory_ingest_outbox_attempts_check"
    CHECK ("attempts" >= 0),
  CONSTRAINT "public_memory_ingest_outbox_generation_check"
    CHECK ("generation" >= 1),
  CONSTRAINT "public_memory_ingest_outbox_link_attempts_check"
    CHECK ("linkAttempts" >= 0),
  CONSTRAINT "public_memory_ingest_outbox_lease_check"
    CHECK (
      ("status" = 'processing' AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
      OR
      ("status" <> 'processing' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
    )
);

CREATE UNIQUE INDEX
  "public_memory_ingest_outbox_tenantId_signalCandidateId_key"
ON "public_memory_ingest_outbox"("tenantId", "signalCandidateId");

CREATE INDEX
  "public_memory_ingest_outbox_status_nextAttemptAt_idx"
ON "public_memory_ingest_outbox"("status", "nextAttemptAt");

CREATE INDEX
  "public_memory_ingest_outbox_sourcingRequestId_status_idx"
ON "public_memory_ingest_outbox"("sourcingRequestId", "status");

CREATE INDEX
  "public_memory_ingest_outbox_leaseExpiresAt_idx"
ON "public_memory_ingest_outbox"("leaseExpiresAt");

CREATE INDEX
  "public_memory_ingest_outbox_linkNextAttemptAt_idx"
ON "public_memory_ingest_outbox"("linkNextAttemptAt");

CREATE INDEX
  "public_memory_ingest_outbox_status_payloadCompactedAt_idx"
ON "public_memory_ingest_outbox"("status", "payloadCompactedAt");

CREATE TABLE "public_memory_ingest_receipts" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "signalCandidateId" TEXT NOT NULL,
  "sourcingRequestId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "terminalAt" TIMESTAMP(3),
  "diagnosticsRecordedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "public_memory_ingest_receipts_status_check"
    CHECK ("status" IN ('pending', 'succeeded', 'dead'))
);

CREATE UNIQUE INDEX
  "public_memory_ingest_receipts_sourcingRequestId_signalCandi_key"
ON "public_memory_ingest_receipts"("sourcingRequestId", "signalCandidateId");

CREATE INDEX
  "public_memory_ingest_receipts_tenantId_signalCandidateId_idx"
ON "public_memory_ingest_receipts"("tenantId", "signalCandidateId");

CREATE INDEX
  "public_memory_ingest_receipts_sourcingRequestId_status_idx"
ON "public_memory_ingest_receipts"("sourcingRequestId", "status");

CREATE INDEX
  "public_memory_ingest_receipts_diagnosticsRecordedAt_created_idx"
ON "public_memory_ingest_receipts"("diagnosticsRecordedAt", "createdAt");
