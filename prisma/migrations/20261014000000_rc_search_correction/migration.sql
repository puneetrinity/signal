-- Direct-fetch protocol and compact reads. No account-admission subsystem.
-- Existing rows remain protocol1; only new caller commands explicitly select2.
ALTER TABLE public.rc_sourcing_runs ADD COLUMN protocol_mode smallint NOT NULL DEFAULT 1 CHECK(protocol_mode IN (1,2));
-- Immutable once selected by the fenced worker, before Memory or purchases.
ALTER TABLE public.job_sourcing_requests ADD COLUMN rc_retrieval_config jsonb;

ALTER TABLE public.rc_lookup_attempts
 ADD COLUMN rejection_proof jsonb,
 ADD COLUMN retry_after_at timestamptz,
 DROP CONSTRAINT rc_lookup_attempts_check,
 DROP CONSTRAINT rc_lookup_attempts_state_check,
 ADD CONSTRAINT rc_lookup_attempts_ordinal_check CHECK((operation='CHECK' AND ordinal BETWEEN 1 AND 2) OR (operation='FETCH' AND ordinal BETWEEN 1 AND 3)),
 ADD CONSTRAINT rc_lookup_attempts_state_check CHECK(state IN ('reserved','dispatched','success','no_data','no_dispatch','uncertain','failed','rejected_free')),
 ADD CONSTRAINT rc_rejection_shape CHECK(((state='rejected_free' AND rejection_proof IS NOT NULL AND retry_after_at IS NOT NULL)
  OR (state<>'rejected_free' AND rejection_proof IS NULL AND retry_after_at IS NULL))
  AND (rejection_proof IS NULL OR (jsonb_typeof(rejection_proof)='object' AND octet_length(rejection_proof::text)<=2048 AND dispatch_at IS NOT NULL)));
CREATE UNIQUE INDEX rc_one_unexonerated_fetch ON public.rc_lookup_attempts(run_id,identity_hash)
 WHERE operation='FETCH' AND dispatch_at IS NOT NULL AND state<>'rejected_free';

CREATE FUNCTION public.signal_rc_free_rejection_valid(proof jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $free_proof$
BEGIN
 IF jsonb_typeof(proof) IS DISTINCT FROM 'object' OR octet_length(proof::text)>2048
  OR proof-ARRAY['version','kind','httpStatus','providerCode','creditsConsumed','requestIdHash','retryAfterAt','policyVersion']<>'{}'::jsonb
  OR NOT proof ?& ARRAY['version','kind','httpStatus','providerCode','creditsConsumed','requestIdHash','retryAfterAt','policyVersion']
  OR proof->'version' IS DISTINCT FROM '1'::jsonb OR proof->>'kind' IS DISTINCT FROM 'rc_429_uncharged'
  OR proof->'httpStatus' IS DISTINCT FROM '429'::jsonb OR proof->'creditsConsumed' IS DISTINCT FROM '0'::jsonb
  OR proof->>'version'<>'1' OR proof->>'httpStatus'<>'429' OR proof->>'creditsConsumed'<>'0'
  OR jsonb_typeof(proof->'providerCode') IS DISTINCT FROM 'string' OR length(proof->>'providerCode') NOT BETWEEN 1 AND 80
  OR jsonb_typeof(proof->'policyVersion') IS DISTINCT FROM 'string' OR length(proof->>'policyVersion') NOT BETWEEN 1 AND 80
  OR jsonb_typeof(proof->'requestIdHash') IS DISTINCT FROM 'string' OR coalesce(proof->>'requestIdHash','') !~ '^[a-f0-9]{64}$'
  OR jsonb_typeof(proof->'retryAfterAt') IS DISTINCT FROM 'string'
  OR coalesce(proof->>'retryAfterAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
  OR NOT pg_input_is_valid(proof->>'retryAfterAt','timestamp with time zone') THEN RETURN false; END IF;
 -- EMPTY_REVIEWED_429_POLICY: no production endpoint/code has been approved.
 -- Only a reviewed forward change can enable a policy; no runtime toggle.
 RETURN false;
END $free_proof$;
REVOKE ALL ON FUNCTION public.signal_rc_free_rejection_valid(jsonb) FROM PUBLIC;
DO $free_acl$ DECLARE gr record; BEGIN
 FOR gr IN SELECT DISTINCT r.rolname FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a JOIN pg_roles r ON r.oid=a.grantee
  WHERE p.oid='public.signal_rc_free_rejection_valid(jsonb)'::regprocedure AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.signal_rc_free_rejection_valid(jsonb) FROM %I',gr.rolname); END LOOP;
END $free_acl$;

CREATE OR REPLACE FUNCTION public.signal_rc_admit(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='5s' AS $rc_admit$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; request public.job_sourcing_requests%ROWTYPE;
 run public.rc_sourcing_runs%ROWTYPE; policy public.rc_rate_policies%ROWTYPE;
 available boolean:=false; selected_policy uuid;
BEGIN
 IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR p_command-ARRAY['version','requestId','generation','contractHash','executionAttemptId','processingLeaseId','purchaseSlot','protocolMode']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['version','requestId','generation','contractHash','executionAttemptId','processingLeaseId']
  OR (p_command ? 'purchaseSlot' AND coalesce(p_command->>'purchaseSlot','') NOT IN ('exact','spill'))
  OR (p_command ? 'protocolMode' AND p_command->'protocolMode' NOT IN ('1'::jsonb,'2'::jsonb))
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
  execution_attempt_id,processing_lease_id,rc_available,protocol_mode)
  VALUES(gen_random_uuid(),p_tenant,p_flow,b.request_id,request.acquisition_generation,policy.id,
   p_command->>'contractHash','admitted',request.execution_attempt_id,request.processing_lease_id,
   available,coalesce((p_command->>'protocolMode')::smallint,1)) RETURNING * INTO run;
 IF NOT available THEN
  INSERT INTO public.rc_operations_events(id,run_id,kind,episode,safe_code)
   VALUES(gen_random_uuid(),run.id,'rate_unavailable',1,'RC_ACCOUNT_UNAVAILABLE');
 END IF;
 RETURN jsonb_build_object('version',1,'enabled',true,'runId',run.id,'rcAvailable',available);
END $rc_admit$;
REVOKE ALL ON FUNCTION public.signal_rc_admit(text,uuid,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.signal_rc_claim(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
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
  ELSIF run.protocol_mode=2 AND attempt.operation='FETCH' AND attempt.state='rejected_free' AND attempt.ordinal<3
   AND public.signal_rc_free_rejection_valid(attempt.rejection_proof) IS TRUE
   AND NOT EXISTS(SELECT 1 FROM public.rc_lookup_attempts a WHERE a.run_id=run.id AND a.identity_hash=member.identity_hash
    AND a.operation='FETCH' AND (a.state<>'rejected_free' OR public.signal_rc_free_rejection_valid(a.rejection_proof) IS NOT TRUE))
   THEN next_ordinal:=attempt.ordinal+1;
  ELSE
   RETURN jsonb_build_object('version',1,'state','existing','attemptId',attempt.id,'attemptState',attempt.state);
  END IF;
 END IF;
 IF run.protocol_mode=2 AND p_command->>'operation'<>'FETCH' THEN RAISE EXCEPTION 'RC_OPERATION_REFUSED'; END IF;
 IF run.protocol_mode=1 AND p_command->>'operation'='FETCH' THEN
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

CREATE OR REPLACE FUNCTION public.signal_rc_dispatch(p_tenant text,p_flow uuid,p_attempt uuid,p_command jsonb) RETURNS jsonb
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
 IF attempt.operation='FETCH' AND attempt.ordinal>1 THEN
  IF run.protocol_mode<>2 OR EXISTS(SELECT 1 FROM public.rc_lookup_attempts a WHERE a.run_id=run.id AND a.identity_hash=attempt.identity_hash
   AND a.operation='FETCH' AND a.ordinal<attempt.ordinal AND (a.state<>'rejected_free' OR public.signal_rc_free_rejection_valid(a.rejection_proof) IS NOT TRUE))
   OR (SELECT count(*) FROM public.rc_lookup_attempts a WHERE a.run_id=run.id AND a.identity_hash=attempt.identity_hash
    AND a.operation='FETCH' AND a.ordinal<attempt.ordinal)<>attempt.ordinal-1 THEN RAISE EXCEPTION 'RC_RETRY_REFUSED'; END IF;
  SELECT max(retry_after_at) INTO next_at FROM public.rc_lookup_attempts WHERE run_id=run.id AND identity_hash=attempt.identity_hash AND ordinal<attempt.ordinal AND operation='FETCH';
  IF next_at>at_time THEN RETURN jsonb_build_object('version',1,'state','wait','nextWorkAt',least(next_at,run.deadline_at)); END IF;
 END IF;
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
 IF inflight>=(CASE WHEN run.protocol_mode=2 THEN 20 ELSE 10 END) THEN RETURN jsonb_build_object('version',1,'state','wait','nextWorkAt',at_time+interval '1 second'); END IF;
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
 IF attempt.operation='FETCH' AND attempt.ordinal=1 AND run.paid_lookups>=300 THEN RAISE EXCEPTION 'RC_LOOKUP_LIMIT'; END IF;
 INSERT INTO public.rc_account_windows(account_hash,window_start,reserved_requests,current_limit)
  VALUES(policy.rc_account_hash,window_at,1,least(450,policy.rpm)) ON CONFLICT(account_hash,window_start)
  DO UPDATE SET reserved_requests=rc_account_windows.reserved_requests+1;
 UPDATE public.rc_lookup_attempts SET state='dispatched',dispatch_at=at_time,privacy_generation=health.active_generation,
  possible_credits=CASE WHEN operation='FETCH' THEN policy.rc_fetch_credits_max ELSE 0 END WHERE id=p_attempt;
 UPDATE public.rc_sourcing_runs SET paid_lookups=paid_lookups+CASE WHEN attempt.operation='FETCH' AND attempt.ordinal=1 THEN 1 ELSE 0 END,
  heartbeat_at=at_time,next_work_at=NULL,revision=revision+1 WHERE id=run.id;
 RETURN jsonb_build_object('version',1,'state','granted','attemptId',p_attempt,'deadlineAt',run.deadline_at,
  'maximumCredits',policy.rc_fetch_credits_max);
END $rc_dispatch$;
REVOKE ALL ON FUNCTION public.signal_rc_dispatch(text,uuid,uuid,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.signal_rc_read(p_tenant text,p_flow uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='10s' AS $rc_read$
DECLARE run public.rc_sourcing_runs%ROWTYPE; b public.governed_sourcing_bindings%ROWTYPE;
 members jsonb; attempts jsonb; total integer; processed integer; stale boolean; notified boolean; progress_state text; progress jsonb;
 request_status text; requested_time timestamptz; work_started boolean;
BEGIN
 IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$' THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow;
 IF NOT FOUND THEN RAISE EXCEPTION 'RC_BINDING_REFUSED'; END IF;
 SELECT j.status,j."requestedAt",EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts c WHERE c."tenantId"=p_tenant AND c."sourcingRequestId"=j.id)
  INTO request_status,requested_time,work_started FROM public.job_sourcing_requests j WHERE j.id=b.request_id AND j."tenantId"=p_tenant;
 SELECT r.* INTO run FROM public.rc_sourcing_runs r JOIN public.job_sourcing_requests j ON j.id=r.request_id AND j."tenantId"=r.tenant_id
  WHERE r.tenant_id=p_tenant AND r.flow_run_id=p_flow AND r.generation=j.acquisition_generation;
 IF NOT FOUND THEN
  IF current_setting('signal.rc_progress_only',true)='true' AND request_status='queued' AND b.cancellation IS NULL
   AND b.command->'rankingContract'->'payload'->>'schemaVersion'='3'
   AND EXISTS(SELECT 1 FROM public.rc_org_policies WHERE tenant_id=p_tenant AND enabled) THEN
   RETURN jsonb_build_object('version',1,'state','queued','processed',0,'total',0,'updatedAt',requested_time,
    'notificationDelivered',false,'safeReason','worker_queue','workStarted',work_started);
  END IF;
  RETURN NULL;
 END IF;
 SELECT count(*),count(*) FILTER(WHERE state NOT IN ('pending','checking','fetching')) INTO total,processed
  FROM public.rc_purchase_members WHERE run_id=run.id;
 stale:=run.sealed_at IS NULL AND run.closed_at IS NULL AND (run.state='stalled' OR
  run.heartbeat_at<clock_timestamp()-interval '90 seconds' OR
  (run.next_work_at IS NULL AND run.last_progress_at<clock_timestamp()-interval '120 seconds') OR
  (run.next_work_at IS NOT NULL AND run.next_work_at<clock_timestamp()-interval '30 seconds'));
 SELECT coalesce((SELECT delivered_at IS NOT NULL FROM public.rc_operations_events
  WHERE run_id=run.id AND kind='stalled' ORDER BY episode DESC LIMIT 1),false) INTO notified;
 progress_state:=CASE WHEN run.state='closed_unrecoverable' THEN 'closed_unrecoverable' WHEN stale THEN 'stalled'
  WHEN run.protocol_mode=2 AND run.sealed_at IS NULL AND run.state IN ('prepared','checking','fetching')
   AND run.next_work_at>clock_timestamp() THEN 'queued'
  WHEN run.state IN ('partial','baseline_only') THEN 'partial' WHEN run.state='complete' THEN 'complete' ELSE 'enriching_skills' END;
 progress:=jsonb_build_object('version',1,'state',progress_state,'processed',processed,'total',total,
  'updatedAt',run.last_progress_at,'notificationDelivered',notified,
  'safeReason',CASE WHEN run.state='closed_unrecoverable' THEN 'closed' WHEN stale THEN 'recovery_pending'
   WHEN progress_state='queued' THEN 'quota_window'
   WHEN NOT run.rc_available THEN 'rate_unavailable' WHEN run.state IN ('partial','baseline_only') THEN 'skills_unavailable' ELSE 'working' END);
 IF progress_state='queued' THEN progress:=progress||jsonb_build_object('workStarted',work_started,'updatedAt',run.heartbeat_at); END IF;
 -- Transaction-local service read mode changes only response size, never
 -- authority. It avoids assembling/returning a 128MiB snapshot on status polls.
 IF current_setting('signal.rc_progress_only',true)='true' THEN RETURN progress; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('candidateId',candidate_id,'identityHash',identity_hash,'receiptId',receipt_id,'state',state)
  ORDER BY identity_hash COLLATE "C"),'[]'::jsonb) INTO members FROM public.rc_purchase_members WHERE run_id=run.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'identityHash',identity_hash,'operation',operation,'ordinal',ordinal,
  'state',state,'dispatchAt',dispatch_at,'outcomeHash',outcome_hash,'outcome',CASE WHEN current_setting('signal.rc_compact_only',true)='true' THEN NULL ELSE outcome END,'possibleCredits',possible_credits)
  ORDER BY identity_hash COLLATE "C",operation COLLATE "C",ordinal),'[]'::jsonb) INTO attempts FROM public.rc_lookup_attempts WHERE run_id=run.id;
 -- Service-private evidence only. Browser callers receive the validated progress
 -- projection, never this resumable snapshot or the candidate/attempt identifiers.
 RETURN jsonb_build_object('version',1,'runId',run.id,'state',run.state,'revision',run.revision::text,'baselineHash',run.baseline_hash,'baseline',CASE WHEN current_setting('signal.rc_compact_only',true)='true' THEN NULL ELSE run.baseline END,'protocolMode',run.protocol_mode,
  'deadlineAt',run.deadline_at,'sealedAt',run.sealed_at,'outcomeSetHash',run.closure_hash,
  'rcAvailable',run.rc_available,'members',members,'attempts',attempts,'progress',progress);
END $rc_read$;
REVOKE ALL ON FUNCTION public.signal_rc_read(text,uuid) FROM PUBLIC;

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
 IF jsonb_typeof(outcome) IS DISTINCT FROM 'object' OR outcome-ARRAY['kind','upstreamAt','retryableFree','safeCode','quota','rejectionProof']<>'{}'::jsonb
  OR NOT outcome ?& ARRAY['kind','upstreamAt','retryableFree','safeCode','quota']
  OR coalesce(kind,'') NOT IN ('eligible','success','no_skills','not_found','unusable_age','cached','restricted','failed','uncertain','rejected_free')
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
  OR ((outcome->>'retryableFree')::boolean AND (kind NOT IN ('failed','rejected_free') OR credits IS DISTINCT FROM 0))
  OR ((kind='rejected_free') IS DISTINCT FROM (outcome ? 'rejectionProof')) THEN RAISE EXCEPTION 'RC_OUTCOME_INVALID'; END IF;
 IF kind='rejected_free' AND (public.signal_rc_free_rejection_valid(outcome->'rejectionProof') IS NOT TRUE
  OR credits IS DISTINCT FROM 0 OR outcome->'retryableFree' IS DISTINCT FROM 'true'::jsonb
  OR outcome->>'safeCode' IS DISTINCT FROM 'rate_limited' OR outcome->'upstreamAt' IS DISTINCT FROM 'null'::jsonb)
  THEN RAISE EXCEPTION 'RC_RETRY_PROOF_REFUSED'; END IF;
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
 IF kind='rejected_free' AND (run.protocol_mode<>2 OR attempt.operation<>'FETCH' OR attempt.dispatch_at IS NULL)
  THEN RAISE EXCEPTION 'RC_RETRY_REFUSED'; END IF;
 IF attempt.operation='FETCH' AND (kind='eligible' OR ((outcome->>'retryableFree')::boolean AND kind<>'rejected_free'))
  OR attempt.operation='CHECK' AND kind='success' THEN RAISE EXCEPTION 'RC_OUTCOME_INVALID'; END IF;
 IF obs<>'null'::jsonb THEN
  IF jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs->'version' IS DISTINCT FROM '1'::jsonb
   OR obs-ARRAY['version','outcome','identityHash','skills','upstreamAt','observedAt','validUntil','timestampSource','contentHash']<>'{}'::jsonb
   OR NOT obs ?& ARRAY['version','outcome','identityHash','skills','upstreamAt','observedAt','validUntil','timestampSource','contentHash']
   OR obs->>'identityHash' IS DISTINCT FROM attempt.identity_hash OR coalesce(obs->>'timestampSource','') NOT IN ('check_last_update','fetch_updated_at')
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
  IF kind<>'cached' AND obs->>'timestampSource' IS DISTINCT FROM
    (CASE WHEN run.protocol_mode=2 THEN 'fetch_updated_at' ELSE 'check_last_update' END) THEN RAISE EXCEPTION 'RC_OBSERVATION_INVALID'; END IF;
  IF run.protocol_mode=1 AND attempt.operation='FETCH' AND kind<>'cached' THEN
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
  WHEN kind='rejected_free' THEN 'rejected_free'
  WHEN kind IN ('no_skills','not_found','unusable_age') THEN 'no_data' WHEN kind='uncertain' THEN 'uncertain' ELSE 'failed' END;
 member_state:=CASE WHEN restricted OR kind='restricted' THEN 'restricted' WHEN kind='cached' THEN 'cached'
  WHEN kind='eligible' THEN 'fetching' WHEN kind='success' THEN 'success' WHEN kind IN ('no_skills','not_found','unusable_age') THEN 'no_data'
  WHEN kind='rejected_free' THEN CASE WHEN attempt.ordinal<3 THEN 'pending' ELSE 'failed' END
  WHEN kind='uncertain' OR (attempt.operation='FETCH' AND attempt.dispatch_at IS NOT NULL) THEN 'uncertain'
  WHEN kind='failed' AND (outcome->>'retryableFree')::boolean AND attempt.ordinal=1 THEN 'checking' ELSE 'failed' END;
 UPDATE public.rc_lookup_attempts SET state=attempt_state,outcome_hash=p_command->>'outcomeHash',
  rejection_proof=CASE WHEN kind='rejected_free' THEN p_command->'outcome'->'rejectionProof' ELSE NULL END,
  retry_after_at=CASE WHEN kind='rejected_free' THEN (p_command->'outcome'->'rejectionProof'->>'retryAfterAt')::timestamptz ELSE NULL END,
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
 IF kind='rejected_free' THEN blocked:=greatest(blocked,(outcome->'rejectionProof'->>'retryAfterAt')::timestamptz); END IF;
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

CREATE OR REPLACE FUNCTION public.signal_rc_prepare_rebuild(kind text,j jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $rebuild$
DECLARE fields text[]; k text; fragments text[]:=ARRAY[]::text[]; value_text text; skill jsonb; skill_texts text[]:=ARRAY[]::text[]; n integer:=0;
BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RC_INVALID_CANONICAL_SHAPE'; END IF;
 CASE kind
 WHEN 'identity' THEN
  fields:=ARRAY['candidateId','globalCandidateId','identityHash','url'];
  IF jsonb_typeof(j->'candidateId') IS DISTINCT FROM 'string' OR length(j->>'candidateId') NOT BETWEEN 1 AND 200
   OR jsonb_typeof(j->'globalCandidateId') IS DISTINCT FROM 'string' OR (j->>'globalCandidateId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR jsonb_typeof(j->'identityHash') IS DISTINCT FROM 'string' OR (j->>'identityHash') !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(j->'url') IS DISTINCT FROM 'string' OR (j->>'url') !~ '^https://linkedin[.]com/in/[a-z0-9][a-z0-9._-]{0,199}$'
   THEN RAISE EXCEPTION 'RC_INVALID_CANONICAL_SHAPE'; END IF;
 WHEN 'cache' THEN
  fields:=ARRAY['identityHash','observation'];
  IF jsonb_typeof(j->'identityHash') IS DISTINCT FROM 'string' OR (j->>'identityHash') !~ '^[a-f0-9]{64}$'
   THEN RAISE EXCEPTION 'RC_INVALID_CANONICAL_SHAPE'; END IF;
 WHEN 'observation' THEN
  fields:=ARRAY['contentHash','identityHash','observedAt','outcome','skills','timestampSource','upstreamAt','validUntil','version'];
  IF (j->'version'='1'::jsonb AND j->>'version'='1'
   AND jsonb_typeof(j->'contentHash')='string' AND j->>'contentHash' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(j->'identityHash')='string' AND j->>'identityHash' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(j->'observedAt')='string' AND length(j->>'observedAt')<=40
   AND jsonb_typeof(j->'outcome')='string' AND j->>'outcome'=ANY(ARRAY['success','no_skills','not_found','unusable_age'])
   AND j->>'timestampSource' IN ('check_last_update','fetch_updated_at')
   AND (j->'upstreamAt'='null'::jsonb OR (jsonb_typeof(j->'upstreamAt')='string' AND length(j->>'upstreamAt')<=40))
   AND (j->'validUntil'='null'::jsonb OR (jsonb_typeof(j->'validUntil')='string' AND length(j->>'validUntil')<=40))
   AND jsonb_typeof(j->'skills')='array') IS NOT TRUE THEN RAISE EXCEPTION 'RC_INVALID_CANONICAL_SHAPE'; END IF;
  IF jsonb_array_length(j->'skills')>500 OR octet_length(j::text)>65536 THEN RAISE EXCEPTION 'RC_INVALID_CANONICAL_SHAPE'; END IF;
  FOR skill IN SELECT value FROM jsonb_array_elements(j->'skills') LOOP
   IF jsonb_typeof(skill) IS DISTINCT FROM 'string' OR length(skill#>>'{}') NOT BETWEEN 1 AND 500
    OR length(trim(skill#>>'{}'))=0 OR (skill#>>'{}') ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'RC_INVALID_CANONICAL_SHAPE'; END IF;
   n:=n+1;skill_texts[n]:=skill::text;
  END LOOP;
 ELSE RAISE EXCEPTION 'RC_INVALID_CANONICAL_SHAPE';
 END CASE;
 IF (j ?& fields AND j-fields='{}'::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'RC_INVALID_CANONICAL_SHAPE'; END IF;
 n:=0;
 FOREACH k IN ARRAY fields LOOP
  value_text:=CASE WHEN kind='cache' AND k='observation' THEN public.signal_rc_prepare_rebuild('observation',j->k)
   WHEN kind='observation' AND k='skills' THEN '['||array_to_string(skill_texts,',')||']'
   ELSE (j->k)::text END;
  IF value_text IS NULL THEN RAISE EXCEPTION 'RC_INVALID_CANONICAL_SHAPE'; END IF;
  n:=n+1;fragments[n]:=to_jsonb(k)::text||':'||value_text;
 END LOOP;
 RETURN '{'||array_to_string(fragments,',')||'}';
END $rebuild$;
REVOKE ALL ON FUNCTION public.signal_rc_prepare_rebuild(text,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.signal_rc_prepare(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='30s' AS $rc_prepare$
DECLARE run public.rc_sourcing_runs%ROWTYPE; request public.job_sourcing_requests%ROWTYPE;
 b public.governed_sourcing_bindings%ROWTYPE; item jsonb; person jsonb; base jsonb; v_text text;
 receipt public.crustdata_acquisition_receipts%ROWTYPE; raw text; parts text[]; url text; identity text;
 purchased text[]:=ARRAY[]::text[]; receipt_ids text[]; wanted text[]; candidate_ids text[]; tagged boolean; existing_url text; stage_start timestamptz;
BEGIN
 tagged:=p_command ? 'transportVersion';
 IF tagged THEN p_command:=public.signal_rc_prepare_transport(p_command); END IF;
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
   OR coalesce(item->>'timestampSource','') NOT IN ('check_last_update','fetch_updated_at')
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
 SELECT coalesce(array_agg(id),ARRAY[]::text[]) INTO candidate_ids FROM (
  SELECT value->>'candidateId' id FROM jsonb_array_elements(base->'evidence')
  UNION ALL SELECT value->>'candidateId' id FROM jsonb_array_elements(base->'withheld')
 ) ids;
 IF cardinality(candidate_ids)<>(SELECT count(DISTINCT id) FROM unnest(candidate_ids) ids(id))
  THEN RAISE EXCEPTION 'RC_IDENTITY_CONFLICT'; END IF;
 FOR person IN SELECT value FROM jsonb_array_elements(base->'identities') LOOP
  IF jsonb_typeof(person) IS DISTINCT FROM 'object' OR person-ARRAY['candidateId','globalCandidateId','url','identityHash']<>'{}'::jsonb
   OR NOT person ?& ARRAY['candidateId','globalCandidateId','url','identityHash']
   OR coalesce(person->>'url','') !~ '^https://linkedin[.]com/in/[a-z0-9][a-z0-9._-]{0,199}$'
   OR person->>'identityHash' IS DISTINCT FROM encode(sha256(convert_to(person->>'url','UTF8')),'hex')
   OR ((person->>'candidateId')=ANY(candidate_ids)) IS NOT TRUE
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
 IF NOT tagged THEN
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
 END IF;
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

CREATE FUNCTION public.signal_rc_work(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
AS $rc_work$
DECLARE run public.rc_sourcing_runs%ROWTYPE; request public.job_sourcing_requests%ROWTYPE;
 health public.candidate_privacy_sync_state%ROWTYPE; result jsonb; previous_setting text;
 requested uuid[]; item uuid; entry public.rc_lookup_attempts%ROWTYPE; candidate text; allowed boolean;
BEGIN
 IF p_command->>'action'='retrieval_config' THEN
  IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
   OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
   OR p_command-ARRAY['version','action','executionAttemptId','processingLeaseId','configuration']<>'{}'::jsonb
   OR NOT p_command ?& ARRAY['version','action','executionAttemptId','processingLeaseId','configuration']
   OR octet_length(p_command::text)>2048 THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
  result:=p_command->'configuration';
  IF jsonb_typeof(result) IS DISTINCT FROM 'object'
   OR result-ARRAY['version','publicLimit','privateLimit','recentLimit','newLimit']<>'{}'::jsonb
   OR NOT result ?& ARRAY['version','publicLimit','privateLimit','recentLimit','newLimit']
   OR result->'version' IS DISTINCT FROM '1'::jsonb OR result->'newLimit' IS DISTINCT FROM '300'::jsonb
   OR EXISTS(SELECT 1 FROM jsonb_each(result) e WHERE jsonb_typeof(e.value)<>'number'
    OR (e.value#>>'{}') !~ '^(0|[1-9][0-9]{0,3})$') THEN RAISE EXCEPTION 'RC_RETRIEVAL_CONFIGURATION'; END IF;
  IF (result->>'publicLimit')::integer<1 OR (result->>'privateLimit')::integer<1
   OR (result->>'publicLimit')::integer+(result->>'privateLimit')::integer+(result->>'recentLimit')::integer+300>2000
   THEN RAISE EXCEPTION 'RC_RETRIEVAL_CONFIGURATION'; END IF;
  SELECT j.* INTO request FROM public.job_sourcing_requests j JOIN public.governed_sourcing_bindings b
   ON b.request_id=j.id AND b.tenant_id=j."tenantId"
   WHERE b.tenant_id=p_tenant AND b.flow_run_id=p_flow AND b.cancellation IS NULL
   AND b.command->>'protocolVersion'='2' FOR UPDATE OF j;
  IF NOT FOUND OR request.status<>'processing'
   OR request.execution_attempt_id IS NULL OR request.execution_attempt_id IS DISTINCT FROM p_command->>'executionAttemptId'
   OR request.processing_lease_id IS NULL OR request.processing_lease_id IS DISTINCT FROM p_command->>'processingLeaseId'
   THEN RAISE EXCEPTION 'RC_EXECUTION_STALE'; END IF;
  IF request.rc_retrieval_config IS NOT NULL THEN RETURN request.rc_retrieval_config; END IF;
  -- No grandfathering a newly selected policy onto already-purchased work.
  IF EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts WHERE "sourcingRequestId"=request.id)
   THEN RAISE EXCEPTION 'RC_RETRIEVAL_ALREADY_STARTED'; END IF;
  UPDATE public.job_sourcing_requests SET rc_retrieval_config=result WHERE id=request.id;
  RETURN result;
 END IF;
 IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR p_command-ARRAY['version','action','executionAttemptId','processingLeaseId','baselineHash','attemptIds']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['version','action','executionAttemptId','processingLeaseId','baselineHash']
  OR coalesce(p_command->>'action','') NOT IN ('baseline','status','observations')
  OR (CASE WHEN p_command->>'action'='baseline' THEN p_command->'baselineHash' IS DISTINCT FROM 'null'::jsonb
      ELSE coalesce(p_command->>'baselineHash','') !~ '^[0-9a-f]{64}$' END)
  OR octet_length(p_command::text)>8192 THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 SELECT r.* INTO run FROM public.rc_sourcing_runs r JOIN public.governed_sourcing_bindings b
  ON b.tenant_id=r.tenant_id AND b.flow_run_id=r.flow_run_id
  JOIN public.job_sourcing_requests j ON j.id=r.request_id AND j."tenantId"=r.tenant_id
  WHERE r.tenant_id=p_tenant AND r.flow_run_id=p_flow AND r.generation=j.acquisition_generation
  AND b.cancellation IS NULL;
 IF NOT FOUND OR (p_command->>'action'<>'baseline' AND run.baseline_hash IS DISTINCT FROM p_command->>'baselineHash')
  THEN RAISE EXCEPTION 'RC_BASELINE_CONFLICT'; END IF;
 SELECT * INTO request FROM public.job_sourcing_requests WHERE id=run.request_id AND "tenantId"=p_tenant;
 IF request.status<>'processing' OR request.execution_attempt_id IS DISTINCT FROM p_command->>'executionAttemptId'
  OR request.execution_attempt_id IS DISTINCT FROM run.execution_attempt_id
  OR request.processing_lease_id IS NULL OR request.processing_lease_id IS DISTINCT FROM p_command->>'processingLeaseId'
  OR request.processing_lease_id IS DISTINCT FROM run.processing_lease_id THEN RAISE EXCEPTION 'RC_EXECUTION_STALE'; END IF;
 IF p_command->>'action' IN ('baseline','status') THEN
  IF p_command ? 'attemptIds' THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
  previous_setting:=current_setting('signal.rc_compact_only',true);
  PERFORM set_config('signal.rc_compact_only',CASE WHEN p_command->>'action'='status' THEN 'true' ELSE 'false' END,true);
  result:=public.signal_rc_read(p_tenant,p_flow);
  PERFORM set_config('signal.rc_compact_only',coalesce(previous_setting,''),true);
  IF p_command->>'action'='status' AND octet_length(result::text)>1048576 THEN RAISE EXCEPTION 'RC_RESPONSE_TOO_LARGE'; END IF;
  RETURN result;
 END IF;
 IF jsonb_typeof(p_command->'attemptIds') IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_command->'attemptIds')>25
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_command->'attemptIds') x
   WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR (x#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 SELECT coalesce(array_agg(value::uuid),ARRAY[]::uuid[]) INTO requested FROM jsonb_array_elements_text(p_command->'attemptIds');
 IF cardinality(requested)<>(SELECT count(DISTINCT x) FROM unnest(requested) x) THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('discover_candidate_privacy_admission_v1',0));
 SELECT * INTO health FROM public.candidate_privacy_sync_state WHERE consumer_name='discover';
 IF NOT FOUND OR health.status<>'healthy' OR health.active_generation<=0 OR health.last_success_at IS NULL
  OR health.last_success_at<clock_timestamp()-interval '300 seconds' OR health.expected_candidates<>health.projected_candidates
  THEN RAISE EXCEPTION 'RC_PRIVACY_UNAVAILABLE'; END IF;
 result:='[]'::jsonb;
 FOREACH item IN ARRAY requested LOOP
  SELECT * INTO entry FROM public.rc_lookup_attempts WHERE id=item AND run_id=run.id;
  IF NOT FOUND OR entry.outcome_hash IS NULL OR entry.state IN ('reserved','dispatched')
   THEN RAISE EXCEPTION 'RC_OUTCOME_CONFLICT'; END IF;
  SELECT candidate_id INTO candidate FROM public.rc_purchase_members WHERE run_id=run.id AND identity_hash=entry.identity_hash;
  allowed:=EXISTS(SELECT 1 FROM public.candidate_privacy_projection WHERE tenant_id=p_tenant AND candidate_id=candidate
   AND generation=health.active_generation AND evaluated_cursor=health.cursor AND decision='allow');
  result:=result||jsonb_build_array(jsonb_build_object('attemptId',entry.id,'outcomeHash',entry.outcome_hash,
   'outcome',CASE WHEN allowed THEN entry.outcome ELSE jsonb_build_object('kind','restricted') END));
 END LOOP;
 IF octet_length(result::text)>2097152 THEN RAISE EXCEPTION 'RC_RESPONSE_TOO_LARGE'; END IF;
 RETURN jsonb_build_object('version',1,'observations',result);
END $rc_work$;
REVOKE ALL ON FUNCTION public.signal_rc_work(text,uuid,jsonb) FROM PUBLIC;
-- New wrappers must not inherit runtime access before the provisioner runs.
DO $rc_work_acl$ DECLARE gr record; BEGIN
 FOR gr IN SELECT DISTINCT r.rolname FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  JOIN pg_roles r ON r.oid=a.grantee
  WHERE p.oid='public.signal_rc_work(text,uuid,jsonb)'::regprocedure AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.signal_rc_work(text,uuid,jsonb) FROM %I',gr.rolname); END LOOP;
END $rc_work_acl$;

CREATE OR REPLACE FUNCTION public.signal_rc_seal(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC'
SET lock_timeout='2s' SET statement_timeout='5s' AS $rc_seal$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; request public.job_sourcing_requests%ROWTYPE;
 run public.rc_sourcing_runs%ROWTYPE; calculated text; terminal_state text; markers text;
BEGIN
 IF p_flow IS NULL OR coalesce(p_tenant,'') !~ '^org_[1-9][0-9]*$'
  OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR p_command->'version' IS DISTINCT FROM '1'::jsonb
  OR p_command-ARRAY['version','baselineHash','outcomeSetHash','expectedRevision','executionAttemptId','processingLeaseId']<>'{}'::jsonb
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
 IF run.protocol_mode=2 THEN
  IF coalesce(p_command->>'expectedRevision','') !~ '^[0-9]{1,19}$' THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
  IF request.status<>'processing' OR request.execution_attempt_id IS DISTINCT FROM p_command->>'executionAttemptId'
   OR request.execution_attempt_id IS DISTINCT FROM run.execution_attempt_id
   OR request.processing_lease_id IS NULL OR request.processing_lease_id IS DISTINCT FROM p_command->>'processingLeaseId'
   OR request.processing_lease_id IS DISTINCT FROM run.processing_lease_id THEN RAISE EXCEPTION 'RC_EXECUTION_STALE'; END IF;
  IF run.sealed_at IS NULL AND run.revision::text IS DISTINCT FROM p_command->>'expectedRevision'
   THEN RETURN jsonb_build_object('version',1,'state','reread'); END IF;
 END IF;
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

-- RC_BASELINE_WRITE_VALIDATION: one atomic replacement; no unchecked interval.
-- Metadata writes must not serialize the immutable pool hundreds of times.
DO $rc_baseline_validation$
DECLARE gr record;
BEGIN
 LOCK TABLE public.rc_sourcing_runs IN ACCESS EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.rc_sourcing_runs'::regclass
   AND c.relkind='r' AND c.relowner=(SELECT relowner FROM pg_class WHERE oid='public.job_sourcing_requests'::regclass))
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.rc_sourcing_runs'::regclass
   AND conname='rc_sourcing_runs_baseline_check' AND contype='c' AND convalidated
   AND pg_get_constraintdef(oid)='CHECK (((jsonb_typeof(baseline) = ''object''::text) AND (octet_length((baseline)::text) <= 134217728)))')
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.rc_sourcing_runs'::regclass AND NOT tgisinternal)
  OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class='public.rc_sourcing_runs'::regclass)
  THEN RAISE EXCEPTION 'RC_BASELINE_VALIDATION_SOURCE_REFUSED'; END IF;
 EXECUTE $ddl$CREATE FUNCTION public.signal_rc_validate_baseline_write() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $body$
 BEGIN
  IF (jsonb_typeof(NEW.baseline)='object' AND octet_length(NEW.baseline::text)<=134217728) IS FALSE
   THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='RC_BASELINE_INVALID',
    CONSTRAINT='rc_sourcing_runs_baseline_check',TABLE='rc_sourcing_runs',SCHEMA='public'; END IF;
  RETURN NULL;
 END $body$;$ddl$;
 REVOKE ALL ON FUNCTION public.signal_rc_validate_baseline_write() FROM PUBLIC;
 FOR gr IN SELECT DISTINCT r.rolname FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  JOIN pg_roles r ON r.oid=a.grantee
  WHERE p.oid='public.signal_rc_validate_baseline_write()'::regprocedure AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.signal_rc_validate_baseline_write() FROM %I',gr.rolname); END LOOP;
 CREATE TRIGGER rc_baseline_write_guard AFTER INSERT OR UPDATE OF baseline ON public.rc_sourcing_runs
  FOR EACH ROW EXECUTE FUNCTION public.signal_rc_validate_baseline_write();
 ALTER TABLE public.rc_sourcing_runs ENABLE ALWAYS TRIGGER rc_baseline_write_guard;
 ALTER TABLE public.rc_sourcing_runs DROP CONSTRAINT rc_sourcing_runs_baseline_check;
END $rc_baseline_validation$;
