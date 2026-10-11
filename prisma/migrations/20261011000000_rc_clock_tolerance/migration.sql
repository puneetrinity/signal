-- V-RC5: tolerate at most five seconds of application/database clock skew.
-- Only application timestamps; provider age/expiry, dispatch and paid-retry rules unchanged.
-- Forward replacement preserves signatures, owners and runtime EXECUTE grants.
CREATE OR REPLACE FUNCTION public.signal_rc_prepare(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='30s' AS $rc_prepare$
DECLARE run public.rc_sourcing_runs%ROWTYPE; request public.job_sourcing_requests%ROWTYPE;
 b public.governed_sourcing_bindings%ROWTYPE; item jsonb; person jsonb; base jsonb; v_text text;
 receipt public.crustdata_acquisition_receipts%ROWTYPE; raw text; parts text[]; url text; identity text;
 purchased text[]:=ARRAY[]::text[]; receipt_ids text[]; wanted text[]; existing_url text; stage_start timestamptz;
BEGIN
 IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR p_command-ARRAY['version','receiptIds','baseline','baselineHash','asOf']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['version','receiptIds','baseline','baselineHash','asOf']
  OR jsonb_typeof(p_command->'receiptIds') IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_command->'receiptIds')>2 OR octet_length(p_command::text)>134217728
  OR coalesce(p_command->>'baselineHash','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND OR b.cancellation IS NOT NULL THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
 SELECT * INTO request FROM public.job_sourcing_requests WHERE id=b.request_id AND "tenantId"=p_tenant FOR UPDATE;
 SELECT * INTO run FROM public.rc_sourcing_runs WHERE tenant_id=p_tenant AND flow_run_id=p_flow
  AND generation=request.acquisition_generation FOR UPDATE;
 IF NOT FOUND OR request.status<>'processing' OR request.execution_attempt_id IS DISTINCT FROM run.execution_attempt_id
  OR request.processing_lease_id IS NULL OR request.processing_lease_id IS DISTINCT FROM run.processing_lease_id
  OR run.state IN ('closed_unrecoverable','stalled','needs_attention') THEN RAISE EXCEPTION 'RC_EXECUTION_STALE'; END IF;
 IF run.baseline_hash IS NOT NULL THEN
  IF run.baseline_hash IS DISTINCT FROM p_command->>'baselineHash' OR run.baseline IS DISTINCT FROM p_command->'baseline'
    THEN RAISE EXCEPTION 'RC_BASELINE_CONFLICT'; END IF;
  RETURN jsonb_build_object('version',1,'runId',run.id,'baselineHash',run.baseline_hash,'replayed',true);
 END IF;
 base:=p_command->'baseline';
 IF jsonb_typeof(base) IS DISTINCT FROM 'object' OR base->'version' IS DISTINCT FROM '1'::jsonb
  OR base-ARRAY['version','asOf','evidence','withheld','identities','cache']<>'{}'::jsonb
  OR NOT base ?& ARRAY['version','asOf','evidence','withheld','identities','cache']
  OR base->>'asOf' IS DISTINCT FROM p_command->>'asOf'
  OR jsonb_typeof(base->'asOf') IS DISTINCT FROM 'string' OR (base->>'asOf')::timestamptz>clock_timestamp()+interval '5 seconds'
  OR jsonb_typeof(base->'evidence') IS DISTINCT FROM 'array' OR jsonb_typeof(base->'withheld') IS DISTINCT FROM 'array'
  OR jsonb_typeof(base->'identities') IS DISTINCT FROM 'array' OR jsonb_typeof(base->'cache') IS DISTINCT FROM 'array'
  OR jsonb_array_length(base->'evidence')+jsonb_array_length(base->'withheld')>2000
  OR jsonb_array_length(base->'identities')>2000 OR jsonb_array_length(base->'cache')>2000 THEN RAISE EXCEPTION 'RC_BASELINE_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(base->'cache') entry WHERE jsonb_typeof(entry) IS DISTINCT FROM 'object'
  OR entry-ARRAY['identityHash','observation']<>'{}'::jsonb OR NOT entry ?& ARRAY['identityHash','observation']
  OR entry->>'identityHash' IS DISTINCT FROM entry->'observation'->>'identityHash'
  OR jsonb_typeof(entry->'observation') IS DISTINCT FROM 'object' OR octet_length((entry->'observation')::text)>65536
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(base->'identities') i WHERE i->>'identityHash'=entry->>'identityHash'))
  OR (SELECT count(DISTINCT e->>'identityHash') FROM jsonb_array_elements(base->'cache') e)<>jsonb_array_length(base->'cache')
  THEN RAISE EXCEPTION 'RC_CACHE_CONFLICT'; END IF;
 FOR item IN SELECT value->'observation' FROM jsonb_array_elements(base->'cache') LOOP
  IF item->'version' IS DISTINCT FROM '1'::jsonb
   OR item-ARRAY['version','outcome','identityHash','skills','upstreamAt','observedAt','validUntil','timestampSource','contentHash']<>'{}'::jsonb
   OR NOT item ?& ARRAY['version','outcome','identityHash','skills','upstreamAt','observedAt','validUntil','timestampSource','contentHash']
   OR coalesce(item->>'outcome','') NOT IN ('success','no_skills','not_found','unusable_age')
   OR item->>'timestampSource' IS DISTINCT FROM 'check_last_update'
   OR coalesce(item->>'contentHash','') !~ '^[0-9a-f]{64}$'
   OR jsonb_typeof(item->'skills') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'skills')>500
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'skills') skill WHERE jsonb_typeof(skill)<>'string'
    OR length(skill#>>'{}') NOT BETWEEN 1 AND 500 OR length(trim(skill#>>'{}'))=0 OR (skill#>>'{}') ~ '[[:cntrl:]]')
   OR coalesce(item->>'observedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
   OR (item->>'observedAt')::timestamptz>clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'RC_CACHE_CONFLICT'; END IF;
  IF item->>'outcome'='success' THEN
   IF jsonb_array_length(item->'skills')=0 OR item->>'upstreamAt' IS NULL OR item->>'validUntil' IS NULL
    OR (item->>'upstreamAt')::timestamptz>(item->>'observedAt')::timestamptz
    OR (item->>'validUntil')::timestamptz IS DISTINCT FROM (item->>'upstreamAt')::timestamptz+interval '26280 hours'
    OR (item->>'validUntil')::timestamptz<clock_timestamp() THEN RAISE EXCEPTION 'RC_CACHE_CONFLICT'; END IF;
  ELSIF jsonb_array_length(item->'skills')<>0 OR item->'validUntil'<>'null'::jsonb THEN RAISE EXCEPTION 'RC_CACHE_CONFLICT'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(base->'evidence') e WHERE
   jsonb_typeof(e) IS DISTINCT FROM 'object' OR e->>'organizationRef' IS DISTINCT FROM b.organization_ref
   OR e->>'version' IS DISTINCT FROM 'rubric-evidence-v1' OR octet_length(e::text)>65536
   OR e-ARRAY['candidateId','organizationRef','presentationSource','facts','employment','version']<>'{}'::jsonb
   OR jsonb_typeof(e->'facts') IS DISTINCT FROM 'array' OR jsonb_typeof(e->'employment') IS DISTINCT FROM 'array')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(base->'evidence') e CROSS JOIN LATERAL jsonb_array_elements(e->'facts') f
   WHERE jsonb_typeof(f) IS DISTINCT FROM 'object' OR
    (f->>'scope'='organization' AND f->>'organizationRef' IS DISTINCT FROM b.organization_ref)
    OR (f->>'scope'='public' AND f->'organizationRef' IS DISTINCT FROM 'null'::jsonb)
    OR coalesce(f->>'scope','') NOT IN ('public','organization'))
  THEN RAISE EXCEPTION 'RC_EVIDENCE_SCOPE'; END IF;
 IF (SELECT count(*) FROM (SELECT e->>'candidateId' id FROM jsonb_array_elements((base->'evidence')||(base->'withheld')) e) ids)
   <> (SELECT count(DISTINCT e->>'candidateId') FROM jsonb_array_elements((base->'evidence')||(base->'withheld')) e)
  THEN RAISE EXCEPTION 'RC_IDENTITY_CONFLICT'; END IF;
 FOR person IN SELECT value FROM jsonb_array_elements(base->'identities') LOOP
  IF jsonb_typeof(person) IS DISTINCT FROM 'object' OR person-ARRAY['candidateId','globalCandidateId','url','identityHash']<>'{}'::jsonb
   OR NOT person ?& ARRAY['candidateId','globalCandidateId','url','identityHash']
   OR coalesce(person->>'url','') !~ '^https://linkedin[.]com/in/[a-z0-9][a-z0-9._-]{0,199}$'
   OR person->>'identityHash' IS DISTINCT FROM encode(sha256(convert_to(person->>'url','UTF8')),'hex')
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements((base->'evidence')||(base->'withheld')) e WHERE e->>'candidateId'=person->>'candidateId')
   THEN RAISE EXCEPTION 'RC_IDENTITY_CONFLICT'; END IF;
  SELECT c."linkedinUrl" INTO existing_url FROM public.candidates c JOIN public.candidate_global_links g
   ON g."candidateId"=c.id AND g."tenantId"=c."tenantId" WHERE c."tenantId"=p_tenant AND c.id=person->>'candidateId'
    AND lower(g."globalCandidateId" COLLATE "C")=lower(person->>'globalCandidateId' COLLATE "C");
  IF NOT FOUND THEN RAISE EXCEPTION 'RC_IDENTITY_CONFLICT'; END IF;
  parts:=regexp_match(trim(existing_url),'^(?:https://)?(?:www[.])?linkedin[.]com(?::[0-9]+)?/+(?:in|pub)/+([a-z0-9][a-z0-9._-]{0,199})(?:[/?#].*)?$','i');
  IF parts IS NULL OR 'https://linkedin.com/in/'||lower(parts[1] COLLATE "C") IS DISTINCT FROM person->>'url'
   THEN RAISE EXCEPTION 'RC_IDENTITY_CONFLICT'; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT e->>'candidateId') FROM jsonb_array_elements(base->'identities') e)<>jsonb_array_length(base->'identities')
  OR (SELECT count(DISTINCT e->>'globalCandidateId') FROM jsonb_array_elements(base->'identities') e)<>jsonb_array_length(base->'identities')
  OR (SELECT count(DISTINCT e->>'identityHash') FROM jsonb_array_elements(base->'identities') e)<>jsonb_array_length(base->'identities')
  THEN RAISE EXCEPTION 'RC_IDENTITY_CONFLICT'; END IF;
 -- Canonical wire JSON, ordered by bytewise keys, not database locale/jsonb spacing.
 WITH RECURSIVE nodes(value,path,prefix) AS (
  SELECT base,ARRAY[]::bigint[],''::text UNION ALL
  SELECT child.value,n.path||child.position,child.prefix FROM nodes n CROSS JOIN LATERAL (
   SELECT e.value,row_number() OVER(ORDER BY e.key COLLATE "C") position,
    CASE WHEN row_number() OVER(ORDER BY e.key COLLATE "C")>1 THEN ',' ELSE '' END||to_jsonb(e.key)::text||':' prefix
    FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) e
   UNION ALL SELECT a.value,a.ordinality,CASE WHEN a.ordinality>1 THEN ',' ELSE '' END
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ordinality)
  ) child
 ), tokens AS (
  SELECT path||0::bigint path,prefix||CASE jsonb_typeof(value) WHEN 'object' THEN '{' WHEN 'array' THEN '[' ELSE value::text END token FROM nodes
  UNION ALL SELECT path||9223372036854775807::bigint,CASE jsonb_typeof(value) WHEN 'object' THEN '}' ELSE ']' END FROM nodes WHERE jsonb_typeof(value) IN ('object','array')
 ) SELECT string_agg(token,'' ORDER BY path) INTO v_text FROM tokens;
 IF encode(sha256(convert_to(v_text,'UTF8')),'hex') IS DISTINCT FROM p_command->>'baselineHash' THEN RAISE EXCEPTION 'RC_BASELINE_CONFLICT'; END IF;
 SELECT coalesce(array_agg(value ORDER BY value COLLATE "C"),ARRAY[]::text[]) INTO wanted FROM jsonb_array_elements_text(p_command->'receiptIds');
 SELECT coalesce(array_agg(id ORDER BY id COLLATE "C"),ARRAY[]::text[]) INTO receipt_ids
  FROM public.crustdata_acquisition_receipts WHERE "tenantId"=p_tenant AND "sourcingRequestId"=run.request_id
   AND "acquisitionGeneration"=run.generation AND status='complete';
 IF wanted IS DISTINCT FROM receipt_ids THEN RAISE EXCEPTION 'RC_RECEIPT_BINDING_CONFLICT'; END IF;
 FOR receipt IN SELECT * FROM public.crustdata_acquisition_receipts WHERE id=ANY(receipt_ids) ORDER BY slot COLLATE "C" LOOP
  IF jsonb_typeof(receipt.result->'profiles') IS DISTINCT FROM 'array' OR jsonb_array_length(receipt.result->'profiles')>300
   THEN RAISE EXCEPTION 'RC_RECEIPT_PAYLOAD_INVALID'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(receipt.result->'profiles') LOOP
   raw:=item#>>'{social_handles,professional_network_identifier,profile_url}';
   parts:=regexp_match(trim(raw),'^(?:https://)?(?:www[.])?linkedin[.]com(?::[0-9]+)?/+(?:in|pub)/+([a-z0-9][a-z0-9._-]{0,199})(?:[/?#].*)?$','i');
   IF parts IS NULL THEN CONTINUE; END IF;
   url:='https://linkedin.com/in/'||lower(parts[1] COLLATE "C");identity:=encode(sha256(convert_to(url,'UTF8')),'hex');
   IF identity=ANY(purchased) THEN CONTINUE; END IF;
   purchased:=array_append(purchased,identity);
   IF cardinality(purchased)>300 THEN RAISE EXCEPTION 'RC_PURCHASE_LIMIT'; END IF;
   SELECT value INTO person FROM jsonb_array_elements(base->'identities') WHERE value->>'identityHash'=identity;
   IF FOUND THEN
    INSERT INTO public.rc_purchase_members(run_id,candidate_id,identity_hash,receipt_id,state)
     VALUES(run.id,person->>'candidateId',identity,receipt.id,'pending');
   END IF;
  END LOOP;
 END LOOP;
 stage_start:=clock_timestamp();
 UPDATE public.rc_sourcing_runs SET baseline=base,baseline_hash=p_command->>'baselineHash',state='prepared',
  rc_started_at=stage_start,deadline_at=stage_start+interval '300 seconds',
  heartbeat_at=clock_timestamp(),last_progress_at=clock_timestamp(),revision=revision+1 WHERE id=run.id;
 RETURN jsonb_build_object('version',1,'runId',run.id,'baselineHash',p_command->>'baselineHash','replayed',false);
END $rc_prepare$;
REVOKE ALL ON FUNCTION public.signal_rc_prepare(text,uuid,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.signal_rc_finish(p_tenant text,p_flow uuid,p_attempt uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='5s' AS $rc_finish$
DECLARE run public.rc_sourcing_runs%ROWTYPE; attempt public.rc_lookup_attempts%ROWTYPE;
 member public.rc_purchase_members%ROWTYPE; policy public.rc_rate_policies%ROWTYPE;
 health public.candidate_privacy_sync_state%ROWTYPE; b public.governed_sourcing_bindings%ROWTYPE;
 obs jsonb; outcome jsonb; quota jsonb; person jsonb; payload jsonb; body jsonb; v_text text;
 kind text; attempt_state text; member_state text; credits integer; blocked timestamptz; limit_rpm integer;
 commitment text; payload_commitment text; check_time timestamptz; restricted boolean:=false; replay boolean:=false;
BEGIN
 IF p_flow IS NULL OR p_attempt IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR p_command-ARRAY['version','outcome','observation','observedCredits','outcomeHash']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['version','outcome','observation','observedCredits','outcomeHash']
  OR coalesce(p_command->>'outcomeHash','') !~ '^[0-9a-f]{64}$' OR octet_length(p_command::text)>65536
  THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 outcome:=p_command->'outcome';obs:=p_command->'observation';quota:=outcome->'quota';kind:=outcome->>'kind';
 IF jsonb_typeof(outcome) IS DISTINCT FROM 'object' OR outcome-ARRAY['kind','upstreamAt','retryableFree','safeCode','quota']<>'{}'::jsonb
  OR NOT outcome ?& ARRAY['kind','upstreamAt','retryableFree','safeCode','quota']
  OR coalesce(kind,'') NOT IN ('eligible','success','no_skills','not_found','unusable_age','cached','restricted','failed','uncertain')
  OR jsonb_typeof(outcome->'retryableFree') IS DISTINCT FROM 'boolean'
  OR coalesce(outcome->>'safeCode','') NOT IN ('ok','unauthorized','rate_limited','restricted','transport','invalid_response','identity_mismatch','credits_breach','deadline')
  OR jsonb_typeof(quota) IS DISTINCT FROM 'object' OR quota-ARRAY['minuteLimit','minuteLeft','resetAt','retryAfterMs','dailyLeft']<>'{}'::jsonb
  OR NOT quota ?& ARRAY['minuteLimit','minuteLeft','resetAt','retryAfterMs','dailyLeft']
  OR EXISTS(SELECT 1 FROM jsonb_each(quota) e WHERE e.key IN ('minuteLimit','minuteLeft','retryAfterMs','dailyLeft')
    AND e.value<>'null'::jsonb AND (jsonb_typeof(e.value)<>'number' OR e.value::text !~ '^[0-9]+$'))
  OR ((p_command->'observedCredits')<>'null'::jsonb AND (jsonb_typeof(p_command->'observedCredits')<>'number'
    OR p_command->>'observedCredits' !~ '^[0-9]+$')) THEN RAISE EXCEPTION 'RC_OUTCOME_INVALID'; END IF;
 IF coalesce((quota->>'minuteLimit')::bigint,1) NOT BETWEEN 1 AND 1000000
  OR coalesce((quota->>'minuteLeft')::bigint,0)>1000000
  OR coalesce((quota->>'retryAfterMs')::bigint,0)>86400000
  OR coalesce((p_command->>'observedCredits')::bigint,0)>2147483647 THEN RAISE EXCEPTION 'RC_OUTCOME_INVALID'; END IF;
 credits:=(p_command->>'observedCredits')::integer;
 IF ((kind IN ('success','no_skills','not_found','unusable_age','cached')) IS DISTINCT FROM (obs<>'null'::jsonb))
  OR (kind='eligible' AND (outcome->>'upstreamAt') IS NULL)
  OR ((outcome->>'retryableFree')::boolean AND (kind<>'failed' OR credits IS DISTINCT FROM 0)) THEN RAISE EXCEPTION 'RC_OUTCOME_INVALID'; END IF;
 -- Validate both commitments through the same bytewise canonical JSON algorithm.
 FOR body IN SELECT p_command-'outcomeHash' UNION ALL
  SELECT CASE WHEN jsonb_typeof(obs)='object' THEN obs-'contentHash' ELSE '{}'::jsonb END WHERE obs<>'null'::jsonb LOOP
  WITH RECURSIVE nodes(value,path,prefix) AS (
   SELECT body,ARRAY[]::bigint[],''::text UNION ALL
   SELECT child.value,n.path||child.position,child.prefix FROM nodes n CROSS JOIN LATERAL (
    SELECT e.value,row_number() OVER(ORDER BY e.key COLLATE "C") position,
     CASE WHEN row_number() OVER(ORDER BY e.key COLLATE "C")>1 THEN ',' ELSE '' END||to_jsonb(e.key)::text||':' prefix
     FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) e
    UNION ALL SELECT a.value,a.ordinality,CASE WHEN a.ordinality>1 THEN ',' ELSE '' END
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ordinality)
   ) child
  ), tokens AS (
   SELECT path||0::bigint path,prefix||CASE jsonb_typeof(value) WHEN 'object' THEN '{' WHEN 'array' THEN '[' ELSE value::text END token FROM nodes
   UNION ALL SELECT path||9223372036854775807::bigint,CASE jsonb_typeof(value) WHEN 'object' THEN '}' ELSE ']' END FROM nodes WHERE jsonb_typeof(value) IN ('object','array')
  ) SELECT string_agg(token,'' ORDER BY path) INTO v_text FROM tokens;
  commitment:=encode(sha256(convert_to(v_text,'UTF8')),'hex');
  IF body=p_command-'outcomeHash' THEN
   IF commitment IS DISTINCT FROM p_command->>'outcomeHash' THEN RAISE EXCEPTION 'RC_OUTCOME_CONFLICT'; END IF;
  ELSIF commitment IS DISTINCT FROM obs->>'contentHash' THEN RAISE EXCEPTION 'RC_OBSERVATION_CONFLICT'; END IF;
 END LOOP;
 PERFORM pg_advisory_xact_lock(hashtextextended('discover_candidate_privacy_admission_v1',0));
 SELECT * INTO health FROM public.candidate_privacy_sync_state WHERE consumer_name='discover';
 IF NOT FOUND OR health.status<>'healthy' OR health.active_generation<=0 OR health.last_success_at IS NULL
  OR health.last_success_at<clock_timestamp()-interval '300 seconds' OR health.expected_candidates<>health.projected_candidates
  THEN RAISE EXCEPTION 'RC_PRIVACY_UNAVAILABLE'; END IF;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
 SELECT r.* INTO run FROM public.rc_sourcing_runs r JOIN public.rc_lookup_attempts a ON a.run_id=r.id
  WHERE r.tenant_id=p_tenant AND r.flow_run_id=p_flow AND a.id=p_attempt FOR UPDATE OF r;
 IF NOT FOUND THEN RAISE EXCEPTION 'RC_ATTEMPT_REFUSED'; END IF;
 SELECT * INTO attempt FROM public.rc_lookup_attempts WHERE id=p_attempt FOR UPDATE;
 SELECT * INTO member FROM public.rc_purchase_members WHERE run_id=run.id AND identity_hash=attempt.identity_hash FOR UPDATE;
 IF attempt.outcome_hash IS NOT NULL THEN
  IF attempt.outcome_hash IS DISTINCT FROM p_command->>'outcomeHash' THEN RAISE EXCEPTION 'RC_OUTCOME_CONFLICT'; END IF;
  RETURN jsonb_build_object('version',1,'attemptId',p_attempt,'replayed',true);
 END IF;
 IF run.sealed_at IS NOT NULL OR run.closed_at IS NOT NULL THEN RAISE EXCEPTION 'RC_SEALED'; END IF;
 IF attempt.state NOT IN ('reserved','dispatched') THEN RAISE EXCEPTION 'RC_ATTEMPT_REFUSED'; END IF;
 IF attempt.state='reserved' AND kind NOT IN ('cached','failed','restricted') THEN RAISE EXCEPTION 'RC_UNDISPATCHED_OUTCOME'; END IF;
 IF kind='cached' AND attempt.state<>'reserved' THEN RAISE EXCEPTION 'RC_CACHE_AFTER_DISPATCH'; END IF;
 IF kind='cached' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(run.baseline->'cache') entry
  WHERE entry->>'identityHash'=attempt.identity_hash AND entry->'observation'=obs) THEN RAISE EXCEPTION 'RC_CACHE_CONFLICT'; END IF;
 IF attempt.operation='FETCH' AND (kind='eligible' OR (outcome->>'retryableFree')::boolean)
  OR attempt.operation='CHECK' AND kind='success' THEN RAISE EXCEPTION 'RC_OUTCOME_INVALID'; END IF;
 IF obs<>'null'::jsonb THEN
  IF jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs->'version' IS DISTINCT FROM '1'::jsonb
   OR obs-ARRAY['version','outcome','identityHash','skills','upstreamAt','observedAt','validUntil','timestampSource','contentHash']<>'{}'::jsonb
   OR NOT obs ?& ARRAY['version','outcome','identityHash','skills','upstreamAt','observedAt','validUntil','timestampSource','contentHash']
   OR obs->>'identityHash' IS DISTINCT FROM attempt.identity_hash OR obs->>'timestampSource' IS DISTINCT FROM 'check_last_update'
   OR obs->>'outcome' NOT IN ('success','no_skills','not_found','unusable_age')
   OR (kind<>'cached' AND obs->>'outcome' IS DISTINCT FROM kind)
   OR jsonb_typeof(obs->'skills') IS DISTINCT FROM 'array' OR jsonb_array_length(obs->'skills')>500
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(obs->'skills') skill WHERE jsonb_typeof(skill)<>'string'
    OR length(skill#>>'{}') NOT BETWEEN 1 AND 500 OR length(trim(skill#>>'{}'))=0 OR (skill#>>'{}') ~ '[[:cntrl:]]')
   OR coalesce(obs->>'observedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
   OR (obs->>'observedAt')::timestamptz>clock_timestamp()+interval '5 seconds'
   THEN RAISE EXCEPTION 'RC_OBSERVATION_INVALID'; END IF;
  IF obs->>'outcome'='success' THEN
   IF jsonb_array_length(obs->'skills')=0 OR obs->>'upstreamAt' IS NULL OR obs->>'validUntil' IS NULL
    OR (obs->>'validUntil')::timestamptz IS DISTINCT FROM (obs->>'upstreamAt')::timestamptz+interval '26280 hours'
    OR (obs->>'upstreamAt')::timestamptz>(obs->>'observedAt')::timestamptz
    OR (obs->>'validUntil')::timestamptz<(obs->>'observedAt')::timestamptz THEN RAISE EXCEPTION 'RC_OBSERVATION_INVALID'; END IF;
  ELSIF jsonb_array_length(obs->'skills')<>0 OR obs->'validUntil'<>'null'::jsonb THEN RAISE EXCEPTION 'RC_OBSERVATION_INVALID'; END IF;
  IF attempt.operation='FETCH' AND kind<>'cached' THEN
   SELECT (a.outcome->>'upstreamAt')::timestamptz INTO check_time FROM public.rc_lookup_attempts a
    WHERE a.run_id=run.id AND a.identity_hash=attempt.identity_hash AND a.operation='CHECK' AND a.state='success'
    ORDER BY a.ordinal DESC LIMIT 1;
   IF check_time IS NULL OR check_time IS DISTINCT FROM (obs->>'upstreamAt')::timestamptz THEN RAISE EXCEPTION 'RC_CHECK_SNAPSHOT_CONFLICT'; END IF;
  END IF;
 END IF;
 restricted:=b.cancellation IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.candidate_privacy_projection
  WHERE tenant_id=p_tenant AND candidate_id=member.candidate_id AND generation=health.active_generation
   AND evaluated_cursor=health.cursor AND decision='allow');
 SELECT * INTO policy FROM public.rc_rate_policies WHERE id=run.policy_id;
 IF kind='eligible' AND ((outcome->>'upstreamAt')::timestamptz>clock_timestamp()
  OR (outcome->>'upstreamAt')::timestamptz+interval '26280 hours'<clock_timestamp()) THEN RAISE EXCEPTION 'RC_CHECK_SNAPSHOT_CONFLICT'; END IF;
 attempt_state:=CASE WHEN attempt.dispatch_at IS NULL THEN 'no_dispatch' WHEN kind IN ('success','eligible') THEN 'success'
  WHEN kind IN ('no_skills','not_found','unusable_age') THEN 'no_data' WHEN kind='uncertain' THEN 'uncertain' ELSE 'failed' END;
 member_state:=CASE WHEN restricted OR kind='restricted' THEN 'restricted' WHEN kind='cached' THEN 'cached'
  WHEN kind='eligible' THEN 'fetching' WHEN kind='success' THEN 'success' WHEN kind IN ('no_skills','not_found','unusable_age') THEN 'no_data'
  WHEN kind='uncertain' OR (attempt.operation='FETCH' AND attempt.dispatch_at IS NOT NULL) THEN 'uncertain'
  WHEN kind='failed' AND (outcome->>'retryableFree')::boolean AND attempt.ordinal=1 THEN 'checking' ELSE 'failed' END;
 UPDATE public.rc_lookup_attempts SET state=attempt_state,outcome_hash=p_command->>'outcomeHash',
  possible_credits=greatest(possible_credits,coalesce(credits,0)),
  outcome=CASE WHEN restricted THEN jsonb_build_object('kind','restricted') ELSE (p_command->'outcome')||jsonb_build_object('observation',obs) END WHERE id=p_attempt;
 UPDATE public.rc_purchase_members SET state=member_state WHERE run_id=run.id AND identity_hash=member.identity_hash;
 IF obs<>'null'::jsonb AND NOT restricted AND kind<>'cached' THEN
  SELECT value INTO person FROM jsonb_array_elements(run.baseline->'identities') WHERE value->>'identityHash'=attempt.identity_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'RC_IDENTITY_CONFLICT'; END IF;
  payload:=jsonb_build_object('version',1,'globalCandidateId',person->>'globalCandidateId','originRun',run.id,'originAttempt',attempt.id,'observation',obs);
  -- Payload hash commits to the observation and its immutable routing identity.
  payload_commitment:=encode(sha256(convert_to(run.id::text||':'||attempt.id::text||':'||(person->>'globalCandidateId')||':'||(obs->>'contentHash'),'UTF8')),'hex');
  INSERT INTO public.rc_skill_outbox(id,attempt_id,minimal_payload,payload_hash,state,next_attempt_at)
   VALUES(gen_random_uuid(),attempt.id,payload,payload_commitment,'pending',clock_timestamp());
 END IF;
 IF attempt.dispatch_at IS NOT NULL AND policy.rc_account_hash IS NOT NULL THEN
 PERFORM pg_advisory_xact_lock(hashtextextended('rc_account:'||policy.rc_account_hash,0));
 blocked:=CASE WHEN quota->>'retryAfterMs' IS NOT NULL THEN clock_timestamp()+((quota->>'retryAfterMs')::bigint*interval '1 millisecond') ELSE NULL END;
 IF quota->>'minuteLeft'='0' OR quota->>'dailyLeft'='0' THEN
  blocked:=greatest(blocked,coalesce((quota->>'resetAt')::timestamptz,clock_timestamp()+interval '60 seconds'));
 END IF;
 limit_rpm:=least(450,policy.rpm,coalesce((quota->>'minuteLimit')::integer,450));
 INSERT INTO public.rc_account_windows(account_hash,window_start,reserved_requests,current_limit,blocked_until)
  VALUES(policy.rc_account_hash,date_trunc('second',clock_timestamp()),0,limit_rpm,blocked)
  ON CONFLICT(account_hash,window_start) DO UPDATE SET current_limit=least(rc_account_windows.current_limit,excluded.current_limit),
   blocked_until=greatest(rc_account_windows.blocked_until,excluded.blocked_until);
 END IF;
 UPDATE public.rc_sourcing_runs SET heartbeat_at=clock_timestamp(),last_progress_at=clock_timestamp(),revision=revision+1 WHERE id=run.id;
 IF outcome->>'safeCode' IN ('unauthorized','credits_breach') OR (attempt.operation='FETCH' AND credits>policy.rc_fetch_credits_max)
  OR (attempt.operation='CHECK' AND credits>0) THEN
  UPDATE public.rc_sourcing_runs SET state='needs_attention',rc_available=false WHERE id=run.id;
  INSERT INTO public.rc_operations_events(id,run_id,kind,episode,safe_code)
   VALUES(gen_random_uuid(),run.id,'rate_unavailable',1,CASE WHEN outcome->>'safeCode'='unauthorized' THEN 'RC_PROVIDER_REFUSED' ELSE 'RC_CREDITS_BREACH' END)
   ON CONFLICT ON CONSTRAINT rc_event_episode_uq DO NOTHING;
 END IF;
 RETURN jsonb_build_object('version',1,'attemptId',p_attempt,'replayed',false);
END $rc_finish$;
REVOKE ALL ON FUNCTION public.signal_rc_finish(text,uuid,uuid,jsonb) FROM PUBLIC;
