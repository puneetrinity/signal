-- Add callback delivery fields
ALTER TABLE "job_sourcing_requests"
  ADD COLUMN IF NOT EXISTS "callback_status" TEXT,
  ADD COLUMN IF NOT EXISTS "callback_sent_at" TIMESTAMPTZ;

-- Backfill: callback_sent → status='complete', callbackStatus='delivered'
UPDATE "job_sourcing_requests"
  SET status = 'complete',
      callback_status = 'delivered',
      callback_sent_at = "completedAt"
  WHERE status = 'callback_sent';

-- Backfill: callback_failed → status='complete', callbackStatus='failed'
-- callback_sent_at stays NULL for rows that never succeeded
UPDATE "job_sourcing_requests"
  SET status = 'complete',
      callback_status = 'failed'
  WHERE status = 'callback_failed';

-- Set callbackStatus='pending' for complete requests that haven't been backfilled
UPDATE "job_sourcing_requests"
  SET callback_status = 'pending'
  WHERE status = 'complete' AND callback_status IS NULL;

-- Index for stale callback redelivery queries
CREATE INDEX IF NOT EXISTS "idx_sourcing_requests_callback_status"
  ON "job_sourcing_requests" ("callback_status")
  WHERE "callback_status" = 'failed';
