-- Wave 5C. No activation, backfill, provider work or historical migration rewrite.
ALTER TABLE public.job_sourcing_requests DROP CONSTRAINT gov_request_binding_ck,
 ADD CONSTRAINT gov_request_binding_ck CHECK (
  (flow_run_id IS NULL AND artifact_hash IS NULL AND protocol_version IS NULL) OR
  (flow_run_id IS NOT NULL AND artifact_hash IS NOT NULL AND artifact_hash ~ '^[a-f0-9]{64}$'
   AND protocol_version IN (1,2) AND acquisition_generation=1));

CREATE TABLE public.governed_ranking_runs (
 tenant_id text NOT NULL, flow_run_id uuid NOT NULL, revision_id uuid NOT NULL,
 input_sha256 text NOT NULL, contract_sha256 text NOT NULL, output_sha256 text,
 policy_version text NOT NULL, taxonomy_version text NOT NULL, adapter_version text NOT NULL, tie_version text NOT NULL,
 as_of timestamptz NOT NULL, input_count integer NOT NULL, state text NOT NULL,
 lease_id uuid, lease_until timestamptz, attempt_count integer NOT NULL DEFAULT 1,
 execution_attempt_id text NOT NULL, processing_lease_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT gr_run_pk PRIMARY KEY(tenant_id,flow_run_id,revision_id),
 CONSTRAINT gr_run_input_uq UNIQUE(tenant_id,flow_run_id,input_sha256),
 CONSTRAINT gr_run_one_uq UNIQUE(tenant_id,flow_run_id),
 CONSTRAINT gr_run_binding_fk FOREIGN KEY(tenant_id,flow_run_id) REFERENCES public.governed_sourcing_bindings(tenant_id,flow_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT gr_run_shape_ck CHECK ((state IN ('reserved','ready','failed') AND input_count BETWEEN 0 AND 2000 AND attempt_count BETWEEN 1 AND 3
  AND input_sha256 ~ '^[a-f0-9]{64}$' AND contract_sha256 ~ '^[a-f0-9]{64}$'
  AND policy_version='rubric-range-v1' AND taxonomy_version='rubric-taxonomy-v3' AND adapter_version='rubric-evidence-v1' AND tie_version='rubric-local-match-v3'
  AND length(execution_attempt_id) BETWEEN 1 AND 200 AND length(processing_lease_id) BETWEEN 1 AND 200
  AND ((state='reserved' AND output_sha256 IS NULL AND lease_id IS NOT NULL AND lease_until IS NOT NULL)
    OR (state='ready' AND output_sha256 ~ '^[a-f0-9]{64}$' AND output_sha256 IS NOT NULL AND lease_id IS NULL AND lease_until IS NULL)
    OR (state='failed' AND output_sha256 IS NULL AND lease_id IS NULL AND lease_until IS NULL))) IS TRUE)
);
CREATE TABLE public.governed_ranking_items (
 tenant_id text NOT NULL, flow_run_id uuid NOT NULL, revision_id uuid NOT NULL, candidate_id text NOT NULL,
 evidence jsonb NOT NULL, evidence_sha256 text NOT NULL, assessment jsonb,
 score_n integer, score_d integer, local_match integer, ordinal integer,
 eligibility_code text, experience_envelope jsonb, selected_ordinal integer,
 CONSTRAINT gr_item_pk PRIMARY KEY(tenant_id,flow_run_id,revision_id,candidate_id),
 CONSTRAINT gr_item_run_fk FOREIGN KEY(tenant_id,flow_run_id,revision_id) REFERENCES public.governed_ranking_runs(tenant_id,flow_run_id,revision_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT gr_item_candidate_fk FOREIGN KEY(tenant_id,candidate_id) REFERENCES public.candidates("tenantId",id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT gr_item_ordinal_uq UNIQUE(tenant_id,flow_run_id,revision_id,ordinal),
 CONSTRAINT gr_item_selected_uq UNIQUE(tenant_id,flow_run_id,revision_id,selected_ordinal),
 CONSTRAINT gr_item_shape_ck CHECK ((jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=32768
  AND evidence ?& ARRAY['candidateId','organizationRef','facts','employment','version']
  AND evidence-ARRAY['candidateId','organizationRef','facts','employment','version','presentationSource']='{}'::jsonb
  AND (NOT evidence ? 'presentationSource' OR evidence->>'presentationSource' IN ('pool','pool_enriched','discovered'))
  AND evidence->>'candidateId'=candidate_id AND evidence->>'version'='rubric-evidence-v1'
  AND evidence->>'organizationRef' ~ '^[1-9][0-9]*$' AND evidence_sha256 ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(evidence->'facts')='array' AND jsonb_typeof(evidence->'employment')='array'
  AND ((assessment IS NULL AND score_n IS NULL AND score_d IS NULL AND local_match IS NULL AND ordinal IS NULL AND eligibility_code IS NULL AND experience_envelope IS NULL AND selected_ordinal IS NULL)
   OR (assessment IS NOT NULL AND score_n IS NOT NULL AND score_d IS NOT NULL AND local_match IS NOT NULL AND ordinal IS NOT NULL AND eligibility_code IS NOT NULL AND experience_envelope IS NOT NULL
    AND jsonb_typeof(assessment)='array' AND jsonb_array_length(assessment)<=12 AND octet_length(assessment::text)<=16384
    AND score_n BETWEEN 0 AND score_d AND score_d BETWEEN 0 AND 36 AND local_match BETWEEN 0 AND 36000000 AND ordinal BETWEEN 1 AND 2000))) IS TRUE),
 CONSTRAINT gr_item_eligibility_ck CHECK(eligibility_code IN ('in_range','wider','unconstrained','outside_experience_range','experience_unavailable','uncertain_boundary','wider_skills_not_established')),
 CONSTRAINT gr_item_selection_ck CHECK(selected_ordinal IS NULL OR (selected_ordinal BETWEEN 1 AND 100 AND eligibility_code IN ('in_range','wider','unconstrained'))),
 CONSTRAINT gr_item_experience_ck CHECK(experience_envelope IS NULL OR (
  jsonb_typeof(experience_envelope)='object' AND octet_length(experience_envelope::text)<=4096
  AND experience_envelope ?& ARRAY['version','asOf','status','lowerDays','upperDays','display','reason']
  AND experience_envelope-ARRAY['version','asOf','status','lowerDays','upperDays','display','reason']='{}'::jsonb
  AND experience_envelope->>'version'='recorded-experience-v1'
  AND jsonb_typeof(experience_envelope->'asOf')='string' AND jsonb_typeof(experience_envelope->'display')='string'
  AND jsonb_typeof(experience_envelope->'reason')='string'
  AND ((experience_envelope->>'status' IN ('unavailable','incomplete','uncertain_boundary') AND experience_envelope->'lowerDays'='null'::jsonb AND experience_envelope->'upperDays'='null'::jsonb)
   OR (experience_envelope->>'status' IN ('measured','bounded')
    AND jsonb_typeof(experience_envelope->'lowerDays')='number' AND jsonb_typeof(experience_envelope->'upperDays')='number'
    AND (experience_envelope->>'lowerDays')::numeric=trunc((experience_envelope->>'lowerDays')::numeric)
    AND (experience_envelope->>'upperDays')::numeric=trunc((experience_envelope->>'upperDays')::numeric)
    AND (experience_envelope->>'lowerDays')::numeric>=0
    AND (experience_envelope->>'upperDays')::numeric>=(experience_envelope->>'lowerDays')::numeric))) IS TRUE)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['governed_ranking_runs','governed_ranking_items'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',name);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY gr_owner ON public.%I TO %I USING (true) WITH CHECK (true)',name,current_user);
 END LOOP;
END $$;

CREATE FUNCTION public.signal_ranking_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'RANKING_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='governed_ranking_runs' THEN
  IF OLD.state='ready' OR OLD.state='failed' OR
   (to_jsonb(NEW)-ARRAY['state','lease_id','lease_until','attempt_count','execution_attempt_id','processing_lease_id','output_sha256','updated_at']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['state','lease_id','lease_until','attempt_count','execution_attempt_id','processing_lease_id','output_sha256','updated_at'])
   THEN RAISE EXCEPTION 'RANKING_IMMUTABLE'; END IF;
 ELSE
  IF OLD.assessment IS NOT NULL OR NEW.assessment IS NULL OR
    (to_jsonb(NEW)-ARRAY['assessment','score_n','score_d','local_match','ordinal','eligibility_code','experience_envelope','selected_ordinal']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['assessment','score_n','score_d','local_match','ordinal','eligibility_code','experience_envelope','selected_ordinal'])
    OR NOT EXISTS(SELECT 1 FROM public.governed_ranking_runs WHERE tenant_id=OLD.tenant_id AND flow_run_id=OLD.flow_run_id AND revision_id=OLD.revision_id AND state='reserved')
    THEN RAISE EXCEPTION 'RANKING_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.signal_ranking_immutable() FROM PUBLIC;
CREATE TRIGGER gr_run_immutable BEFORE UPDATE OR DELETE ON public.governed_ranking_runs FOR EACH ROW EXECUTE FUNCTION public.signal_ranking_immutable();
CREATE TRIGGER gr_item_immutable BEFORE UPDATE OR DELETE ON public.governed_ranking_items FOR EACH ROW EXECUTE FUNCTION public.signal_ranking_immutable();
CREATE TRIGGER gr_run_no_truncate BEFORE TRUNCATE ON public.governed_ranking_runs FOR EACH STATEMENT EXECUTE FUNCTION public.signal_ranking_immutable();
CREATE TRIGGER gr_item_no_truncate BEFORE TRUNCATE ON public.governed_ranking_items FOR EACH STATEMENT EXECUTE FUNCTION public.signal_ranking_immutable();

CREATE FUNCTION public.signal_ranking_claim(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='30s' AS $$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; r public.job_sourcing_requests%ROWTYPE;
 g public.governed_ranking_runs%ROWTYPE; item jsonb; contract jsonb; pool jsonb; v_json jsonb; v_text text; evidence_hash text;
BEGIN
 IF p_flow IS NULL OR nullif(p_tenant,'') IS NULL OR jsonb_typeof(p_command) IS DISTINCT FROM 'object'
  OR octet_length(p_command::text)>67108864 OR p_command-ARRAY['contractHash','executionAttemptId','processingLeaseId','evidence']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['contractHash','executionAttemptId','processingLeaseId','evidence']
  OR jsonb_typeof(p_command->'evidence') NOT IN ('array','null') THEN RAISE EXCEPTION 'RANKING_INVALID_COMMAND'; END IF;
 IF jsonb_typeof(p_command->'evidence')='array' THEN
  IF jsonb_array_length(p_command->'evidence')>2000 THEN RAISE EXCEPTION 'RANKING_POOL_TOO_LARGE'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('discover_candidate_privacy_admission_v1',0));
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.job_sourcing_requests WHERE "tenantId"=p_tenant AND id=b.request_id FOR UPDATE;
 IF r.protocol_version IS DISTINCT FROM 2 OR b.command->>'protocolVersion' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'GOVERNED_PROTOCOL_CONFLICT'; END IF;
 contract:=b.command->'rankingContract';
 IF b.cancellation IS NOT NULL OR contract->>'contractHash' IS DISTINCT FROM p_command->>'contractHash' THEN RAISE EXCEPTION 'RANKING_CONTRACT_CONFLICT'; END IF;
 SELECT * INTO g FROM public.governed_ranking_runs WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF FOUND THEN
  SELECT coalesce(jsonb_agg(evidence ORDER BY candidate_id COLLATE "C"),'[]'::jsonb) INTO pool
    FROM public.governed_ranking_items WHERE tenant_id=p_tenant AND flow_run_id=p_flow AND revision_id=g.revision_id;
  IF p_command->'evidence'<>'null'::jsonb THEN
   IF pool IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY value->>'candidateId' COLLATE "C"),'[]'::jsonb) FROM jsonb_array_elements(p_command->'evidence'))
    THEN RAISE EXCEPTION 'RANKING_INPUT_CONFLICT'; END IF;
  END IF;
  IF g.state='ready' THEN RETURN jsonb_build_object('state','ready','revisionId',g.revision_id,'outputHash',g.output_sha256); END IF;
 END IF;
 IF g.revision_id IS NULL AND p_command->'evidence'='null'::jsonb THEN RETURN NULL; END IF;
 pool:=coalesce(pool,p_command->'evidence');
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(pool) e WHERE NOT EXISTS(
   SELECT 1 FROM public.candidate_privacy_projection p JOIN public.candidate_privacy_sync_state s
    ON s.consumer_name='discover' AND p.generation=s.active_generation AND p.evaluated_cursor=s.cursor
   WHERE p.tenant_id=p_tenant AND p.candidate_id=e->>'candidateId'))
  THEN RAISE EXCEPTION 'candidate_privacy_unavailable'; END IF;
 -- The application also checks its configured (60–300s) health bound in this
 -- same transaction. SQL enforces the absolute maximum and current projection
 -- even if a service caller invokes the routine without that wrapper.
 IF NOT EXISTS(SELECT 1 FROM public.candidate_privacy_sync_state s WHERE s.consumer_name='discover'
   AND s.status='healthy' AND s.active_generation>0 AND s.expected_candidates=s.projected_candidates
   AND s.last_success_at>=clock_timestamp()-interval '300 seconds')
  THEN RAISE EXCEPTION 'candidate_privacy_unavailable'; END IF;
 IF r.status<>'processing' OR r.execution_attempt_id IS DISTINCT FROM p_command->>'executionAttemptId'
   OR r.processing_lease_id IS NULL OR r.processing_lease_id IS DISTINCT FROM p_command->>'processingLeaseId'
   THEN RAISE EXCEPTION 'GOVERNED_EXECUTION_STALE'; END IF;
 IF g.revision_id IS NOT NULL THEN
  IF g.state<>'reserved' OR (g.lease_until>clock_timestamp() AND g.processing_lease_id=r.processing_lease_id) OR g.attempt_count>=3 THEN RAISE EXCEPTION 'RANKING_CLAIM_REFUSED'; END IF;
  UPDATE public.governed_ranking_runs SET lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '120 seconds',
    attempt_count=attempt_count+1,execution_attempt_id=r.execution_attempt_id,processing_lease_id=r.processing_lease_id,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND flow_run_id=p_flow RETURNING * INTO g;
 ELSE
  pool:=p_command->'evidence';
  IF (SELECT count(DISTINCT value->>'candidateId') FROM jsonb_array_elements(pool))<>jsonb_array_length(pool)
    THEN RAISE EXCEPTION 'RANKING_DUPLICATE_IDENTITY'; END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'candidateId' COLLATE "C"),'[]'::jsonb) INTO pool FROM jsonb_array_elements(pool);
  g.as_of:=date_trunc('milliseconds',clock_timestamp());
  v_json:=jsonb_build_object('contractHash',p_command->>'contractHash','asOf',to_char(g.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'evidence',pool);
  WITH RECURSIVE nodes(value,path,prefix) AS (
    SELECT v_json, ARRAY[]::bigint[], ''::text
    UNION ALL
    SELECT child.value,n.path||child.position,child.prefix
    FROM nodes n CROSS JOIN LATERAL (
      SELECT e.value,row_number() OVER(ORDER BY e.key COLLATE "C") AS position,
        CASE WHEN row_number() OVER(ORDER BY e.key COLLATE "C")>1 THEN ',' ELSE '' END||to_jsonb(e.key)::text||':' AS prefix
      FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT a.value,a.ordinality,CASE WHEN a.ordinality>1 THEN ',' ELSE '' END
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ordinality)
    ) child
  ), tokens AS (
    SELECT path||0::bigint AS path,prefix||CASE jsonb_typeof(value) WHEN 'object' THEN '{' WHEN 'array' THEN '[' ELSE value::text END AS token FROM nodes
    UNION ALL
    SELECT path||9223372036854775807::bigint,CASE jsonb_typeof(value) WHEN 'object' THEN '}' ELSE ']' END FROM nodes WHERE jsonb_typeof(value) IN ('object','array')
  ) SELECT string_agg(token,'' ORDER BY path) INTO v_text FROM tokens;

  INSERT INTO public.governed_ranking_runs(tenant_id,flow_run_id,revision_id,input_sha256,contract_sha256,policy_version,taxonomy_version,adapter_version,tie_version,
    as_of,input_count,state,lease_id,lease_until,execution_attempt_id,processing_lease_id)
    VALUES(p_tenant,p_flow,gen_random_uuid(),encode(sha256(convert_to(v_text,'UTF8')),'hex'),p_command->>'contractHash',
      contract->>'policyVersion',contract->>'taxonomyVersion',contract->>'adapterVersion',contract->>'localMatchVersion',
      g.as_of,jsonb_array_length(pool),'reserved',gen_random_uuid(),clock_timestamp()+interval '120 seconds',r.execution_attempt_id,r.processing_lease_id)
    RETURNING * INTO g;
  FOR item IN SELECT value FROM jsonb_array_elements(pool) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item->>'organizationRef' IS DISTINCT FROM b.organization_ref
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'facts') fact WHERE fact->>'scope'='organization' AND fact->>'organizationRef' IS DISTINCT FROM b.organization_ref)
      THEN RAISE EXCEPTION 'RANKING_EVIDENCE_SCOPE'; END IF;
    IF jsonb_typeof(item->'facts') IS DISTINCT FROM 'array' OR jsonb_typeof(item->'employment') IS DISTINCT FROM 'array'
      OR jsonb_array_length(item->'facts')>1000 OR jsonb_array_length(item->'employment')>500
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'facts') f WHERE (
        jsonb_typeof(f)='object' AND f ?& ARRAY['field','value','ref','kind','sourceVersion','observedAt','scope','organizationRef']
        AND f-ARRAY['field','value','ref','kind','sourceVersion','observedAt','scope','organizationRef','qualifier','validUntil','revoked']='{}'::jsonb
        AND f->>'field' IN ('title','skill','seniority','function','domain','city','country','work_arrangement','certification','language','education_requirement','work_eligibility')
        AND f->>'kind' IN ('profile_evidence','candidate_provided','verified_document')
        AND length(f->>'value') BETWEEN 1 AND 500 AND length(f->>'ref') BETWEEN 1 AND 160
        AND length(f->>'sourceVersion') BETWEEN 1 AND 100 AND jsonb_typeof(f->'observedAt')='string'
        AND ((f->>'scope'='public' AND f->'organizationRef'='null'::jsonb) OR (f->>'scope'='organization' AND f->>'organizationRef'=b.organization_ref))) IS NOT TRUE)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'employment') e WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
        OR e-ARRAY['title','employmentType','start','end','ongoing']<>'{}'::jsonb
        OR (e ? 'ongoing' AND jsonb_typeof(e->'ongoing') IS DISTINCT FROM 'boolean'))
      THEN RAISE EXCEPTION 'RANKING_INVALID_EVIDENCE'; END IF;
    v_json:=item;
  WITH RECURSIVE nodes(value,path,prefix) AS (
    SELECT v_json, ARRAY[]::bigint[], ''::text
    UNION ALL
    SELECT child.value,n.path||child.position,child.prefix
    FROM nodes n CROSS JOIN LATERAL (
      SELECT e.value,row_number() OVER(ORDER BY e.key COLLATE "C") AS position,
        CASE WHEN row_number() OVER(ORDER BY e.key COLLATE "C")>1 THEN ',' ELSE '' END||to_jsonb(e.key)::text||':' AS prefix
      FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT a.value,a.ordinality,CASE WHEN a.ordinality>1 THEN ',' ELSE '' END
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ordinality)
    ) child
  ), tokens AS (
    SELECT path||0::bigint AS path,prefix||CASE jsonb_typeof(value) WHEN 'object' THEN '{' WHEN 'array' THEN '[' ELSE value::text END AS token FROM nodes
    UNION ALL
    SELECT path||9223372036854775807::bigint,CASE jsonb_typeof(value) WHEN 'object' THEN '}' ELSE ']' END FROM nodes WHERE jsonb_typeof(value) IN ('object','array')
  ) SELECT string_agg(token,'' ORDER BY path) INTO v_text FROM tokens;

    evidence_hash:=encode(sha256(convert_to(v_text,'UTF8')),'hex');
    INSERT INTO public.governed_ranking_items(tenant_id,flow_run_id,revision_id,candidate_id,evidence,evidence_sha256)
      VALUES(p_tenant,p_flow,g.revision_id,item->>'candidateId',item,evidence_hash);
  END LOOP;
 END IF;
 RETURN jsonb_build_object('state','reserved','revisionId',g.revision_id,'lease',g.lease_id,'inputHash',g.input_sha256,
   'asOf',to_char(g.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'contract',contract,'evidence',pool);
END $$;
REVOKE ALL ON FUNCTION public.signal_ranking_claim(text,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_ranking_finish(p_tenant text,p_flow uuid,p_lease uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='30s' AS $$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; r public.job_sourcing_requests%ROWTYPE;
 g public.governed_ranking_runs%ROWTYPE; item jsonb; v_json jsonb; v_text text; output_hash text; selected_ids jsonb;
BEGIN
 IF p_lease IS NULL OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR octet_length(p_result::text)>67108864
  OR p_result-ARRAY['inputHash','items','outputHash']<>'{}'::jsonb OR NOT p_result ?& ARRAY['inputHash','items','outputHash']
  OR jsonb_typeof(p_result->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'RANKING_INVALID_RESULT'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('discover_candidate_privacy_admission_v1',0));
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'items') e WHERE NOT EXISTS(
   SELECT 1 FROM public.candidate_privacy_projection p JOIN public.candidate_privacy_sync_state s
    ON s.consumer_name='discover' AND p.generation=s.active_generation AND p.evaluated_cursor=s.cursor
   WHERE p.tenant_id=p_tenant AND p.candidate_id=e->>'candidateId'))
  THEN RAISE EXCEPTION 'candidate_privacy_unavailable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.candidate_privacy_sync_state s WHERE s.consumer_name='discover'
   AND s.status='healthy' AND s.active_generation>0 AND s.expected_candidates=s.projected_candidates
   AND s.last_success_at>=clock_timestamp()-interval '300 seconds')
  THEN RAISE EXCEPTION 'candidate_privacy_unavailable'; END IF;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.job_sourcing_requests WHERE id=b.request_id AND "tenantId"=p_tenant FOR UPDATE;
 SELECT * INTO g FROM public.governed_ranking_runs WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND OR b.cancellation IS NOT NULL OR r.protocol_version IS DISTINCT FROM 2 OR g.input_sha256 IS DISTINCT FROM p_result->>'inputHash'
  THEN RAISE EXCEPTION 'RANKING_INPUT_CONFLICT'; END IF;
 v_json:=p_result-'outputHash';
  WITH RECURSIVE nodes(value,path,prefix) AS (
    SELECT v_json, ARRAY[]::bigint[], ''::text
    UNION ALL
    SELECT child.value,n.path||child.position,child.prefix
    FROM nodes n CROSS JOIN LATERAL (
      SELECT e.value,row_number() OVER(ORDER BY e.key COLLATE "C") AS position,
        CASE WHEN row_number() OVER(ORDER BY e.key COLLATE "C")>1 THEN ',' ELSE '' END||to_jsonb(e.key)::text||':' AS prefix
      FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT a.value,a.ordinality,CASE WHEN a.ordinality>1 THEN ',' ELSE '' END
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ordinality)
    ) child
  ), tokens AS (
    SELECT path||0::bigint AS path,prefix||CASE jsonb_typeof(value) WHEN 'object' THEN '{' WHEN 'array' THEN '[' ELSE value::text END AS token FROM nodes
    UNION ALL
    SELECT path||9223372036854775807::bigint,CASE jsonb_typeof(value) WHEN 'object' THEN '}' ELSE ']' END FROM nodes WHERE jsonb_typeof(value) IN ('object','array')
  ) SELECT string_agg(token,'' ORDER BY path) INTO v_text FROM tokens;

 output_hash:=encode(sha256(convert_to(v_text,'UTF8')),'hex');
 IF output_hash IS DISTINCT FROM p_result->>'outputHash' THEN RAISE EXCEPTION 'RANKING_OUTPUT_CONFLICT'; END IF;
 IF g.state='ready' THEN
  IF g.output_sha256<>output_hash THEN RAISE EXCEPTION 'RANKING_OUTPUT_CONFLICT'; END IF;
  RETURN jsonb_build_object('state','ready','revisionId',g.revision_id,'outputHash',g.output_sha256,'replayed',true);
 END IF;
 IF g.state<>'reserved' OR g.lease_id IS DISTINCT FROM p_lease OR g.lease_until<=clock_timestamp()
  OR r.status<>'processing' OR r.execution_attempt_id IS DISTINCT FROM g.execution_attempt_id
  OR r.processing_lease_id IS NULL OR r.processing_lease_id IS DISTINCT FROM g.processing_lease_id THEN RAISE EXCEPTION 'RANKING_LEASE_STALE'; END IF;
 IF jsonb_array_length(p_result->'items')<>g.input_count
  OR (SELECT count(DISTINCT value->>'candidateId') FROM jsonb_array_elements(p_result->'items'))<>g.input_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'items') x WHERE NOT EXISTS(
   SELECT 1 FROM public.governed_ranking_items i WHERE i.tenant_id=p_tenant AND i.flow_run_id=p_flow AND i.revision_id=g.revision_id AND i.candidate_id=x->>'candidateId'))
  OR (SELECT count(DISTINCT value->>'D') FROM jsonb_array_elements(p_result->'items'))>1
  THEN RAISE EXCEPTION 'RANKING_INPUT_CONFLICT'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_result->'items') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['candidateId','N','D','L','assessments','eligibility','experience','ordinal','selectedOrdinal','sourceType']<>'{}'::jsonb
   OR NOT item ?& ARRAY['candidateId','N','D','L','assessments','eligibility','experience','ordinal','selectedOrdinal','sourceType']
   OR jsonb_typeof(item->'N') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'D') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'L') IS DISTINCT FROM 'number'
   OR jsonb_typeof(item->'ordinal') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'assessments') IS DISTINCT FROM 'array'
   OR (item->>'sourceType' IN ('pool','pool_enriched','discovered')) IS NOT TRUE
   OR EXISTS(SELECT 1 FROM public.governed_ranking_items i WHERE i.tenant_id=p_tenant AND i.flow_run_id=p_flow AND i.revision_id=g.revision_id
     AND i.candidate_id=item->>'candidateId' AND i.evidence ? 'presentationSource' AND i.evidence->>'presentationSource' IS DISTINCT FROM item->>'sourceType')
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['N','D','L','ordinal']) k WHERE (item->>k)::numeric<>trunc((item->>k)::numeric))
   OR item->'experience'->>'asOf' IS DISTINCT FROM to_char(g.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   THEN RAISE EXCEPTION 'RANKING_INVALID_RESULT'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(item->'assessments') a WHERE jsonb_typeof(a) IS DISTINCT FROM 'object'
     OR a-ARRAY['criterionIds','labels','subject','state','mapped','weight','points','localPoints','refs']<>'{}'::jsonb
     OR NOT a ?& ARRAY['criterionIds','labels','subject','state','mapped','weight','points','localPoints','refs']
     OR (a->>'state' IN ('met','not_met','unknown')) IS NOT TRUE OR jsonb_typeof(a->'mapped') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(a->'criterionIds') IS DISTINCT FROM 'array' OR jsonb_typeof(a->'refs') IS DISTINCT FROM 'array'
     OR jsonb_typeof(a->'weight') IS DISTINCT FROM 'number' OR jsonb_typeof(a->'points') IS DISTINCT FROM 'number'
     OR jsonb_typeof(a->'localPoints') IS DISTINCT FROM 'number'
     OR EXISTS(SELECT 1 FROM unnest(ARRAY['weight','points','localPoints']) k WHERE (a->>k)::numeric<>trunc((a->>k)::numeric))
     OR (a->>'weight')::integer NOT IN (0,1,3)
     OR (a->>'mapped'='false' AND (a->>'weight')::integer<>0)
     OR jsonb_array_length(a->'criterionIds') NOT BETWEEN 1 AND 12 OR jsonb_array_length(a->'refs')>1000
     OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a->'criterionIds') id WHERE NOT EXISTS(
       SELECT 1 FROM jsonb_array_elements(b.command->'rankingContract'->'payload'->'criteria') c WHERE c->>'id'=id AND c->>'subject'=a->>'subject'))
     OR a->'labels' IS DISTINCT FROM (SELECT jsonb_agg(c->'label' ORDER BY ids.ordinality)
       FROM jsonb_array_elements_text(a->'criterionIds') WITH ORDINALITY ids(value,ordinality)
       JOIN LATERAL jsonb_array_elements(b.command->'rankingContract'->'payload'->'criteria') c ON c->>'id'=ids.value)
     OR (a->>'points')::integer IS DISTINCT FROM CASE WHEN a->>'state'='met' THEN (a->>'weight')::integer ELSE 0 END
     OR (a->>'localPoints')::integer NOT BETWEEN 0 AND (a->>'points')::integer*1000000)
   OR (item->>'N')::numeric IS DISTINCT FROM (SELECT coalesce(sum((a->>'points')::numeric),0) FROM jsonb_array_elements(item->'assessments') a)
   OR (item->>'D')::numeric IS DISTINCT FROM (SELECT coalesce(sum((a->>'weight')::numeric),0) FROM jsonb_array_elements(item->'assessments') a)
   OR (item->>'L')::numeric IS DISTINCT FROM (SELECT coalesce(sum((a->>'localPoints')::numeric),0) FROM jsonb_array_elements(item->'assessments') a)
   THEN RAISE EXCEPTION 'RANKING_INVALID_RESULT'; END IF;
 END LOOP;
 -- Rank over the complete sealed pool. Selection is not supplied independently:
 -- eligible in-range first, wider next, then N/L/bytewise identity; never padding.
 IF EXISTS(
  SELECT 1 FROM (
   SELECT x, row_number() OVER(ORDER BY CASE WHEN x->>'eligibility' IN ('in_range','unconstrained') THEN 0 WHEN x->>'eligibility'='wider' THEN 1 ELSE 2 END,
      (x->>'N')::numeric DESC,(x->>'L')::numeric DESC,x->>'candidateId' COLLATE "C") AS expected
   FROM jsonb_array_elements(p_result->'items') x
  ) ordered WHERE (x->>'ordinal')::numeric IS DISTINCT FROM expected
   OR (x->>'selectedOrdinal')::numeric IS DISTINCT FROM CASE WHEN expected<=100 AND x->>'eligibility' IN ('in_range','wider','unconstrained') THEN expected ELSE NULL END
 ) THEN RAISE EXCEPTION 'RANKING_ORDER_CONFLICT'; END IF;
 -- Every output field is filled once while the header is reserved.
 FOR item IN SELECT value FROM jsonb_array_elements(p_result->'items') LOOP
  UPDATE public.governed_ranking_items SET assessment=item->'assessments',score_n=(item->>'N')::integer,score_d=(item->>'D')::integer,
   local_match=(item->>'L')::integer,ordinal=(item->>'ordinal')::integer,eligibility_code=item->>'eligibility',experience_envelope=item->'experience',
   selected_ordinal=(item->>'selectedOrdinal')::integer
   WHERE tenant_id=p_tenant AND flow_run_id=p_flow AND revision_id=g.revision_id AND candidate_id=item->>'candidateId';
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.job_sourcing_candidates WHERE "tenantId"=p_tenant AND "sourcingRequestId"=b.request_id)
   THEN RAISE EXCEPTION 'RANKING_PUBLICATION_CONFLICT'; END IF;
 INSERT INTO public.job_sourcing_candidates(id,"tenantId","sourcingRequestId","candidateId","fitScore","fitBreakdown","sourceType","enrichmentStatus",rank)
  SELECT gen_random_uuid()::text,p_tenant,b.request_id,i.candidate_id,NULL,NULL,published.value->>'sourceType',c."enrichmentStatus",i.selected_ordinal
  FROM public.governed_ranking_items i JOIN public.candidates c ON c."tenantId"=i.tenant_id AND c.id=i.candidate_id
  JOIN jsonb_array_elements(p_result->'items') published(value) ON published.value->>'candidateId'=i.candidate_id
  WHERE i.tenant_id=p_tenant AND i.flow_run_id=p_flow AND i.revision_id=g.revision_id AND i.selected_ordinal IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.candidate_privacy_projection p JOIN public.candidate_privacy_sync_state s
    ON s.consumer_name='discover' AND p.generation=s.active_generation AND p.evaluated_cursor=s.cursor
    WHERE p.tenant_id=p_tenant AND p.candidate_id=i.candidate_id AND p.decision='allow');
 -- Suppression removes only that candidate. Preserve original ordinals and do
 -- not backfill the sealed top100 from previously unselected candidates.
 SELECT coalesce(jsonb_agg("candidateId" ORDER BY rank),'[]'::jsonb) INTO selected_ids FROM public.job_sourcing_candidates
  WHERE "tenantId"=p_tenant AND "sourcingRequestId"=b.request_id;
 UPDATE public.governed_sourcing_bindings SET delivery_ids=selected_ids,delivery_revision=1 WHERE tenant_id=p_tenant AND flow_run_id=p_flow;
 UPDATE public.job_sourcing_requests SET status='complete',"completedAt"=clock_timestamp(),"resultCount"=jsonb_array_length(selected_ids),
   diagnostics=coalesce(diagnostics,'{}'::jsonb)||jsonb_build_object('rubricRanking',jsonb_build_object(
     'protocolVersion',2,'inputCount',jsonb_array_length(p_result->'items'),'publishedCount',jsonb_array_length(selected_ids),
     'shortfall',100-jsonb_array_length(selected_ids),'revisionId',g.revision_id,'outputHash',output_hash,
     'inRangeCount',(SELECT count(*) FROM jsonb_array_elements(p_result->'items') x WHERE x->>'eligibility' IN ('in_range','unconstrained')),
     'widerCount',(SELECT count(*) FROM jsonb_array_elements(p_result->'items') x WHERE x->>'eligibility'='wider'))),
   last_reranked_at=g.as_of,callback_status='pending' WHERE id=b.request_id AND "tenantId"=p_tenant;
 UPDATE public.governed_ranking_runs SET state='ready',output_sha256=output_hash,lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
  WHERE tenant_id=p_tenant AND flow_run_id=p_flow;
 RETURN jsonb_build_object('state','ready','revisionId',g.revision_id,'outputHash',output_hash,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.signal_ranking_finish(text,uuid,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_ranking_read(p_tenant text,p_flow uuid,p_revision uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('protocolVersion',2,'flowRunId',g.flow_run_id,'revisionId',g.revision_id,
  'contractHash',g.contract_sha256,'outputHash',g.output_sha256,'asOf',to_char(g.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object('candidateId',i.candidate_id,'N',i.score_n,'D',i.score_d,'L',i.local_match,
    'assessments',i.assessment,'eligibility',i.eligibility_code,'experience',i.experience_envelope,'ordinal',i.selected_ordinal) ORDER BY i.selected_ordinal)
    FROM public.governed_ranking_items i WHERE i.tenant_id=g.tenant_id AND i.flow_run_id=g.flow_run_id AND i.revision_id=g.revision_id AND i.selected_ordinal IS NOT NULL
      AND EXISTS(SELECT 1 FROM public.job_sourcing_candidates c JOIN public.governed_sourcing_bindings b
        ON b.tenant_id=c."tenantId" AND b.request_id=c."sourcingRequestId"
        WHERE b.tenant_id=g.tenant_id AND b.flow_run_id=g.flow_run_id AND c."candidateId"=i.candidate_id)),'[]'::jsonb))
 FROM public.governed_ranking_runs g WHERE g.tenant_id=p_tenant AND g.flow_run_id=p_flow AND g.revision_id=p_revision AND g.state='ready'
$$;
REVOKE ALL ON FUNCTION public.signal_ranking_read(text,uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.signal_sourcing_bind(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='5s' AS $$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; r public.job_sourcing_requests%ROWTYPE; request_id text:=gen_random_uuid()::text; v_json jsonb; v_text text;
BEGIN
  IF p_flow IS NULL OR nullif(p_tenant,'') IS NULL OR jsonb_typeof(p_command) IS DISTINCT FROM 'object'
    OR octet_length(p_command::text)>131072 OR (p_command->>'protocolVersion' IS NULL OR p_command->>'protocolVersion' NOT IN ('1','2'))
    OR p_command->>'flowRunId' IS DISTINCT FROM p_flow::text
    OR p_command-(CASE WHEN p_command->>'protocolVersion'='2' THEN ARRAY['rankingContract'] ELSE ARRAY[]::text[] END)-ARRAY['protocolVersion','flowRunId','organizationRef','externalJobId','briefVersionId','materialHash','artifactHash','compilerVersion','queryArtifact','callbackUrl']<>'{}'::jsonb
    OR NOT p_command ?& ARRAY['protocolVersion','flowRunId','organizationRef','externalJobId','briefVersionId','materialHash','artifactHash','compilerVersion','queryArtifact','callbackUrl']
    THEN RAISE EXCEPTION 'GOVERNED_INVALID_COMMAND'; END IF;
  -- Serialize first admission without relying on a missing-row lock.
  PERFORM tenant_id FROM public.governed_sourcing_tenants WHERE tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNED_TENANT_REQUIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.governed_sourcing_tenants WHERE tenant_id=p_tenant
    AND organization_ref=p_command->>'organizationRef' AND callback_url=p_command->>'callbackUrl') THEN RAISE EXCEPTION 'GOVERNED_TARGET_MISMATCH'; END IF;
  SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow;
  IF FOUND THEN
    IF b.command<>p_command THEN RAISE EXCEPTION 'GOVERNED_REQUEST_CONFLICT'; END IF;
    SELECT * INTO r FROM public.job_sourcing_requests WHERE id=b.request_id AND "tenantId"=p_tenant;
    RETURN jsonb_build_object('requestId',r.id,'status',r.status,'flowRunId',p_flow,'artifactHash',b.artifact_hash,
      'acquisitionGeneration',r.acquisition_generation,'executionAttemptId',r.execution_attempt_id,'idempotent',true);
  END IF;
  IF p_command->>'protocolVersion'<>'2' THEN RAISE EXCEPTION 'GOVERNED_PROTOCOL_CONFLICT'; END IF;
  v_json:=p_command->'rankingContract';
  IF jsonb_typeof(v_json) IS DISTINCT FROM 'object' OR octet_length(v_json::text)>32768
    OR v_json-ARRAY['schemaVersion','briefVersionId','materialHash','policyVersion','taxonomyVersion','adapterVersion','localMatchVersion','payload','projectionText','projectionHash','contractHash']<>'{}'::jsonb
    OR NOT v_json ?& ARRAY['schemaVersion','briefVersionId','materialHash','policyVersion','taxonomyVersion','adapterVersion','localMatchVersion','payload','projectionText','projectionHash','contractHash']
    OR v_json->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR v_json->>'briefVersionId' IS DISTINCT FROM p_command->>'briefVersionId'
    OR v_json->>'materialHash' IS DISTINCT FROM p_command->>'materialHash'
    OR v_json->>'policyVersion' IS DISTINCT FROM 'rubric-range-v1'
    OR v_json->>'taxonomyVersion' IS DISTINCT FROM 'rubric-taxonomy-v3'
    OR v_json->>'adapterVersion' IS DISTINCT FROM 'rubric-evidence-v1'
    OR v_json->>'localMatchVersion' IS DISTINCT FROM 'rubric-local-match-v3'
    OR v_json->'payload'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR v_json->'payload'->'compilerVersion' IS DISTINCT FROM '2'::jsonb
    OR v_json->'payload'->'taxonomyVersion' IS DISTINCT FROM '2'::jsonb
    THEN RAISE EXCEPTION 'GOVERNED_PROTOCOL_CONFLICT'; END IF;
  v_json:=v_json-'contractHash';
  WITH RECURSIVE nodes(value,path,prefix) AS (
    SELECT v_json, ARRAY[]::bigint[], ''::text
    UNION ALL
    SELECT child.value,n.path||child.position,child.prefix
    FROM nodes n CROSS JOIN LATERAL (
      SELECT e.value,row_number() OVER(ORDER BY e.key COLLATE "C") AS position,
        CASE WHEN row_number() OVER(ORDER BY e.key COLLATE "C")>1 THEN ',' ELSE '' END||to_jsonb(e.key)::text||':' AS prefix
      FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT a.value,a.ordinality,CASE WHEN a.ordinality>1 THEN ',' ELSE '' END
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ordinality)
    ) child
  ), tokens AS (
    SELECT path||0::bigint AS path,prefix||CASE jsonb_typeof(value) WHEN 'object' THEN '{' WHEN 'array' THEN '[' ELSE value::text END AS token FROM nodes
    UNION ALL
    SELECT path||9223372036854775807::bigint,CASE jsonb_typeof(value) WHEN 'object' THEN '}' ELSE ']' END FROM nodes WHERE jsonb_typeof(value) IN ('object','array')
  ) SELECT string_agg(token,'' ORDER BY path) INTO v_text FROM tokens;

  IF encode(sha256(convert_to(v_text,'UTF8')),'hex') IS DISTINCT FROM p_command->'rankingContract'->>'contractHash'
    THEN RAISE EXCEPTION 'RANKING_CONTRACT_CONFLICT'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.governed_sourcing_tenants WHERE tenant_id=p_tenant AND allow_new) THEN RAISE EXCEPTION 'GOVERNED_DISABLED'; END IF;
  INSERT INTO public.job_sourcing_requests(id,"tenantId","externalJobId","jobContextHash","jobContext","callbackUrl",status,flow_run_id,artifact_hash,protocol_version,acquisition_generation,execution_attempt_id)
    VALUES(request_id,p_tenant,p_command->>'externalJobId',encode(sha256(convert_to(p_flow::text,'UTF8')),'hex'),p_command->'queryArtifact'->'jobContext',
      p_command->>'callbackUrl','queued',p_flow,p_command->>'artifactHash',2,1,gen_random_uuid()::text) RETURNING * INTO r;
  INSERT INTO public.governed_sourcing_bindings(tenant_id,flow_run_id,request_id,artifact_hash,organization_ref,external_job_id,command)
    VALUES(p_tenant,p_flow,request_id,p_command->>'artifactHash',p_command->>'organizationRef',p_command->>'externalJobId',p_command);
  RETURN jsonb_build_object('requestId',r.id,'status',r.status,'flowRunId',p_flow,'artifactHash',r.artifact_hash,
    'acquisitionGeneration',1,'executionAttemptId',r.execution_attempt_id,'idempotent',false);
END $$;
REVOKE ALL ON FUNCTION public.signal_sourcing_bind(text,uuid,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.signal_sourcing_execution(p_tenant text,p_request text,p_context jsonb,p_fence jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='5s' AS $$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; r public.job_sourcing_requests%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.governed_sourcing_tenants WHERE tenant_id=p_tenant) THEN RETURN NULL; END IF;
  SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND request_id=p_request;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNED_BINDING_REQUIRED'; END IF;
  IF jsonb_typeof(p_fence) IS DISTINCT FROM 'object' OR p_fence-ARRAY['acquisitionGeneration','executionAttemptId','processingLeaseId']<>'{}'::jsonb
    OR NOT p_fence ?& ARRAY['acquisitionGeneration','executionAttemptId','processingLeaseId'] THEN RAISE EXCEPTION 'GOVERNED_EXECUTION_STALE'; END IF;
  SELECT * INTO r FROM public.job_sourcing_requests WHERE id=p_request AND "tenantId"=p_tenant;
  IF NOT FOUND OR r.status<>'processing' OR r.flow_run_id IS DISTINCT FROM b.flow_run_id OR (r.protocol_version IS NULL OR r.protocol_version NOT IN (1,2) OR r.protocol_version::text IS DISTINCT FROM b.command->>'protocolVersion')
    OR r.acquisition_generation IS DISTINCT FROM 1 OR p_fence->>'acquisitionGeneration' IS DISTINCT FROM '1'
    OR r.execution_attempt_id IS DISTINCT FROM p_fence->>'executionAttemptId' OR r.processing_lease_id IS NULL
    OR r.processing_lease_id IS DISTINCT FROM p_fence->>'processingLeaseId'
    OR r."jobContext" IS DISTINCT FROM p_context OR b.command->'queryArtifact'->'jobContext' IS DISTINCT FROM p_context
    THEN RAISE EXCEPTION 'GOVERNED_EXECUTION_STALE'; END IF;
  RETURN b.command;
END $$;
REVOKE ALL ON FUNCTION public.signal_sourcing_execution(text,text,jsonb,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.signal_sourcing_delivery(p_tenant text,p_request text,p_execution text,p_ids jsonb,p_reranked_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='5s' AS $$
DECLARE binding public.governed_sourcing_bindings%ROWTYPE; request public.job_sourcing_requests%ROWTYPE; ranking public.governed_ranking_runs%ROWTYPE;
BEGIN
  SELECT * INTO binding FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND request_id=p_request FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO request FROM public.job_sourcing_requests WHERE "tenantId"=p_tenant AND id=p_request FOR SHARE;
  IF request.execution_attempt_id IS DISTINCT FROM p_execution OR binding.cancellation IS NOT NULL
    OR request.last_reranked_at IS DISTINCT FROM p_reranked_at THEN RAISE EXCEPTION 'GOVERNED_EXECUTION_STALE'; END IF;
  IF jsonb_typeof(p_ids) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GOVERNED_INVALID_COMMAND'; END IF;
  IF jsonb_array_length(p_ids)>100 OR octet_length(p_ids::text)>32768
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_ids) value WHERE jsonb_typeof(value)<>'string' OR length(value#>>'{}') NOT BETWEEN 1 AND 256)
    OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(p_ids) value)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_ids) value WHERE NOT EXISTS(
      SELECT 1 FROM public.job_sourcing_candidates c WHERE c."tenantId"=p_tenant AND c."sourcingRequestId"=p_request AND c."candidateId"=value))
    THEN RAISE EXCEPTION 'GOVERNED_INVALID_COMMAND'; END IF;
  IF request.protocol_version=2 THEN
    SELECT * INTO ranking FROM public.governed_ranking_runs WHERE tenant_id=p_tenant AND flow_run_id=binding.flow_run_id AND state='ready';
    IF NOT FOUND OR binding.delivery_ids IS DISTINCT FROM p_ids OR binding.delivery_revision<>1 THEN RAISE EXCEPTION 'RANKING_OUTPUT_CONFLICT'; END IF;
    RETURN jsonb_build_object('protocolVersion',2,'flowRunId',binding.flow_run_id,'artifactHash',binding.artifact_hash,
      'executionAttemptId',p_execution,'revision',binding.delivery_revision,'orderedSignalIds',p_ids,
      'rankingRevision',ranking.revision_id,'rankingHash',ranking.output_sha256,'contractHash',ranking.contract_sha256);
  END IF;
  IF binding.delivery_ids IS DISTINCT FROM p_ids THEN
    UPDATE public.governed_sourcing_bindings SET delivery_ids=p_ids,delivery_revision=delivery_revision+1
      WHERE tenant_id=p_tenant AND flow_run_id=binding.flow_run_id RETURNING * INTO binding;
  END IF;
  RETURN jsonb_build_object('protocolVersion',1,'flowRunId',binding.flow_run_id,'artifactHash',binding.artifact_hash,
    'executionAttemptId',p_execution,'revision',binding.delivery_revision,'orderedSignalIds',p_ids);
END $$;
REVOKE ALL ON FUNCTION public.signal_sourcing_delivery(text,text,text,jsonb,timestamptz) FROM PUBLIC;
