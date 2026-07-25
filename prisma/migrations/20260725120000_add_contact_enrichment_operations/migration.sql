-- Earlier find-contact implementations could persist resolved addresses inside
-- candidates.searchMeta.crustdata. Keep only non-sensitive availability flags;
-- durable contact evidence now belongs exclusively in Memory.
UPDATE "candidates"
SET "searchMeta" = jsonb_set(
  "searchMeta",
  '{crustdata}',
  (
    (
      ("searchMeta"->'crustdata')
      - 'email'
      - 'emails'
      - 'personal_email'
      - 'personal_emails'
      - 'work_email'
      - 'work_emails'
      - 'business_email'
      - 'business_emails'
      - 'phone'
      - 'phones'
      - 'phone_number'
      - 'phone_numbers'
      - 'contact_info'
      - 'contact'
    )
    ||
    CASE
      WHEN jsonb_typeof("searchMeta"#>'{crustdata,contact}') = 'object'
      THEN jsonb_build_object(
        'contact',
        jsonb_strip_nulls(
          jsonb_build_object(
            'has_business_email',
              CASE
                WHEN jsonb_typeof(
                  "searchMeta"#>'{crustdata,contact,has_business_email}'
                ) = 'boolean'
                THEN "searchMeta"#>'{crustdata,contact,has_business_email}'
                ELSE NULL
              END,
            'has_personal_email',
              CASE
                WHEN jsonb_typeof(
                  "searchMeta"#>'{crustdata,contact,has_personal_email}'
                ) = 'boolean'
                THEN "searchMeta"#>'{crustdata,contact,has_personal_email}'
                ELSE NULL
              END,
            'has_phone_number',
              CASE
                WHEN jsonb_typeof(
                  "searchMeta"#>'{crustdata,contact,has_phone_number}'
                ) = 'boolean'
                THEN "searchMeta"#>'{crustdata,contact,has_phone_number}'
                ELSE NULL
              END
          )
        )
      )
      ELSE '{}'::jsonb
    END
  ),
  true
)
WHERE jsonb_typeof("searchMeta"->'crustdata') = 'object';

CREATE TABLE "contact_enrichment_operations" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "globalCandidateId" TEXT,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "provider" TEXT,
  "providerRequestKey" TEXT,
  "providerRecordId" TEXT,
  "stagedEvidence" JSONB,
  "stagedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "providerStartedAt" TIMESTAMP(3),
  "selectedEmail" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contact_enrichment_operations_tenantId_candidateId_fkey"
    FOREIGN KEY ("tenantId", "candidateId")
    REFERENCES "candidates"("tenantId", "id")
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT "contact_enrichment_operations_state_check"
    CHECK (
      "state" IN (
        'queued',
        'awaiting_global_id',
        'memory_lookup',
        'fullenrich_starting',
        'fullenrich_polling',
        'fullenrich_ambiguous',
        'enrichlayer_starting',
        'enrichlayer_ambiguous',
        'evidence_pending',
        'found',
        'suppressed',
        'not_found',
        'failed'
      )
    ),
  CONSTRAINT "contact_enrichment_operations_generation_check"
    CHECK ("generation" >= 1),
  CONSTRAINT "contact_enrichment_operations_attempts_check"
    CHECK ("attempts" >= 0),
  CONSTRAINT "contact_enrichment_operations_provider_check"
    CHECK (
      "provider" IS NULL
      OR "provider" IN ('fullenrich', 'enrichlayer')
    ),
  CONSTRAINT "contact_enrichment_operations_lease_check"
    CHECK (
      ("leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
      OR
      ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    ),
  CONSTRAINT "contact_enrichment_operations_start_lease_check"
    CHECK (
      "state" NOT IN (
        'fullenrich_starting',
        'enrichlayer_starting'
      )
      OR
      ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    ),
  CONSTRAINT "contact_enrichment_operations_evidence_check"
    CHECK (
      "state" <> 'evidence_pending'
      OR
      ("stagedEvidence" IS NOT NULL AND "stagedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX
  "contact_enrichment_operations_tenantId_candidateId_key"
ON "contact_enrichment_operations"("tenantId", "candidateId");

CREATE UNIQUE INDEX
  "contact_enrichment_operations_tenantId_globalCandidateId_key"
ON "contact_enrichment_operations"("tenantId", "globalCandidateId");

CREATE INDEX
  "contact_enrichment_operations_state_nextAttemptAt_idx"
ON "contact_enrichment_operations"("state", "nextAttemptAt");

CREATE INDEX
  "contact_enrichment_operations_leaseExpiresAt_idx"
ON "contact_enrichment_operations"("leaseExpiresAt");
