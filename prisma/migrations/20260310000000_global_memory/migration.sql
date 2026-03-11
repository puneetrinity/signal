-- AlterTable
ALTER TABLE "candidate_intelligence_snapshots" ADD COLUMN     "locationConfidence" DOUBLE PRECISION,
ADD COLUMN     "locationSource" TEXT;

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "locationConfidence" DOUBLE PRECISION,
ADD COLUMN     "locationSource" TEXT;

-- AlterTable
ALTER TABLE "job_sourcing_requests" ADD COLUMN     "callback_sent_at" TIMESTAMP(3),
ADD COLUMN     "callback_status" TEXT,
ADD COLUMN     "diagnostics" JSONB,
ADD COLUMN     "last_reranked_at" TIMESTAMP(3),
ADD COLUMN     "quality_gate_triggered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "queries_executed" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "candidate_global_links" (
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
CREATE UNIQUE INDEX "candidate_global_links_candidateId_key" ON "candidate_global_links"("candidateId");

-- CreateIndex
CREATE INDEX "candidate_global_links_globalCandidateId_idx" ON "candidate_global_links"("globalCandidateId");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_global_links_tenantId_candidateId_key" ON "candidate_global_links"("tenantId", "candidateId");

-- AddForeignKey
ALTER TABLE "candidate_global_links" ADD CONSTRAINT "candidate_global_links_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
