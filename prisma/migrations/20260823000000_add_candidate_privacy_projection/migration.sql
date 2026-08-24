CREATE TABLE "candidate_privacy_sync_state" (
  "consumer_name" TEXT NOT NULL,
  "cursor" BIGINT NOT NULL DEFAULT 0,
  "active_generation" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'uninitialized',
  "last_success_at" TIMESTAMPTZ,
  "rebuild_started_at" TIMESTAMPTZ,
  "last_error_code" TEXT,
  "expected_candidates" INTEGER NOT NULL DEFAULT 0,
  "projected_candidates" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "candidate_privacy_sync_state_pkey" PRIMARY KEY ("consumer_name"),
  CONSTRAINT "candidate_privacy_sync_state_consumer_check"
    CHECK ("consumer_name" = 'discover'),
  CONSTRAINT "candidate_privacy_sync_state_cursor_check"
    CHECK ("cursor" >= 0),
  CONSTRAINT "candidate_privacy_sync_state_generation_check"
    CHECK ("active_generation" >= 0),
  CONSTRAINT "candidate_privacy_sync_state_status_check"
    CHECK ("status" IN ('uninitialized', 'healthy', 'stale', 'rebuilding', 'needs_reconciliation')),
  CONSTRAINT "candidate_privacy_sync_state_error_code_check"
    CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT "candidate_privacy_sync_state_counts_check"
    CHECK (
      "expected_candidates" >= 0
      AND "projected_candidates" >= 0
      AND "projected_candidates" <= "expected_candidates"
    )
);

INSERT INTO "candidate_privacy_sync_state" (
  "consumer_name",
  "cursor",
  "active_generation",
  "status",
  "expected_candidates",
  "projected_candidates"
) VALUES ('discover', 0, 0, 'uninitialized', 0, 0);

CREATE TABLE "candidate_privacy_projection" (
  "tenant_id" TEXT NOT NULL,
  "candidate_id" TEXT NOT NULL,
  "generation" BIGINT NOT NULL,
  "decision" TEXT NOT NULL,
  "evaluated_cursor" BIGINT NOT NULL,
  "checked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "candidate_privacy_projection_pkey"
    PRIMARY KEY ("tenant_id", "candidate_id", "generation"),
  CONSTRAINT "candidate_privacy_projection_generation_check"
    CHECK ("generation" > 0),
  CONSTRAINT "candidate_privacy_projection_cursor_check"
    CHECK ("evaluated_cursor" >= 0),
  CONSTRAINT "candidate_privacy_projection_decision_check"
    CHECK ("decision" IN ('allow', 'block_global', 'block_all', 'review')),
  CONSTRAINT "candidate_privacy_projection_tenant_id_candidate_id_fkey"
    FOREIGN KEY ("tenant_id", "candidate_id")
    REFERENCES "candidates"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "candidate_privacy_projection_active_idx"
  ON "candidate_privacy_projection"("tenant_id", "generation", "decision", "candidate_id");

CREATE INDEX "candidate_privacy_projection_generation_idx"
  ON "candidate_privacy_projection"("generation", "candidate_id");

REVOKE ALL ON TABLE "candidate_privacy_sync_state" FROM PUBLIC;
REVOKE ALL ON TABLE "candidate_privacy_projection" FROM PUBLIC;
