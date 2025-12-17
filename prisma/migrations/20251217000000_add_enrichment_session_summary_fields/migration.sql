-- Add summary fields to enrichment_sessions (v2.1)
ALTER TABLE "enrichment_sessions"
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "summaryStructured" JSONB,
ADD COLUMN     "summaryEvidence" JSONB,
ADD COLUMN     "summaryModel" TEXT,
ADD COLUMN     "summaryTokens" INTEGER,
ADD COLUMN     "summaryGeneratedAt" TIMESTAMP(3);

