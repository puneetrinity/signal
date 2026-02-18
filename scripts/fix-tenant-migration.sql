-- Fix missing tenantId columns (migration was baselined without running SQL)
-- Run this on Railway PostgreSQL via the Data → Query tab

-- Step 1: Add tenantId columns (IF NOT EXISTS for safety)
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "identity_candidates" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "confirmed_identities" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "enrichment_sessions" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "search_cache_v2" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Step 2: Set default value for existing rows
UPDATE "candidates" SET "tenantId" = 'migration-tenant-pending' WHERE "tenantId" IS NULL;
UPDATE "identity_candidates" SET "tenantId" = 'migration-tenant-pending' WHERE "tenantId" IS NULL;
UPDATE "confirmed_identities" SET "tenantId" = 'migration-tenant-pending' WHERE "tenantId" IS NULL;
UPDATE "enrichment_sessions" SET "tenantId" = 'migration-tenant-pending' WHERE "tenantId" IS NULL;
UPDATE "search_cache_v2" SET "tenantId" = 'migration-tenant-pending' WHERE "tenantId" IS NULL;

-- Step 3: Make columns non-nullable where required
ALTER TABLE "candidates" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "identity_candidates" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "confirmed_identities" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "enrichment_sessions" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "search_cache_v2" ALTER COLUMN "tenantId" SET NOT NULL;

-- Step 4: Drop old unique constraints (ignore errors if they don't exist)
ALTER TABLE "candidates" DROP CONSTRAINT IF EXISTS "candidates_linkedinUrl_key";
ALTER TABLE "candidates" DROP CONSTRAINT IF EXISTS "candidates_linkedinId_key";
ALTER TABLE "identity_candidates" DROP CONSTRAINT IF EXISTS "identity_candidates_candidateId_platform_platformId_key";
ALTER TABLE "confirmed_identities" DROP CONSTRAINT IF EXISTS "confirmed_identities_candidateId_platform_platformId_key";
ALTER TABLE "confirmed_identities" DROP CONSTRAINT IF EXISTS "confirmed_identities_identityCandidateId_key";
ALTER TABLE "search_cache_v2" DROP CONSTRAINT IF EXISTS "search_cache_v2_queryHash_key";

-- Step 5: Create new tenant-scoped unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS "candidates_tenantId_linkedinUrl_key" ON "candidates"("tenantId", "linkedinUrl");
CREATE UNIQUE INDEX IF NOT EXISTS "candidates_tenantId_linkedinId_key" ON "candidates"("tenantId", "linkedinId");
CREATE UNIQUE INDEX IF NOT EXISTS "identity_candidates_tenantId_candidateId_platform_platformId_key" ON "identity_candidates"("tenantId", "candidateId", "platform", "platformId");
CREATE UNIQUE INDEX IF NOT EXISTS "confirmed_identities_tenantId_candidateId_platform_platformId_key" ON "confirmed_identities"("tenantId", "candidateId", "platform", "platformId");
CREATE UNIQUE INDEX IF NOT EXISTS "confirmed_identities_tenantId_identityCandidateId_key" ON "confirmed_identities"("tenantId", "identityCandidateId");
CREATE UNIQUE INDEX IF NOT EXISTS "search_cache_v2_tenantId_queryHash_key" ON "search_cache_v2"("tenantId", "queryHash");

-- Step 6: Create indexes for tenant queries
CREATE INDEX IF NOT EXISTS "candidates_tenantId_idx" ON "candidates"("tenantId");
CREATE INDEX IF NOT EXISTS "candidates_tenantId_linkedinId_idx" ON "candidates"("tenantId", "linkedinId");
CREATE INDEX IF NOT EXISTS "identity_candidates_tenantId_idx" ON "identity_candidates"("tenantId");
CREATE INDEX IF NOT EXISTS "confirmed_identities_tenantId_idx" ON "confirmed_identities"("tenantId");
CREATE INDEX IF NOT EXISTS "enrichment_sessions_tenantId_idx" ON "enrichment_sessions"("tenantId");
CREATE INDEX IF NOT EXISTS "audit_logs_tenantId_idx" ON "audit_logs"("tenantId");
CREATE INDEX IF NOT EXISTS "search_cache_v2_tenantId_idx" ON "search_cache_v2"("tenantId");
CREATE INDEX IF NOT EXISTS "search_cache_v2_tenantId_queryHash_idx" ON "search_cache_v2"("tenantId", "queryHash");

-- Step 7: Add sourcing diagnostics columns (Phase 5.1)
ALTER TABLE "job_sourcing_requests" ADD COLUMN IF NOT EXISTS "quality_gate_triggered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "job_sourcing_requests" ADD COLUMN IF NOT EXISTS "queries_executed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "job_sourcing_requests" ADD COLUMN IF NOT EXISTS "diagnostics" JSONB;
