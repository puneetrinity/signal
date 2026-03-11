-- AlterTable (idempotent: columns may not exist yet)
ALTER TABLE "candidate_intelligence_snapshots" ADD COLUMN IF NOT EXISTS "locationConfidence" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "locationSource" TEXT;

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "locationConfidence" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "locationSource" TEXT;

-- AlterTable (these columns were created outside Prisma migrations on some environments)
ALTER TABLE "job_sourcing_requests" ADD COLUMN IF NOT EXISTS "callback_sent_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "callback_status" TEXT,
ADD COLUMN IF NOT EXISTS "diagnostics" JSONB,
ADD COLUMN IF NOT EXISTS "last_reranked_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "quality_gate_triggered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "queries_executed" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE IF NOT EXISTS "candidate_global_links" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "globalCandidateId" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkConfidence" DOUBLE PRECISION,
    "matchMethod" TEXT,

    CONSTRAINT "candidate_global_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "candidate_global_links_candidateId_key" ON "candidate_global_links"("candidateId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "candidate_global_links_globalCandidateId_idx" ON "candidate_global_links"("globalCandidateId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "candidate_global_links_tenantId_candidateId_key" ON "candidate_global_links"("tenantId", "candidateId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "candidate_global_links" ADD CONSTRAINT "candidate_global_links_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
