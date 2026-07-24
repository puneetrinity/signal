CREATE TABLE IF NOT EXISTS "sourcing_coverage_states" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "queryFingerprint" TEXT NOT NULL,
    "rung" TEXT NOT NULL,
    "baselineTotal" INTEGER,
    "baselineObservedAt" TIMESTAMP(3),
    "lastProviderTotal" INTEGER,
    "lastRawReturnedCount" INTEGER NOT NULL DEFAULT 0,
    "lastDedupedCount" INTEGER NOT NULL DEFAULT 0,
    "lastSubmittedExclusionCount" INTEGER NOT NULL DEFAULT 0,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sourcing_coverage_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sourcing_coverage_states_scope_scopeKey_queryFingerprint_rung_key"
  ON "sourcing_coverage_states"("scope", "scopeKey", "queryFingerprint", "rung");

CREATE INDEX IF NOT EXISTS "sourcing_coverage_states_scope_scopeKey_queryFingerprint_lastObservedAt_idx"
  ON "sourcing_coverage_states"("scope", "scopeKey", "queryFingerprint", "lastObservedAt");
