-- V16: forward-only evidence isolation. Existing sealed inputs retain their hashes.
-- No runtime table grant; existing routine ACLs and immutable trigger remain.
ALTER TABLE public.governed_ranking_runs ADD COLUMN withheld_profiles jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.governed_ranking_runs ADD CONSTRAINT gr_run_withheld_ck CHECK (
 jsonb_typeof(withheld_profiles)='array' AND jsonb_array_length(withheld_profiles)<=2000
 AND input_count+jsonb_array_length(withheld_profiles)<=2000);
ALTER TABLE public.governed_ranking_items DROP CONSTRAINT gr_item_shape_ck;
ALTER TABLE public.governed_ranking_items ADD CONSTRAINT gr_item_shape_ck CHECK ((jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=65536
  AND evidence ?& ARRAY['candidateId','organizationRef','facts','employment','version']
  AND evidence-ARRAY['candidateId','organizationRef','facts','employment','version','presentationSource']='{}'::jsonb
  AND (NOT evidence ? 'presentationSource' OR evidence->>'presentationSource' IN ('pool','pool_enriched','discovered'))
  AND evidence->>'candidateId'=candidate_id AND evidence->>'version'='rubric-evidence-v1'
  AND evidence->>'organizationRef' ~ '^[1-9][0-9]*$' AND evidence_sha256 ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(evidence->'facts')='array' AND jsonb_typeof(evidence->'employment')='array'
  AND ((assessment IS NULL AND score_n IS NULL AND score_d IS NULL AND local_match IS NULL AND ordinal IS NULL AND eligibility_code IS NULL AND experience_envelope IS NULL AND selected_ordinal IS NULL)
   OR (assessment IS NOT NULL AND score_n IS NOT NULL AND score_d IS NOT NULL AND local_match IS NOT NULL AND ordinal IS NOT NULL AND eligibility_code IS NOT NULL AND experience_envelope IS NOT NULL
    AND jsonb_typeof(assessment)='array' AND jsonb_array_length(assessment)<=12 AND octet_length(assessment::text)<=16384
    AND score_n BETWEEN 0 AND score_d AND score_d BETWEEN 0 AND 36 AND local_match BETWEEN 0 AND 36000000 AND ordinal BETWEEN 1 AND 2000))) IS TRUE);

CREATE OR REPLACE FUNCTION public.signal_ranking_claim(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='30s' AS $$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; r public.job_sourcing_requests%ROWTYPE;
 g public.governed_ranking_runs%ROWTYPE; item jsonb; contract jsonb; pool jsonb; withheld jsonb; v_json jsonb; v_text text; evidence_hash text;
BEGIN
 IF p_flow IS NULL OR nullif(p_tenant,'') IS NULL OR jsonb_typeof(p_command) IS DISTINCT FROM 'object'
  OR octet_length(p_command::text)>134217728 OR p_command-ARRAY['contractHash','executionAttemptId','processingLeaseId','evidence','withheld']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['contractHash','executionAttemptId','processingLeaseId','evidence']
  OR jsonb_typeof(p_command->'evidence') NOT IN ('array','null') THEN RAISE EXCEPTION 'RANKING_INVALID_COMMAND'; END IF;
 IF jsonb_typeof(p_command->'evidence')='array' THEN
  IF jsonb_array_length(p_command->'evidence')>2000 THEN RAISE EXCEPTION 'RANKING_POOL_TOO_LARGE'; END IF;
 END IF;
 withheld:=coalesce(p_command->'withheld','[]'::jsonb);
 IF jsonb_typeof(withheld) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'RANKING_INVALID_WITHHOLDING'; END IF;
 IF jsonb_array_length(withheld)>2000 THEN RAISE EXCEPTION 'RANKING_POOL_TOO_LARGE'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(withheld) LOOP
  IF (jsonb_typeof(item)='object' AND item ?& ARRAY['candidateId','reason','evidenceHash','bytes','limit']
   AND item-ARRAY['candidateId','reason','evidenceHash','bytes','limit']='{}'::jsonb
   AND jsonb_typeof(item->'candidateId')='string' AND length(item->>'candidateId') BETWEEN 1 AND 200
   AND item->>'reason'='evidence_too_large' AND item->>'evidenceHash' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(item->'bytes')='number' AND (item->>'bytes')::numeric BETWEEN 65537 AND 9007199254740991
   AND (item->>'bytes')::numeric=trunc((item->>'bytes')::numeric) AND item->'limit'='65536'::jsonb) IS NOT TRUE
   THEN RAISE EXCEPTION 'RANKING_INVALID_WITHHOLDING'; END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'candidateId' COLLATE "C"),'[]'::jsonb) INTO withheld FROM jsonb_array_elements(withheld);
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
  IF ((p_command->'evidence'<>'null'::jsonb OR p_command ? 'withheld') AND withheld IS DISTINCT FROM g.withheld_profiles)
   THEN RAISE EXCEPTION 'RANKING_INPUT_CONFLICT'; END IF;
  withheld:=g.withheld_profiles;
  IF g.state='ready' THEN RETURN jsonb_build_object('state','ready','revisionId',g.revision_id,'outputHash',g.output_sha256); END IF;
 END IF;
 IF g.revision_id IS NULL AND p_command->'evidence'='null'::jsonb THEN RETURN NULL; END IF;
 pool:=coalesce(pool,p_command->'evidence');
 IF jsonb_array_length(pool)+jsonb_array_length(withheld)>2000 THEN RAISE EXCEPTION 'RANKING_POOL_TOO_LARGE'; END IF;
 IF (SELECT count(DISTINCT value->>'candidateId') FROM jsonb_array_elements(pool||withheld))<>jsonb_array_length(pool)+jsonb_array_length(withheld)
  THEN RAISE EXCEPTION 'RANKING_DUPLICATE_IDENTITY'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(withheld) e WHERE NOT EXISTS(
  SELECT 1 FROM public.candidates c WHERE c."tenantId"=p_tenant AND c.id=e->>'candidateId'))
  THEN RAISE EXCEPTION 'RANKING_EVIDENCE_SCOPE'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(pool||withheld) e WHERE NOT EXISTS(
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
  IF jsonb_array_length(withheld)>0 THEN v_json:=v_json||jsonb_build_object('withheld',withheld); END IF;
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
    as_of,input_count,state,lease_id,lease_until,execution_attempt_id,processing_lease_id,withheld_profiles)
    VALUES(p_tenant,p_flow,gen_random_uuid(),encode(sha256(convert_to(v_text,'UTF8')),'hex'),p_command->>'contractHash',
      contract->>'policyVersion',contract->>'taxonomyVersion',contract->>'adapterVersion',contract->>'localMatchVersion',
      g.as_of,jsonb_array_length(pool),'reserved',gen_random_uuid(),clock_timestamp()+interval '120 seconds',r.execution_attempt_id,r.processing_lease_id,withheld)
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
   'asOf',to_char(g.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'contract',contract,'evidence',pool,'withheld',withheld);
END $$;
REVOKE ALL ON FUNCTION public.signal_ranking_claim(text,uuid,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.signal_ranking_finish(p_tenant text,p_flow uuid,p_lease uuid,p_result jsonb) RETURNS jsonb
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
     'protocolVersion',2,'consideredCount',g.input_count+jsonb_array_length(g.withheld_profiles),
     'withheldCount',jsonb_array_length(g.withheld_profiles),'withheldReasons',jsonb_build_object('evidence_too_large',jsonb_array_length(g.withheld_profiles)),
     'inputCount',jsonb_array_length(p_result->'items'),'publishedCount',jsonb_array_length(selected_ids),
     'shortfall',100-jsonb_array_length(selected_ids),'revisionId',g.revision_id,'outputHash',output_hash,
     'inRangeCount',(SELECT count(*) FROM jsonb_array_elements(p_result->'items') x WHERE x->>'eligibility' IN ('in_range','unconstrained')),
     'widerCount',(SELECT count(*) FROM jsonb_array_elements(p_result->'items') x WHERE x->>'eligibility'='wider'))),
   last_reranked_at=g.as_of,callback_status='pending' WHERE id=b.request_id AND "tenantId"=p_tenant;
 UPDATE public.governed_ranking_runs SET state='ready',output_sha256=output_hash,lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
  WHERE tenant_id=p_tenant AND flow_run_id=p_flow;
 RETURN jsonb_build_object('state','ready','revisionId',g.revision_id,'outputHash',output_hash,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.signal_ranking_finish(text,uuid,uuid,jsonb) FROM PUBLIC;
