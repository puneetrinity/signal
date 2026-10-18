-- Inserted before the frozen v1 CASE in signal_ranking_rebuild.
 IF p_kind='evidence' AND j->>'version'='rubric-evidence-v2' THEN
  IF j->'employment' IS DISTINCT FROM '[]'::jsonb
   OR jsonb_typeof(j->'employmentSources') IS DISTINCT FROM 'array'
   OR jsonb_array_length(j->'employmentSources')>2 OR octet_length(j::text)>65536 THEN
   RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
  -- Reuse the full v1 scalar/fact/scope checks, including unknown-field refusal.
  PERFORM public.signal_ranking_rebuild('evidence',
    (j-ARRAY['employmentSources','resumeIdentity'])||jsonb_build_object('version','rubric-evidence-v1'));
  IF j ? 'resumeIdentity' THEN
   source:=j->'resumeIdentity';
   IF jsonb_typeof(source) IS DISTINCT FROM 'object'
    OR NOT source ?& ARRAY['candidateId','referenceId','applicationId','applicationJobId','resumeVersionId','sourceId','generationId','sourceHash']
    OR source-ARRAY['candidateId','referenceId','applicationId','applicationJobId','resumeVersionId','sourceId','generationId','sourceHash']<>'{}'::jsonb
    OR jsonb_typeof(source->'sourceHash') IS DISTINCT FROM 'string' OR source->>'sourceHash' !~ '^[0-9a-f]{64}$'
    OR EXISTS(SELECT 1 FROM jsonb_each(source) x WHERE x.key IN ('candidateId','referenceId','resumeVersionId','sourceId','generationId')
      AND (jsonb_typeof(x.value)<>'string' OR (x.value#>>'{}') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        OR x.value='"00000000-0000-0000-0000-000000000000"'::jsonb))
    OR EXISTS(SELECT 1 FROM jsonb_each(source) x WHERE x.key IN ('applicationId','applicationJobId')
      AND (jsonb_typeof(x.value)<>'number' OR (x.value#>>'{}') !~ '^[1-9][0-9]*$'
        OR (x.value#>>'{}')::numeric>2147483647)) THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
  END IF;
  IF (SELECT count(DISTINCT x->>'kind') FROM jsonb_array_elements(j->'employmentSources') x)
    <>jsonb_array_length(j->'employmentSources') THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
  FOR source IN SELECT value FROM jsonb_array_elements(j->'employmentSources') LOOP
   IF jsonb_typeof(source) IS DISTINCT FROM 'object'
    OR NOT source ?& ARRAY['kind','scope','organizationRef','sourceVersion','sourceHash','observedAt','referenceId','intervals']
    OR source-ARRAY['kind','scope','organizationRef','sourceVersion','sourceHash','observedAt','referenceId','intervals']<>'{}'::jsonb
    OR jsonb_typeof(source->'sourceVersion') IS DISTINCT FROM 'string' OR length(source->>'sourceVersion') NOT BETWEEN 1 AND 100
    OR jsonb_typeof(source->'sourceHash') IS DISTINCT FROM 'string' OR (source->>'sourceHash') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(source->'observedAt') IS DISTINCT FROM 'string' OR length(source->>'observedAt')>40
    OR (source->>'observedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
    OR NOT pg_input_is_valid(source->>'observedAt','timestamptz')
    OR jsonb_typeof(source->'intervals') IS DISTINCT FROM 'array' OR jsonb_array_length(source->'intervals')>500
    OR (((source->>'kind'='candidate_provided' AND source->>'scope'='organization'
         AND source->>'organizationRef'=j->>'organizationRef'
         AND jsonb_typeof(source->'referenceId')='string'
         AND (source->>'referenceId') ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
      OR (source->>'kind'='profile_evidence' AND source->>'scope'='public'
         AND source->'organizationRef'='null'::jsonb AND source->'referenceId'='null'::jsonb)) IS NOT TRUE)
    THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
   FOR role IN SELECT value FROM jsonb_array_elements(source->'intervals') LOOP
    PERFORM public.signal_ranking_rebuild('employment',role);
   END LOOP;
  END LOOP;
  RETURN public.signal_ranking_canonical(j);
 END IF;
