SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='30s';

ALTER TABLE public.crustdata_acquisition_receipts
 ADD COLUMN memory_delivery_contract integer NOT NULL DEFAULT 1 CHECK(memory_delivery_contract IN(1,2)),
 ADD COLUMN memory_prepared_at timestamptz,
 ADD COLUMN memory_manifest_sha256 text,
 ADD COLUMN memory_member_count integer,
 ADD COLUMN memory_wait_until timestamptz,
 ADD CONSTRAINT memory_preparation_shape CHECK (
  (memory_prepared_at IS NULL AND memory_manifest_sha256 IS NULL AND memory_member_count IS NULL AND memory_wait_until IS NULL)
  OR (memory_delivery_contract=2 AND memory_prepared_at IS NOT NULL AND memory_manifest_sha256 ~ '^[0-9a-f]{64}$'
   AND memory_member_count BETWEEN 0 AND 300 AND memory_wait_until IS NOT NULL)),
 ADD CONSTRAINT memory_acquisition_owner_key UNIQUE(id,"tenantId","sourcingRequestId","acquisitionGeneration",slot);

CREATE TABLE public.public_memory_ingest_requests (
 id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{64}$'),
 tenant_id text NOT NULL,
 request_id text NOT NULL,
 acquisition_id text NOT NULL,
 generation integer NOT NULL,
 slot text NOT NULL CHECK(slot IN('exact','spill')),
 provider_id text NOT NULL CHECK(provider_id ~ '^[1-9][0-9]{0,18}$'),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
 request_body text,
 wire_sha256 text NOT NULL CHECK(wire_sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','leased','retry_wait','succeeded','suppressed','blocked')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_token uuid,
 lease_until timestamptz,
 result jsonb,
 failure_code text,
 acknowledged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 compacted_at timestamptz,
 CONSTRAINT memory_packet_owner_fk FOREIGN KEY(acquisition_id,tenant_id,request_id,generation,slot)
  REFERENCES public.crustdata_acquisition_receipts(id,"tenantId","sourcingRequestId","acquisitionGeneration",slot)
  ON UPDATE NO ACTION ON DELETE RESTRICT,
 CONSTRAINT memory_packet_member_key UNIQUE(acquisition_id,provider_id),
 CONSTRAINT memory_packet_body_check CHECK(request_body IS NULL OR
  (octet_length(request_body)<=262144 AND encode(sha256(convert_to(request_body,'UTF8')),'hex')=wire_sha256
   AND request_body::jsonb->>'idempotency_key'=id
   AND request_body::jsonb->>'provider_record_id'=provider_id
   AND request_body::jsonb->>'acquisition_receipt_id'=acquisition_id
   AND request_body::jsonb->>'acquisition_generation'=generation::text
   AND request_body::jsonb->>'acquisition_slot'=slot)),
 CONSTRAINT memory_packet_absence_check CHECK(request_body IS NOT NULL OR state='suppressed' OR compacted_at IS NOT NULL)
);
CREATE INDEX memory_packet_work_idx ON public.public_memory_ingest_requests(state,next_attempt_at,lease_until);
REVOKE ALL ON public.public_memory_ingest_requests FROM PUBLIC;
ALTER TABLE public.public_memory_ingest_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_memory_ingest_requests FORCE ROW LEVEL SECURITY;
DO $$ DECLARE owner_name text; BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid='public.job_sourcing_requests'::regclass;
 EXECUTE format('ALTER TABLE public.public_memory_ingest_requests OWNER TO %I',owner_name);
 EXECUTE format('CREATE POLICY memory_packet_owner ON public.public_memory_ingest_requests TO %I USING(true) WITH CHECK(true)',owner_name);
END $$;

CREATE FUNCTION public.signal_memory_packet_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MEMORY_PACKET_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','attempts','next_attempt_at','lease_token','lease_until','result','failure_code','acknowledged_at','compacted_at','request_body'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','attempts','next_attempt_at','lease_token','lease_until','result','failure_code','acknowledged_at','compacted_at','request_body'])
  OR (NEW.request_body IS DISTINCT FROM OLD.request_body AND NOT (
   NEW.request_body IS NULL AND ((NEW.state='suppressed' AND NEW.failure_code='privacy_restricted') OR (NEW.compacted_at IS NOT NULL AND OLD.state IN('succeeded','suppressed')
   AND EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts a JOIN public.job_sourcing_requests j ON j.id=a."sourcingRequestId"
    WHERE a.id=OLD.acquisition_id AND a.memory_ingested_at IS NOT NULL AND j.status='complete' AND j.callback_status='delivered'
      AND OLD.acknowledged_at<clock_timestamp()-interval '24 hours')))))
  OR (OLD.state IN('succeeded','suppressed','blocked') AND NEW.state IS DISTINCT FROM OLD.state AND NEW.state<>'suppressed') THEN
  RAISE EXCEPTION 'MEMORY_PACKET_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.signal_memory_packet_guard() FROM PUBLIC;
CREATE TRIGGER memory_packet_guard BEFORE UPDATE OR DELETE ON public.public_memory_ingest_requests
 FOR EACH ROW EXECUTE FUNCTION public.signal_memory_packet_guard();

CREATE FUNCTION public.signal_memory_acquisition_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.memory_delivery_contract IS DISTINCT FROM OLD.memory_delivery_contract
  OR (OLD.memory_prepared_at IS NOT NULL AND
    (NEW.memory_prepared_at,NEW.memory_manifest_sha256,NEW.memory_member_count,NEW.memory_wait_until)
    IS DISTINCT FROM (OLD.memory_prepared_at,OLD.memory_manifest_sha256,OLD.memory_member_count,OLD.memory_wait_until)) THEN
  RAISE EXCEPTION 'MEMORY_PREPARATION_IMMUTABLE'; END IF;
 IF NEW.memory_delivery_contract=2 AND NEW.memory_ingested_at IS NOT NULL AND OLD.memory_ingested_at IS NULL THEN
  IF NEW.memory_prepared_at IS NULL OR
    (SELECT count(*) FROM public.public_memory_ingest_requests p WHERE p.acquisition_id=NEW.id)<>NEW.memory_member_count
    OR EXISTS(SELECT 1 FROM public.public_memory_ingest_requests p WHERE p.acquisition_id=NEW.id AND p.state NOT IN('succeeded','suppressed')) THEN
   RAISE EXCEPTION 'MEMORY_ACKS_REQUIRED'; END IF;
 END IF;
 IF NEW.memory_delivery_contract=2 AND OLD.result IS NOT NULL AND NEW.result IS NULL AND NEW.memory_ingested_at IS NULL THEN
  RAISE EXCEPTION 'MEMORY_UNRESOLVED_PURCHASE_RETAINED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.signal_memory_acquisition_guard() FROM PUBLIC;
CREATE TRIGGER memory_acquisition_guard BEFORE UPDATE ON public.crustdata_acquisition_receipts
 FOR EACH ROW EXECUTE FUNCTION public.signal_memory_acquisition_guard();

-- A single restricted entry point: all lookups bind the complete purchase tuple.
CREATE FUNCTION public.signal_memory_ingest(p_owner jsonb,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET lock_timeout='1500ms' SET statement_timeout='5s' AS $$
DECLARE a public.crustdata_acquisition_receipts%ROWTYPE; j public.job_sourcing_requests%ROWTYPE;
 p public.public_memory_ingest_requests%ROWTYPE; item jsonb; body jsonb; meta jsonb; response jsonb;
 action text:=p_command->>'action'; ident text; token uuid; n integer; manifest text;
BEGIN
 IF jsonb_typeof(p_owner) IS DISTINCT FROM 'object' OR p_owner-ARRAY['tenantId','sourcingRequestId','acquisitionReceiptId','acquisitionGeneration','acquisitionSlot']<>'{}'::jsonb
  OR NOT p_owner ?& ARRAY['tenantId','sourcingRequestId','acquisitionReceiptId','acquisitionGeneration','acquisitionSlot']
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'MEMORY_COMMAND_INVALID'; END IF;
 SELECT * INTO a FROM public.crustdata_acquisition_receipts WHERE id=p_owner->>'acquisitionReceiptId'
  AND "tenantId"=p_owner->>'tenantId' AND "sourcingRequestId"=p_owner->>'sourcingRequestId'
  AND "acquisitionGeneration"::text=p_owner->>'acquisitionGeneration' AND slot=p_owner->>'acquisitionSlot' FOR UPDATE;
 IF NOT FOUND OR a.memory_delivery_contract<>2 THEN RAISE EXCEPTION 'MEMORY_ACQUISITION_REFUSED'; END IF;
 SELECT * INTO STRICT j FROM public.job_sourcing_requests WHERE id=a."sourcingRequestId" AND "tenantId"=a."tenantId";
 IF action IN('append','seal') THEN
  IF j.status<>'processing' OR j.protocol_version<>2 OR j.execution_attempt_id IS DISTINCT FROM p_command->>'executionAttemptId'
   OR j.processing_lease_id IS NULL OR j.processing_lease_id IS DISTINCT FROM p_command->>'processingLeaseId'
   OR a.status<>'complete' THEN RAISE EXCEPTION 'MEMORY_EXECUTION_STALE'; END IF;
 END IF;
 IF action='append' THEN
  IF a.memory_prepared_at IS NOT NULL THEN RETURN jsonb_build_object('sealed',true); END IF;
  IF jsonb_typeof(p_command->'packets') IS DISTINCT FROM 'array' OR jsonb_array_length(p_command->'packets')>25
   OR octet_length(p_command::text)>7000000 THEN RAISE EXCEPTION 'MEMORY_PACKET_INVALID'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_command->'packets') LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item->>'tenantId' IS DISTINCT FROM a."tenantId"
    OR item->>'sourcingRequestId' IS DISTINCT FROM a."sourcingRequestId" OR item->>'acquisitionReceiptId' IS DISTINCT FROM a.id
    OR item->>'acquisitionGeneration' IS DISTINCT FROM a."acquisitionGeneration"::text OR item->>'acquisitionSlot' IS DISTINCT FROM a.slot
    OR item->>'version' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'MEMORY_PACKET_INVALID'; END IF;
   IF item-ARRAY['tenantId','sourcingRequestId','acquisitionReceiptId','acquisitionGeneration','acquisitionSlot','version',
      'signalCandidateId','providerRecordId','linkedinUrl','expectedGlobalCandidateId','idempotencyKey','requestBody','wireSha256','initialSuppressed']<>'{}'::jsonb
    OR jsonb_typeof(item->'requestBody') IS DISTINCT FROM 'string'
    OR octet_length(item->>'requestBody')>262144
    OR coalesce(item->>'wireSha256','')<>encode(sha256(convert_to(item->>'requestBody','UTF8')),'hex')
    OR coalesce(item->>'signalCandidateId','')='' OR length(item->>'signalCandidateId')>2048
    OR coalesce(item->>'linkedinUrl','')=''
    OR (item ? 'initialSuppressed' AND jsonb_typeof(item->'initialSuppressed') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'MEMORY_PACKET_INVALID'; END IF;
   body:=(item->>'requestBody')::jsonb;
   IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR body->>'schema_version' IS DISTINCT FROM '1'
    OR body->>'provider_namespace' IS DISTINCT FROM 'crustdata' OR body->>'record_type' IS DISTINCT FROM 'person'
    OR body->>'adapter_version' IS DISTINCT FROM 'crustdata_person_v1'
    OR body->>'provider_record_id' IS DISTINCT FROM item->>'providerRecordId'
    OR body->>'linkedin_url' IS DISTINCT FROM item->>'linkedinUrl'
    OR body->>'expected_global_candidate_id' IS DISTINCT FROM item->>'expectedGlobalCandidateId'
    OR body->>'acquisition_receipt_id' IS DISTINCT FROM a.id
    OR body->>'acquisition_generation' IS DISTINCT FROM a."acquisitionGeneration"::text
    OR body->>'acquisition_slot' IS DISTINCT FROM a.slot
    OR jsonb_typeof(body->'normalized_profile') IS DISTINCT FROM 'object'
    OR (body ? 'expected_global_candidate_id' AND jsonb_typeof(body->'expected_global_candidate_id') IS DISTINCT FROM 'string')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.result->'profiles') x WHERE x->>'crustdata_person_id'=item->>'providerRecordId') THEN
    RAISE EXCEPTION 'MEMORY_PACKET_INVALID'; END IF;
   ident:=encode(sha256(decode('76310063727573746461746100706572736f6e00','hex')||convert_to(item->>'providerRecordId','UTF8')||decode('00','hex')||
    convert_to(a.id,'UTF8')||decode('00','hex')||convert_to(a."acquisitionGeneration"::text,'UTF8')||decode('00','hex')||convert_to(a.slot,'UTF8')),'hex');
   IF item->>'idempotencyKey' IS DISTINCT FROM ident OR body->>'idempotency_key' IS DISTINCT FROM ident THEN RAISE EXCEPTION 'MEMORY_PACKET_INVALID'; END IF;
   meta:=item-ARRAY['requestBody','wireSha256','initialSuppressed'];
   INSERT INTO public.public_memory_ingest_requests(id,tenant_id,request_id,acquisition_id,generation,slot,provider_id,metadata,request_body,wire_sha256,state,failure_code,acknowledged_at)
    VALUES(ident,a."tenantId",a."sourcingRequestId",a.id,a."acquisitionGeneration",a.slot,item->>'providerRecordId',meta,
     CASE WHEN item->>'initialSuppressed'='true' THEN NULL ELSE item->>'requestBody' END,item->>'wireSha256',
     CASE WHEN item->>'initialSuppressed'='true' THEN 'suppressed' ELSE 'pending' END,
     CASE WHEN item->>'initialSuppressed'='true' THEN 'privacy_restricted' ELSE NULL END,
     CASE WHEN item->>'initialSuppressed'='true' THEN clock_timestamp() ELSE NULL END)
    ON CONFLICT(id) DO NOTHING;
   SELECT * INTO STRICT p FROM public.public_memory_ingest_requests WHERE id=ident;
   IF p.metadata IS DISTINCT FROM meta OR (p.state<>'suppressed' AND p.request_body IS DISTINCT FROM item->>'requestBody') OR p.wire_sha256 IS DISTINCT FROM item->>'wireSha256' THEN
    RAISE EXCEPTION 'MEMORY_PACKET_CONFLICT'; END IF;
  END LOOP;
  RETURN jsonb_build_object('sealed',false);
 ELSIF action='seal' THEN
  IF a.memory_prepared_at IS NULL THEN
   SELECT count(*) INTO n FROM public.public_memory_ingest_requests WHERE acquisition_id=a.id;
   IF n>300 OR n<>(SELECT count(DISTINCT x->>'crustdata_person_id') FROM jsonb_array_elements(a.result->'profiles') x) THEN
    RAISE EXCEPTION 'MEMORY_MEMBERS_INCOMPLETE'; END IF;
   -- Manifest is a wire-independent commitment over fixed member tuples.
   SELECT encode(sha256(convert_to(coalesce(string_agg(id||':'||wire_sha256,E'\n' ORDER BY provider_id COLLATE "C"),''),'UTF8')),'hex')
    INTO manifest FROM public.public_memory_ingest_requests WHERE acquisition_id=a.id;
   UPDATE public.crustdata_acquisition_receipts SET memory_prepared_at=clock_timestamp(),memory_member_count=n,
    memory_manifest_sha256=manifest,memory_wait_until=clock_timestamp()+interval '150 seconds' WHERE id=a.id;
  END IF;
  RETURN public.signal_memory_ingest(p_owner,jsonb_build_object('action','read'));
 ELSIF action='anchors' THEN
  RETURN coalesce((SELECT jsonb_agg(metadata||jsonb_build_object('id',id,'state',state,'resolvedId',result->>'globalCandidateId'))
    FROM public.public_memory_ingest_requests WHERE acquisition_id=a.id),'[]'::jsonb);
 ELSIF action='suppress_member' THEN
  UPDATE public.public_memory_ingest_requests SET state='suppressed',request_body=NULL,result=NULL,
   failure_code='privacy_restricted',acknowledged_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
   WHERE acquisition_id=a.id AND id=p_command->>'id' AND state<>'suppressed';
  RETURN 'true'::jsonb;
 ELSIF action='read' THEN
  RETURN jsonb_build_object('sealed',a.memory_prepared_at IS NOT NULL,'deadlineAt',a.memory_wait_until,
   'memberCount',a.memory_member_count,'manifestSha256',a.memory_manifest_sha256,
   'members',coalesce((SELECT jsonb_agg(jsonb_build_object('packet',metadata||jsonb_build_object('requestBody',request_body,'wireSha256',wire_sha256),
    'state',state,'result',result,'leaseToken',lease_token,'id',id) ORDER BY provider_id COLLATE "C")
    FROM public.public_memory_ingest_requests WHERE acquisition_id=a.id),'[]'::jsonb));
 ELSIF action='claim' THEN
  IF a.memory_prepared_at IS NULL OR a.status<>'complete' OR j.status NOT IN('processing','stalled') THEN RETURN '[]'::jsonb; END IF;
  n:=(p_command->>'limit')::integer;
  IF n IS NULL OR n NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'MEMORY_COMMAND_INVALID'; END IF;
  UPDATE public.public_memory_ingest_requests SET state='blocked',failure_code='attempts_exhausted',lease_token=NULL,lease_until=NULL
   WHERE acquisition_id=a.id AND state='leased' AND lease_until<=clock_timestamp() AND attempts>=8;
  WITH selected AS (SELECT id FROM public.public_memory_ingest_requests WHERE acquisition_id=a.id AND request_body IS NOT NULL
   AND attempts<8 AND ((state IN('pending','retry_wait') AND next_attempt_at<=clock_timestamp()) OR (state='leased' AND lease_until<=clock_timestamp()))
   ORDER BY next_attempt_at,id LIMIT n FOR UPDATE SKIP LOCKED), updated AS (
   UPDATE public.public_memory_ingest_requests r SET state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds'
   FROM selected s WHERE r.id=s.id RETURNING r.*)
   SELECT coalesce(jsonb_agg(jsonb_build_object('packet',metadata||jsonb_build_object('requestBody',request_body,'wireSha256',wire_sha256),
    'leaseToken',lease_token,'id',id)),'[]'::jsonb) INTO response FROM updated;
  RETURN response;
 ELSIF action IN('ack','fail','suppress') THEN
  SELECT * INTO p FROM public.public_memory_ingest_requests WHERE id=p_command->>'id' AND acquisition_id=a.id FOR UPDATE;
  IF NOT FOUND OR p.state<>'leased' OR p.lease_token IS DISTINCT FROM (p_command->>'leaseToken')::uuid OR p.lease_until<=clock_timestamp() THEN RETURN 'false'::jsonb; END IF;
  IF action='ack' THEN
   response:=p_command->'result';
   IF response->>'success' IS DISTINCT FROM 'true' OR coalesce(response->>'deliveryStatus','') NOT IN('recorded','replayed')
    OR response->>'signalCandidateId' IS DISTINCT FROM p.metadata->>'signalCandidateId'
    OR response->>'ingestReceiptId' IS DISTINCT FROM p.id OR response->>'sourceRecordId' IS DISTINCT FROM p.id
    OR coalesce(response->>'sourceObservationId','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    OR coalesce(response->>'resolutionStatus','') NOT IN('created','refreshed','matched','stale','conflict_review_required') THEN RAISE EXCEPTION 'MEMORY_ACK_INVALID'; END IF;
   IF response->>'resolutionStatus'='conflict_review_required' THEN
    IF response->'globalCandidateId' IS DISTINCT FROM 'null'::jsonb OR response->'sourceIdentityId' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'MEMORY_ACK_INVALID'; END IF;
   ELSE
    IF coalesce(response->>'globalCandidateId','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     OR coalesce(response->>'sourceIdentityId','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     OR (p.metadata->>'expectedGlobalCandidateId' IS NOT NULL AND p.metadata->>'expectedGlobalCandidateId' IS DISTINCT FROM response->>'globalCandidateId') THEN RAISE EXCEPTION 'MEMORY_ACK_INVALID'; END IF;
   END IF;
   UPDATE public.public_memory_ingest_requests SET state='succeeded',result=response,acknowledged_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=p.id;
  ELSIF action='suppress' THEN
   UPDATE public.public_memory_ingest_requests SET state='suppressed',request_body=NULL,result=NULL,failure_code='privacy_restricted',acknowledged_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=p.id;
  ELSE
   IF coalesce(p_command->>'code','') NOT IN('transport','timeout','privacy_unavailable','packet_integrity','invalid_contract','identity_mismatch','idempotency_conflict','auth_configuration','http_retryable','http_terminal','unexpected') THEN
    RAISE EXCEPTION 'MEMORY_FAILURE_INVALID'; END IF;
   UPDATE public.public_memory_ingest_requests SET state=CASE WHEN p.attempts>=8 OR coalesce((p_command->>'terminal')::boolean,false) THEN 'blocked' ELSE 'retry_wait' END,
    failure_code=p_command->>'code',lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '10 seconds' WHERE id=p.id;
  END IF;
  RETURN 'true'::jsonb;
 ELSIF action='complete' THEN
  IF a.memory_prepared_at IS NULL OR EXISTS(SELECT 1 FROM public.public_memory_ingest_requests WHERE acquisition_id=a.id AND state NOT IN('succeeded','suppressed')) THEN RETURN 'false'::jsonb; END IF;
  UPDATE public.crustdata_acquisition_receipts SET memory_ingested_at=coalesce(memory_ingested_at,clock_timestamp()),
   memory_ingest_metadata=jsonb_build_object('version',2,'memberCount',a.memory_member_count,'manifestSha256',a.memory_manifest_sha256)
   WHERE id=a.id;
  RETURN 'true'::jsonb;
 ELSIF action='compact' THEN
  IF a.memory_ingested_at IS NULL OR j.status<>'complete' OR j.callback_status<>'delivered' THEN RETURN 'false'::jsonb; END IF;
  UPDATE public.public_memory_ingest_requests SET request_body=NULL,compacted_at=clock_timestamp()
   WHERE acquisition_id=a.id AND state IN('succeeded','suppressed') AND compacted_at IS NULL
    AND acknowledged_at<clock_timestamp()-interval '24 hours';
  IF NOT EXISTS(SELECT 1 FROM public.public_memory_ingest_requests WHERE acquisition_id=a.id AND compacted_at IS NULL) THEN
   UPDATE public.crustdata_acquisition_receipts SET memory_ingest_metadata=coalesce(memory_ingest_metadata,'{}'::jsonb)||jsonb_build_object('compactedAt',clock_timestamp()) WHERE id=a.id;
  END IF;
  RETURN 'true'::jsonb;
 ELSE RAISE EXCEPTION 'MEMORY_COMMAND_INVALID'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.signal_memory_ingest(jsonb,jsonb) FROM PUBLIC;

-- Public-provider IDs only, for the existing market delivery-lag exclusion.
-- No packet/profile/tenant identity is exposed by this read surface.
CREATE FUNCTION public.signal_memory_ingest_lag_ids(p_markets text[],p_since timestamptz,p_limit integer)
RETURNS TABLE(pid text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET statement_timeout='5s' AS $$
BEGIN
 IF p_markets IS NULL OR cardinality(p_markets)>100 OR p_since IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50000 THEN
  RAISE EXCEPTION 'MEMORY_COMMAND_INVALID'; END IF;
 RETURN QUERY SELECT DISTINCT r.provider_id FROM public.public_memory_ingest_requests r
  WHERE r.state IN('pending','leased','retry_wait','succeeded') AND r.request_body IS NOT NULL
   AND r.created_at>p_since
   AND r.request_body::jsonb->'public_market'->>'coarse_market_key'=ANY(p_markets)
  ORDER BY r.provider_id LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION public.signal_memory_ingest_lag_ids(text[],timestamptz,integer) FROM PUBLIC;

CREATE FUNCTION public.signal_memory_ingest_work(p_tenant text,p_request text,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='5s' AS $$
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'MEMORY_COMMAND_INVALID'; END IF;
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(work)) FROM (
  SELECT a."tenantId" AS "tenantId",a."sourcingRequestId" AS "sourcingRequestId",a.id AS "acquisitionReceiptId",
   a."acquisitionGeneration" AS "acquisitionGeneration",a.slot AS "acquisitionSlot"
  FROM public.crustdata_acquisition_receipts a JOIN public.job_sourcing_requests j ON j.id=a."sourcingRequestId" AND j."tenantId"=a."tenantId"
  WHERE a.memory_delivery_contract=2 AND a.status='complete' AND a.memory_prepared_at IS NOT NULL AND a.memory_ingested_at IS NULL
   AND j.status IN('processing','stalled') AND (p_tenant IS NULL OR a."tenantId"=p_tenant) AND (p_request IS NULL OR a."sourcingRequestId"=p_request)
   AND (EXISTS(SELECT 1 FROM public.public_memory_ingest_requests r WHERE r.acquisition_id=a.id AND
      ((r.state IN('pending','retry_wait') AND r.next_attempt_at<=clock_timestamp()) OR (r.state='leased' AND r.lease_until<=clock_timestamp())))
    OR NOT EXISTS(SELECT 1 FROM public.public_memory_ingest_requests r WHERE r.acquisition_id=a.id AND r.state NOT IN('succeeded','suppressed')))
  ORDER BY a."startedAt" LIMIT p_limit
 ) work),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.signal_memory_ingest_work(text,text,integer) FROM PUBLIC;

-- The existing person-wide queue cannot be a second route for contract 2.
CREATE FUNCTION public.signal_memory_legacy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts WHERE id=NEW.payload->'options'->>'acquisitionReceiptId'
  AND memory_delivery_contract=2) THEN RAISE EXCEPTION 'MEMORY_IMMUTABLE_ROUTE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.signal_memory_legacy_guard() FROM PUBLIC;
CREATE TRIGGER memory_legacy_guard BEFORE INSERT OR UPDATE OF payload ON public.public_memory_ingest_outbox
 FOR EACH ROW EXECUTE FUNCTION public.signal_memory_legacy_guard();

-- Neutralise pre-existing default grants before any service is restarted.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='signal_runtime') THEN
 REVOKE ALL ON public.public_memory_ingest_requests FROM signal_runtime;
 REVOKE ALL ON FUNCTION public.signal_memory_ingest(jsonb,jsonb),public.signal_memory_packet_guard(),
  public.signal_memory_acquisition_guard(),public.signal_memory_legacy_guard(),
  public.signal_memory_ingest_lag_ids(text[],timestamptz,integer),public.signal_memory_ingest_work(text,text,integer) FROM signal_runtime;
END IF; END $$;
