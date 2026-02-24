/**
 * Fix missing columns in production database (baselined migrations that didn't execute)
 * Run with: npx tsx scripts/fix-tenant-migration.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('[Fix] Starting migration fix...');

  const statements = [
    // === Migration: Add companyHint to candidates ===
    `ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "companyHint" TEXT`,

    // === Migration: Add bridge detection fields to identity_candidates (v2.1) ===
    `ALTER TABLE "identity_candidates" ADD COLUMN IF NOT EXISTS "bridgeTier" INTEGER`,
    `ALTER TABLE "identity_candidates" ADD COLUMN IF NOT EXISTS "bridgeSignals" JSONB`,
    `ALTER TABLE "identity_candidates" ADD COLUMN IF NOT EXISTS "persistReason" TEXT`,
    `CREATE INDEX IF NOT EXISTS "identity_candidates_bridgeTier_idx" ON "identity_candidates"("bridgeTier")`,

    // === Migration 20251217000000: Add summary fields to enrichment_sessions ===
    `ALTER TABLE "enrichment_sessions" ADD COLUMN IF NOT EXISTS "summary" TEXT`,
    `ALTER TABLE "enrichment_sessions" ADD COLUMN IF NOT EXISTS "summaryStructured" JSONB`,
    `ALTER TABLE "enrichment_sessions" ADD COLUMN IF NOT EXISTS "summaryEvidence" JSONB`,
    `ALTER TABLE "enrichment_sessions" ADD COLUMN IF NOT EXISTS "summaryModel" TEXT`,
    `ALTER TABLE "enrichment_sessions" ADD COLUMN IF NOT EXISTS "summaryTokens" INTEGER`,
    `ALTER TABLE "enrichment_sessions" ADD COLUMN IF NOT EXISTS "summaryGeneratedAt" TIMESTAMP(3)`,

    // === Migration 20251218000000: Add runTrace field ===
    `ALTER TABLE "enrichment_sessions" ADD COLUMN IF NOT EXISTS "runTrace" JSONB`,

    // === Migration 20260218010000: Add sourcing diagnostics columns ===
    `ALTER TABLE "job_sourcing_requests" ADD COLUMN IF NOT EXISTS "quality_gate_triggered" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "job_sourcing_requests" ADD COLUMN IF NOT EXISTS "queries_executed" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "job_sourcing_requests" ADD COLUMN IF NOT EXISTS "diagnostics" JSONB`,
    // Cleanup duplicate camelCase columns if a previous db push created them.
    `DO $$
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
END $$`,
    `DO $$
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
END $$`,
    `ALTER TABLE "job_sourcing_requests" DROP COLUMN IF EXISTS "qualityGateTriggered"`,
    `ALTER TABLE "job_sourcing_requests" DROP COLUMN IF EXISTS "queriesExecuted"`,

    // === Migration 20251218200000: Create tenant_settings table ===
    `CREATE TABLE IF NOT EXISTS "tenant_settings" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "rateLimitMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
      "maxEnrichmentsPerDay" INTEGER NOT NULL DEFAULT 100,
      "maxQueriesPerEnrichment" INTEGER NOT NULL DEFAULT 30,
      "maxParallelPlatforms" INTEGER NOT NULL DEFAULT 3,
      "features" JSONB,
      "allowContactStorage" BOOLEAN NOT NULL DEFAULT true,
      "plan" TEXT NOT NULL DEFAULT 'free',
      "planSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "tenant_settings_tenantId_key" ON "tenant_settings"("tenantId")`,
    `CREATE INDEX IF NOT EXISTS "tenant_settings_tenantId_idx" ON "tenant_settings"("tenantId")`,
    `CREATE INDEX IF NOT EXISTS "tenant_settings_plan_idx" ON "tenant_settings"("plan")`,

    // === Migration 20251218100000: Add tenantId columns ===
    // Step 1: Add tenantId columns
    `ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "tenantId" TEXT`,
    `ALTER TABLE "identity_candidates" ADD COLUMN IF NOT EXISTS "tenantId" TEXT`,
    `ALTER TABLE "confirmed_identities" ADD COLUMN IF NOT EXISTS "tenantId" TEXT`,
    `ALTER TABLE "enrichment_sessions" ADD COLUMN IF NOT EXISTS "tenantId" TEXT`,
    `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "tenantId" TEXT`,
    `ALTER TABLE "search_cache_v2" ADD COLUMN IF NOT EXISTS "tenantId" TEXT`,

    // Step 2: Set default value for existing rows
    `UPDATE "candidates" SET "tenantId" = 'migration-tenant-pending' WHERE "tenantId" IS NULL`,
    `UPDATE "identity_candidates" SET "tenantId" = 'migration-tenant-pending' WHERE "tenantId" IS NULL`,
    `UPDATE "confirmed_identities" SET "tenantId" = 'migration-tenant-pending' WHERE "tenantId" IS NULL`,
    `UPDATE "enrichment_sessions" SET "tenantId" = 'migration-tenant-pending' WHERE "tenantId" IS NULL`,
    `UPDATE "search_cache_v2" SET "tenantId" = 'migration-tenant-pending' WHERE "tenantId" IS NULL`,

    // Step 3: Make columns non-nullable
    `ALTER TABLE "candidates" ALTER COLUMN "tenantId" SET NOT NULL`,
    `ALTER TABLE "identity_candidates" ALTER COLUMN "tenantId" SET NOT NULL`,
    `ALTER TABLE "confirmed_identities" ALTER COLUMN "tenantId" SET NOT NULL`,
    `ALTER TABLE "enrichment_sessions" ALTER COLUMN "tenantId" SET NOT NULL`,
    `ALTER TABLE "search_cache_v2" ALTER COLUMN "tenantId" SET NOT NULL`,

    // Step 4: Drop old unique constraints
    `ALTER TABLE "candidates" DROP CONSTRAINT IF EXISTS "candidates_linkedinUrl_key"`,
    `ALTER TABLE "candidates" DROP CONSTRAINT IF EXISTS "candidates_linkedinId_key"`,
    `ALTER TABLE "identity_candidates" DROP CONSTRAINT IF EXISTS "identity_candidates_candidateId_platform_platformId_key"`,
    `ALTER TABLE "confirmed_identities" DROP CONSTRAINT IF EXISTS "confirmed_identities_candidateId_platform_platformId_key"`,
    `ALTER TABLE "confirmed_identities" DROP CONSTRAINT IF EXISTS "confirmed_identities_identityCandidateId_key"`,
    `ALTER TABLE "search_cache_v2" DROP CONSTRAINT IF EXISTS "search_cache_v2_queryHash_key"`,

    // Step 5: Create new tenant-scoped unique constraints
    `CREATE UNIQUE INDEX IF NOT EXISTS "candidates_tenantId_linkedinUrl_key" ON "candidates"("tenantId", "linkedinUrl")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "candidates_tenantId_linkedinId_key" ON "candidates"("tenantId", "linkedinId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "identity_candidates_tenantId_candidateId_platform_platformId_key" ON "identity_candidates"("tenantId", "candidateId", "platform", "platformId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "confirmed_identities_tenantId_candidateId_platform_platformId_key" ON "confirmed_identities"("tenantId", "candidateId", "platform", "platformId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "confirmed_identities_tenantId_identityCandidateId_key" ON "confirmed_identities"("tenantId", "identityCandidateId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "search_cache_v2_tenantId_queryHash_key" ON "search_cache_v2"("tenantId", "queryHash")`,

    // Step 6: Create indexes
    `CREATE INDEX IF NOT EXISTS "candidates_tenantId_idx" ON "candidates"("tenantId")`,
    `CREATE INDEX IF NOT EXISTS "candidates_tenantId_linkedinId_idx" ON "candidates"("tenantId", "linkedinId")`,
    `CREATE INDEX IF NOT EXISTS "identity_candidates_tenantId_idx" ON "identity_candidates"("tenantId")`,
    `CREATE INDEX IF NOT EXISTS "confirmed_identities_tenantId_idx" ON "confirmed_identities"("tenantId")`,
    `CREATE INDEX IF NOT EXISTS "enrichment_sessions_tenantId_idx" ON "enrichment_sessions"("tenantId")`,
    `CREATE INDEX IF NOT EXISTS "audit_logs_tenantId_idx" ON "audit_logs"("tenantId")`,
    `CREATE INDEX IF NOT EXISTS "search_cache_v2_tenantId_idx" ON "search_cache_v2"("tenantId")`,
    `CREATE INDEX IF NOT EXISTS "search_cache_v2_tenantId_queryHash_idx" ON "search_cache_v2"("tenantId", "queryHash")`,
  ];

  for (const sql of statements) {
    try {
      console.log(`[Fix] Running: ${sql.slice(0, 60)}...`);
      await prisma.$executeRawUnsafe(sql);
      console.log(`[Fix] ✓ Success`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Ignore "already exists" or "does not exist" errors
      if (msg.includes('already exists') || msg.includes('does not exist')) {
        console.log(`[Fix] ⚠ Skipped (already done)`);
      } else {
        console.error(`[Fix] ✗ Error: ${msg}`);
      }
    }
  }

  console.log('[Fix] Done!');
}

main()
  .catch((e) => {
    console.error('[Fix] Fatal error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
