-- Add last_reranked_at to job_sourcing_requests.
-- Tracks when post-enrichment rerank last updated fitScore/rank for a request.

ALTER TABLE "job_sourcing_requests"
ADD COLUMN IF NOT EXISTS "last_reranked_at" TIMESTAMPTZ;
