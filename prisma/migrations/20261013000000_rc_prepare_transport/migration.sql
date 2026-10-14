-- RC preparation: preserve baseline bytes/order; bound the caller separately.
CREATE FUNCTION public.signal_rc_prepare_rebuild(kind text,j jsonb) RETURNS text
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
   AND j->'timestampSource'='"check_last_update"'::jsonb
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

CREATE FUNCTION public.signal_rc_prepare_transport(cmd jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $transport$
DECLARE t jsonb; base jsonb; logical_cmd jsonb; entry jsonb; parsed jsonb; rendered text; body text; label text; kind text;
 texts text[]; records jsonb[]; arrays jsonb[]:=ARRAY[]::jsonb[]; sections text[]:=ARRAY[]::text[]; n integer; idx integer:=0; logical_bytes bigint:=0;
BEGIN
 IF (jsonb_typeof(cmd)='object' AND cmd->'version'='1'::jsonb AND cmd->>'version'='1'
  AND cmd->'transportVersion'='1'::jsonb AND cmd->>'transportVersion'='1'
  AND cmd ?& ARRAY['version','transportVersion','receiptIds','baselineHash','asOf','baselineTransport']
  AND cmd-ARRAY['version','transportVersion','receiptIds','baselineHash','asOf','baselineTransport']='{}'::jsonb
  AND jsonb_typeof(cmd->'receiptIds')='array' AND jsonb_typeof(cmd->'baselineHash')='string'
  AND cmd->>'baselineHash' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(cmd->'asOf')='string'
  AND octet_length(cmd::text)<=268500992) IS NOT TRUE THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 IF jsonb_array_length(cmd->'receiptIds')>2 THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 t:=cmd->'baselineTransport';
 IF (jsonb_typeof(t)='object' AND t->'version'='1'::jsonb AND t->>'version'='1'
  AND t ?& ARRAY['version','asOf','cacheCanonical','evidenceCanonical','identitiesCanonical','withheldCanonical']
  AND t-ARRAY['version','asOf','cacheCanonical','evidenceCanonical','identitiesCanonical','withheldCanonical']='{}'::jsonb
  AND jsonb_typeof(t->'asOf')='string' AND t->'asOf'=cmd->'asOf'
  AND jsonb_typeof(t->'evidenceCanonical')='array' AND jsonb_typeof(t->'withheldCanonical')='array'
  AND jsonb_typeof(t->'identitiesCanonical')='array' AND jsonb_typeof(t->'cacheCanonical')='array') IS NOT TRUE
  THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 IF jsonb_array_length(t->'evidenceCanonical')+jsonb_array_length(t->'withheldCanonical')>2000
  OR jsonb_array_length(t->'identitiesCanonical')>2000 OR jsonb_array_length(t->'cacheCanonical')>2000
  THEN RAISE EXCEPTION 'RC_BASELINE_INVALID'; END IF;
 base:=jsonb_build_object('version',1,'asOf',t->'asOf','cache','[]'::jsonb,'evidence','[]'::jsonb,'identities','[]'::jsonb,'withheld','[]'::jsonb);
 logical_cmd:=jsonb_build_object('version',1,'receiptIds',cmd->'receiptIds','baselineHash',cmd->'baselineHash','asOf',cmd->'asOf','baseline',base);
 logical_bytes:=octet_length(logical_cmd::text);
 FOREACH label IN ARRAY ARRAY['cache','evidence','identities','withheld'] LOOP
  texts:=ARRAY[]::text[];records:=ARRAY[]::jsonb[];n:=0;
  kind:=CASE label WHEN 'identities' THEN 'identity' ELSE label END;
  FOR entry IN SELECT value FROM jsonb_array_elements(t->(label||'Canonical')) LOOP
   IF jsonb_typeof(entry) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'RC_INVALID_CANONICAL_TEXT'; END IF;
   body:=entry#>>'{}';
   IF octet_length(body)>67108864 OR pg_input_is_valid(body,'jsonb') IS NOT TRUE THEN RAISE EXCEPTION 'RC_INVALID_CANONICAL_TEXT'; END IF;
   IF label IN ('evidence','withheld') THEN parsed:=public.signal_ranking_transport_record(label,body);
   ELSE
    parsed:=body::jsonb;rendered:=public.signal_rc_prepare_rebuild(kind,parsed);
    IF (convert_to(rendered,'UTF8')=convert_to(body,'UTF8')) IS NOT TRUE THEN RAISE EXCEPTION 'RC_NONCANONICAL_TEXT'; END IF;
   END IF;
   n:=n+1;texts[n]:=body;records[n]:=parsed;logical_bytes:=logical_bytes+octet_length(parsed::text);
  END LOOP;
  logical_bytes:=logical_bytes+greatest(n-1,0)*2;
  idx:=idx+1;sections[idx]:='['||array_to_string(texts,',')||']';
  arrays[idx]:=to_jsonb(records);
 END LOOP;
 IF logical_bytes>134217728 THEN RAISE EXCEPTION 'RC_INVALID_COMMAND'; END IF;
 base:=jsonb_build_object('version',1,'asOf',t->'asOf','cache',arrays[1],'evidence',arrays[2],'identities',arrays[3],'withheld',arrays[4]);
 body:='{"asOf":'||(t->'asOf')::text||',"cache":'||sections[1]||',"evidence":'||sections[2]||',"identities":'||sections[3]||',"version":1,"withheld":'||sections[4]||'}';
 IF encode(sha256(convert_to(body,'UTF8')),'hex') IS DISTINCT FROM cmd->>'baselineHash' THEN RAISE EXCEPTION 'RC_BASELINE_CONFLICT'; END IF;
 RETURN jsonb_set(logical_cmd,'{baseline}',base);
END $transport$;
REVOKE ALL ON FUNCTION public.signal_rc_prepare_transport(jsonb) FROM PUBLIC;

-- CREATE can inherit non-PUBLIC default grants. Close them within this migration,
-- before any runtime deployment, not merely in the subsequent provisioner.
DO $acl$
DECLARE grant_row record;
BEGIN
 FOR grant_row IN SELECT DISTINCT p.oid::regprocedure signature,r.rolname FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  JOIN pg_roles r ON r.oid=a.grantee
  WHERE p.oid IN ('public.signal_rc_prepare_rebuild(text,jsonb)'::regprocedure,'public.signal_rc_prepare_transport(jsonb)'::regprocedure)
   AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',grant_row.signature,grant_row.rolname); END LOOP;
END $acl$;

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
