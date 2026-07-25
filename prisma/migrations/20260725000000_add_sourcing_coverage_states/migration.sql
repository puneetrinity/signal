CREATE TABLE IF NOT EXISTS "sourcing_coverage_states" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "queryFingerprint" TEXT NOT NULL,
    "activeRung" TEXT,
    "shortfallStreak" INTEGER NOT NULL DEFAULT 0,
    "lastExactProviderTotal" INTEGER,
    "lastExactRequestedLimit" INTEGER NOT NULL DEFAULT 0,
    "lastProviderTotal" INTEGER,
    "lastRequestedLimit" INTEGER NOT NULL DEFAULT 0,
    "lastRawReturnedCount" INTEGER NOT NULL DEFAULT 0,
    "lastSpillObservedAt" TIMESTAMP(3),
    "lastSubmittedExclusionCount" INTEGER NOT NULL DEFAULT 0,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sourcing_coverage_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sourcing_coverage_states_scope_scopeKey_queryFingerprint_key"
  ON "sourcing_coverage_states"("scope", "scopeKey", "queryFingerprint");

CREATE INDEX IF NOT EXISTS "sourcing_coverage_states_scope_scopeKey_queryFingerprint_lastObservedAt_idx"
  ON "sourcing_coverage_states"("scope", "scopeKey", "queryFingerprint", "lastObservedAt");
