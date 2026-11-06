-- Local P7 forward migration. No historical search row is deleted or rewritten.
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='30s';

ALTER TABLE public.candidates ADD COLUMN "networkSubjectRef" uuid;
ALTER TABLE public.candidates DROP CONSTRAINT candidates_identity_shape;
ALTER TABLE public.candidates ADD CONSTRAINT candidates_identity_shape CHECK ((
 ("identityKind"='linkedin' AND "privateCandidateRef" IS NULL AND "networkSubjectRef" IS NULL
  AND length(btrim("linkedinUrl"))>0 AND length(btrim("linkedinId"))>0)
 OR ("identityKind"='organization_candidate' AND "privateCandidateRef" IS NOT NULL
  AND "privateCandidateRef"<>'00000000-0000-0000-0000-000000000000'::uuid AND "networkSubjectRef" IS NULL
  AND "tenantId" ~ '^org_[1-9][0-9]*$' AND "linkedinUrl" IS NULL AND "linkedinId" IS NULL)
 OR ("identityKind"='candidate_network' AND "networkSubjectRef" IS NOT NULL
  AND "networkSubjectRef"<>'00000000-0000-0000-0000-000000000000'::uuid AND "privateCandidateRef" IS NULL
  AND "tenantId" ~ '^org_[1-9][0-9]*$' AND "linkedinUrl" IS NULL AND "linkedinId" IS NULL)
) IS TRUE);
CREATE UNIQUE INDEX candidates_tenant_network_subject ON public.candidates("tenantId","networkSubjectRef");

CREATE FUNCTION public.signal_network_identity_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW."networkSubjectRef" IS DISTINCT FROM OLD."networkSubjectRef"
  OR (OLD."identityKind"='candidate_network' AND NEW."tenantId" IS DISTINCT FROM OLD."tenantId") THEN
  RAISE EXCEPTION 'NETWORK_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER network_identity_immutable BEFORE UPDATE ON public.candidates
 FOR EACH ROW EXECUTE FUNCTION public.signal_network_identity_immutable();

CREATE TABLE public.candidate_network_sources (
 tenant_id text NOT NULL CHECK(tenant_id ~ '^org_[1-9][0-9]*$'),
 candidate_id text NOT NULL,
 publication_id uuid NOT NULL,
 subject_id uuid NOT NULL,
 global_candidate_id uuid NOT NULL,
 authority jsonb NOT NULL,
 hit jsonb NOT NULL CHECK(jsonb_typeof(hit)='object' AND octet_length(hit::text)<=524288),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,candidate_id,publication_id),
 UNIQUE(tenant_id,publication_id),
 FOREIGN KEY(tenant_id,candidate_id) REFERENCES public.candidates("tenantId",id) ON DELETE RESTRICT,
 CHECK(authority=jsonb_build_object('subjectId',subject_id,'publicationId',publication_id,
  'profileVersion',hit->'profileVersion','preferenceVersion',hit->'preferenceVersion',
  'consentRevision',hit->'consentRevision','contentHash',hit->'contentHash'))
);
ALTER TABLE public.candidate_network_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidate_network_sources FORCE ROW LEVEL SECURITY;
DO $$ DECLARE owner_name text; BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid='public.candidates'::regclass;
 EXECUTE format('ALTER TABLE public.candidate_network_sources OWNER TO %I',owner_name);
 EXECUTE format('CREATE POLICY network_sources_owner ON public.candidate_network_sources TO %I USING(true) WITH CHECK(true)',owner_name);
END $$;

CREATE FUNCTION public.signal_network_authority_valid(j jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT (jsonb_typeof(j)='object' AND j ?& ARRAY['subjectId','publicationId','profileVersion','preferenceVersion','consentRevision','contentHash']
  AND j-ARRAY['subjectId','publicationId','profileVersion','preferenceVersion','consentRevision','contentHash']='{}'::jsonb
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(j) x WHERE x.key IN ('subjectId','publicationId')
    AND (jsonb_typeof(x.value)<>'string' OR (x.value#>>'{}') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      OR (x.value#>>'{}')='00000000-0000-0000-0000-000000000000'))
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(j) x WHERE x.key IN ('profileVersion','preferenceVersion','consentRevision')
    AND (jsonb_typeof(x.value)<>'number' OR (x.value#>>'{}') !~ '^[1-9][0-9]*$' OR (x.value#>>'{}')::numeric>9007199254740991))
  AND jsonb_typeof(j->'contentHash')='string' AND j->>'contentHash' ~ '^[a-f0-9]{64}$') IS TRUE
$$;

-- Validate the redacted projection independently of the service's TypeScript
-- parser. A recomputed hash must never legitimise nested contact/private fields.
CREATE FUNCTION public.signal_network_facts_valid(j jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE k text; row jsonb; v jsonb; field text; lim integer; d jsonb;
BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR NOT j ?& ARRAY['displayName','headline','currentLocation','skills','employment','education']
  OR j-ARRAY['displayName','headline','currentLocation','skills','employment','education']<>'{}'::jsonb THEN RETURN false; END IF;
 FOR k IN SELECT unnest(ARRAY['displayName','headline']) LOOP
  IF jsonb_typeof(j->k) IS DISTINCT FROM 'string' OR length(j->>k)>(CASE WHEN k='headline' THEN 300 ELSE 200 END) THEN RETURN false; END IF;
 END LOOP;
 v:=j->'currentLocation';
 IF v<>'null'::jsonb THEN
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT v ?& ARRAY['city','countryCode','displayCountry']
   OR v-ARRAY['city','countryCode','displayCountry']<>'{}'::jsonb THEN RETURN false; END IF;
  FOR k IN SELECT unnest(ARRAY['city','countryCode','displayCountry']) LOOP
   IF jsonb_typeof(v->k) IS DISTINCT FROM 'string' OR length(v->>k)>200 THEN RETURN false; END IF;
  END LOOP;
  IF v->>'countryCode' !~ '^[A-Z]{2}$' THEN RETURN false; END IF;
 END IF;
 FOR k IN SELECT unnest(ARRAY['skills','employment','education']) LOOP
  IF jsonb_typeof(j->k) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(j->k)>(CASE WHEN k='education' THEN 50 ELSE 200 END) THEN RETURN false; END IF;
  FOR row IN SELECT value FROM jsonb_array_elements(j->k) LOOP
   IF k='skills' THEN
    IF jsonb_typeof(row) IS DISTINCT FROM 'string' OR length(row#>>'{}')>100 THEN RETURN false; END IF;
   ELSE
    IF jsonb_typeof(row) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF k='employment' THEN
     IF NOT row ?& ARRAY['employer','title','start','end','current'] OR row-ARRAY['employer','title','start','end','current']<>'{}'::jsonb THEN RETURN false; END IF;
    ELSE
     IF NOT row ?& ARRAY['institution','qualification','start','end','current'] OR row-ARRAY['institution','qualification','start','end','current']<>'{}'::jsonb THEN RETURN false; END IF;
    END IF;
    IF jsonb_typeof(row->'current') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    FOR field,v IN SELECT key,value FROM jsonb_each(row) WHERE key NOT IN ('start','end','current') LOOP
     lim:=CASE WHEN field='qualification' THEN 300 ELSE 200 END;
     IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(v#>>'{}')>lim THEN RETURN false; END IF;
    END LOOP;
    FOR d IN SELECT row->'start' UNION ALL SELECT row->'end' LOOP
     IF d<>'null'::jsonb THEN
      IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT d ?& ARRAY['value','precision'] OR d-ARRAY['value','precision']<>'{}'::jsonb
       OR jsonb_typeof(d->'value') IS DISTINCT FROM 'string' OR jsonb_typeof(d->'precision') IS DISTINCT FROM 'string'
       OR d->>'value' !~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$' OR d->>'precision' NOT IN ('year','month','day') THEN RETURN false; END IF;
     END IF;
    END LOOP;
   END IF;
  END LOOP;
 END LOOP;
 -- Inspect free text, not structured dates (an ISO date is not a phone number).
 FOR v IN
  SELECT j->'displayName' UNION ALL SELECT j->'headline'
  UNION ALL SELECT jsonb_path_query(j,'lax $.currentLocation.* ? (@.type() == "string")')
  UNION ALL SELECT jsonb_path_query(j,'strict $.skills[*]')
  UNION ALL SELECT jsonb_path_query(j,'strict $.employment[*].employer')
  UNION ALL SELECT jsonb_path_query(j,'strict $.employment[*].title')
  UNION ALL SELECT jsonb_path_query(j,'strict $.education[*].institution')
  UNION ALL SELECT jsonb_path_query(j,'strict $.education[*].qualification') LOOP
  IF (v#>>'{}') ~* '[[:alnum:]_.+%\-]+@[[:alnum:].\-]+\.[[:alpha:]]{2,}'
   OR (v#>>'{}') ~ '\+?[0-9][0-9 ().\-]{7,}[0-9]' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION public.signal_network_candidate_materialize(p_tenant text,p_hit jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET statement_timeout='3s' SET lock_timeout='1s' AS $$
DECLARE authority jsonb; uid uuid; c public.candidates%ROWTYPE; old public.candidate_network_sources%ROWTYPE;
BEGIN
 authority:=p_hit-ARRAY['kind','identity','globalCandidateId','encoderVersion','observedAt','facts','similarity'];
 IF p_tenant IS NULL OR p_tenant !~ '^org_[1-9][0-9]*$' OR NOT public.signal_network_authority_valid(authority)
  OR p_hit->>'kind' IS DISTINCT FROM 'candidate_network' OR p_hit->>'identity' IS DISTINCT FROM 'network:'||(p_hit->>'subjectId')
  OR p_hit->'encoderVersion' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p_hit->'facts') IS DISTINCT FROM 'object'
  OR octet_length(p_hit::text)>524288 OR jsonb_typeof(p_hit->'globalCandidateId') IS DISTINCT FROM 'string'
  OR p_hit->>'globalCandidateId' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR p_hit->>'globalCandidateId'='00000000-0000-0000-0000-000000000000'
  OR jsonb_typeof(p_hit->'observedAt') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(p_hit->>'observedAt','timestamptz')
  OR (p_hit->>'observedAt')::timestamptz>clock_timestamp()+interval '5 seconds'
  OR jsonb_typeof(p_hit->'similarity') IS DISTINCT FROM 'number' OR (p_hit->>'similarity')::numeric NOT BETWEEN -1 AND 1
  OR NOT public.signal_network_facts_valid(p_hit->'facts')
  OR encode(sha256(convert_to(public.signal_ranking_canonical(p_hit->'facts'),'UTF8')),'hex') IS DISTINCT FROM p_hit->>'contentHash'
 THEN RAISE EXCEPTION 'NETWORK_PUBLICATION_INVALID'; END IF;
 uid:=(p_hit->>'subjectId')::uuid;
 INSERT INTO public.candidates(id,"tenantId","identityKind","networkSubjectRef","linkedinUrl","linkedinId",
   "captureSource","enrichmentStatus","createdAt","updatedAt")
 VALUES(gen_random_uuid()::text,p_tenant,'candidate_network',uid,NULL,NULL,'candidate_network','completed',clock_timestamp(),clock_timestamp())
 ON CONFLICT("tenantId","networkSubjectRef") DO NOTHING;
 SELECT * INTO STRICT c FROM public.candidates WHERE "tenantId"=p_tenant AND "networkSubjectRef"=uid FOR UPDATE;
 IF c."identityKind"<>'candidate_network' THEN RAISE EXCEPTION 'NETWORK_IDENTITY_CONFLICT'; END IF;
 INSERT INTO public.candidate_network_sources(tenant_id,candidate_id,publication_id,subject_id,global_candidate_id,authority,hit)
 VALUES(p_tenant,c.id,(p_hit->>'publicationId')::uuid,uid,(p_hit->>'globalCandidateId')::uuid,authority,p_hit-'similarity') ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT old FROM public.candidate_network_sources WHERE tenant_id=p_tenant AND publication_id=(p_hit->>'publicationId')::uuid;
 IF old.candidate_id<>c.id OR old.hit<>p_hit-'similarity' THEN RAISE EXCEPTION 'NETWORK_PUBLICATION_CONFLICT'; END IF;
 INSERT INTO public.candidate_global_links(id,"tenantId","candidateId","globalCandidateId","linkedAt","matchMethod")
 VALUES(gen_random_uuid()::text,p_tenant,c.id,p_hit->>'globalCandidateId',clock_timestamp(),'network_subject_exact') ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.candidate_global_links WHERE "tenantId"=p_tenant AND "candidateId"=c.id AND "globalCandidateId"=p_hit->>'globalCandidateId') THEN
  RAISE EXCEPTION 'NETWORK_IDENTITY_CONFLICT'; END IF;
 RETURN c.id;
END $$;

CREATE FUNCTION public.signal_network_evidence_bound(p_tenant text,j jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.candidate_network_sources s JOIN public.candidates c
   ON c."tenantId"=s.tenant_id AND c.id=s.candidate_id
  WHERE s.tenant_id=p_tenant AND s.candidate_id=j->>'candidateId' AND c."identityKind"='candidate_network'
    AND c."networkSubjectRef"=s.subject_id AND j->'networkIdentity'=s.authority)
$$;

-- Grants are deliberately closed here; the reviewed runtime provisioner opens
-- only materialization and the historical redacted reader, never table access.
CREATE FUNCTION public.signal_network_evidence_canonical(j jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE a jsonb; s jsonb; f jsonb; role jsonb;
BEGIN
 a:=j->'networkIdentity';s:=j->'employmentSources'->0;
 IF NOT public.signal_network_authority_valid(a) OR j->>'version' IS DISTINCT FROM 'rubric-evidence-v2'
  OR j->'employment' IS DISTINCT FROM '[]'::jsonb OR jsonb_typeof(j->'employmentSources') IS DISTINCT FROM 'array'
  OR jsonb_array_length(j->'employmentSources')<>1 OR octet_length(j::text)>65536
  OR jsonb_typeof(s) IS DISTINCT FROM 'object'
  OR NOT s ?& ARRAY['kind','scope','organizationRef','sourceVersion','sourceHash','observedAt','referenceId','intervals']
  OR s-ARRAY['kind','scope','organizationRef','sourceVersion','sourceHash','observedAt','referenceId','intervals']<>'{}'::jsonb
  OR s->>'kind' IS DISTINCT FROM 'candidate_provided' OR s->>'scope' IS DISTINCT FROM 'public'
  OR s->'organizationRef' IS DISTINCT FROM 'null'::jsonb
  OR s->>'sourceVersion' IS DISTINCT FROM a->>'contentHash' OR s->>'sourceHash' IS DISTINCT FROM a->>'contentHash'
  OR s->>'referenceId' IS DISTINCT FROM a->>'publicationId'
  OR jsonb_typeof(s->'observedAt') IS DISTINCT FROM 'string' OR length(s->>'observedAt')>40
  OR s->>'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
  OR NOT pg_input_is_valid(s->>'observedAt','timestamptz')
  OR jsonb_typeof(s->'intervals') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'intervals')>200 THEN
  RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 -- Reuse frozen scalar/fact validation, never weaken its private-source branch.
 PERFORM public.signal_ranking_rebuild('evidence',(j-ARRAY['networkIdentity','employmentSources'])||jsonb_build_object('version','rubric-evidence-v1'));
 FOR f IN SELECT value FROM jsonb_array_elements(j->'facts') LOOP
  IF f->>'kind' IS DISTINCT FROM 'candidate_provided' OR f->>'scope' IS DISTINCT FROM 'public'
   OR f->'organizationRef' IS DISTINCT FROM 'null'::jsonb OR f->>'sourceVersion' IS DISTINCT FROM a->>'contentHash'
   OR f->>'observedAt' IS DISTINCT FROM s->>'observedAt' OR left(f->>'ref',8) IS DISTINCT FROM 'network.' THEN
   RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 END LOOP;
 FOR role IN SELECT value FROM jsonb_array_elements(s->'intervals') LOOP
  PERFORM public.signal_ranking_rebuild('employment',role);
 END LOOP;
 RETURN public.signal_ranking_canonical(j);
END $$;

-- Exact single insertion leaves the historical v1/v2 validators untouched.
DO $$ DECLARE d text; needle text:='BEGIN
-- Inserted before the frozen v1 CASE in signal_ranking_rebuild.'; BEGIN
 SELECT pg_get_functiondef('public.signal_ranking_rebuild(text,jsonb)'::regprocedure) INTO d;
 IF (length(d)-length(replace(d,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'NETWORK_RANKING_ROUTINE_DRIFT'; END IF;
 d:=replace(d,needle,'BEGIN
 IF p_kind=''evidence'' AND j ? ''networkIdentity'' THEN RETURN public.signal_network_evidence_canonical(j); END IF;
-- Inserted before the frozen v1 CASE in signal_ranking_rebuild.');
 EXECUTE d;
END $$;

CREATE OR REPLACE FUNCTION public.signal_private_evidence_bound(p_tenant text,p_evidence jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
SET statement_timeout='3s' SET lock_timeout='1s' AS $$
 SELECT CASE WHEN p_evidence ? 'networkIdentity' THEN public.signal_network_evidence_bound(p_tenant,p_evidence)
 ELSE EXISTS(SELECT 1 FROM public.candidates c WHERE c."tenantId"=p_tenant AND c.id=p_evidence->>'candidateId'
  AND ((c."identityKind"='linkedin' AND NOT p_evidence ? 'resumeIdentity')
   OR (c."identityKind"='organization_candidate' AND p_evidence->>'version'='rubric-evidence-v2'
    AND EXISTS(SELECT 1 FROM public.private_candidate_sources s WHERE s.tenant_id=p_tenant AND s.candidate_id=c.id
     AND p_evidence->'resumeIdentity'=jsonb_build_object('candidateId',s.memory_candidate_id,'referenceId',s.reference_id,
       'applicationId',s.application_id,'applicationJobId',s.application_job_id,'resumeVersionId',s.resume_version_id,
       'sourceId',s.source_id,'generationId',s.generation_id,'sourceHash',s.source_hash))))) END;
$$;

DO $$ DECLARE d text; old_keys text:='ARRAY[''employmentSources'',''resumeIdentity'']'; BEGIN
 SELECT pg_get_functiondef('public.signal_rc_prepare(text,uuid,jsonb)'::regprocedure) INTO d;
 IF (length(d)-length(replace(d,old_keys,'')))/length(old_keys)<>1 THEN RAISE EXCEPTION 'NETWORK_RC_ROUTINE_DRIFT'; END IF;
 EXECUTE replace(d,old_keys,'ARRAY[''employmentSources'',''resumeIdentity'',''networkIdentity'']');
 SELECT pg_get_constraintdef(oid) INTO STRICT d FROM pg_constraint
  WHERE conrelid='public.governed_ranking_items'::regclass AND conname='gr_item_shape_ck';
 IF (length(d)-length(replace(d,'''resumeIdentity''::text','')))/length('''resumeIdentity''::text')<>1 THEN
  RAISE EXCEPTION 'NETWORK_RANKING_CONSTRAINT_DRIFT'; END IF;
 ALTER TABLE public.governed_ranking_items DROP CONSTRAINT gr_item_shape_ck;
 EXECUTE 'ALTER TABLE public.governed_ranking_items ADD CONSTRAINT gr_item_shape_ck '||
  replace(d,'''resumeIdentity''::text','''resumeIdentity''::text, ''networkIdentity''::text');
END $$;

CREATE FUNCTION public.signal_network_ranking_sources(p_tenant text,p_flow uuid,p_revision uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
SET statement_timeout='3s' SET lock_timeout='1s' AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.governed_ranking_runs WHERE tenant_id=p_tenant AND flow_run_id=p_flow
   AND revision_id=p_revision AND state='ready') THEN RAISE EXCEPTION 'NETWORK_RANKING_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM public.governed_ranking_items i WHERE i.tenant_id=p_tenant AND i.flow_run_id=p_flow
   AND i.revision_id=p_revision AND i.evidence ? 'networkIdentity' AND NOT public.signal_network_evidence_bound(p_tenant,i.evidence)) THEN
   RAISE EXCEPTION 'NETWORK_RANKING_UNAVAILABLE'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('candidateId',i.candidate_id,'hit',s.hit) ORDER BY i.ordinal),'[]'::jsonb)
 INTO result FROM public.governed_ranking_items i JOIN public.candidate_network_sources s
  ON s.tenant_id=i.tenant_id AND s.candidate_id=i.candidate_id AND s.authority=i.evidence->'networkIdentity'
 WHERE i.tenant_id=p_tenant AND i.flow_run_id=p_flow AND i.revision_id=p_revision AND i.selected_ordinal IS NOT NULL;
 IF jsonb_array_length(result)>100 OR octet_length(result::text)>33554432 THEN RAISE EXCEPTION 'NETWORK_RANKING_UNAVAILABLE'; END IF;
 RETURN result;
END $$;

REVOKE ALL ON public.candidate_network_sources FROM PUBLIC;
REVOKE ALL ON FUNCTION public.signal_network_identity_immutable(),public.signal_network_authority_valid(jsonb),
 public.signal_network_facts_valid(jsonb),
 public.signal_network_candidate_materialize(text,jsonb),public.signal_network_evidence_bound(text,jsonb),
 public.signal_network_evidence_canonical(jsonb),public.signal_network_ranking_sources(text,uuid,uuid) FROM PUBLIC;

-- Neutralise inherited default grants for every non-owner, not just PUBLIC.
DO $$ DECLARE r record; f record; BEGIN
 FOR r IN SELECT rolname,oid FROM pg_roles LOOP
  IF r.oid<>(SELECT relowner FROM pg_class WHERE oid='public.candidate_network_sources'::regclass) THEN
   EXECUTE format('REVOKE ALL ON public.candidate_network_sources FROM %I',r.rolname);
  END IF;
  FOR f IN SELECT p.oid::regprocedure AS signature,p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND starts_with(p.proname,'signal_network_') LOOP
   IF r.oid<>f.proowner THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r.rolname); END IF;
  END LOOP;
 END LOOP;
END $$;
