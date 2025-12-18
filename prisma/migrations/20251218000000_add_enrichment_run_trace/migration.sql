-- Add runTrace field to enrichment_sessions for observability (Phase A.5)
-- Contains per-platform diagnostics, seed hints, and final metrics
ALTER TABLE "enrichment_sessions"
ADD COLUMN     "runTrace" JSONB;
