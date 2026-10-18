-- The migration runner owns the transaction.
SET LOCAL lock_timeout = '1500ms';
SET LOCAL statement_timeout = '30s';

ALTER TABLE candidates ADD COLUMN "identityKind" text NOT NULL DEFAULT 'linkedin',
  ADD COLUMN "privateCandidateRef" uuid,
  ALTER COLUMN "linkedinUrl" DROP NOT NULL,
  ALTER COLUMN "linkedinId" DROP NOT NULL;
ALTER TABLE candidates ADD CONSTRAINT candidates_identity_shape CHECK (
  ("identityKind" = 'linkedin' AND "privateCandidateRef" IS NULL
    AND "linkedinUrl" IS NOT NULL AND length(btrim("linkedinUrl")) > 0
    AND "linkedinId" IS NOT NULL AND length(btrim("linkedinId")) > 0)
  OR ("identityKind" = 'organization_candidate' AND "privateCandidateRef" IS NOT NULL
    AND "privateCandidateRef" <> '00000000-0000-0000-0000-000000000000'::uuid
    AND "tenantId" ~ '^org_[1-9][0-9]*$'
    AND "linkedinUrl" IS NULL AND "linkedinId" IS NULL)
);
CREATE UNIQUE INDEX "candidates_tenantId_privateCandidateRef_key"
  ON candidates ("tenantId", "privateCandidateRef");

CREATE FUNCTION public.signal_private_identity_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW."identityKind" IS DISTINCT FROM OLD."identityKind"
  OR NEW."privateCandidateRef" IS DISTINCT FROM OLD."privateCandidateRef"
  OR (OLD."identityKind"='organization_candidate' AND NEW."tenantId" IS DISTINCT FROM OLD."tenantId") THEN
  RAISE EXCEPTION 'PRIVATE_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.signal_private_identity_immutable() FROM PUBLIC;
CREATE TRIGGER private_identity_immutable BEFORE UPDATE ON public.candidates
 FOR EACH ROW EXECUTE FUNCTION public.signal_private_identity_immutable();

CREATE TABLE private_candidate_sources (
  tenant_id text NOT NULL,
  candidate_id text NOT NULL,
  reference_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  memory_candidate_id uuid NOT NULL,
  application_id integer NOT NULL CHECK (application_id > 0),
  application_job_id integer NOT NULL CHECK (application_job_id > 0),
  resume_version_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  linked_public_id uuid,
  authority_version integer NOT NULL DEFAULT 1 CHECK (authority_version = 1),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, candidate_id, reference_id, generation_id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates ("tenantId", id) ON DELETE RESTRICT,
  CHECK (tenant_id ~ '^org_[1-9][0-9]*$'),
  CHECK (reference_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND generation_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND memory_candidate_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND resume_version_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND source_id <> '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX private_candidate_sources_tenant_id_linked_public_id_idx
  ON private_candidate_sources (tenant_id, linked_public_id);
REVOKE ALL ON private_candidate_sources FROM PUBLIC;

ALTER TABLE private_candidate_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_candidate_sources FORCE ROW LEVEL SECURITY;
DO $$ DECLARE owner_name text; BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid='public.candidates'::regclass;
 EXECUTE format('ALTER TABLE public.private_candidate_sources OWNER TO %I',owner_name);
 EXECUTE format('CREATE POLICY private_candidate_sources_owner ON public.private_candidate_sources TO %I USING (true) WITH CHECK (true)',owner_name);
END $$;

CREATE FUNCTION public.signal_private_candidate_materialize(p_tenant text,p_hit jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET statement_timeout='3s' SET lock_timeout='1s' AS $$
DECLARE i jsonb; c public.candidates%ROWTYPE; existing public.private_candidate_sources%ROWTYPE;
 uid uuid; k text; observed timestamptz;
BEGIN
 IF p_tenant IS NULL OR p_tenant !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_hit) IS DISTINCT FROM 'object' OR octet_length(p_hit::text)>16384
  OR NOT p_hit ?& ARRAY['identity','linkedPublicId','observedAt']
  OR p_hit-ARRAY['identity','linkedPublicId','observedAt']<>'{}'::jsonb THEN
  RAISE EXCEPTION 'PRIVATE_CANDIDATE_INVALID'; END IF;
 i:=p_hit->'identity';
 IF jsonb_typeof(i) IS DISTINCT FROM 'object'
  OR NOT i ?& ARRAY['candidateId','referenceId','applicationId','applicationJobId','resumeVersionId','sourceId','generationId','sourceHash']
  OR i-ARRAY['candidateId','referenceId','applicationId','applicationJobId','resumeVersionId','sourceId','generationId','sourceHash']<>'{}'::jsonb THEN
  RAISE EXCEPTION 'PRIVATE_CANDIDATE_INVALID'; END IF;
 FOREACH k IN ARRAY ARRAY['candidateId','referenceId','resumeVersionId','sourceId','generationId'] LOOP
  IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR (i->>k) !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
   OR (i->>k)::uuid='00000000-0000-0000-0000-000000000000'::uuid THEN
   RAISE EXCEPTION 'PRIVATE_CANDIDATE_INVALID'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['applicationId','applicationJobId'] LOOP
  IF jsonb_typeof(i->k) IS DISTINCT FROM 'number' OR (i->>k) !~ '^[1-9][0-9]*$'
   OR (i->>k)::numeric>2147483647 THEN RAISE EXCEPTION 'PRIVATE_CANDIDATE_INVALID'; END IF;
 END LOOP;
 IF jsonb_typeof(i->'sourceHash') IS DISTINCT FROM 'string' OR (i->>'sourceHash') !~ '^[0-9a-f]{64}$'
  OR jsonb_typeof(p_hit->'observedAt') IS DISTINCT FROM 'string'
  OR length(p_hit->>'observedAt')>40 OR NOT pg_input_is_valid(p_hit->>'observedAt','timestamptz') THEN
  RAISE EXCEPTION 'PRIVATE_CANDIDATE_INVALID'; END IF;
 observed:=(p_hit->>'observedAt')::timestamptz;
 IF NOT isfinite(observed) OR observed>clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'PRIVATE_CANDIDATE_INVALID'; END IF;
 IF p_hit->'linkedPublicId'<>'null'::jsonb THEN
  IF jsonb_typeof(p_hit->'linkedPublicId') IS DISTINCT FROM 'string'
   OR (p_hit->>'linkedPublicId') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
   OR (p_hit->>'linkedPublicId')::uuid='00000000-0000-0000-0000-000000000000'::uuid THEN
   RAISE EXCEPTION 'PRIVATE_CANDIDATE_INVALID'; END IF;
 END IF;
 uid:=(i->>'candidateId')::uuid;
 INSERT INTO public.candidates (id,"tenantId","identityKind","privateCandidateRef","linkedinUrl","linkedinId",
   "captureSource","enrichmentStatus","createdAt","updatedAt")
 VALUES (gen_random_uuid()::text,p_tenant,'organization_candidate',uid,NULL,NULL,'organization_candidate','completed',clock_timestamp(),clock_timestamp())
 ON CONFLICT ("tenantId","privateCandidateRef") DO NOTHING;
 SELECT * INTO STRICT c FROM public.candidates WHERE "tenantId"=p_tenant AND "privateCandidateRef"=uid FOR UPDATE;
 IF c."identityKind"<>'organization_candidate' OR c."linkedinUrl" IS NOT NULL OR c."linkedinId" IS NOT NULL THEN
  RAISE EXCEPTION 'PRIVATE_CANDIDATE_CONFLICT'; END IF;
 INSERT INTO public.private_candidate_sources VALUES (
   p_tenant,c.id,(i->>'referenceId')::uuid,(i->>'generationId')::uuid,uid,
   (i->>'applicationId')::integer,(i->>'applicationJobId')::integer,(i->>'resumeVersionId')::uuid,
   (i->>'sourceId')::uuid,i->>'sourceHash',(p_hit->>'linkedPublicId')::uuid,1,observed)
 ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT existing FROM public.private_candidate_sources WHERE tenant_id=p_tenant
  AND candidate_id=c.id AND reference_id=(i->>'referenceId')::uuid AND generation_id=(i->>'generationId')::uuid;
 IF existing.memory_candidate_id<>uid OR existing.application_id<>(i->>'applicationId')::integer
  OR existing.application_job_id<>(i->>'applicationJobId')::integer OR existing.resume_version_id<>(i->>'resumeVersionId')::uuid
  OR existing.source_id<>(i->>'sourceId')::uuid OR existing.source_hash<>i->>'sourceHash'
  OR existing.linked_public_id IS DISTINCT FROM (p_hit->>'linkedPublicId')::uuid OR existing.observed_at<>observed THEN
  RAISE EXCEPTION 'PRIVATE_CANDIDATE_CONFLICT'; END IF;
 RETURN c.id;
END $$;
REVOKE ALL ON FUNCTION public.signal_private_candidate_materialize(text,jsonb) FROM PUBLIC;
CREATE FUNCTION public.signal_private_contact_allowed(p_tenant text,p_candidate text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
SET statement_timeout='3s' SET lock_timeout='1s' AS $$
 SELECT EXISTS(SELECT 1 FROM public.candidates c WHERE c."tenantId"=p_tenant AND c.id=p_candidate
  AND c."identityKind"='linkedin' AND c."privateCandidateRef" IS NULL
  AND length(btrim(c."linkedinId"))>0
  AND c."linkedinUrl" ~ '^https://([a-z0-9-]+[.])*linkedin[.]com/(in|pub)/[^/?#[:space:]@]+/?$'
  AND NOT EXISTS(SELECT 1 FROM public.private_candidate_sources p WHERE p.tenant_id=c."tenantId"
   AND (p.candidate_id=c.id OR p.linked_public_id::text IN (
    SELECT l."globalCandidateId" FROM public.candidate_global_links l WHERE l."tenantId"=c."tenantId" AND l."candidateId"=c.id))));
$$;
REVOKE ALL ON FUNCTION public.signal_private_contact_allowed(text,text) FROM PUBLIC;
CREATE FUNCTION public.signal_private_evidence_bound(p_tenant text,p_evidence jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
SET statement_timeout='3s' SET lock_timeout='1s' AS $$
 SELECT EXISTS(SELECT 1 FROM public.candidates c WHERE c."tenantId"=p_tenant AND c.id=p_evidence->>'candidateId'
  AND ((c."identityKind"='linkedin' AND NOT p_evidence ? 'resumeIdentity')
   OR (c."identityKind"='organization_candidate' AND p_evidence->>'version'='rubric-evidence-v2'
    AND EXISTS(SELECT 1 FROM public.private_candidate_sources s WHERE s.tenant_id=p_tenant AND s.candidate_id=c.id
     AND p_evidence->'resumeIdentity'=jsonb_build_object('candidateId',s.memory_candidate_id,'referenceId',s.reference_id,
       'applicationId',s.application_id,'applicationJobId',s.application_job_id,'resumeVersionId',s.resume_version_id,
       'sourceId',s.source_id,'generationId',s.generation_id,'sourceHash',s.source_hash)))));
$$;
REVOKE ALL ON FUNCTION public.signal_private_evidence_bound(text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_private_ranking_sources(p_tenant text,p_flow uuid,p_revision uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
SET statement_timeout='3s' SET lock_timeout='1s' AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.governed_ranking_runs r WHERE r.tenant_id=p_tenant
   AND r.flow_run_id=p_flow AND r.revision_id=p_revision AND r.state='ready') THEN
   RAISE EXCEPTION 'PRIVATE_RANKING_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM public.governed_ranking_items i WHERE i.tenant_id=p_tenant
   AND i.flow_run_id=p_flow AND i.revision_id=p_revision
   AND NOT public.signal_private_evidence_bound(p_tenant,i.evidence)) THEN
   RAISE EXCEPTION 'PRIVATE_RANKING_UNAVAILABLE'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('candidateId',i.candidate_id,'identity',i.evidence->'resumeIdentity')
  ORDER BY i.candidate_id COLLATE "C"),'[]'::jsonb) INTO result
 FROM public.governed_ranking_items i WHERE i.tenant_id=p_tenant AND i.flow_run_id=p_flow AND i.revision_id=p_revision
  AND i.evidence ? 'resumeIdentity';
 IF jsonb_array_length(result)>100 OR octet_length(result::text)>65536 THEN RAISE EXCEPTION 'PRIVATE_RANKING_UNAVAILABLE'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.signal_private_ranking_sources(text,uuid,uuid) FROM PUBLIC;
-- Preserve the frozen body except these counted substitutions.
DO $forward$ DECLARE definition text; source text; BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc INTO STRICT definition,source FROM pg_proc p WHERE p.oid='public.signal_sourcing_bind(text,uuid,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(source,'UTF8')),'hex')<>'1d52738a6c3fe22958448a9b25127bf7412159c5833a426d9fdcb3e03d0ecab0' THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 IF (length(definition)-length(replace(definition,' OR ((v_json->>''policyVersion'',v_json->>''taxonomyVersion'',v_json->>''adapterVersion'',v_json->>''localMatchVersion'') =
   (''rubric-approved-skills-v1'',''rubric-taxonomy-v4'',''rubric-evidence-v1'',''rubric-local-match-v4'')
   AND v_json->''payload''->''schemaVersion''=''3''::jsonb AND v_json->''payload''->''compilerVersion''=''3''::jsonb AND v_json->''payload''->''taxonomyVersion''=''3''::jsonb)','')))/length(' OR ((v_json->>''policyVersion'',v_json->>''taxonomyVersion'',v_json->>''adapterVersion'',v_json->>''localMatchVersion'') =
   (''rubric-approved-skills-v1'',''rubric-taxonomy-v4'',''rubric-evidence-v1'',''rubric-local-match-v4'')
   AND v_json->''payload''->''schemaVersion''=''3''::jsonb AND v_json->''payload''->''compilerVersion''=''3''::jsonb AND v_json->''payload''->''taxonomyVersion''=''3''::jsonb)')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,' OR ((v_json->>''policyVersion'',v_json->>''taxonomyVersion'',v_json->>''adapterVersion'',v_json->>''localMatchVersion'') =
   (''rubric-approved-skills-v1'',''rubric-taxonomy-v4'',''rubric-evidence-v1'',''rubric-local-match-v4'')
   AND v_json->''payload''->''schemaVersion''=''3''::jsonb AND v_json->''payload''->''compilerVersion''=''3''::jsonb AND v_json->''payload''->''taxonomyVersion''=''3''::jsonb)',' OR ((v_json->>''policyVersion'',v_json->>''taxonomyVersion'',v_json->>''adapterVersion'',v_json->>''localMatchVersion'') =
   (''rubric-approved-skills-v1'',''rubric-taxonomy-v4'',''rubric-evidence-v1'',''rubric-local-match-v4'')
   AND v_json->''payload''->''schemaVersion''=''3''::jsonb AND v_json->''payload''->''compilerVersion''=''3''::jsonb AND v_json->''payload''->''taxonomyVersion''=''3''::jsonb) OR ((v_json->>''policyVersion'',v_json->>''taxonomyVersion'',v_json->>''adapterVersion'',v_json->>''localMatchVersion'') =
   (''rubric-resume-evidence-v1'',''rubric-taxonomy-v4'',''rubric-evidence-v2'',''rubric-local-match-v4'')
   AND v_json->''payload''->''schemaVersion''=''4''::jsonb AND v_json->''payload''->''compilerVersion''=''4''::jsonb AND v_json->''payload''->''taxonomyVersion''=''4''::jsonb)');
 IF (length(definition)-length(replace(definition,'IF v_json->''payload''->''schemaVersion''=''3''::jsonb THEN','')))/length('IF v_json->''payload''->''schemaVersion''=''3''::jsonb THEN')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,'IF v_json->''payload''->''schemaVersion''=''3''::jsonb THEN','IF v_json->''payload''->>''schemaVersion'' IN (''3'',''4'') THEN');
 IF (length(definition)-length(replace(definition,'p_payload->''schemaVersion'' IS DISTINCT FROM ''3''::jsonb','')))/length('p_payload->''schemaVersion'' IS DISTINCT FROM ''3''::jsonb')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,'p_payload->''schemaVersion'' IS DISTINCT FROM ''3''::jsonb','p_payload->>''schemaVersion'' NOT IN (''3'',''4'')');
 IF (length(definition)-length(replace(definition,'p_payload->''compilerVersion'' IS DISTINCT FROM ''3''::jsonb','')))/length('p_payload->''compilerVersion'' IS DISTINCT FROM ''3''::jsonb')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,'p_payload->''compilerVersion'' IS DISTINCT FROM ''3''::jsonb','p_payload->>''compilerVersion'' NOT IN (''3'',''4'')');
 IF (length(definition)-length(replace(definition,'p_payload->''taxonomyVersion'' IS DISTINCT FROM ''3''::jsonb','')))/length('p_payload->''taxonomyVersion'' IS DISTINCT FROM ''3''::jsonb')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,'p_payload->''taxonomyVersion'' IS DISTINCT FROM ''3''::jsonb','p_payload->>''taxonomyVersion'' NOT IN (''3'',''4'')');
 EXECUTE definition;
END $forward$;

-- Preserve the frozen body except these counted substitutions.
DO $forward$ DECLARE definition text; source text; BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc INTO STRICT definition,source FROM pg_proc p WHERE p.oid='public.signal_ranking_claim(text,uuid,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(source,'UTF8')),'hex')<>'dca23a719ba9d7b54a6b61f5c594676228b0a6d7501a1a35f5217346bc5eaef4' THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 IF (length(definition)-length(replace(definition,' OR ((contract->>''policyVersion'',contract->>''taxonomyVersion'',contract->>''adapterVersion'',contract->>''localMatchVersion'') =
   (''rubric-approved-skills-v1'',''rubric-taxonomy-v4'',''rubric-evidence-v1'',''rubric-local-match-v4'')
   AND contract->''payload''->''schemaVersion''=''3''::jsonb AND contract->''payload''->''compilerVersion''=''3''::jsonb AND contract->''payload''->''taxonomyVersion''=''3''::jsonb)','')))/length(' OR ((contract->>''policyVersion'',contract->>''taxonomyVersion'',contract->>''adapterVersion'',contract->>''localMatchVersion'') =
   (''rubric-approved-skills-v1'',''rubric-taxonomy-v4'',''rubric-evidence-v1'',''rubric-local-match-v4'')
   AND contract->''payload''->''schemaVersion''=''3''::jsonb AND contract->''payload''->''compilerVersion''=''3''::jsonb AND contract->''payload''->''taxonomyVersion''=''3''::jsonb)')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,' OR ((contract->>''policyVersion'',contract->>''taxonomyVersion'',contract->>''adapterVersion'',contract->>''localMatchVersion'') =
   (''rubric-approved-skills-v1'',''rubric-taxonomy-v4'',''rubric-evidence-v1'',''rubric-local-match-v4'')
   AND contract->''payload''->''schemaVersion''=''3''::jsonb AND contract->''payload''->''compilerVersion''=''3''::jsonb AND contract->''payload''->''taxonomyVersion''=''3''::jsonb)',' OR ((contract->>''policyVersion'',contract->>''taxonomyVersion'',contract->>''adapterVersion'',contract->>''localMatchVersion'') =
   (''rubric-approved-skills-v1'',''rubric-taxonomy-v4'',''rubric-evidence-v1'',''rubric-local-match-v4'')
   AND contract->''payload''->''schemaVersion''=''3''::jsonb AND contract->''payload''->''compilerVersion''=''3''::jsonb AND contract->''payload''->''taxonomyVersion''=''3''::jsonb) OR ((contract->>''policyVersion'',contract->>''taxonomyVersion'',contract->>''adapterVersion'',contract->>''localMatchVersion'') =
   (''rubric-resume-evidence-v1'',''rubric-taxonomy-v4'',''rubric-evidence-v2'',''rubric-local-match-v4'')
   AND contract->''payload''->''schemaVersion''=''4''::jsonb AND contract->''payload''->''compilerVersion''=''4''::jsonb AND contract->''payload''->''taxonomyVersion''=''4''::jsonb)');
 IF (length(definition)-length(replace(definition,'contract:=b.command->''rankingContract'';','')))/length('contract:=b.command->''rankingContract'';')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,'contract:=b.command->''rankingContract'';','contract:=b.command->''rankingContract'';
 IF EXISTS(SELECT 1 FROM (
   SELECT e FROM unnest(prepared_items) e WHERE tagged
   UNION ALL SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_command->''evidence'')=''array'' THEN p_command->''evidence'' ELSE ''[]''::jsonb END) e WHERE NOT tagged
  ) input WHERE e->>''version'' IS DISTINCT FROM contract->>''adapterVersion''
    OR NOT public.signal_private_evidence_bound(p_tenant,e)) THEN RAISE EXCEPTION ''RANKING_EVIDENCE_VERSION_MISMATCH''; END IF;');
 EXECUTE definition;
END $forward$;

-- Preserve the frozen body except these counted substitutions.
DO $forward$ DECLARE definition text; source text; BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc INTO STRICT definition,source FROM pg_proc p WHERE p.oid='public.signal_ranking_rebuild(text,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(source,'UTF8')),'hex')<>'1da1dc11a7654ec05c678446d89ebab763c59e7ff26c24fa20366265f2b4b26a' THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 IF (length(definition)-length(replace(definition,'DECLARE body text;','')))/length('DECLARE body text;')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,'DECLARE body text;','DECLARE source jsonb; role jsonb; body text;');
 IF (length(definition)-length(replace(definition,'BEGIN
 CASE p_kind','')))/length('BEGIN
 CASE p_kind')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,'BEGIN
 CASE p_kind','BEGIN
-- Inserted before the frozen v1 CASE in signal_ranking_rebuild.
 IF p_kind=''evidence'' AND j->>''version''=''rubric-evidence-v2'' THEN
  IF j->''employment'' IS DISTINCT FROM ''[]''::jsonb
   OR jsonb_typeof(j->''employmentSources'') IS DISTINCT FROM ''array''
   OR jsonb_array_length(j->''employmentSources'')>2 OR octet_length(j::text)>65536 THEN
   RAISE EXCEPTION ''RANKING_INVALID_CANONICAL_SHAPE''; END IF;
  -- Reuse the full v1 scalar/fact/scope checks, including unknown-field refusal.
  PERFORM public.signal_ranking_rebuild(''evidence'',
    (j-ARRAY[''employmentSources'',''resumeIdentity''])||jsonb_build_object(''version'',''rubric-evidence-v1''));
  IF j ? ''resumeIdentity'' THEN
   source:=j->''resumeIdentity'';
   IF jsonb_typeof(source) IS DISTINCT FROM ''object''
    OR NOT source ?& ARRAY[''candidateId'',''referenceId'',''applicationId'',''applicationJobId'',''resumeVersionId'',''sourceId'',''generationId'',''sourceHash'']
    OR source-ARRAY[''candidateId'',''referenceId'',''applicationId'',''applicationJobId'',''resumeVersionId'',''sourceId'',''generationId'',''sourceHash'']<>''{}''::jsonb
    OR jsonb_typeof(source->''sourceHash'') IS DISTINCT FROM ''string'' OR source->>''sourceHash'' !~ ''^[0-9a-f]{64}$''
    OR EXISTS(SELECT 1 FROM jsonb_each(source) x WHERE x.key IN (''candidateId'',''referenceId'',''resumeVersionId'',''sourceId'',''generationId'')
      AND (jsonb_typeof(x.value)<>''string'' OR (x.value#>>''{}'') !~ ''^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$''
        OR x.value=''"00000000-0000-0000-0000-000000000000"''::jsonb))
    OR EXISTS(SELECT 1 FROM jsonb_each(source) x WHERE x.key IN (''applicationId'',''applicationJobId'')
      AND (jsonb_typeof(x.value)<>''number'' OR (x.value#>>''{}'') !~ ''^[1-9][0-9]*$''
        OR (x.value#>>''{}'')::numeric>2147483647)) THEN RAISE EXCEPTION ''RANKING_INVALID_CANONICAL_SHAPE''; END IF;
  END IF;
  IF (SELECT count(DISTINCT x->>''kind'') FROM jsonb_array_elements(j->''employmentSources'') x)
    <>jsonb_array_length(j->''employmentSources'') THEN RAISE EXCEPTION ''RANKING_INVALID_CANONICAL_SHAPE''; END IF;
  FOR source IN SELECT value FROM jsonb_array_elements(j->''employmentSources'') LOOP
   IF jsonb_typeof(source) IS DISTINCT FROM ''object''
    OR NOT source ?& ARRAY[''kind'',''scope'',''organizationRef'',''sourceVersion'',''sourceHash'',''observedAt'',''referenceId'',''intervals'']
    OR source-ARRAY[''kind'',''scope'',''organizationRef'',''sourceVersion'',''sourceHash'',''observedAt'',''referenceId'',''intervals'']<>''{}''::jsonb
    OR jsonb_typeof(source->''sourceVersion'') IS DISTINCT FROM ''string'' OR length(source->>''sourceVersion'') NOT BETWEEN 1 AND 100
    OR jsonb_typeof(source->''sourceHash'') IS DISTINCT FROM ''string'' OR (source->>''sourceHash'') !~ ''^[0-9a-f]{64}$''
    OR jsonb_typeof(source->''observedAt'') IS DISTINCT FROM ''string'' OR length(source->>''observedAt'')>40
    OR (source->>''observedAt'') !~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$''
    OR NOT pg_input_is_valid(source->>''observedAt'',''timestamptz'')
    OR jsonb_typeof(source->''intervals'') IS DISTINCT FROM ''array'' OR jsonb_array_length(source->''intervals'')>500
    OR (((source->>''kind''=''candidate_provided'' AND source->>''scope''=''organization''
         AND source->>''organizationRef''=j->>''organizationRef''
         AND jsonb_typeof(source->''referenceId'')=''string''
         AND (source->>''referenceId'') ~ ''^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'')
      OR (source->>''kind''=''profile_evidence'' AND source->>''scope''=''public''
         AND source->''organizationRef''=''null''::jsonb AND source->''referenceId''=''null''::jsonb)) IS NOT TRUE)
    THEN RAISE EXCEPTION ''RANKING_INVALID_CANONICAL_SHAPE''; END IF;
   FOR role IN SELECT value FROM jsonb_array_elements(source->''intervals'') LOOP
    PERFORM public.signal_ranking_rebuild(''employment'',role);
   END LOOP;
  END LOOP;
  RETURN public.signal_ranking_canonical(j);
 END IF;

 CASE p_kind');
 EXECUTE definition;
END $forward$;

-- Preserve the frozen body except these counted substitutions.
DO $forward$ DECLARE definition text; source text; BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc INTO STRICT definition,source FROM pg_proc p WHERE p.oid='public.signal_rc_admit(text,uuid,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(source,'UTF8')),'hex')<>'7632f72779be5278be1662664e5043d1d7038507cba792ba4b948a5b5a0aa96b' THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 IF (length(definition)-length(replace(definition,'b.command->''rankingContract''->''payload''->>''schemaVersion'' IS DISTINCT FROM ''3''','')))/length('b.command->''rankingContract''->''payload''->>''schemaVersion'' IS DISTINCT FROM ''3''')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,'b.command->''rankingContract''->''payload''->>''schemaVersion'' IS DISTINCT FROM ''3''','coalesce(b.command->''rankingContract''->''payload''->>''schemaVersion'','''') NOT IN (''3'',''4'')');
 EXECUTE definition;
END $forward$;

-- Preserve the frozen body except these counted substitutions.
DO $forward$ DECLARE definition text; source text; BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc INTO STRICT definition,source FROM pg_proc p WHERE p.oid='public.signal_rc_read(text,uuid)'::regprocedure;
 IF encode(sha256(convert_to(source,'UTF8')),'hex')<>'3b65d528a603213c70dd15af52ecdc8aa19f7b2d985008fec27500b105fd870f' THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 IF (length(definition)-length(replace(definition,'b.command->''rankingContract''->''payload''->>''schemaVersion''=''3''','')))/length('b.command->''rankingContract''->''payload''->>''schemaVersion''=''3''')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,'b.command->''rankingContract''->''payload''->>''schemaVersion''=''3''','b.command->''rankingContract''->''payload''->>''schemaVersion'' IN (''3'',''4'')');
 EXECUTE definition;
END $forward$;

-- Preserve the frozen body except these counted substitutions.
DO $forward$ DECLARE definition text; source text; BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc INTO STRICT definition,source FROM pg_proc p WHERE p.oid='public.signal_rc_prepare(text,uuid,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(source,'UTF8')),'hex')<>'196837f7d1a59a3e74ac948a1643e03dbb03eafe920b5287257e06dbaec1404f' THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 IF (length(definition)-length(replace(definition,'e->>''version'' IS DISTINCT FROM ''rubric-evidence-v1''','')))/length('e->>''version'' IS DISTINCT FROM ''rubric-evidence-v1''')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,'e->>''version'' IS DISTINCT FROM ''rubric-evidence-v1''','e->>''version'' IS DISTINCT FROM b.command->''rankingContract''->>''adapterVersion''');
 IF (length(definition)-length(replace(definition,'e-ARRAY[''candidateId'',''organizationRef'',''presentationSource'',''facts'',''employment'',''version'']','')))/length('e-ARRAY[''candidateId'',''organizationRef'',''presentationSource'',''facts'',''employment'',''version'']')<>1 THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;
 definition:=replace(definition,'e-ARRAY[''candidateId'',''organizationRef'',''presentationSource'',''facts'',''employment'',''version'']','e-(CASE WHEN e->>''version''=''rubric-evidence-v2'' THEN ARRAY[''employmentSources'',''resumeIdentity''] ELSE ARRAY[]::text[] END)-ARRAY[''candidateId'',''organizationRef'',''presentationSource'',''facts'',''employment'',''version'']');
 EXECUTE definition;
END $forward$;

ALTER TABLE public.governed_ranking_runs DROP CONSTRAINT gr_run_shape_ck,
 ADD CONSTRAINT gr_run_shape_ck CHECK ((state IN ('reserved','ready','failed') AND input_count BETWEEN 0 AND 2000 AND attempt_count BETWEEN 1 AND 3
  AND input_sha256 ~ '^[a-f0-9]{64}$' AND contract_sha256 ~ '^[a-f0-9]{64}$'
  AND ((policy_version,taxonomy_version,adapter_version,tie_version) IN (
 ('rubric-range-v1','rubric-taxonomy-v3','rubric-evidence-v1','rubric-local-match-v3'),
 ('rubric-approved-skills-v1','rubric-taxonomy-v4','rubric-evidence-v1','rubric-local-match-v4'),
 ('rubric-resume-evidence-v1','rubric-taxonomy-v4','rubric-evidence-v2','rubric-local-match-v4')))
  AND length(execution_attempt_id) BETWEEN 1 AND 200 AND length(processing_lease_id) BETWEEN 1 AND 200
  AND ((state='reserved' AND output_sha256 IS NULL AND lease_id IS NOT NULL AND lease_until IS NOT NULL)
    OR (state='ready' AND output_sha256 ~ '^[a-f0-9]{64}$' AND output_sha256 IS NOT NULL AND lease_id IS NULL AND lease_until IS NULL)
    OR (state='failed' AND output_sha256 IS NULL AND lease_id IS NULL AND lease_until IS NULL))) IS TRUE);



ALTER TABLE public.governed_ranking_items DROP CONSTRAINT gr_item_shape_ck;
ALTER TABLE public.governed_ranking_items ADD CONSTRAINT gr_item_shape_ck CHECK ((jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=65536
  AND evidence ?& ARRAY['candidateId','organizationRef','facts','employment','version']
  AND evidence-(CASE WHEN evidence->>'version'='rubric-evidence-v2' THEN ARRAY['employmentSources','resumeIdentity'] ELSE ARRAY[]::text[] END)-ARRAY['candidateId','organizationRef','facts','employment','version','presentationSource']='{}'::jsonb
  AND (NOT evidence ? 'presentationSource' OR evidence->>'presentationSource' IN ('pool','pool_enriched','discovered'))
  AND evidence->>'candidateId'=candidate_id AND evidence->>'version' IN ('rubric-evidence-v1','rubric-evidence-v2')
  AND (evidence->>'version'<>'rubric-evidence-v2' OR (evidence->'employment'='[]'::jsonb AND jsonb_typeof(evidence->'employmentSources')='array' AND jsonb_array_length(evidence->'employmentSources')<=2))
  AND evidence->>'organizationRef' ~ '^[1-9][0-9]*$' AND evidence_sha256 ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(evidence->'facts')='array' AND jsonb_typeof(evidence->'employment')='array'
  AND ((assessment IS NULL AND score_n IS NULL AND score_d IS NULL AND local_match IS NULL AND ordinal IS NULL AND eligibility_code IS NULL AND experience_envelope IS NULL AND selected_ordinal IS NULL)
   OR (assessment IS NOT NULL AND score_n IS NOT NULL AND score_d IS NOT NULL AND local_match IS NOT NULL AND ordinal IS NOT NULL AND eligibility_code IS NOT NULL AND experience_envelope IS NOT NULL
    AND jsonb_typeof(assessment)='array' AND jsonb_array_length(assessment)<=12 AND octet_length(assessment::text)<=16384
    AND score_n BETWEEN 0 AND score_d AND score_d BETWEEN 0 AND 36 AND local_match BETWEEN 0 AND 36000000 AND ordinal BETWEEN 1 AND 2000))) IS TRUE);
