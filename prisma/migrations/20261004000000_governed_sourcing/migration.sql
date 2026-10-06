-- Wave 5B. No tenant activation or acquisition backfill.
ALTER TABLE public.job_sourcing_requests ADD COLUMN flow_run_id uuid,
  ADD COLUMN artifact_hash text, ADD COLUMN protocol_version integer,
  ADD CONSTRAINT gov_request_binding_ck CHECK (
    (flow_run_id IS NULL AND artifact_hash IS NULL AND protocol_version IS NULL) OR
    (flow_run_id IS NOT NULL AND artifact_hash IS NOT NULL AND artifact_hash ~ '^[a-f0-9]{64}$' AND protocol_version=1 AND acquisition_generation=1));
CREATE UNIQUE INDEX gov_request_flow_uq ON public.job_sourcing_requests("tenantId",flow_run_id);
CREATE TABLE public.governed_sourcing_tenants (
  tenant_id text CONSTRAINT gov_tenant_pk PRIMARY KEY,
  enabled_at timestamptz NOT NULL,
  policy_hash text NOT NULL CONSTRAINT gov_tenant_hash_ck CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  organization_ref text NOT NULL CONSTRAINT gov_tenant_org_ck CHECK (organization_ref ~ '^[1-9][0-9]*$'),
  callback_url text NOT NULL CONSTRAINT gov_tenant_callback_ck CHECK (length(callback_url) BETWEEN 1 AND 2048),
  allow_new boolean NOT NULL DEFAULT false
);
CREATE TABLE public.governed_sourcing_bindings (
  tenant_id text NOT NULL,
  flow_run_id uuid NOT NULL,
  request_id text NOT NULL CONSTRAINT gov_binding_request_uq UNIQUE,
  artifact_hash text NOT NULL CONSTRAINT gov_binding_hash_ck CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  organization_ref text NOT NULL,
  external_job_id text NOT NULL,
  command jsonb NOT NULL CONSTRAINT gov_binding_command_ck CHECK (jsonb_typeof(command)='object' AND octet_length(command::text)<=131072),
  cancellation jsonb CONSTRAINT gov_binding_cancel_ck CHECK (jsonb_typeof(cancellation)='object' AND octet_length(cancellation::text)<=16384),
  delivery_revision integer NOT NULL DEFAULT 0 CONSTRAINT gov_binding_revision_ck CHECK (delivery_revision>=0),
  delivery_ids jsonb CONSTRAINT gov_binding_ids_ck CHECK (jsonb_typeof(delivery_ids)='array' AND jsonb_array_length(delivery_ids)<=100 AND octet_length(delivery_ids::text)<=32768),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT gov_binding_pk PRIMARY KEY (tenant_id,flow_run_id),
  CONSTRAINT gov_binding_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.governed_sourcing_tenants(tenant_id) ON DELETE RESTRICT,
  CONSTRAINT gov_binding_request_fk FOREIGN KEY (request_id,tenant_id) REFERENCES public.job_sourcing_requests(id,"tenantId") ON DELETE RESTRICT
);
CREATE TABLE public.governed_sourcing_grants (
  tenant_id text NOT NULL,
  flow_run_id uuid NOT NULL,
  slot text NOT NULL CONSTRAINT gov_grant_slot_ck CHECK (slot IN ('exact','spill')),
  grant_id uuid NOT NULL CONSTRAINT gov_grant_id_uq UNIQUE,
  provider_input_sha256 text NOT NULL CONSTRAINT gov_grant_hash_ck CHECK (provider_input_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  state text NOT NULL CONSTRAINT gov_grant_state_ck CHECK (state IN ('issued','started','no_dispatch','uncertain')),
  receipt_id text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT gov_grant_pk PRIMARY KEY (tenant_id,flow_run_id,slot),
  CONSTRAINT gov_grant_binding_fk FOREIGN KEY (tenant_id,flow_run_id) REFERENCES public.governed_sourcing_bindings(tenant_id,flow_run_id) ON DELETE RESTRICT
);
CREATE TABLE public.governed_sourcing_previews (
  tenant_id text NOT NULL,
  preview_id uuid NOT NULL,
  external_job_id text NOT NULL,
  artifact_hash text NOT NULL CONSTRAINT gov_preview_hash_ck CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  request_sha256 text NOT NULL CONSTRAINT gov_preview_req_ck CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  command jsonb NOT NULL CONSTRAINT gov_preview_command_ck CHECK (jsonb_typeof(command)='object' AND octet_length(command::text)<=131072),
  state text NOT NULL CONSTRAINT gov_preview_state_ck CHECK (state IN ('pending','started','complete','unavailable','unknown')),
  count bigint CONSTRAINT gov_preview_count_ck CHECK (count>=0),
  count_relation text CONSTRAINT gov_preview_relation_ck CHECK (count_relation IN ('eq','gte','approximate')),
  credits_used numeric(65,30) CONSTRAINT gov_preview_cost_ck CHECK (credits_used>=0),
  lease_id uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT gov_preview_pk PRIMARY KEY (tenant_id,preview_id),
  CONSTRAINT gov_preview_lease_ck CHECK ((lease_id IS NULL)=(lease_until IS NULL)),
  CONSTRAINT gov_preview_complete_ck CHECK (state<>'complete' OR (count IS NOT NULL AND count_relation IS NOT NULL AND credits_used IS NOT NULL))
);
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['governed_sourcing_tenants','governed_sourcing_bindings','governed_sourcing_grants','governed_sourcing_previews'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',name);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY gov_owner ON public.%I TO %I USING (true) WITH CHECK (true)',name,current_user);
  END LOOP;
END $$;

-- The runtime cannot SELECT through the owner-only RLS policy. A fixed owner
-- observation is required: an RLS-hidden row must never mean "not activated".
CREATE FUNCTION public.signal_sourcing_tenant(p_tenant text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce((SELECT jsonb_build_object('latched',true,'allowNew',allow_new,'organizationRef',organization_ref,'callbackUrl',callback_url)
    FROM public.governed_sourcing_tenants WHERE tenant_id=p_tenant),jsonb_build_object('latched',false,'allowNew',false,'organizationRef',NULL,'callbackUrl',NULL))
$$;
REVOKE ALL ON FUNCTION public.signal_sourcing_tenant(text) FROM PUBLIC;

CREATE FUNCTION public.signal_sourcing_bind(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='5s' AS $$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; r public.job_sourcing_requests%ROWTYPE; request_id text:=gen_random_uuid()::text;
BEGIN
  IF p_flow IS NULL OR nullif(p_tenant,'') IS NULL OR jsonb_typeof(p_command) IS DISTINCT FROM 'object'
    OR octet_length(p_command::text)>131072 OR p_command->>'protocolVersion' IS DISTINCT FROM '1'
    OR p_command->>'flowRunId' IS DISTINCT FROM p_flow::text
    OR p_command-ARRAY['protocolVersion','flowRunId','organizationRef','externalJobId','briefVersionId','materialHash','artifactHash','compilerVersion','queryArtifact','callbackUrl']<>'{}'::jsonb
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
  IF NOT EXISTS(SELECT 1 FROM public.governed_sourcing_tenants WHERE tenant_id=p_tenant AND allow_new) THEN RAISE EXCEPTION 'GOVERNED_DISABLED'; END IF;
  INSERT INTO public.job_sourcing_requests(id,"tenantId","externalJobId","jobContextHash","jobContext","callbackUrl",status,flow_run_id,artifact_hash,protocol_version,acquisition_generation,execution_attempt_id)
    VALUES(request_id,p_tenant,p_command->>'externalJobId',encode(sha256(convert_to(p_flow::text,'UTF8')),'hex'),p_command->'queryArtifact'->'jobContext',
      p_command->>'callbackUrl','queued',p_flow,p_command->>'artifactHash',1,1,gen_random_uuid()::text) RETURNING * INTO r;
  INSERT INTO public.governed_sourcing_bindings(tenant_id,flow_run_id,request_id,artifact_hash,organization_ref,external_job_id,command)
    VALUES(p_tenant,p_flow,request_id,p_command->>'artifactHash',p_command->>'organizationRef',p_command->>'externalJobId',p_command);
  RETURN jsonb_build_object('requestId',r.id,'status',r.status,'flowRunId',p_flow,'artifactHash',r.artifact_hash,
    'acquisitionGeneration',1,'executionAttemptId',r.execution_attempt_id,'idempotent',false);
END $$;
REVOKE ALL ON FUNCTION public.signal_sourcing_bind(text,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_sourcing_execution(p_tenant text,p_request text,p_context jsonb,p_fence jsonb) RETURNS jsonb
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
  IF NOT FOUND OR r.status<>'processing' OR r.flow_run_id IS DISTINCT FROM b.flow_run_id OR r.protocol_version IS DISTINCT FROM 1
    OR r.acquisition_generation IS DISTINCT FROM 1 OR p_fence->>'acquisitionGeneration' IS DISTINCT FROM '1'
    OR r.execution_attempt_id IS DISTINCT FROM p_fence->>'executionAttemptId' OR r.processing_lease_id IS NULL
    OR r.processing_lease_id IS DISTINCT FROM p_fence->>'processingLeaseId'
    OR r."jobContext" IS DISTINCT FROM p_context OR b.command->'queryArtifact'->'jobContext' IS DISTINCT FROM p_context
    THEN RAISE EXCEPTION 'GOVERNED_EXECUTION_STALE'; END IF;
  RETURN b.command;
END $$;
REVOKE ALL ON FUNCTION public.signal_sourcing_execution(text,text,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_sourcing_grant_transition(p_tenant text,p_flow uuid,p_slot text,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='5s' AS $$
DECLARE g public.governed_sourcing_grants%ROWTYPE; b public.governed_sourcing_bindings%ROWTYPE; target text;
BEGIN
  IF p_slot NOT IN ('exact','spill') OR p_slot IS NULL OR jsonb_typeof(p_command) IS DISTINCT FROM 'object'
    OR p_command-ARRAY['grantId','providerInputHash','expiresAt','state','receiptId','executionAttemptId','processingLeaseId']<>'{}'::jsonb
    OR NOT p_command ?& ARRAY['grantId','providerInputHash','expiresAt','state','executionAttemptId','processingLeaseId']
    OR p_command->>'state' IS NULL OR p_command->>'state' NOT IN ('issued','started','no_dispatch','uncertain') THEN RAISE EXCEPTION 'GOVERNED_INVALID_COMMAND'; END IF;
  SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNED_BINDING_REQUIRED'; END IF;
  PERFORM id FROM public.job_sourcing_requests WHERE id=b.request_id AND "tenantId"=p_tenant AND status='processing'
    AND acquisition_generation=1 AND execution_attempt_id=p_command->>'executionAttemptId' AND processing_lease_id=p_command->>'processingLeaseId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNED_EXECUTION_STALE'; END IF;
  target:=p_command->>'state';
  SELECT * INTO g FROM public.governed_sourcing_grants WHERE tenant_id=p_tenant AND flow_run_id=p_flow AND slot=p_slot FOR UPDATE;
  IF NOT FOUND THEN
    -- Permit at most five seconds of inter-database skew, while subtracting
    -- that margin at dispatch so a fast Flow clock cannot extend authority.
    IF target<>'issued' OR (p_command->>'expiresAt')::timestamptz<=clock_timestamp()+interval '5 seconds'
      OR (p_command->>'expiresAt')::timestamptz>clock_timestamp()+interval '65 seconds' THEN RAISE EXCEPTION 'GOVERNED_GRANT_EXPIRED'; END IF;
    INSERT INTO public.governed_sourcing_grants(tenant_id,flow_run_id,slot,grant_id,provider_input_sha256,expires_at,state)
      VALUES(p_tenant,p_flow,p_slot,(p_command->>'grantId')::uuid,p_command->>'providerInputHash',(p_command->>'expiresAt')::timestamptz,'issued') RETURNING * INTO g;
  ELSE
    IF g.grant_id IS DISTINCT FROM (p_command->>'grantId')::uuid OR g.provider_input_sha256 IS DISTINCT FROM p_command->>'providerInputHash'
      OR g.expires_at IS DISTINCT FROM (p_command->>'expiresAt')::timestamptz THEN RAISE EXCEPTION 'GOVERNED_REQUEST_CONFLICT'; END IF;
    IF target='started' AND g.expires_at<=clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'GOVERNED_GRANT_EXPIRED'; END IF;
    IF target='started' AND g.state='started' AND g.receipt_id IS DISTINCT FROM p_command->>'receiptId' THEN RAISE EXCEPTION 'GOVERNED_RECEIPT_REQUIRED'; END IF;
    IF target<>g.state THEN
      IF NOT ((g.state='issued' AND target IN ('started','no_dispatch')) OR (g.state='started' AND target='uncertain')) THEN RAISE EXCEPTION 'GOVERNED_TRANSITION_REFUSED'; END IF;
      IF target='started' AND (g.expires_at<=clock_timestamp()+interval '5 seconds' OR NOT EXISTS(SELECT 1 FROM public.governed_sourcing_tenants WHERE tenant_id=p_tenant AND allow_new)) THEN RAISE EXCEPTION 'GOVERNED_GRANT_EXPIRED'; END IF;
      IF target='started' AND NOT EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts r WHERE r.id=p_command->>'receiptId'
        AND r."tenantId"=p_tenant AND r."sourcingRequestId"=b.request_id AND r."acquisitionGeneration"=1 AND r.slot=p_slot AND r.status='started'
        AND r."requestFingerprint"=g.provider_input_sha256) THEN RAISE EXCEPTION 'GOVERNED_RECEIPT_REQUIRED'; END IF;
      IF target='no_dispatch' AND EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts r WHERE r."tenantId"=p_tenant
        AND r."sourcingRequestId"=b.request_id AND r."acquisitionGeneration"=1 AND r.slot=p_slot) THEN RAISE EXCEPTION 'GOVERNED_TRANSITION_REFUSED'; END IF;
      UPDATE public.governed_sourcing_grants SET state=target,receipt_id=coalesce(p_command->>'receiptId',receipt_id),updated_at=clock_timestamp()
        WHERE tenant_id=p_tenant AND flow_run_id=p_flow AND slot=p_slot RETURNING * INTO g;
    END IF;
  END IF;
  RETURN jsonb_build_object('grantId',g.grant_id,'state',g.state,'expiresAt',g.expires_at);
END $$;
REVOKE ALL ON FUNCTION public.signal_sourcing_grant_transition(text,uuid,text,jsonb) FROM PUBLIC;

-- Distinguish a caught failure before transport invocation from an ambiguous
-- after-dispatch failure. Retain the receipt; never erase purchase evidence.
ALTER TABLE public.crustdata_acquisition_receipts DROP CONSTRAINT IF EXISTS crustdata_acquisition_receipts_status_check;
ALTER TABLE public.crustdata_acquisition_receipts ADD CONSTRAINT crustdata_acquisition_receipts_status_check
  CHECK (status IN ('started','complete','uncertain','released','no_dispatch'));

CREATE FUNCTION public.signal_sourcing_receipt_evidence(p_tenant text,p_request text,p_slot text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('action','receipt','protocolVersion',1,'flowRunId',b.flow_run_id,'artifactHash',b.artifact_hash,
    'discoverRequestId',b.request_id,'executionAttemptId',request.execution_attempt_id,'grantId',g.grant_id,'slot',g.slot,
    'providerInputHash',g.provider_input_sha256,'receiptId',r.id,'state',CASE WHEN r.status='complete' THEN 'complete' WHEN r.status='uncertain' THEN 'uncertain' ELSE 'started' END)
    || CASE WHEN r.status='complete' THEN jsonb_build_object('rawReturnedCount',r.result->'rawReturnedCount','providerTotal',r.result->'providerTotal') ELSE '{}'::jsonb END
  FROM public.governed_sourcing_bindings b JOIN public.governed_sourcing_grants g ON g.tenant_id=b.tenant_id AND g.flow_run_id=b.flow_run_id
    JOIN public.job_sourcing_requests request ON request.id=b.request_id AND request."tenantId"=b.tenant_id
    JOIN public.crustdata_acquisition_receipts r ON r.id=g.receipt_id AND r."tenantId"=b.tenant_id AND r."sourcingRequestId"=b.request_id
      AND r."acquisitionGeneration"=1 AND r.slot=g.slot AND r."requestFingerprint"=g.provider_input_sha256
  WHERE b.tenant_id=p_tenant AND b.request_id=p_request AND g.slot=p_slot AND g.state IN ('started','uncertain')
    AND r.status IN ('started','complete','uncertain')
$$;
REVOKE ALL ON FUNCTION public.signal_sourcing_receipt_evidence(text,text,text) FROM PUBLIC;

-- Persist the actual ordered result identity, not a process-local counter or a
-- timestamp invented by the caller. Same order replays the same revision.
CREATE FUNCTION public.signal_sourcing_delivery(p_tenant text,p_request text,p_execution text,p_ids jsonb,p_reranked_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='5s' AS $$
DECLARE binding public.governed_sourcing_bindings%ROWTYPE; request public.job_sourcing_requests%ROWTYPE;
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
  IF binding.delivery_ids IS DISTINCT FROM p_ids THEN
    UPDATE public.governed_sourcing_bindings SET delivery_ids=p_ids,delivery_revision=delivery_revision+1
      WHERE tenant_id=p_tenant AND flow_run_id=binding.flow_run_id RETURNING * INTO binding;
  END IF;
  RETURN jsonb_build_object('protocolVersion',1,'flowRunId',binding.flow_run_id,'artifactHash',binding.artifact_hash,
    'executionAttemptId',p_execution,'revision',binding.delivery_revision,'orderedSignalIds',p_ids);
END $$;
REVOKE ALL ON FUNCTION public.signal_sourcing_delivery(text,text,text,jsonb,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.signal_sourcing_cancel(p_tenant text,p_request text,p_fence jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='5s' AS $$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; r public.job_sourcing_requests%ROWTYPE; proof jsonb;
BEGIN
  SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND request_id=p_request FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF b.cancellation IS NOT NULL THEN RETURN b.cancellation; END IF;
  IF jsonb_typeof(p_fence) IS DISTINCT FROM 'object' OR p_fence-ARRAY['acquisitionGeneration','executionAttemptId','processingLeaseId']<>'{}'::jsonb
    OR NOT p_fence ?& ARRAY['acquisitionGeneration','executionAttemptId','processingLeaseId'] THEN RAISE EXCEPTION 'GOVERNED_EXECUTION_STALE'; END IF;
  SELECT * INTO r FROM public.job_sourcing_requests WHERE id=p_request AND "tenantId"=p_tenant FOR UPDATE;
  IF r.status<>'processing' OR r.acquisition_generation<>1 OR p_fence->>'acquisitionGeneration' IS DISTINCT FROM '1'
    OR r.execution_attempt_id IS DISTINCT FROM p_fence->>'executionAttemptId' OR r.processing_lease_id IS NULL
    OR r.processing_lease_id IS DISTINCT FROM p_fence->>'processingLeaseId' THEN RAISE EXCEPTION 'GOVERNED_EXECUTION_STALE'; END IF;
  -- Holding binding + request locks serializes with the receipt+grant start
  -- transaction. Only a recorded pre-transport failure permits a refund.
  IF EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts WHERE "tenantId"=p_tenant AND "sourcingRequestId"=p_request AND status<>'no_dispatch')
    OR EXISTS(SELECT 1 FROM public.governed_sourcing_grants g WHERE tenant_id=p_tenant AND flow_run_id=b.flow_run_id AND state IN ('started','uncertain')
      AND (state='uncertain' OR NOT EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts receipt
        WHERE receipt.id=g.receipt_id AND receipt."tenantId"=p_tenant AND receipt."sourcingRequestId"=p_request AND receipt.slot=g.slot AND receipt.status='no_dispatch')))
    THEN RETURN NULL; END IF;
  proof:=jsonb_build_object('action','no_dispatch','protocolVersion',1,'flowRunId',b.flow_run_id,'artifactHash',b.artifact_hash,
    'discoverRequestId',p_request,'executionAttemptId',r.execution_attempt_id,'cancellationId',gen_random_uuid(),'cancelledAt',clock_timestamp());
  UPDATE public.governed_sourcing_grants SET state='no_dispatch',updated_at=clock_timestamp() WHERE tenant_id=p_tenant AND flow_run_id=b.flow_run_id AND state IN ('issued','started');
  UPDATE public.job_sourcing_requests SET status='failed',processing_lease_id=NULL,"completedAt"=clock_timestamp(),callback_status='pending',"resultCount"=0 WHERE id=p_request;
  UPDATE public.governed_sourcing_bindings SET cancellation=proof WHERE tenant_id=p_tenant AND flow_run_id=b.flow_run_id;
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION public.signal_sourcing_cancel(text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_sourcing_cancel_evidence(p_tenant text,p_request text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT cancellation FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND request_id=p_request
$$;
REVOKE ALL ON FUNCTION public.signal_sourcing_cancel_evidence(text,text) FROM PUBLIC;

CREATE FUNCTION public.signal_sourcing_bound_command(p_tenant text,p_request text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT command FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND request_id=p_request
$$;
REVOKE ALL ON FUNCTION public.signal_sourcing_bound_command(text,text) FROM PUBLIC;

-- Admission does not contact Crustdata. API replay only reads this durable
-- identity; the sourcing worker is the sole provider-key holder.
CREATE FUNCTION public.signal_sourcing_preview_admit(p_tenant text,p_job text,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='5s' AS $$
DECLARE p public.governed_sourcing_previews%ROWTYPE; digest text; preview uuid;
BEGIN
  IF nullif(p_tenant,'') IS NULL OR p_job !~ '^vanta:jobs:[1-9][0-9]*$' OR p_job IS NULL
    OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR octet_length(p_command::text)>131072
    OR p_command-ARRAY['protocolVersion','previewId','artifactHash','queryArtifact']<>'{}'::jsonb
    OR NOT p_command ?& ARRAY['protocolVersion','previewId','artifactHash','queryArtifact']
    OR p_command->>'protocolVersion' IS DISTINCT FROM '1'
    OR p_command->>'artifactHash' IS DISTINCT FROM p_command->'queryArtifact'->>'queryHash' THEN RAISE EXCEPTION 'GOVERNED_INVALID_COMMAND'; END IF;
  preview:=(p_command->>'previewId')::uuid;
  digest:=encode(sha256(convert_to(p_command::text,'UTF8')),'hex');
  PERFORM tenant_id FROM public.governed_sourcing_tenants WHERE tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNED_TENANT_REQUIRED'; END IF;
  SELECT * INTO p FROM public.governed_sourcing_previews WHERE tenant_id=p_tenant AND preview_id=preview FOR UPDATE;
  IF FOUND THEN
    IF p.external_job_id<>p_job OR p.request_sha256<>digest OR p.command<>p_command THEN RAISE EXCEPTION 'GOVERNED_REQUEST_CONFLICT'; END IF;
    IF p.state='started' AND p.lease_until<=clock_timestamp() THEN
      UPDATE public.governed_sourcing_previews SET state='unknown',lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=p_tenant AND preview_id=preview RETURNING * INTO p;
    END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.governed_sourcing_tenants WHERE tenant_id=p_tenant AND allow_new) THEN RAISE EXCEPTION 'GOVERNED_DISABLED'; END IF;
    INSERT INTO public.governed_sourcing_previews(tenant_id,preview_id,external_job_id,artifact_hash,request_sha256,command,state)
      VALUES(p_tenant,preview,p_job,p_command->>'artifactHash',digest,p_command,'pending') RETURNING * INTO p;
  END IF;
  RETURN jsonb_build_object('previewId',p.preview_id,'state',CASE WHEN p.state='started' THEN 'pending' ELSE p.state END,
    'count',p.count,'countRelation',p.count_relation,'creditsUsed',p.credits_used);
END $$;
REVOKE ALL ON FUNCTION public.signal_sourcing_preview_admit(text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_sourcing_preview_claim(p_tenant text,p_preview uuid,p_worker uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='5s' AS $$
DECLARE p public.governed_sourcing_previews%ROWTYPE;
BEGIN
  IF p_worker IS NULL THEN RAISE EXCEPTION 'GOVERNED_INVALID_COMMAND'; END IF;
  PERFORM tenant_id FROM public.governed_sourcing_tenants WHERE tenant_id=p_tenant AND allow_new FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNED_DISABLED'; END IF;
  SELECT * INTO p FROM public.governed_sourcing_previews WHERE tenant_id=p_tenant AND preview_id=p_preview FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p.state='started' AND p.lease_until<=clock_timestamp() THEN
    UPDATE public.governed_sourcing_previews SET state='unknown',lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=p_tenant AND preview_id=p_preview;
    RETURN NULL;
  END IF;
  IF p.state<>'pending' THEN RETURN NULL; END IF;
  IF p.created_at<=clock_timestamp()-interval '15 minutes' THEN
    UPDATE public.governed_sourcing_previews SET state='unavailable',updated_at=clock_timestamp() WHERE tenant_id=p_tenant AND preview_id=p_preview;
    RETURN NULL;
  END IF;
  -- Started is committed before the HTTP call. No expiry path returns it to
  -- pending, including a crash between this commit and opening the socket.
  UPDATE public.governed_sourcing_previews SET state='started',lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND preview_id=p_preview RETURNING * INTO p;
  RETURN jsonb_build_object('previewId',p.preview_id,'lease',p.lease_id,'command',p.command);
END $$;
REVOKE ALL ON FUNCTION public.signal_sourcing_preview_claim(text,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.signal_sourcing_preview_finish(p_tenant text,p_preview uuid,p_lease uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='5s' AS $$
DECLARE p public.governed_sourcing_previews%ROWTYPE; target text;
BEGIN
  IF p_lease IS NULL OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
    OR p_result-ARRAY['state','count','countRelation','creditsUsed']<>'{}'::jsonb
    OR p_result->>'state' IS NULL OR p_result->>'state' NOT IN ('complete','unknown','unavailable') THEN RAISE EXCEPTION 'GOVERNED_INVALID_COMMAND'; END IF;
  SELECT * INTO p FROM public.governed_sourcing_previews WHERE tenant_id=p_tenant AND preview_id=p_preview FOR UPDATE;
  IF NOT FOUND OR p.state<>'started' OR p.lease_id IS DISTINCT FROM p_lease OR p.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'GOVERNED_LEASE_STALE'; END IF;
  target:=p_result->>'state';
  IF target='complete' AND (NOT p_result ?& ARRAY['count','countRelation','creditsUsed']
    OR p_result->>'count' IS NULL OR p_result->>'count' !~ '^[0-9]+$'
    OR p_result->>'countRelation' IS NULL OR p_result->>'countRelation' NOT IN ('eq','gte','approximate')
    OR p_result->>'creditsUsed' IS NULL OR (p_result->>'creditsUsed')::numeric NOT BETWEEN 0 AND 0.03) THEN RAISE EXCEPTION 'GOVERNED_INVALID_RECEIPT'; END IF;
  IF target<>'complete' AND p_result-ARRAY['state']<>'{}'::jsonb THEN RAISE EXCEPTION 'GOVERNED_INVALID_RECEIPT'; END IF;
  UPDATE public.governed_sourcing_previews SET state=target,
    count=CASE WHEN target='complete' THEN (p_result->>'count')::bigint END,
    count_relation=CASE WHEN target='complete' THEN p_result->>'countRelation' END,
    credits_used=CASE WHEN target='complete' THEN (p_result->>'creditsUsed')::numeric END,
    lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND preview_id=p_preview RETURNING * INTO p;
  RETURN jsonb_build_object('previewId',p.preview_id,'state',p.state,'count',p.count,'countRelation',p.count_relation,'creditsUsed',p.credits_used);
END $$;
REVOKE ALL ON FUNCTION public.signal_sourcing_preview_finish(text,uuid,uuid,jsonb) FROM PUBLIC;
