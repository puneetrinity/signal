-- Add searchMeta field to candidates for Serper KG/answerBox metadata
ALTER TABLE "candidates"
ADD COLUMN     "searchMeta" JSONB;
