-- Candidate Privacy Phase 1AR — durable rebuild ownership and recovery.
--
-- Additive operational metadata only. Existing candidate, projection and
-- singleton values remain untouched; old 1AD code may safely ignore these
-- nullable columns during the forward-compatible rollout overlap.

ALTER TABLE "candidate_privacy_sync_state"
  ADD COLUMN "rebuild_claim_token" UUID,
  ADD COLUMN "rebuild_lease_expires_at" TIMESTAMPTZ(6);

CREATE INDEX "candidate_privacy_rebuild_lease_idx"
  ON "candidate_privacy_sync_state"("rebuild_lease_expires_at")
  WHERE "status" = 'rebuilding';
