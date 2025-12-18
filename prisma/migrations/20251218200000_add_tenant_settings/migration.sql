-- CreateTable
CREATE TABLE "tenant_settings" (
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_settings_tenantId_key" ON "tenant_settings"("tenantId");

-- CreateIndex
CREATE INDEX "tenant_settings_tenantId_idx" ON "tenant_settings"("tenantId");

-- CreateIndex
CREATE INDEX "tenant_settings_plan_idx" ON "tenant_settings"("plan");
