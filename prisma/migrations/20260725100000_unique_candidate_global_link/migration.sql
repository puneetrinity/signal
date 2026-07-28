-- A tenant must never materialize two local candidates for the same canonical
-- Memory identity. Refuse to hide historical conflicts: operators must
-- reconcile them explicitly before this invariant can be installed.
DO $$
DECLARE
  duplicate_summary TEXT;
BEGIN
  SELECT string_agg(
    format(
      'tenant=%s global_candidate=%s candidates=[%s]',
      tenant_id,
      global_candidate_id,
      candidate_ids
    ),
    '; '
  )
  INTO duplicate_summary
  FROM (
    SELECT
      "tenantId" AS tenant_id,
      "globalCandidateId" AS global_candidate_id,
      string_agg("candidateId", ', ' ORDER BY "candidateId") AS candidate_ids
    FROM "candidate_global_links"
    GROUP BY "tenantId", "globalCandidateId"
    HAVING COUNT(*) > 1
    ORDER BY "tenantId", "globalCandidateId"
    LIMIT 20
  ) AS duplicates;

  IF duplicate_summary IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce one local candidate per tenant/global identity. Reconcile duplicate candidate_global_links first: %',
      duplicate_summary
      USING ERRCODE = '23505';
  END IF;
END
$$;

-- Refuse to install a nominal tenant key over historically cross-tenant links.
DO $$
DECLARE
  mismatch_summary TEXT;
BEGIN
  SELECT string_agg(
    format(
      'link=%s link_tenant=%s candidate=%s candidate_tenant=%s',
      links."id",
      links."tenantId",
      links."candidateId",
      candidates."tenantId"
    ),
    '; '
  )
  INTO mismatch_summary
  FROM "candidate_global_links" AS links
  JOIN "candidates" AS candidates
    ON candidates."id" = links."candidateId"
  WHERE candidates."tenantId" <> links."tenantId"
  LIMIT 20;

  IF mismatch_summary IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce tenant-safe candidate links. Reconcile mismatched candidate_global_links first: %',
      mismatch_summary
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE UNIQUE INDEX
  "candidates_tenantId_id_key"
ON "candidates"("tenantId", "id");

CREATE UNIQUE INDEX
  "candidate_global_links_tenantId_globalCandidateId_key"
ON "candidate_global_links"("tenantId", "globalCandidateId");

ALTER TABLE "candidate_global_links"
  DROP CONSTRAINT "candidate_global_links_candidateId_fkey";

ALTER TABLE "candidate_global_links"
  ADD CONSTRAINT "candidate_global_links_tenantId_candidateId_fkey"
  FOREIGN KEY ("tenantId", "candidateId")
  REFERENCES "candidates"("tenantId", "id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
