-- CreateTable
CREATE TABLE "candidate_intelligence_snapshots" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "track" TEXT NOT NULL DEFAULT 'tech',
    "skillsNormalized" TEXT[],
    "roleType" TEXT,
    "seniorityBand" TEXT,
    "location" TEXT,
    "industries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activityRecencyDays" INTEGER,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staleAfter" TIMESTAMP(3) NOT NULL,
    "sourceSessionId" TEXT,
    "sourceFingerprint" TEXT,
    "signalsJson" JSONB,

    CONSTRAINT "candidate_intelligence_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "candidate_intelligence_snapshots_candidateId_tenantId_track_key" ON "candidate_intelligence_snapshots"("candidateId", "tenantId", "track");

-- CreateIndex
CREATE INDEX "candidate_intelligence_snapshots_tenantId_track_idx" ON "candidate_intelligence_snapshots"("tenantId", "track");

-- CreateIndex
CREATE INDEX "candidate_intelligence_snapshots_tenantId_staleAfter_idx" ON "candidate_intelligence_snapshots"("tenantId", "staleAfter");

-- AddForeignKey
ALTER TABLE "candidate_intelligence_snapshots" ADD CONSTRAINT "candidate_intelligence_snapshots_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
