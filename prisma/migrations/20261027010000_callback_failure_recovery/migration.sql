-- Durable retry schedule for governed failure callbacks, so Flow learns a
-- search failed (and refunds it) even across deployments and outages.
-- Retries back off per request and stop at a bound; an exhausted callback is
-- kept pending and flagged for operator review, never silently abandoned.
ALTER TABLE "job_sourcing_requests"
  ADD COLUMN "callback_redelivery_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "callback_next_redelivery_at" TIMESTAMPTZ(6),
  ADD COLUMN "callback_review_required_at" TIMESTAMPTZ(6);
