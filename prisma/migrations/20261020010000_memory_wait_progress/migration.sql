-- Upstream progress is durable purchase preparation / terminal acknowledgements,
-- never a heartbeat or a repeated poll. Old sealed purchases keep their deadline.
DO $baseline$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.signal_memory_ingest(jsonb,jsonb)'::regprocedure)
     <> 'c2057d15ca6a34e40d60ba511f15efd6'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.signal_rc_maintain(jsonb)'::regprocedure)
     <> 'f4800e4390a128a66ad566fa2ae3730d'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.signal_rc_read(text,uuid)'::regprocedure)
     <> '99ce0d0310e9848c5c6f42f8c0d7e00b'
 THEN RAISE EXCEPTION 'MEMORY_PROGRESS_BASELINE_MISMATCH'; END IF;
END $baseline$;

CREATE FUNCTION public.signal_memory_rc_progress(r public.rc_sourcing_runs)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $progress$
 SELECT greatest(r.last_progress_at, coalesce(max(least(
   greatest(a.memory_prepared_at, p.acknowledged_at), a.memory_wait_until
 )), r.last_progress_at))
 FROM public.crustdata_acquisition_receipts a
 JOIN public.job_sourcing_requests j ON j.id=a."sourcingRequestId" AND j."tenantId"=a."tenantId"
 JOIN public.governed_sourcing_bindings b ON b.request_id=j.id AND b.tenant_id=j."tenantId"
   AND b.flow_run_id=r.flow_run_id AND b.cancellation IS NULL
 LEFT JOIN public.public_memory_ingest_requests p ON p.acquisition_id=a.id
   AND p.state IN ('succeeded','suppressed')
 WHERE r.protocol_mode=2 AND r.baseline IS NULL AND r.state='admitted'
   AND a."tenantId"=r.tenant_id AND a."sourcingRequestId"=r.request_id
   AND a."acquisitionGeneration"=r.generation AND a.memory_delivery_contract=2
   AND a.status='complete' AND a.memory_prepared_at IS NOT NULL
   AND j.status='processing' AND j.acquisition_generation=r.generation
   AND j.execution_attempt_id=r.execution_attempt_id
   AND j.processing_lease_id=r.processing_lease_id
$progress$;
REVOKE ALL ON FUNCTION public.signal_memory_rc_progress(public.rc_sourcing_runs) FROM PUBLIC;

DO $migration$
DECLARE definition text; target text; replacement text;
BEGIN
 definition:=pg_get_functiondef('public.signal_rc_maintain(jsonb)'::regprocedure);
 target:='(next_work_at IS NULL AND last_progress_at<at_time-interval ''120 seconds'')';
 replacement:='(next_work_at IS NULL AND public.signal_memory_rc_progress(rc_sourcing_runs)<at_time-interval ''120 seconds'')';
 IF (length(definition)-length(replace(definition,target,'')))/length(target)<>1
 THEN RAISE EXCEPTION 'MEMORY_PROGRESS_BASELINE_MISMATCH'; END IF;
 EXECUTE replace(definition,target,replacement);

 definition:=pg_get_functiondef('public.signal_rc_read(text,uuid)'::regprocedure);
 target:='(run.next_work_at IS NULL AND run.last_progress_at<clock_timestamp()-interval ''120 seconds'')';
 replacement:='(run.next_work_at IS NULL AND public.signal_memory_rc_progress(run)<clock_timestamp()-interval ''120 seconds'')';
 IF (length(definition)-length(replace(definition,target,'')))/length(target)<>1
 THEN RAISE EXCEPTION 'MEMORY_PROGRESS_BASELINE_MISMATCH'; END IF;
 EXECUTE replace(definition,target,replacement);

 definition:=pg_get_functiondef('public.signal_memory_ingest(jsonb,jsonb)'::regprocedure);
 target:='memory_wait_until=clock_timestamp()+interval ''150 seconds''';
 replacement:='memory_wait_until=clock_timestamp()+interval ''15 minutes''';
 IF (length(definition)-length(replace(definition,target,'')))/length(target)<>1
 THEN RAISE EXCEPTION 'MEMORY_PROGRESS_BASELINE_MISMATCH'; END IF;
 EXECUTE replace(definition,target,replacement);
END $migration$;
