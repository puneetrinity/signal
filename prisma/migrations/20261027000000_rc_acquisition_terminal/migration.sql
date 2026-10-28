-- A purchase whose outcome is uncertain (provider dispatched, result discarded
-- or unknown) can never be replayed or re-bought. If RC has not dispatched
-- anything and has no baseline, operator resume cannot progress it either.
-- Close the RC run as unrecoverable and report 'terminal', so the caller
-- marks the search failed and sends Flow its failed callback, instead of
-- leaving it 'processing' behind a permanent stall. No purchase is repeated.
-- Idempotent: a repeat after a lost response returns 'terminal' again and
-- closes the run at most once.
DO $baseline$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.signal_rc_maintain(jsonb)'::regprocedure)
     <> '8994228ee54ca6b0cc53aa30aa683f35'
 THEN RAISE EXCEPTION 'RC_ACQUISITION_TERMINAL_BASELINE_MISMATCH'; END IF;
END $baseline$;

DO $migration$
DECLARE definition text; target text; replacement text;
BEGIN
 definition:=pg_get_functiondef('public.signal_rc_maintain(jsonb)'::regprocedure);
 target:='    RETURN jsonb_build_object(''version'',1,''state'',''cancelled'');
   END IF;
  END IF;
  IF (p_command->>''attemptsMade'')::integer+1<least((p_command->>''maxAttempts'')::integer,3)';
 replacement:='    RETURN jsonb_build_object(''version'',1,''state'',''cancelled'');
   END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.rc_lookup_attempts WHERE run_id=run.id AND dispatch_at IS NOT NULL)
   AND run.baseline IS NULL
   AND EXISTS(SELECT 1 FROM public.crustdata_acquisition_receipts WHERE "tenantId"=run.tenant_id
    AND "sourcingRequestId"=run.request_id AND "acquisitionGeneration"=run.generation AND slot=''exact'' AND status=''uncertain'') THEN
   UPDATE public.rc_sourcing_runs SET state=''closed_unrecoverable'',closed_at=at_time,rc_available=false,
    closure_hash=encode(sha256(convert_to(jsonb_build_object(''version'',1,''reason'',''acquisition_unrecoverable'',
     ''requestId'',request.id,''generation'',run.generation)::text,''UTF8'')),''hex''),revision=revision+1
    WHERE id=run.id AND state<>''closed_unrecoverable'';
   RETURN jsonb_build_object(''version'',1,''state'',''terminal'');
  END IF;
  IF (p_command->>''attemptsMade'')::integer+1<least((p_command->>''maxAttempts'')::integer,3)';
 IF (length(definition)-length(replace(definition,target,'')))/length(target)<>1
 THEN RAISE EXCEPTION 'RC_ACQUISITION_TERMINAL_BASELINE_MISMATCH'; END IF;
 EXECUTE replace(definition,target,replacement);
END $migration$;
