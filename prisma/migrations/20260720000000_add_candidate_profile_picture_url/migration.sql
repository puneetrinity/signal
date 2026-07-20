-- The Candidate.profilePictureUrl field was added to schema.prisma without a
-- migration, so prod's candidates table lacked the column and every sourced-
-- candidate upsert failed ("column candidates.profilePictureUrl does not
-- exist"). IF NOT EXISTS makes this safe whether or not the column was already
-- added out-of-band.
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "profilePictureUrl" TEXT;
