-- RC skill enrichment. Count-only limits; no currency or price-expiry authority.
CREATE TABLE public.rc_rate_policies (
 id uuid PRIMARY KEY, policy_hash text NOT NULL UNIQUE CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
 rc_account_hash text CHECK(rc_account_hash ~ '^[0-9a-f]{64}$'),
 rc_fetch_credits_max integer CHECK(rc_fetch_credits_max BETWEEN 1 AND 1000000),
 rpm integer CHECK(rpm BETWEEN 1 AND 500),
 enabled boolean NOT NULL DEFAULT false,
 CONSTRAINT rc_account_config_ck CHECK(
  (rc_account_hash IS NULL AND rc_fetch_credits_max IS NULL AND rpm IS NULL)
   OR (rc_account_hash IS NOT NULL AND rc_fetch_credits_max IS NOT NULL AND rpm IS NOT NULL))
);
CREATE TABLE public.rc_org_policies (
 tenant_id text PRIMARY KEY REFERENCES public.governed_sourcing_tenants(tenant_id) ON DELETE RESTRICT,
 policy_id uuid NOT NULL REFERENCES public.rc_rate_policies(id) ON DELETE RESTRICT,
 enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.rc_sourcing_runs (
 id uuid PRIMARY KEY, tenant_id text NOT NULL, flow_run_id uuid NOT NULL, request_id text NOT NULL,
 generation integer NOT NULL CHECK(generation>=0), policy_id uuid NOT NULL REFERENCES public.rc_rate_policies(id) ON DELETE RESTRICT,
 brief_hash text NOT NULL CHECK(brief_hash ~ '^[0-9a-f]{64}$'),
 baseline_hash text CHECK(baseline_hash ~ '^[0-9a-f]{64}$'),
 baseline jsonb CHECK(jsonb_typeof(baseline)='object' AND octet_length(baseline::text)<=134217728),
 state text NOT NULL CHECK(state IN ('admitted','prepared','checking','fetching','complete','partial','baseline_only','needs_attention','stalled','closed_unrecoverable')),
 execution_attempt_id text NOT NULL CHECK(length(execution_attempt_id) BETWEEN 1 AND 200),
 processing_lease_id text NOT NULL CHECK(length(processing_lease_id) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), rc_started_at timestamptz, deadline_at timestamptz,
 sealed_at timestamptz, heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_progress_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 next_work_at timestamptz, stalled_at timestamptz, closed_at timestamptz, safe_to_clean_at timestamptz, cleaned_at timestamptz,
 closure_hash text CHECK(closure_hash ~ '^[0-9a-f]{64}$'),
 -- Owner-recovery controls implement the specified optimistic revision, hold
 -- and immutable command receipts without adding a second claim system.
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0), retention_hold boolean NOT NULL DEFAULT false,
 recovery_receipts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(recovery_receipts)='array' AND octet_length(recovery_receipts::text)<=65536),
 rc_available boolean NOT NULL,
 paid_lookups integer NOT NULL DEFAULT 0 CHECK(paid_lookups BETWEEN 0 AND 300),
 -- Durable operator-authorized enqueue intent, cleared only by matching ack.
 resume_token uuid, resume_enqueued_at timestamptz,
 CONSTRAINT rc_run_one_uq UNIQUE(tenant_id,flow_run_id,generation),
 CONSTRAINT rc_run_request_fk FOREIGN KEY(request_id,tenant_id) REFERENCES public.job_sourcing_requests(id,"tenantId") ON DELETE RESTRICT,
 CONSTRAINT rc_run_binding_fk FOREIGN KEY(tenant_id,flow_run_id) REFERENCES public.governed_sourcing_bindings(tenant_id,flow_run_id) ON DELETE RESTRICT,
 CONSTRAINT rc_run_deadline_ck CHECK((rc_started_at IS NULL AND deadline_at IS NULL)
   OR (rc_started_at IS NOT NULL AND deadline_at=rc_started_at+interval '300 seconds')),
 CONSTRAINT rc_run_cleanup_ck CHECK(cleaned_at IS NULL OR (baseline IS NULL AND safe_to_clean_at IS NOT NULL
   AND state IN ('complete','partial','baseline_only','closed_unrecoverable')))
);
CREATE TABLE public.rc_purchase_members (
 run_id uuid NOT NULL REFERENCES public.rc_sourcing_runs(id) ON DELETE RESTRICT,
 candidate_id text NOT NULL CHECK(length(candidate_id) BETWEEN 1 AND 200),
 identity_hash text NOT NULL CHECK(identity_hash ~ '^[0-9a-f]{64}$'),
 receipt_id text NOT NULL REFERENCES public.crustdata_acquisition_receipts(id) ON DELETE RESTRICT,
 state text NOT NULL CHECK(state IN ('pending','cached','no_data','checking','fetching','success','failed','uncertain','restricted','oversized')),
 PRIMARY KEY(run_id,identity_hash), UNIQUE(run_id,candidate_id)
);
CREATE TABLE public.rc_lookup_attempts (
 id uuid PRIMARY KEY, run_id uuid NOT NULL, identity_hash text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('CHECK','FETCH')),
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 2 AND (operation<>'FETCH' OR ordinal=1)),
 state text NOT NULL CHECK(state IN ('reserved','dispatched','success','no_data','no_dispatch','uncertain','failed')),
 possible_credits integer NOT NULL CHECK(possible_credits>=0), privacy_generation bigint NOT NULL CHECK(privacy_generation>=0),
 dispatch_at timestamptz, outcome_hash text CHECK(outcome_hash ~ '^[0-9a-f]{64}$'),
 outcome jsonb CHECK(jsonb_typeof(outcome)='object' AND octet_length(outcome::text)<=65536),
 CONSTRAINT rc_attempt_member_fk FOREIGN KEY(run_id,identity_hash) REFERENCES public.rc_purchase_members(run_id,identity_hash) ON DELETE RESTRICT,
 UNIQUE(run_id,identity_hash,operation,ordinal),
 CHECK(state NOT IN ('dispatched','success','no_data','uncertain') OR dispatch_at IS NOT NULL)
);
CREATE TABLE public.rc_skill_outbox (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL UNIQUE REFERENCES public.rc_lookup_attempts(id) ON DELETE RESTRICT,
 minimal_payload jsonb CHECK(jsonb_typeof(minimal_payload)='object' AND octet_length(minimal_payload::text)<=65536),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('pending','delivered','suppressed')),
 next_attempt_at timestamptz NOT NULL, delivery_receipt text CHECK(delivery_receipt ~ '^[0-9a-f]{64}$'),
 CHECK(state='pending' OR delivery_receipt IS NOT NULL), CHECK(state<>'pending' OR minimal_payload IS NOT NULL)
);
CREATE TABLE public.rc_account_windows (
 account_hash text NOT NULL CHECK(account_hash ~ '^[0-9a-f]{64}$'), window_start timestamptz NOT NULL,
 reserved_requests integer NOT NULL CHECK(reserved_requests>=0), current_limit integer NOT NULL CHECK(current_limit BETWEEN 1 AND 450),
 blocked_until timestamptz, PRIMARY KEY(account_hash,window_start)
);
CREATE TABLE public.rc_operations_events (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES public.rc_sourcing_runs(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('stalled','rate_unavailable','cache_delivery','receipt_delivery','closed')),
 episode integer NOT NULL CHECK(episode>=1), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 delivered_at timestamptz, acknowledged_at timestamptz, ack_actor text CHECK(length(ack_actor) BETWEEN 1 AND 160),
 next_delivery_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivery_attempts integer NOT NULL DEFAULT 0 CHECK(delivery_attempts>=0),
 safe_code text NOT NULL CHECK(safe_code IN ('RC_ACCOUNT_UNAVAILABLE','RC_STALLED','RC_CACHE_DELIVERY','RC_CACHE_UNAVAILABLE','RC_RECEIPT_DELIVERY','RC_CLOSED','RC_PROVIDER_REFUSED','RC_CREDITS_BREACH')),
 CONSTRAINT rc_event_episode_uq UNIQUE(run_id,kind,episode), CHECK((acknowledged_at IS NULL)=(ack_actor IS NULL))
);
CREATE INDEX rc_outbox_pending_idx ON public.rc_skill_outbox(next_attempt_at,id) WHERE state='pending';
CREATE INDEX rc_run_maintenance_idx ON public.rc_sourcing_runs(heartbeat_at,last_progress_at,id) WHERE cleaned_at IS NULL;
CREATE INDEX rc_operations_due_idx ON public.rc_operations_events(next_delivery_at,id) WHERE acknowledged_at IS NULL;
DO $rc_acl$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['rc_rate_policies','rc_org_policies','rc_sourcing_runs','rc_purchase_members',
  'rc_lookup_attempts','rc_skill_outbox','rc_account_windows','rc_operations_events'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',relation);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY rc_owner ON public.%I TO %I USING (true) WITH CHECK (true)',relation,current_user);
 END LOOP;
END $rc_acl$;

CREATE FUNCTION public.signal_rc_admit(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='5s' AS $rc_admit$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; request public.job_sourcing_requests%ROWTYPE;
 run public.rc_sourcing_runs%ROWTYPE; policy public.rc_rate_policies%ROWTYPE;
 available boolean:=false; selected_policy uuid;
BEGIN
 IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR p_command-ARRAY['version','requestId','generation','contractHash','executionAttemptId','processingLeaseId','purchaseSlot']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['version','requestId','generation','contractHash','executionAttemptId','processingLeaseId']
  OR (p_command ? 'purchaseSlot' AND coalesce(p_command->>'purchaseSlot','') NOT IN ('exact','spill'))
  OR octet_length(p_command::text)>4096 THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND OR b.cancellation IS NOT NULL OR b.command->>'protocolVersion' IS DISTINCT FROM '2'
  OR b.command->'rankingContract'->'payload'->>'schemaVersion' IS DISTINCT FROM '3'
  OR b.command->'rankingContract'->>'contractHash' IS DISTINCT FROM p_command->>'contractHash'
  OR b.request_id IS DISTINCT FROM p_command->>'requestId' THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
 SELECT * INTO request FROM public.job_sourcing_requests WHERE id=b.request_id AND "tenantId"=p_tenant FOR UPDATE;
 IF request.status<>'processing' OR request.protocol_version IS DISTINCT FROM 2
  OR request.acquisition_generation::text IS DISTINCT FROM p_command->>'generation'
  OR request.execution_attempt_id IS DISTINCT FROM p_command->>'executionAttemptId'
  OR request.processing_lease_id IS NULL OR request.processing_lease_id IS DISTINCT FROM p_command->>'processingLeaseId'
  THEN RAISE EXCEPTION 'RC_EXECUTION_STALE'; END IF;
 SELECT * INTO run FROM public.rc_sourcing_runs WHERE tenant_id=p_tenant AND flow_run_id=p_flow
  AND generation=request.acquisition_generation FOR UPDATE;
 IF FOUND THEN
  -- Admission retry never renews paid markers or the stage deadline.
  IF run.state IN ('closed_unrecoverable','stalled','needs_attention') THEN RAISE EXCEPTION 'RC_RECOVERY_REQUIRED'; END IF;
   UPDATE public.rc_sourcing_runs SET execution_attempt_id=request.execution_attempt_id,
    processing_lease_id=request.processing_lease_id,heartbeat_at=clock_timestamp(),revision=revision+1 WHERE id=run.id;
  RETURN jsonb_build_object('version',1,'enabled',true,'runId',run.id,'rcAvailable',run.rc_available);
 END IF;
 SELECT policy_id INTO selected_policy FROM public.rc_org_policies WHERE tenant_id=p_tenant AND enabled;
 IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'enabled',false); END IF;
 SELECT * INTO policy FROM public.rc_rate_policies WHERE id=selected_policy FOR SHARE;
 available:=coalesce(policy.enabled AND policy.rc_account_hash IS NOT NULL AND policy.rc_fetch_credits_max IS NOT NULL,false);
 INSERT INTO public.rc_sourcing_runs(id,tenant_id,flow_run_id,request_id,generation,policy_id,brief_hash,state,
  execution_attempt_id,processing_lease_id,rc_available)
  VALUES(gen_random_uuid(),p_tenant,p_flow,b.request_id,request.acquisition_generation,policy.id,
   p_command->>'contractHash','admitted',request.execution_attempt_id,request.processing_lease_id,
   available) RETURNING * INTO run;
 IF NOT available THEN
  INSERT INTO public.rc_operations_events(id,run_id,kind,episode,safe_code)
   VALUES(gen_random_uuid(),run.id,'rate_unavailable',1,'RC_ACCOUNT_UNAVAILABLE');
 END IF;
 RETURN jsonb_build_object('version',1,'enabled',true,'runId',run.id,'rcAvailable',available);
END $rc_admit$;
REVOKE ALL ON FUNCTION public.signal_rc_admit(text,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_rc_prepare(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
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
  OR jsonb_typeof(base->'asOf') IS DISTINCT FROM 'string' OR (base->>'asOf')::timestamptz>clock_timestamp()
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
   OR (item->>'observedAt')::timestamptz>clock_timestamp() THEN RAISE EXCEPTION 'RC_CACHE_CONFLICT'; END IF;
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

CREATE FUNCTION public.signal_rc_claim(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='5s' AS $rc_claim$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; request public.job_sourcing_requests%ROWTYPE;
 run public.rc_sourcing_runs%ROWTYPE; member public.rc_purchase_members%ROWTYPE;
 attempt public.rc_lookup_attempts%ROWTYPE; prior public.rc_lookup_attempts%ROWTYPE;
 policy public.rc_rate_policies%ROWTYPE; next_ordinal integer:=1;
BEGIN
 IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR p_command-ARRAY['version','operation','identityHash','executionAttemptId','processingLeaseId']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['version','operation','identityHash','executionAttemptId','processingLeaseId']
  OR coalesce(p_command->>'operation','') NOT IN ('CHECK','FETCH')
  OR coalesce(p_command->>'identityHash','') !~ '^[0-9a-f]{64}$' OR octet_length(p_command::text)>4096
  THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND OR b.cancellation IS NOT NULL THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
 SELECT * INTO request FROM public.job_sourcing_requests WHERE id=b.request_id AND "tenantId"=p_tenant FOR UPDATE;
 SELECT * INTO run FROM public.rc_sourcing_runs WHERE tenant_id=p_tenant AND flow_run_id=p_flow
  AND generation=request.acquisition_generation FOR UPDATE;
 IF NOT FOUND OR request.status<>'processing' OR run.baseline IS NULL
  OR request.execution_attempt_id IS DISTINCT FROM p_command->>'executionAttemptId'
  OR request.execution_attempt_id IS DISTINCT FROM run.execution_attempt_id
  OR request.processing_lease_id IS NULL OR request.processing_lease_id IS DISTINCT FROM p_command->>'processingLeaseId'
  OR request.processing_lease_id IS DISTINCT FROM run.processing_lease_id THEN RAISE EXCEPTION 'RC_EXECUTION_STALE'; END IF;
 IF run.state NOT IN ('prepared','checking','fetching') OR run.sealed_at IS NOT NULL OR clock_timestamp()>=run.deadline_at
  THEN RETURN jsonb_build_object('version',1,'state','unavailable'); END IF;
 SELECT * INTO member FROM public.rc_purchase_members WHERE run_id=run.id AND identity_hash=p_command->>'identityHash' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RC_MEMBER_REFUSED'; END IF;
 IF member.state NOT IN ('pending','checking','fetching') THEN RETURN jsonb_build_object('version',1,'state','done'); END IF;
 SELECT * INTO attempt FROM public.rc_lookup_attempts WHERE run_id=run.id AND identity_hash=member.identity_hash
  AND operation=p_command->>'operation' ORDER BY ordinal DESC LIMIT 1 FOR UPDATE;
 IF FOUND THEN
  IF attempt.operation='CHECK' AND attempt.ordinal=1 AND attempt.state='failed'
   AND attempt.possible_credits=0 AND attempt.outcome->>'retryableFree'='true' THEN next_ordinal:=2;
  ELSE
   RETURN jsonb_build_object('version',1,'state','existing','attemptId',attempt.id,'attemptState',attempt.state);
  END IF;
 END IF;
 IF p_command->>'operation'='FETCH' THEN
  SELECT * INTO prior FROM public.rc_lookup_attempts WHERE run_id=run.id AND identity_hash=member.identity_hash
   AND operation='CHECK' ORDER BY ordinal DESC LIMIT 1;
  IF NOT FOUND OR prior.state<>'success' OR prior.outcome->>'kind'<>'eligible'
   OR (prior.outcome->>'upstreamAt')::timestamptz>clock_timestamp()
   OR (prior.outcome->>'upstreamAt')::timestamptz+interval '26280 hours'<clock_timestamp()
   THEN RETURN jsonb_build_object('version',1,'state','unavailable'); END IF;
 END IF;
 SELECT * INTO policy FROM public.rc_rate_policies WHERE id=run.policy_id;
 INSERT INTO public.rc_lookup_attempts(id,run_id,identity_hash,operation,ordinal,state,possible_credits,privacy_generation)
  VALUES(gen_random_uuid(),run.id,member.identity_hash,p_command->>'operation',next_ordinal,'reserved',0,0) RETURNING * INTO attempt;
 UPDATE public.rc_purchase_members SET state=CASE WHEN attempt.operation='FETCH' THEN 'fetching' ELSE 'checking' END
  WHERE run_id=run.id AND identity_hash=member.identity_hash;
 UPDATE public.rc_sourcing_runs SET state=CASE WHEN attempt.operation='FETCH' THEN 'fetching' ELSE 'checking' END,
  heartbeat_at=clock_timestamp(),last_progress_at=clock_timestamp(),revision=revision+1 WHERE id=run.id;
 RETURN jsonb_build_object('version',1,'state','reserved','attemptId',attempt.id,'attemptState',attempt.state);
END $rc_claim$;
REVOKE ALL ON FUNCTION public.signal_rc_claim(text,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_rc_dispatch(p_tenant text,p_flow uuid,p_attempt uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='5s' AS $rc_dispatch$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; request public.job_sourcing_requests%ROWTYPE;
 run public.rc_sourcing_runs%ROWTYPE; member public.rc_purchase_members%ROWTYPE;
 attempt public.rc_lookup_attempts%ROWTYPE; policy public.rc_rate_policies%ROWTYPE;
 health public.candidate_privacy_sync_state%ROWTYPE; quota public.rc_account_windows%ROWTYPE;
 at_time timestamptz:=clock_timestamp(); window_at timestamptz; next_at timestamptz; inflight integer;
BEGIN
 IF p_flow IS NULL OR p_attempt IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR p_command-ARRAY['version','privacyCursor','executionAttemptId','processingLeaseId']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['version','privacyCursor','executionAttemptId','processingLeaseId']
  OR jsonb_typeof(p_command->'privacyCursor') IS DISTINCT FROM 'number' OR coalesce(p_command->>'privacyCursor','') !~ '^[0-9]+$'
  OR octet_length(p_command::text)>4096 THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 -- Same lock ordering as the existing privacy admission boundary; no network in this transaction.
 PERFORM pg_advisory_xact_lock(hashtextextended('discover_candidate_privacy_admission_v1',0));
 SELECT * INTO health FROM public.candidate_privacy_sync_state WHERE consumer_name='discover';
 IF NOT FOUND OR health.status<>'healthy' OR health.active_generation<=0 OR health.last_success_at IS NULL
  OR health.last_success_at<clock_timestamp()-interval '300 seconds' OR health.expected_candidates<>health.projected_candidates
  OR health.cursor::text IS DISTINCT FROM p_command->>'privacyCursor' THEN RAISE EXCEPTION 'RC_PRIVACY_UNAVAILABLE'; END IF;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND OR b.cancellation IS NOT NULL THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
 SELECT * INTO request FROM public.job_sourcing_requests WHERE id=b.request_id AND "tenantId"=p_tenant FOR UPDATE;
 SELECT * INTO run FROM public.rc_sourcing_runs WHERE tenant_id=p_tenant AND flow_run_id=p_flow
  AND generation=request.acquisition_generation FOR UPDATE;
 IF NOT FOUND OR request.status<>'processing' OR request.execution_attempt_id IS DISTINCT FROM p_command->>'executionAttemptId'
  OR request.execution_attempt_id IS DISTINCT FROM run.execution_attempt_id
  OR request.processing_lease_id IS NULL OR request.processing_lease_id IS DISTINCT FROM p_command->>'processingLeaseId'
  OR request.processing_lease_id IS DISTINCT FROM run.processing_lease_id THEN RAISE EXCEPTION 'RC_EXECUTION_STALE'; END IF;
 SELECT * INTO attempt FROM public.rc_lookup_attempts WHERE id=p_attempt AND run_id=run.id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RC_ATTEMPT_REFUSED'; END IF;
 IF attempt.state<>'reserved' OR attempt.dispatch_at IS NOT NULL THEN
  RETURN jsonb_build_object('version',1,'state','already_dispatched'); END IF;
 SELECT * INTO member FROM public.rc_purchase_members WHERE run_id=run.id AND identity_hash=attempt.identity_hash FOR UPDATE;
 IF run.sealed_at IS NOT NULL OR run.state NOT IN ('prepared','checking','fetching') OR clock_timestamp()>=run.deadline_at
  OR member.state NOT IN ('checking','fetching') THEN RETURN jsonb_build_object('version',1,'state','unavailable'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.candidate_privacy_projection WHERE tenant_id=p_tenant AND candidate_id=member.candidate_id
  AND generation=health.active_generation AND evaluated_cursor=health.cursor AND decision='allow') THEN
  UPDATE public.rc_purchase_members SET state='restricted' WHERE run_id=run.id AND identity_hash=member.identity_hash;
  UPDATE public.rc_lookup_attempts SET state='no_dispatch' WHERE id=p_attempt;
  RETURN jsonb_build_object('version',1,'state','restricted');
 END IF;
 SELECT * INTO policy FROM public.rc_rate_policies WHERE id=run.policy_id;
 IF NOT policy.enabled OR policy.rc_account_hash IS NULL OR NOT run.rc_available
  THEN RETURN jsonb_build_object('version',1,'state','unavailable'); END IF;
 -- The shared account lock covers every run and both free/paid operations. A
 -- conservative rolling 60s count avoids a double burst at a minute boundary.
 PERFORM pg_advisory_xact_lock(hashtextextended('rc_account:'||policy.rc_account_hash,0));
 at_time:=clock_timestamp();window_at:=date_trunc('second',at_time);
 SELECT count(*) INTO inflight FROM public.rc_lookup_attempts WHERE run_id=run.id AND state='dispatched';
 IF inflight>=10 THEN RETURN jsonb_build_object('version',1,'state','wait','nextWorkAt',at_time+interval '1 second'); END IF;
 SELECT max(blocked_until) INTO next_at FROM public.rc_account_windows WHERE account_hash=policy.rc_account_hash AND blocked_until>at_time;
 IF next_at IS NULL AND (SELECT coalesce(sum(reserved_requests),0) FROM public.rc_account_windows
  WHERE account_hash=policy.rc_account_hash AND window_start>at_time-interval '60 seconds')>=
  least(450,policy.rpm,coalesce((SELECT min(current_limit) FROM public.rc_account_windows
   WHERE account_hash=policy.rc_account_hash AND window_start>at_time-interval '60 seconds'),450)) THEN
  SELECT min(window_start)+interval '61 seconds' INTO next_at FROM public.rc_account_windows
   WHERE account_hash=policy.rc_account_hash AND window_start>at_time-interval '60 seconds' AND reserved_requests>0;
 END IF;
 IF next_at IS NOT NULL THEN
  UPDATE public.rc_sourcing_runs SET next_work_at=least(next_at,deadline_at),heartbeat_at=at_time WHERE id=run.id;
  RETURN jsonb_build_object('version',1,'state','wait','nextWorkAt',least(next_at,run.deadline_at));
 END IF;
 IF attempt.operation='FETCH' AND run.paid_lookups>=300 THEN RAISE EXCEPTION 'RC_LOOKUP_LIMIT'; END IF;
 INSERT INTO public.rc_account_windows(account_hash,window_start,reserved_requests,current_limit)
  VALUES(policy.rc_account_hash,window_at,1,least(450,policy.rpm)) ON CONFLICT(account_hash,window_start)
  DO UPDATE SET reserved_requests=rc_account_windows.reserved_requests+1;
 UPDATE public.rc_lookup_attempts SET state='dispatched',dispatch_at=at_time,privacy_generation=health.active_generation,
  possible_credits=CASE WHEN operation='FETCH' THEN policy.rc_fetch_credits_max ELSE 0 END WHERE id=p_attempt;
 UPDATE public.rc_sourcing_runs SET paid_lookups=paid_lookups+CASE WHEN attempt.operation='FETCH' THEN 1 ELSE 0 END,
  heartbeat_at=at_time,next_work_at=NULL,revision=revision+1 WHERE id=run.id;
 RETURN jsonb_build_object('version',1,'state','granted','attemptId',p_attempt,'deadlineAt',run.deadline_at,
  'maximumCredits',policy.rc_fetch_credits_max);
END $rc_dispatch$;
REVOKE ALL ON FUNCTION public.signal_rc_dispatch(text,uuid,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_rc_finish(p_tenant text,p_flow uuid,p_attempt uuid,p_command jsonb) RETURNS jsonb
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
   OR (obs->>'observedAt')::timestamptz>clock_timestamp()
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

CREATE FUNCTION public.signal_rc_read(p_tenant text,p_flow uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='10s' AS $rc_read$
DECLARE run public.rc_sourcing_runs%ROWTYPE; b public.governed_sourcing_bindings%ROWTYPE;
 members jsonb; attempts jsonb; total integer; processed integer; stale boolean; notified boolean; progress_state text; progress jsonb;
BEGIN
 IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$' THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow;
 IF NOT FOUND THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
 SELECT r.* INTO run FROM public.rc_sourcing_runs r JOIN public.job_sourcing_requests j ON j.id=r.request_id AND j."tenantId"=r.tenant_id
  WHERE r.tenant_id=p_tenant AND r.flow_run_id=p_flow AND r.generation=j.acquisition_generation;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT count(*),count(*) FILTER(WHERE state NOT IN ('pending','checking','fetching')) INTO total,processed
  FROM public.rc_purchase_members WHERE run_id=run.id;
 stale:=run.sealed_at IS NULL AND run.closed_at IS NULL AND (run.state='stalled' OR
  run.heartbeat_at<clock_timestamp()-interval '90 seconds' OR
  (run.next_work_at IS NULL AND run.last_progress_at<clock_timestamp()-interval '120 seconds') OR
  (run.next_work_at IS NOT NULL AND run.next_work_at<clock_timestamp()-interval '30 seconds'));
 SELECT coalesce((SELECT delivered_at IS NOT NULL FROM public.rc_operations_events
  WHERE run_id=run.id AND kind='stalled' ORDER BY episode DESC LIMIT 1),false) INTO notified;
 progress_state:=CASE WHEN run.state='closed_unrecoverable' THEN 'closed_unrecoverable' WHEN stale THEN 'stalled'
  WHEN run.state IN ('partial','baseline_only') THEN 'partial' WHEN run.state='complete' THEN 'complete' ELSE 'enriching_skills' END;
 progress:=jsonb_build_object('version',1,'state',progress_state,'processed',processed,'total',total,
  'updatedAt',run.last_progress_at,'notificationDelivered',notified,
  'safeReason',CASE WHEN run.state='closed_unrecoverable' THEN 'closed' WHEN stale THEN 'recovery_pending'
   WHEN NOT run.rc_available THEN 'rate_unavailable' WHEN run.state IN ('partial','baseline_only') THEN 'skills_unavailable' ELSE 'working' END);
 -- Transaction-local service read mode changes only response size, never
 -- authority. It avoids assembling/returning a 128MiB snapshot on status polls.
 IF current_setting('signal.rc_progress_only',true)='true' THEN RETURN progress; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('candidateId',candidate_id,'identityHash',identity_hash,'receiptId',receipt_id,'state',state)
  ORDER BY identity_hash COLLATE "C"),'[]'::jsonb) INTO members FROM public.rc_purchase_members WHERE run_id=run.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'identityHash',identity_hash,'operation',operation,'ordinal',ordinal,
  'state',state,'dispatchAt',dispatch_at,'outcomeHash',outcome_hash,'outcome',outcome,'possibleCredits',possible_credits)
  ORDER BY identity_hash COLLATE "C",operation COLLATE "C",ordinal),'[]'::jsonb) INTO attempts FROM public.rc_lookup_attempts WHERE run_id=run.id;
 -- Service-private evidence only. Browser callers receive the validated progress
 -- projection, never this resumable snapshot or the candidate/attempt identifiers.
 RETURN jsonb_build_object('version',1,'runId',run.id,'state',run.state,'revision',run.revision::text,'baselineHash',run.baseline_hash,'baseline',run.baseline,
  'deadlineAt',run.deadline_at,'sealedAt',run.sealed_at,'outcomeSetHash',run.closure_hash,
  'rcAvailable',run.rc_available,'members',members,'attempts',attempts,'progress',progress);
END $rc_read$;
REVOKE ALL ON FUNCTION public.signal_rc_read(text,uuid) FROM PUBLIC;

CREATE FUNCTION public.signal_rc_seal(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='5s' AS $rc_seal$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; request public.job_sourcing_requests%ROWTYPE;
 run public.rc_sourcing_runs%ROWTYPE; calculated text; terminal_state text; markers text;
BEGIN
 IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR p_command-ARRAY['version','baselineHash','outcomeSetHash']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['version','baselineHash','outcomeSetHash']
  OR coalesce(p_command->>'baselineHash','') !~ '^[0-9a-f]{64}$'
  OR coalesce(p_command->>'outcomeSetHash','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND OR b.cancellation IS NOT NULL THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
 SELECT * INTO request FROM public.job_sourcing_requests WHERE id=b.request_id AND "tenantId"=p_tenant FOR UPDATE;
 SELECT * INTO run FROM public.rc_sourcing_runs WHERE tenant_id=p_tenant AND flow_run_id=p_flow
  AND generation=request.acquisition_generation FOR UPDATE;
 IF NOT FOUND OR run.state='closed_unrecoverable' OR run.baseline_hash IS DISTINCT FROM p_command->>'baselineHash'
  THEN RAISE EXCEPTION 'RC_BASELINE_CONFLICT'; END IF;
 IF run.sealed_at IS NOT NULL THEN
  IF run.closure_hash IS DISTINCT FROM p_command->>'outcomeSetHash' THEN RAISE EXCEPTION 'RC_OUTCOME_CONFLICT'; END IF;
  RETURN jsonb_build_object('version',1,'state',run.state,'outcomeSetHash',run.closure_hash,'replayed',true);
 END IF;
 IF request.status<>'processing' OR request.processing_lease_id IS NULL
  OR request.processing_lease_id IS DISTINCT FROM run.processing_lease_id
  OR request.execution_attempt_id IS DISTINCT FROM run.execution_attempt_id THEN RAISE EXCEPTION 'RC_EXECUTION_STALE'; END IF;
 IF EXISTS(SELECT 1 FROM public.rc_lookup_attempts WHERE run_id=run.id AND state='dispatched'
   AND dispatch_at>clock_timestamp()-interval '10 seconds') THEN RAISE EXCEPTION 'RC_ATTEMPTS_IN_FLIGHT'; END IF;
 IF run.rc_available AND clock_timestamp()<run.deadline_at AND run.state<>'needs_attention'
  AND EXISTS(SELECT 1 FROM public.rc_purchase_members WHERE run_id=run.id AND state IN ('pending','checking','fetching'))
  THEN RAISE EXCEPTION 'RC_WORK_PENDING'; END IF;
 -- Hash the recorded set BEFORE settling unattempted/uncertain work. An exact
 -- retry uses closure_hash; no outcome can change after this transaction seals.
 SELECT coalesce(string_agg(identity_hash||':'||operation||':'||ordinal::text||':'||state||':'||coalesce(outcome_hash,'-'),E'\n'
  ORDER BY identity_hash COLLATE "C",operation COLLATE "C",ordinal),'') INTO markers FROM public.rc_lookup_attempts WHERE run_id=run.id;
 calculated:=encode(sha256(convert_to(run.baseline_hash||E'\n'||markers,'UTF8')),'hex');
 IF calculated IS DISTINCT FROM p_command->>'outcomeSetHash' THEN RAISE EXCEPTION 'RC_OUTCOME_CONFLICT'; END IF;
 UPDATE public.rc_lookup_attempts SET state=CASE WHEN dispatch_at IS NULL THEN 'no_dispatch' ELSE 'uncertain' END
  WHERE run_id=run.id AND state IN ('reserved','dispatched');
 UPDATE public.rc_purchase_members m SET state=CASE WHEN EXISTS(SELECT 1 FROM public.rc_lookup_attempts a
   WHERE a.run_id=m.run_id AND a.identity_hash=m.identity_hash AND a.operation='FETCH' AND a.dispatch_at IS NOT NULL) THEN 'uncertain' ELSE 'failed' END
  WHERE m.run_id=run.id AND m.state IN ('pending','checking','fetching');
 terminal_state:=CASE WHEN NOT EXISTS(SELECT 1 FROM public.rc_purchase_members WHERE run_id=run.id AND state IN ('success','cached','no_data')) THEN 'baseline_only'
  WHEN EXISTS(SELECT 1 FROM public.rc_purchase_members WHERE run_id=run.id AND state IN ('failed','uncertain','restricted','oversized')) THEN 'partial' ELSE 'complete' END;
 UPDATE public.rc_sourcing_runs SET state=terminal_state,sealed_at=clock_timestamp(),closure_hash=calculated,
  heartbeat_at=clock_timestamp(),last_progress_at=clock_timestamp(),next_work_at=NULL,revision=revision+1 WHERE id=run.id;
 RETURN jsonb_build_object('version',1,'state',terminal_state,'outcomeSetHash',calculated,'replayed',false);
END $rc_seal$;
REVOKE ALL ON FUNCTION public.signal_rc_seal(text,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_rc_outbox(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='5s' AS $rc_outbox$
DECLARE run public.rc_sourcing_runs%ROWTYPE; entry public.rc_skill_outbox%ROWTYPE;
 health public.candidate_privacy_sync_state%ROWTYPE; candidate text; allowed boolean; acknowledgment text;
BEGIN
 IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR p_command-ARRAY['version','action','id','receiptHash']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['version','action','id','receiptHash'] OR coalesce(p_command->>'action','') NOT IN ('claim','ack')
  OR octet_length(p_command::text)>4096 THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 IF p_command->>'action'='ack' AND (p_command->>'id' IS NULL OR coalesce(p_command->>'receiptHash','') !~ '^[0-9a-f]{64}$')
  OR p_command->>'action'='claim' AND p_command->'receiptHash'<>'null'::jsonb THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('discover_candidate_privacy_admission_v1',0));
 SELECT * INTO health FROM public.candidate_privacy_sync_state WHERE consumer_name='discover';
 IF NOT FOUND OR health.status<>'healthy' OR health.active_generation<=0 OR health.last_success_at IS NULL
  OR health.last_success_at<clock_timestamp()-interval '300 seconds' OR health.expected_candidates<>health.projected_candidates
  THEN RAISE EXCEPTION 'RC_PRIVACY_UNAVAILABLE'; END IF;
 SELECT r.* INTO run FROM public.rc_sourcing_runs r JOIN public.governed_sourcing_bindings b
  ON b.tenant_id=r.tenant_id AND b.flow_run_id=r.flow_run_id
  JOIN public.job_sourcing_requests j ON j.id=r.request_id AND j."tenantId"=r.tenant_id
  WHERE r.tenant_id=p_tenant AND r.flow_run_id=p_flow AND r.generation=j.acquisition_generation FOR UPDATE OF r;
 IF NOT FOUND THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
 SELECT o.* INTO entry FROM public.rc_skill_outbox o JOIN public.rc_lookup_attempts a ON a.id=o.attempt_id
  WHERE a.run_id=run.id AND (p_command->>'id' IS NULL OR o.id=(p_command->>'id')::uuid)
   AND (p_command->>'action'='ack' OR (o.state='pending' AND o.next_attempt_at<=clock_timestamp()))
  ORDER BY o.next_attempt_at,o.id LIMIT 1 FOR UPDATE OF o;
 IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'state','empty'); END IF;
 IF p_command->>'action'='ack' THEN
  IF entry.state='delivered' THEN
   IF entry.delivery_receipt IS DISTINCT FROM p_command->>'receiptHash' THEN RAISE EXCEPTION 'RC_OUTBOX_CONFLICT'; END IF;
   RETURN jsonb_build_object('version',1,'state','delivered','id',entry.id,'replayed',true);
  END IF;
  IF entry.state='suppressed' THEN RETURN jsonb_build_object('version',1,'state','suppressed','id',entry.id); END IF;
  UPDATE public.rc_skill_outbox SET state='delivered',delivery_receipt=p_command->>'receiptHash' WHERE id=entry.id;
  UPDATE public.rc_sourcing_runs SET last_progress_at=clock_timestamp() WHERE id=run.id;
  RETURN jsonb_build_object('version',1,'state','delivered','id',entry.id,'replayed',false);
 END IF;
 SELECT m.candidate_id INTO candidate FROM public.rc_lookup_attempts a JOIN public.rc_purchase_members m
  ON m.run_id=a.run_id AND m.identity_hash=a.identity_hash WHERE a.id=entry.attempt_id;
 allowed:=EXISTS(SELECT 1 FROM public.candidate_privacy_projection WHERE tenant_id=p_tenant AND candidate_id=candidate
  AND generation=health.active_generation AND evaluated_cursor=health.cursor AND decision='allow');
 IF NOT allowed THEN
  acknowledgment:=encode(sha256(convert_to('privacy-suppressed:'||entry.id::text||':'||entry.payload_hash||':'||health.cursor::text,'UTF8')),'hex');
  UPDATE public.rc_skill_outbox SET state='suppressed',delivery_receipt=acknowledgment WHERE id=entry.id;
  RETURN jsonb_build_object('version',1,'state','suppressed','id',entry.id);
 END IF;
 UPDATE public.rc_skill_outbox SET next_attempt_at=clock_timestamp()+interval '30 seconds' WHERE id=entry.id;
 RETURN jsonb_build_object('version',1,'state','claimed','id',entry.id,'payloadHash',entry.payload_hash,'payload',entry.minimal_payload);
END $rc_outbox$;
REVOKE ALL ON FUNCTION public.signal_rc_outbox(text,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_rc_recover(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='5s' AS $rc_recover$
DECLARE run public.rc_sourcing_runs%ROWTYPE; b public.governed_sourcing_bindings%ROWTYPE;
 request public.job_sourcing_requests%ROWTYPE; prior jsonb; receipt jsonb; command_hash text; target_state text; actor text:=session_user;
 ranking_attempts integer;
BEGIN
 IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR p_command-ARRAY['version','action','requestId','expectedRevision','reason','hold']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['version','action','requestId','expectedRevision','reason','hold']
  OR coalesce(p_command->>'action','') NOT IN ('resume','close','ack','hold')
  OR coalesce(p_command->>'expectedRevision','') !~ '^[0-9]+$' OR jsonb_typeof(p_command->'reason') IS DISTINCT FROM 'string'
  OR length(trim(p_command->>'reason')) NOT BETWEEN 1 AND 160 OR p_command->>'reason' ~ '[[:cntrl:]]'
  OR (p_command->>'requestId')::uuid IS NULL OR octet_length(p_command::text)>4096
  OR (p_command->>'action'='hold' AND jsonb_typeof(p_command->'hold') IS DISTINCT FROM 'boolean')
  OR (p_command->>'action'<>'hold' AND p_command->'hold'<>'null'::jsonb) THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
 SELECT * INTO request FROM public.job_sourcing_requests WHERE id=b.request_id AND "tenantId"=p_tenant FOR UPDATE;
 SELECT * INTO run FROM public.rc_sourcing_runs WHERE tenant_id=p_tenant AND flow_run_id=p_flow
  AND generation=request.acquisition_generation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
 command_hash:=encode(sha256(convert_to(p_command::text,'UTF8')),'hex');
 SELECT value INTO prior FROM jsonb_array_elements(run.recovery_receipts) WHERE value->>'requestId'=p_command->>'requestId';
 IF FOUND THEN
  IF prior->>'commandHash' IS DISTINCT FROM command_hash THEN RAISE EXCEPTION 'RC_RECOVERY_CONFLICT'; END IF;
  RETURN prior;
 END IF;
 IF run.revision::text IS DISTINCT FROM p_command->>'expectedRevision' THEN RAISE EXCEPTION 'RC_RECOVERY_STALE'; END IF;
 target_state:=run.state;
 IF p_command->>'action'='resume' THEN
  IF b.cancellation IS NOT NULL OR run.closed_at IS NOT NULL OR run.cleaned_at IS NOT NULL OR request.status='complete'
   OR run.state NOT IN ('stalled','needs_attention')
   THEN RAISE EXCEPTION 'RC_RECOVERY_REFUSED'; END IF;
  IF EXISTS(SELECT 1 FROM public.rc_lookup_attempts WHERE run_id=run.id AND state='dispatched'
   AND dispatch_at>clock_timestamp()-interval '10 seconds') THEN RAISE EXCEPTION 'RC_ATTEMPTS_IN_FLIGHT'; END IF;
  target_state:=CASE WHEN run.sealed_at IS NOT NULL THEN
   CASE WHEN NOT EXISTS(SELECT 1 FROM public.rc_purchase_members WHERE run_id=run.id AND state IN ('success','cached','no_data')) THEN 'baseline_only'
    WHEN EXISTS(SELECT 1 FROM public.rc_purchase_members WHERE run_id=run.id AND state IN ('failed','uncertain','restricted','oversized')) THEN 'partial' ELSE 'complete' END
   WHEN run.baseline IS NULL THEN 'admitted' ELSE 'prepared' END;
  -- Queue only the saved execution. Existing paid dispatch markers, original
  -- stage deadline, generation, dispatches and immutable receipt payloads survive.
  -- Preserve Flow's immutable execution identity. A separate recovery token
  -- fences old queue jobs, and a new worker claims a fresh processing lease.
  UPDATE public.job_sourcing_requests SET status='queued',processing_lease_id=NULL
   WHERE id=run.request_id AND "tenantId"=p_tenant RETURNING * INTO request;
  UPDATE public.rc_sourcing_runs SET state=target_state,stalled_at=NULL,heartbeat_at=clock_timestamp(),last_progress_at=clock_timestamp(),
   next_work_at=NULL,safe_to_clean_at=NULL,execution_attempt_id=request.execution_attempt_id,
   resume_token=(p_command->>'requestId')::uuid,resume_enqueued_at=NULL WHERE id=run.id;
  -- Explicit owner recovery may renew computation attempts, never acquisition
  -- or enrichment. Keep immutable ranking input/revision; audit the prior count.
  SELECT attempt_count INTO ranking_attempts FROM public.governed_ranking_runs
   WHERE tenant_id=p_tenant AND flow_run_id=p_flow AND state='reserved' FOR UPDATE;
  IF FOUND THEN
   UPDATE public.governed_ranking_runs SET attempt_count=1,lease_until=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND flow_run_id=p_flow AND state='reserved';
  END IF;
 ELSIF p_command->>'action'='close' THEN
  IF run.sealed_at IS NOT NULL OR run.closed_at IS NOT NULL THEN RAISE EXCEPTION 'RC_RECOVERY_REFUSED'; END IF;
  IF EXISTS(SELECT 1 FROM public.rc_lookup_attempts WHERE run_id=run.id AND state='dispatched' AND dispatch_at>clock_timestamp()-interval '10 seconds')
   THEN RAISE EXCEPTION 'RC_ATTEMPTS_IN_FLIGHT'; END IF;
  target_state:='closed_unrecoverable';
  UPDATE public.rc_lookup_attempts SET state=CASE WHEN dispatch_at IS NULL THEN 'no_dispatch' ELSE 'uncertain' END
   WHERE run_id=run.id AND state IN ('reserved','dispatched');
  UPDATE public.rc_purchase_members m SET state=CASE WHEN EXISTS(SELECT 1 FROM public.rc_lookup_attempts a
   WHERE a.run_id=m.run_id AND a.identity_hash=m.identity_hash AND a.operation='FETCH' AND a.dispatch_at IS NOT NULL) THEN 'uncertain' ELSE 'failed' END
   WHERE m.run_id=run.id AND m.state IN ('pending','checking','fetching');
  UPDATE public.rc_sourcing_runs SET state=target_state,closed_at=clock_timestamp(),closure_hash=command_hash,
   safe_to_clean_at=NULL,next_work_at=NULL,last_progress_at=clock_timestamp() WHERE id=run.id;
  UPDATE public.job_sourcing_requests SET status='failed',processing_lease_id=NULL,callback_status='pending' WHERE id=run.request_id AND "tenantId"=p_tenant;
  INSERT INTO public.rc_operations_events(id,run_id,kind,episode,safe_code)
   VALUES(gen_random_uuid(),run.id,'closed',1,'RC_CLOSED') ON CONFLICT(run_id,kind,episode) DO NOTHING;
 ELSIF p_command->>'action'='hold' THEN
  UPDATE public.rc_sourcing_runs SET retention_hold=(p_command->>'hold')::boolean,safe_to_clean_at=NULL WHERE id=run.id;
 ELSE
  UPDATE public.rc_operations_events SET acknowledged_at=clock_timestamp(),ack_actor=actor
   WHERE run_id=run.id AND acknowledged_at IS NULL;
 END IF;
 receipt:=jsonb_build_object('version',1,'requestId',p_command->>'requestId','commandHash',command_hash,
  'revision',(run.revision+1)::text,'state',target_state,'action',p_command->>'action','reason',p_command->>'reason',
  'actor',actor,'at',clock_timestamp(),'rankingAttemptsBefore',ranking_attempts);
 receipt:=receipt||jsonb_build_object('receiptHash',encode(sha256(convert_to(receipt::text,'UTF8')),'hex'));
 UPDATE public.rc_sourcing_runs SET revision=revision+1,recovery_receipts=recovery_receipts||jsonb_build_array(receipt) WHERE id=run.id;
 RETURN receipt;
END $rc_recover$;
REVOKE ALL ON FUNCTION public.signal_rc_recover(text,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_rc_set_policy(p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='5s' AS $rc_policy$
DECLARE p jsonb; fingerprint text; prior public.rc_rate_policies%ROWTYPE; policy_id uuid;
BEGIN
 IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR octet_length(p_command::text)>8192 OR coalesce(p_command->>'action','') NOT IN ('rates','organization') THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 IF p_command->>'action'='organization' THEN
  IF p_command-ARRAY['version','action','tenantId','policyId','enabled']<>'{}'::jsonb
   OR NOT p_command ?& ARRAY['version','action','tenantId','policyId','enabled']
   OR coalesce(p_command->>'tenantId','') !~ '^org_[1-9][0-9]*$'
   OR jsonb_typeof(p_command->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
  policy_id:=(p_command->>'policyId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.governed_sourcing_tenants WHERE tenant_id=p_command->>'tenantId')
   OR NOT EXISTS(SELECT 1 FROM public.rc_rate_policies WHERE id=policy_id) THEN RAISE EXCEPTION 'RC_POLICY_REFUSED'; END IF;
  INSERT INTO public.rc_org_policies(tenant_id,policy_id,enabled) VALUES(p_command->>'tenantId',policy_id,(p_command->>'enabled')::boolean)
   ON CONFLICT(tenant_id) DO UPDATE SET policy_id=excluded.policy_id,enabled=excluded.enabled,updated_at=clock_timestamp();
  RETURN jsonb_build_object('version',1,'state','configured','policyId',policy_id);
 END IF;
 IF p_command-ARRAY['version','action','policy']<>'{}'::jsonb OR NOT p_command ?& ARRAY['version','action','policy'] THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 p:=p_command->'policy';
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p-ARRAY['id','rcAccountHash','rcFetchCreditsMax','rpm','enabled']<>'{}'::jsonb
  OR NOT p ?& ARRAY['id','rcAccountHash','rcFetchCreditsMax','rpm','enabled']
  OR jsonb_typeof(p->'enabled') IS DISTINCT FROM 'boolean'
  OR EXISTS(SELECT 1 FROM jsonb_each(p) e WHERE e.key IN ('rcFetchCreditsMax','rpm') AND e.value<>'null'::jsonb
   AND (jsonb_typeof(e.value)<>'number' OR e.value::text !~ '^[0-9]+$')) THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 policy_id:=(p->>'id')::uuid;
 fingerprint:=encode(sha256(convert_to((p-'id')::text,'UTF8')),'hex');
 SELECT * INTO prior FROM public.rc_rate_policies WHERE id=policy_id FOR UPDATE;
 IF FOUND THEN
  IF prior.policy_hash IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'RC_POLICY_IMMUTABLE'; END IF;
  RETURN jsonb_build_object('version',1,'state','configured','policyId',policy_id,'policyHash',fingerprint,'replayed',true);
 END IF;
 INSERT INTO public.rc_rate_policies(id,policy_hash,rc_account_hash,rc_fetch_credits_max,rpm,enabled)
  VALUES(policy_id,fingerprint,p->>'rcAccountHash',(p->>'rcFetchCreditsMax')::integer,(p->>'rpm')::integer,(p->>'enabled')::boolean);
 RETURN jsonb_build_object('version',1,'state','configured','policyId',policy_id,'policyHash',fingerprint,'replayed',false);
END $rc_policy$;
REVOKE ALL ON FUNCTION public.signal_rc_set_policy(jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_rc_maintain(p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='10s' AS $rc_maintain$
DECLARE run public.rc_sourcing_runs%ROWTYPE; request public.job_sourcing_requests%ROWTYPE;
 event public.rc_operations_events%ROWTYPE; entry record; episode_number integer; count_stalled integer:=0;
 count_cleaned integer:=0; count_ready integer:=0; at_time timestamptz:=clock_timestamp(); safe boolean;
 ack boolean; receipt jsonb; receipt_hash text; response jsonb:='[]'::jsonb; binding public.governed_sourcing_bindings%ROWTYPE;
BEGIN
 IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR octet_length(p_command::text)>4096 OR coalesce(p_command->>'action','') NOT IN ('heartbeat','stall','skip_cache','tick','alerts','alert_result','cleanup','deliveries','delivery_result','resumes','resume_ack','failure','execution_claim')
  THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 IF p_command->>'action'='execution_claim' THEN
  IF p_command-ARRAY['version','action','tenantId','requestId','generation','executionAttemptId','processingLeaseId','resumeToken']<>'{}'::jsonb
   OR NOT p_command ?& ARRAY['version','action','tenantId','requestId','generation','executionAttemptId','processingLeaseId','resumeToken']
   OR coalesce(p_command->>'processingLeaseId','')='' THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
  SELECT * INTO binding FROM public.governed_sourcing_bindings WHERE tenant_id=p_command->>'tenantId'
   AND request_id=p_command->>'requestId' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'state','unmanaged'); END IF;
  SELECT * INTO request FROM public.job_sourcing_requests WHERE id=binding.request_id AND "tenantId"=binding.tenant_id FOR UPDATE;
  SELECT * INTO run FROM public.rc_sourcing_runs WHERE tenant_id=binding.tenant_id AND flow_run_id=binding.flow_run_id
   AND generation=request.acquisition_generation FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'state','unmanaged'); END IF;
  IF binding.cancellation IS NOT NULL OR request.status NOT IN ('queued','processing')
   OR request.execution_attempt_id IS DISTINCT FROM p_command->>'executionAttemptId'
   OR request.acquisition_generation::text IS DISTINCT FROM p_command->>'generation'
   OR run.resume_token::text IS DISTINCT FROM p_command->>'resumeToken'
   OR run.state IN ('stalled','closed_unrecoverable','needs_attention')
   THEN RETURN jsonb_build_object('version',1,'state','rejected'); END IF;
  UPDATE public.job_sourcing_requests SET status='processing',processing_lease_id=p_command->>'processingLeaseId'
   WHERE id=request.id AND "tenantId"=request."tenantId";
  RETURN jsonb_build_object('version',1,'state','claimed');
 END IF;
 IF p_command->>'action'='failure' THEN
  IF p_command-ARRAY['version','action','tenantId','flowRunId','executionAttemptId','processingLeaseId','attemptsMade','maxAttempts']<>'{}'::jsonb
   OR NOT p_command ?& ARRAY['version','action','tenantId','flowRunId','executionAttemptId','processingLeaseId','attemptsMade','maxAttempts']
   OR coalesce(p_command->>'attemptsMade','') !~ '^[0-9]+$' OR coalesce(p_command->>'maxAttempts','') !~ '^[1-9][0-9]*$'
   THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
  SELECT * INTO binding FROM public.governed_sourcing_bindings WHERE tenant_id=p_command->>'tenantId'
   AND flow_run_id=(p_command->>'flowRunId')::uuid FOR UPDATE;
  SELECT * INTO request FROM public.job_sourcing_requests WHERE id=binding.request_id AND "tenantId"=binding.tenant_id FOR UPDATE;
  SELECT * INTO run FROM public.rc_sourcing_runs WHERE tenant_id=binding.tenant_id AND flow_run_id=binding.flow_run_id
   AND generation=request.acquisition_generation FOR UPDATE;
  IF NOT FOUND OR binding.cancellation IS NOT NULL OR request.status<>'processing'
   OR request.execution_attempt_id IS DISTINCT FROM p_command->>'executionAttemptId'
   OR run.execution_attempt_id IS DISTINCT FROM request.execution_attempt_id
   OR request.processing_lease_id IS NULL OR request.processing_lease_id IS DISTINCT FROM p_command->>'processingLeaseId'
   THEN RAISE EXCEPTION 'RC_EXECUTION_STALE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.rc_lookup_attempts WHERE run_id=run.id AND dispatch_at IS NOT NULL) THEN
   receipt:=public.signal_sourcing_cancel(binding.tenant_id,request.id,jsonb_build_object(
    'acquisitionGeneration',request.acquisition_generation,'executionAttemptId',request.execution_attempt_id,'processingLeaseId',request.processing_lease_id));
   IF receipt IS NOT NULL THEN
    UPDATE public.rc_sourcing_runs SET state='closed_unrecoverable',closed_at=at_time,rc_available=false,
     closure_hash=encode(sha256(convert_to(receipt::text,'UTF8')),'hex'),revision=revision+1 WHERE id=run.id;
    RETURN jsonb_build_object('version',1,'state','cancelled');
   END IF;
  END IF;
  IF (p_command->>'attemptsMade')::integer+1<least((p_command->>'maxAttempts')::integer,3)
   AND run.state NOT IN ('stalled','needs_attention','closed_unrecoverable')
   AND EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts WHERE "tenantId"=run.tenant_id
    AND "sourcingRequestId"=run.request_id AND "acquisitionGeneration"=run.generation AND slot='exact' AND status='complete')
   AND NOT EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts WHERE "tenantId"=run.tenant_id
    AND "sourcingRequestId"=run.request_id AND "acquisitionGeneration"=run.generation AND status<>'complete') THEN
   UPDATE public.job_sourcing_requests SET status='queued',processing_lease_id=NULL WHERE id=request.id AND "tenantId"=run.tenant_id;
   UPDATE public.rc_sourcing_runs SET heartbeat_at=at_time,last_progress_at=at_time,revision=revision+1 WHERE id=run.id;
   RETURN jsonb_build_object('version',1,'state','retry');
  END IF;
  IF run.state NOT IN ('stalled','closed_unrecoverable') THEN
   UPDATE public.rc_sourcing_runs SET state='stalled',stalled_at=at_time,revision=revision+1 WHERE id=run.id;
   SELECT coalesce(max(episode),0)+1 INTO episode_number FROM public.rc_operations_events WHERE run_id=run.id AND kind='stalled';
   INSERT INTO public.rc_operations_events(id,run_id,kind,episode,safe_code) VALUES(gen_random_uuid(),run.id,'stalled',episode_number,'RC_STALLED');
  END IF;
  RETURN jsonb_build_object('version',1,'state','stalled');
 END IF;
 IF p_command->>'action'='resumes' THEN
  IF p_command-ARRAY['version','action']<>'{}'::jsonb THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
  SELECT coalesce(jsonb_agg(value),'[]'::jsonb) INTO response FROM (
   SELECT jsonb_build_object('tenantId',r.tenant_id,'flowRunId',r.flow_run_id,'token',r.resume_token,
    'requestId',r.request_id,'externalJobId',b.command->>'externalJobId','callbackUrl',b.command->>'callbackUrl',
    'acquisitionGeneration',r.generation,'executionAttemptId',r.execution_attempt_id) value
   FROM public.rc_sourcing_runs r JOIN public.job_sourcing_requests j ON j.id=r.request_id AND j."tenantId"=r.tenant_id
   JOIN public.governed_sourcing_bindings b ON b.tenant_id=r.tenant_id AND b.flow_run_id=r.flow_run_id
   WHERE r.resume_token IS NOT NULL AND r.resume_enqueued_at IS NULL AND r.closed_at IS NULL
    AND b.cancellation IS NULL
    AND j.status IN ('queued','processing','complete') AND j.execution_attempt_id=r.execution_attempt_id
    AND j.acquisition_generation=r.generation ORDER BY r.id LIMIT 25
  ) pending;
  RETURN jsonb_build_object('version',1,'runs',response);
 ELSIF p_command->>'action'='resume_ack' THEN
  IF p_command-ARRAY['version','action','tenantId','flowRunId','token']<>'{}'::jsonb
   OR NOT p_command ?& ARRAY['version','action','tenantId','flowRunId','token'] THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
  UPDATE public.rc_sourcing_runs SET resume_enqueued_at=coalesce(resume_enqueued_at,at_time)
   WHERE tenant_id=p_command->>'tenantId' AND flow_run_id=(p_command->>'flowRunId')::uuid
    AND resume_token=(p_command->>'token')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'RC_RECOVERY_STALE'; END IF;
  RETURN jsonb_build_object('version',1,'state','recorded');
 END IF;
 IF p_command->>'action'='delivery_result' THEN
  IF p_command-ARRAY['version','action','tenantId','flowRunId','pending']<>'{}'::jsonb
   OR NOT p_command ?& ARRAY['version','action','tenantId','flowRunId','pending']
   OR jsonb_typeof(p_command->'pending') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
  SELECT * INTO run FROM public.rc_sourcing_runs WHERE tenant_id=p_command->>'tenantId'
   AND flow_run_id=(p_command->>'flowRunId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
  IF (p_command->>'pending')::boolean THEN
   INSERT INTO public.rc_operations_events(id,run_id,kind,episode,safe_code)
    VALUES(gen_random_uuid(),run.id,'receipt_delivery',1,'RC_RECEIPT_DELIVERY') ON CONFLICT(run_id,kind,episode) DO NOTHING;
  ELSE
   UPDATE public.rc_sourcing_runs SET last_progress_at=at_time WHERE id=run.id;
  END IF;
  RETURN jsonb_build_object('version',1,'state','recorded');
 END IF;
 IF p_command->>'action' IN ('heartbeat','stall','skip_cache') THEN
  IF p_command-ARRAY['version','action','tenantId','flowRunId','executionAttemptId','processingLeaseId']<>'{}'::jsonb
   OR NOT p_command ?& ARRAY['version','action','tenantId','flowRunId','executionAttemptId','processingLeaseId'] THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
  SELECT r.* INTO run FROM public.rc_sourcing_runs r JOIN public.job_sourcing_requests j ON j.id=r.request_id AND j."tenantId"=r.tenant_id
   WHERE r.tenant_id=p_command->>'tenantId' AND r.flow_run_id=(p_command->>'flowRunId')::uuid AND r.generation=j.acquisition_generation
   AND j.status='processing' AND j.execution_attempt_id=p_command->>'executionAttemptId' AND j.processing_lease_id=p_command->>'processingLeaseId'
   AND r.execution_attempt_id=j.execution_attempt_id AND r.processing_lease_id=j.processing_lease_id FOR UPDATE OF r;
  IF NOT FOUND OR run.state='closed_unrecoverable' THEN RAISE EXCEPTION 'RC_EXECUTION_STALE'; END IF;
  IF p_command->>'action'='skip_cache' THEN
   IF run.baseline IS NOT NULL OR run.sealed_at IS NOT NULL OR run.state<>'admitted'
    OR EXISTS(SELECT 1 FROM public.rc_lookup_attempts WHERE run_id=run.id)
    THEN RAISE EXCEPTION 'RC_CACHE_SKIP_REFUSED'; END IF;
   -- No cache answer is not a paid cache miss. Skip new RC work for this run
   -- without changing purchase receipts or paid dispatch markers.
   UPDATE public.rc_sourcing_runs SET rc_available=false,revision=revision+1,last_progress_at=at_time WHERE id=run.id;
   INSERT INTO public.rc_operations_events(id,run_id,kind,episode,safe_code)
    VALUES(gen_random_uuid(),run.id,'cache_delivery',1,'RC_CACHE_UNAVAILABLE') ON CONFLICT(run_id,kind,episode) DO NOTHING;
   RETURN jsonb_build_object('version',1,'state','skipped');
  END IF;
  IF p_command->>'action'='stall' THEN
   IF run.sealed_at IS NULL AND run.state<>'stalled' THEN
    UPDATE public.rc_sourcing_runs SET state='stalled',stalled_at=at_time,revision=revision+1 WHERE id=run.id;
    SELECT coalesce(max(episode),0)+1 INTO episode_number FROM public.rc_operations_events WHERE run_id=run.id AND kind='stalled';
    INSERT INTO public.rc_operations_events(id,run_id,kind,episode,safe_code) VALUES(gen_random_uuid(),run.id,'stalled',episode_number,'RC_STALLED');
   END IF;
   RETURN jsonb_build_object('version',1,'state','stalled');
  END IF;
  IF run.state='stalled' THEN RAISE EXCEPTION 'RC_EXECUTION_STALE'; END IF;
  UPDATE public.rc_sourcing_runs SET heartbeat_at=at_time WHERE id=run.id;
  RETURN jsonb_build_object('version',1,'state','alive');
 ELSIF p_command->>'action'='alert_result' THEN
  IF p_command-ARRAY['version','action','id','delivered']<>'{}'::jsonb OR NOT p_command ?& ARRAY['version','action','id','delivered']
   OR jsonb_typeof(p_command->'delivered') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
  SELECT * INTO event FROM public.rc_operations_events WHERE id=(p_command->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RC_EVENT_REFUSED'; END IF;
  ack:=(p_command->>'delivered')::boolean;
  UPDATE public.rc_operations_events SET delivered_at=CASE WHEN ack THEN coalesce(delivered_at,at_time) ELSE delivered_at END,
   next_delivery_at=CASE WHEN ack THEN least(created_at+interval '30 minutes',at_time+interval '1 day')
    ELSE at_time+least(900,30*power(2,least(delivery_attempts,5))) * interval '1 second' END WHERE id=event.id;
  -- Once the backup reminder is due, subsequent reminders are daily rather
  -- than re-emitting a past 30-minute timestamp on every scheduler tick.
  IF ack AND event.created_at+interval '30 minutes'<=at_time THEN
   UPDATE public.rc_operations_events SET next_delivery_at=at_time+interval '1 day' WHERE id=event.id;
  END IF;
  RETURN jsonb_build_object('version',1,'state','recorded');
 END IF;
 IF p_command-ARRAY['version','action']<>'{}'::jsonb OR NOT p_command ?& ARRAY['version','action'] THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 IF p_command->>'action'='alerts' THEN
  FOR event IN SELECT * FROM public.rc_operations_events WHERE acknowledged_at IS NULL AND next_delivery_at<=at_time
   ORDER BY next_delivery_at,id LIMIT 25 FOR UPDATE SKIP LOCKED LOOP
   UPDATE public.rc_operations_events SET next_delivery_at=at_time+interval '30 seconds',delivery_attempts=delivery_attempts+1 WHERE id=event.id;
   response:=response||jsonb_build_array(jsonb_build_object('id',event.id,'runId',event.run_id,'kind',event.kind,'code',event.safe_code,
    'createdAt',event.created_at,'escalation',CASE WHEN event.created_at<at_time-interval '7 days' THEN 'retention_review'
     WHEN event.created_at<at_time-interval '30 minutes' THEN 'backup' ELSE 'primary' END));
  END LOOP;
  RETURN jsonb_build_object('version',1,'events',response);
 ELSIF p_command->>'action'='deliveries' THEN
  FOR entry IN SELECT r.tenant_id,r.flow_run_id,r.request_id FROM public.rc_sourcing_runs r WHERE r.cleaned_at IS NULL AND (
   EXISTS(SELECT 1 FROM public.rc_skill_outbox o JOIN public.rc_lookup_attempts a ON a.id=o.attempt_id WHERE a.run_id=r.id AND o.state='pending' AND o.next_attempt_at<=at_time)
   OR EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts c WHERE c."tenantId"=r.tenant_id AND c."sourcingRequestId"=r.request_id
    AND c."acquisitionGeneration"=r.generation AND c.status='complete' AND c.memory_ingested_at IS NULL)) ORDER BY r.last_progress_at,r.id LIMIT 25 LOOP
   response:=response||jsonb_build_array(jsonb_build_object('tenantId',entry.tenant_id,'flowRunId',entry.flow_run_id,'requestId',entry.request_id));
  END LOOP;
  RETURN jsonb_build_object('version',1,'runs',response);
 ELSIF p_command->>'action'='tick' THEN
  FOR run IN SELECT * FROM public.rc_sourcing_runs WHERE sealed_at IS NULL AND closed_at IS NULL AND state<>'stalled'
   AND (heartbeat_at<at_time-interval '90 seconds' OR (next_work_at IS NULL AND last_progress_at<at_time-interval '120 seconds')
    OR (next_work_at IS NOT NULL AND next_work_at<at_time-interval '30 seconds')) ORDER BY heartbeat_at,id LIMIT 25 FOR UPDATE SKIP LOCKED LOOP
   UPDATE public.rc_sourcing_runs SET state='stalled',stalled_at=at_time,revision=revision+1 WHERE id=run.id;
   SELECT coalesce(max(episode),0)+1 INTO episode_number FROM public.rc_operations_events WHERE run_id=run.id AND kind='stalled';
   INSERT INTO public.rc_operations_events(id,run_id,kind,episode,safe_code) VALUES(gen_random_uuid(),run.id,'stalled',episode_number,'RC_STALLED');
   count_stalled:=count_stalled+1;
  END LOOP;
  RETURN jsonb_build_object('version',1,'stalled',count_stalled);
 END IF;
 -- Cleanup takes the same binding -> request -> run locks as admission. A
 -- racing lease/recovery/hold must not invalidate the predicates after checking.
 FOR entry IN SELECT id,tenant_id,flow_run_id,request_id FROM public.rc_sourcing_runs WHERE cleaned_at IS NULL
  AND sealed_at IS NOT NULL ORDER BY coalesce(safe_to_clean_at,sealed_at),id LIMIT 25 LOOP
  PERFORM 1 FROM public.governed_sourcing_bindings WHERE tenant_id=entry.tenant_id AND flow_run_id=entry.flow_run_id FOR UPDATE;
  SELECT * INTO request FROM public.job_sourcing_requests WHERE id=entry.request_id AND "tenantId"=entry.tenant_id FOR UPDATE;
  SELECT * INTO run FROM public.rc_sourcing_runs WHERE id=entry.id FOR UPDATE;
  safe:=NOT run.retention_hold AND run.cleaned_at IS NULL AND run.sealed_at IS NOT NULL
   AND run.state IN ('complete','partial','baseline_only') AND request.status='complete'
   AND request.processing_lease_id IS NULL AND request.callback_status='delivered'
   AND EXISTS(SELECT 1 FROM public.governed_ranking_runs g WHERE g.tenant_id=run.tenant_id AND g.flow_run_id=run.flow_run_id AND g.state='ready')
   AND NOT EXISTS(SELECT 1 FROM public.rc_lookup_attempts WHERE run_id=run.id AND state IN ('reserved','dispatched'))
   AND NOT EXISTS(SELECT 1 FROM public.rc_skill_outbox o JOIN public.rc_lookup_attempts a ON a.id=o.attempt_id WHERE a.run_id=run.id AND o.state='pending')
   AND NOT EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts c WHERE c."tenantId"=run.tenant_id AND c."sourcingRequestId"=run.request_id
    AND c."acquisitionGeneration"=run.generation AND ((c.status IN ('complete','released') AND c.memory_ingested_at IS NULL) OR c.status NOT IN ('complete','released','no_dispatch')));
  -- Failed-close payload sufficiency has no automatic proof: keep those copies
  -- for explicit operator retention review, even after terminal delivery.
  IF NOT safe THEN
   UPDATE public.rc_sourcing_runs SET safe_to_clean_at=NULL WHERE id=run.id;CONTINUE;
  END IF;
  IF run.safe_to_clean_at IS NULL THEN
   UPDATE public.rc_sourcing_runs SET safe_to_clean_at=at_time,revision=revision+1 WHERE id=run.id;count_ready:=count_ready+1;CONTINUE;
  END IF;
  IF run.safe_to_clean_at>at_time-interval '24 hours' THEN CONTINUE; END IF;
  receipt:=jsonb_build_object('version',1,'action','redundant_copy_cleanup','runId',run.id,'baselineHash',run.baseline_hash,
   'outcomeSetHash',run.closure_hash,'attempts',(SELECT count(*) FROM public.rc_lookup_attempts WHERE run_id=run.id),
   'outboxes',(SELECT count(*) FROM public.rc_skill_outbox o JOIN public.rc_lookup_attempts a ON a.id=o.attempt_id WHERE a.run_id=run.id),'at',at_time);
  receipt_hash:=encode(sha256(convert_to(receipt::text,'UTF8')),'hex');
  UPDATE public.rc_lookup_attempts SET outcome=NULL WHERE run_id=run.id;
  UPDATE public.rc_skill_outbox o SET minimal_payload=NULL FROM public.rc_lookup_attempts a WHERE a.id=o.attempt_id AND a.run_id=run.id AND o.state<>'pending';
  UPDATE public.rc_sourcing_runs SET baseline=NULL,cleaned_at=at_time,revision=revision+1,
   recovery_receipts=recovery_receipts||jsonb_build_array(receipt||jsonb_build_object('receiptHash',receipt_hash)) WHERE id=run.id;
  count_cleaned:=count_cleaned+1;
 END LOOP;
 RETURN jsonb_build_object('version',1,'ready',count_ready,'cleaned',count_cleaned);
END $rc_maintain$;
REVOKE ALL ON FUNCTION public.signal_rc_maintain(jsonb) FROM PUBLIC;
