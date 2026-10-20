-- Record candidate-local exclusions without treating them as Memory deliveries.
-- Existing packets, purchases and immutable historical migrations are unchanged.
ALTER TABLE public.crustdata_acquisition_receipts
 ADD COLUMN memory_exclusions jsonb NOT NULL DEFAULT '[]'::jsonb,
 ADD CONSTRAINT memory_exclusions_shape CHECK
  (jsonb_typeof(memory_exclusions)='array' AND jsonb_array_length(memory_exclusions)<=300
   AND octet_length(memory_exclusions::text)<=100000);

DO $migration$
DECLARE definition text; before_text text; after_text text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.signal_memory_ingest(jsonb,jsonb)'::regprocedure)
    <> '4acc33a105d892e4057fa1f68fef191c'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.signal_memory_acquisition_guard()'::regprocedure)
    <> '664ef717e3df138a21953030bc2f32e2' THEN
  RAISE EXCEPTION 'MEMORY_EXCLUSIONS_BASELINE_MISMATCH';
 END IF;
 definition:=pg_get_functiondef('public.signal_memory_ingest(jsonb,jsonb)'::regprocedure);
 before_text:=$old$ ELSIF action='seal' THEN
  IF a.memory_prepared_at IS NULL THEN$old$;
 after_text:=$new$ ELSIF action='seal' THEN
  response:=coalesce(p_command->'exclusions','[]'::jsonb);
  IF jsonb_typeof(response) IS DISTINCT FROM 'array' OR jsonb_array_length(response)>300
   OR octet_length(response::text)>100000 THEN RAISE EXCEPTION 'MEMORY_EXCLUSIONS_INVALID'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(response) LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object'
    OR item-ARRAY['index','providerRecordId','candidateFingerprint','reason']<>'{}'::jsonb
    OR NOT item ?& ARRAY['index','providerRecordId','candidateFingerprint','reason']
    OR coalesce(item->>'providerRecordId','') !~ '^[1-9][0-9]{0,18}$'
    OR coalesce(item->>'candidateFingerprint','') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(item->'index') IS DISTINCT FROM 'number'
    OR coalesce(item->>'index','') !~ '^[0-9]{1,3}$'
    OR (item->>'index')::integer>599
    OR coalesce(item->>'reason','') NOT IN ('linkedin_invalid','profile_missing','profile_field_too_large',
       'profile_list_invalid','employment_invalid','education_invalid','certification_invalid','honor_invalid')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.result->'profiles') x
       WHERE x->>'crustdata_person_id'=item->>'providerRecordId')
    OR EXISTS(SELECT 1 FROM public.public_memory_ingest_requests WHERE acquisition_id=a.id
       AND provider_id=item->>'providerRecordId') THEN RAISE EXCEPTION 'MEMORY_EXCLUSIONS_INVALID'; END IF;
  END LOOP;
  IF jsonb_array_length(response)<>(SELECT count(DISTINCT x->>'providerRecordId') FROM jsonb_array_elements(response) x)
   THEN RAISE EXCEPTION 'MEMORY_EXCLUSIONS_INVALID'; END IF;
  IF a.memory_prepared_at IS NOT NULL AND a.memory_exclusions<>response THEN
   RAISE EXCEPTION 'MEMORY_EXCLUSIONS_CONFLICT'; END IF;
  IF a.memory_prepared_at IS NULL THEN
   UPDATE public.crustdata_acquisition_receipts SET memory_exclusions=response WHERE id=a.id;$new$;
 IF strpos(definition,before_text)=0 THEN RAISE EXCEPTION 'MEMORY_EXCLUSIONS_PATCH_MISSING'; END IF;
 definition:=replace(definition,before_text,after_text);
 definition:=replace(definition,
  'IF n>300 OR n<>(SELECT count(DISTINCT x->>''crustdata_person_id'') FROM jsonb_array_elements(a.result->''profiles'') x) THEN',
  'IF n>300 OR n+jsonb_array_length(response)<>(SELECT count(DISTINCT x->>''crustdata_person_id'') FROM jsonb_array_elements(a.result->''profiles'') x) THEN');
 EXECUTE definition;

 definition:=pg_get_functiondef('public.signal_memory_acquisition_guard()'::regprocedure);
 definition:=replace(definition, E'BEGIN\n',
 $guard$BEGIN
 IF NEW.memory_exclusions IS DISTINCT FROM OLD.memory_exclusions AND
  (OLD.memory_prepared_at IS NOT NULL OR current_user<>pg_get_userbyid(
   (SELECT relowner FROM pg_class WHERE oid='public.crustdata_acquisition_receipts'::regclass))) THEN
  RAISE EXCEPTION 'MEMORY_EXCLUSIONS_IMMUTABLE';
 END IF;
 $guard$);
 EXECUTE definition;
END
$migration$;
