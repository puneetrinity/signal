-- Stage 1 only. Ship while governed sourcing is OFF; requires the new transaction wrapper.
-- Prior migrations remain immutable. No new tables, retry counters or provider authority.
CREATE FUNCTION public.signal_ranking_canonical(p_value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $canonical$
  WITH RECURSIVE nodes(value,path,prefix) AS (
    SELECT p_value, ARRAY[]::bigint[], ''::text
    UNION ALL
    SELECT child.value,n.path||child.position,child.prefix
    FROM nodes n CROSS JOIN LATERAL (
      SELECT e.value,row_number() OVER(ORDER BY e.key COLLATE "C") AS position,
        CASE WHEN row_number() OVER(ORDER BY e.key COLLATE "C")>1 THEN ',' ELSE '' END||to_jsonb(e.key)::text||':' AS prefix
      FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT a.value,a.ordinality,CASE WHEN a.ordinality>1 THEN ',' ELSE '' END
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ordinality)
    ) child
  ), tokens AS (
    SELECT path||0::bigint AS path,prefix||CASE jsonb_typeof(value) WHEN 'object' THEN '{' WHEN 'array' THEN '[' ELSE value::text END AS token FROM nodes
    UNION ALL
    SELECT path||9223372036854775807::bigint,CASE jsonb_typeof(value) WHEN 'object' THEN '}' ELSE ']' END FROM nodes WHERE jsonb_typeof(value) IN ('object','array')
  ) SELECT string_agg(token,'' ORDER BY path) FROM tokens;
$canonical$;
REVOKE ALL ON FUNCTION public.signal_ranking_canonical(jsonb) FROM PUBLIC;

-- BEGIN LAYOUT TRANSPORT: reviewed fixed shapes, never a generic JSON walker.
CREATE FUNCTION public.signal_ranking_transport_parse(p_text text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $parse$
BEGIN
 IF p_text IS NULL OR octet_length(p_text)>67108864 OR pg_input_is_valid(p_text,'jsonb') IS NOT TRUE
 THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_TEXT'; END IF;
 RETURN p_text::jsonb;
END;
$parse$;
REVOKE ALL ON FUNCTION public.signal_ranking_transport_parse(text) FROM PUBLIC;

CREATE FUNCTION public.signal_ranking_rebuild(p_kind text,j jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $layout$
DECLARE body text; employment_text text; facts_text text; assessments_text text; good boolean;
BEGIN
 CASE p_kind
 WHEN 'employment' THEN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 IF NOT ((jsonb_typeof(j)='object' AND j-ARRAY['employmentType','end','ongoing','start','title']::text[]='{}'::jsonb AND j ?& ARRAY[]::text[] AND (NOT j ? 'employmentType' OR (jsonb_typeof((j->'employmentType'))='string' AND CASE WHEN length(((j->'employmentType')#>>'{}')) BETWEEN 0 AND 50 THEN true WHEN length(((j->'employmentType')#>>'{}')) BETWEEN 0 AND 100 THEN length(((j->'employmentType')#>>'{}'))+CASE WHEN octet_length(((j->'employmentType')#>>'{}'))=length(((j->'employmentType')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'employmentType')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 100 ELSE false END)) AND (NOT j ? 'end' OR (((j->'end')='null'::jsonb OR (jsonb_typeof((j->'end'))='string' AND CASE WHEN length(((j->'end')#>>'{}')) BETWEEN 0 AND 20 THEN true WHEN length(((j->'end')#>>'{}')) BETWEEN 0 AND 40 THEN length(((j->'end')#>>'{}'))+CASE WHEN octet_length(((j->'end')#>>'{}'))=length(((j->'end')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'end')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 40 ELSE false END)))) AND (NOT j ? 'ongoing' OR (jsonb_typeof((j->'ongoing'))='boolean')) AND (NOT j ? 'start' OR (((j->'start')='null'::jsonb OR (jsonb_typeof((j->'start'))='string' AND CASE WHEN length(((j->'start')#>>'{}')) BETWEEN 0 AND 20 THEN true WHEN length(((j->'start')#>>'{}')) BETWEEN 0 AND 40 THEN length(((j->'start')#>>'{}'))+CASE WHEN octet_length(((j->'start')#>>'{}'))=length(((j->'start')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'start')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 40 ELSE false END)))) AND (NOT j ? 'title' OR (jsonb_typeof((j->'title'))='string' AND CASE WHEN length(((j->'title')#>>'{}')) BETWEEN 0 AND 250 THEN true WHEN length(((j->'title')#>>'{}')) BETWEEN 0 AND 500 THEN length(((j->'title')#>>'{}'))+CASE WHEN octet_length(((j->'title')#>>'{}'))=length(((j->'title')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'title')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 500 ELSE false END))) IS TRUE) THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 body:='{'||concat_ws(',',CASE WHEN j ? 'employmentType' THEN '"employmentType":'||((j->'employmentType')::text) END,CASE WHEN j ? 'end' THEN '"end":'||((j->'end')::text) END,CASE WHEN j ? 'ongoing' THEN '"ongoing":'||((j->'ongoing')::text) END,CASE WHEN j ? 'start' THEN '"start":'||((j->'start')::text) END,CASE WHEN j ? 'title' THEN '"title":'||((j->'title')::text) END)||'}';
 WHEN 'fact' THEN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 IF NOT ((jsonb_typeof(j)='object' AND j-ARRAY['field','kind','observedAt','organizationRef','qualifier','ref','revoked','scope','sourceVersion','validUntil','value']::text[]='{}'::jsonb AND j ?& ARRAY['field','kind','observedAt','organizationRef','ref','scope','sourceVersion','value']::text[] AND (jsonb_typeof((j->'field'))='string' AND ((j->'field')#>>'{}') = ANY(ARRAY['title','skill','seniority','function','domain','city','country','work_arrangement','certification','language','education_requirement','work_eligibility']::text[])) AND (jsonb_typeof((j->'kind'))='string' AND ((j->'kind')#>>'{}') = ANY(ARRAY['profile_evidence','candidate_provided','verified_document']::text[])) AND (jsonb_typeof((j->'observedAt'))='string' AND ((j->'observedAt')#>>'{}') ~ '^(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|(02)-(0[1-9]|1[0-9]|2[0-8])))T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z)$') AND (((j->'organizationRef')='null'::jsonb OR (jsonb_typeof((j->'organizationRef'))='string'))) AND (NOT j ? 'qualifier' OR (jsonb_typeof((j->'qualifier'))='string' AND CASE WHEN length(((j->'qualifier')#>>'{}')) BETWEEN 0 AND 80 THEN true WHEN length(((j->'qualifier')#>>'{}')) BETWEEN 0 AND 160 THEN length(((j->'qualifier')#>>'{}'))+CASE WHEN octet_length(((j->'qualifier')#>>'{}'))=length(((j->'qualifier')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'qualifier')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 160 ELSE false END)) AND (jsonb_typeof((j->'ref'))='string' AND CASE WHEN length(((j->'ref')#>>'{}')) BETWEEN 1 AND 80 THEN true WHEN length(((j->'ref')#>>'{}')) BETWEEN 1 AND 160 THEN length(((j->'ref')#>>'{}'))+CASE WHEN octet_length(((j->'ref')#>>'{}'))=length(((j->'ref')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'ref')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 1 AND 160 ELSE false END) AND (NOT j ? 'revoked' OR (jsonb_typeof((j->'revoked'))='boolean')) AND (jsonb_typeof((j->'scope'))='string' AND ((j->'scope')#>>'{}') = ANY(ARRAY['public','organization']::text[])) AND (jsonb_typeof((j->'sourceVersion'))='string' AND CASE WHEN length(((j->'sourceVersion')#>>'{}')) BETWEEN 1 AND 50 THEN true WHEN length(((j->'sourceVersion')#>>'{}')) BETWEEN 1 AND 100 THEN length(((j->'sourceVersion')#>>'{}'))+CASE WHEN octet_length(((j->'sourceVersion')#>>'{}'))=length(((j->'sourceVersion')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'sourceVersion')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 1 AND 100 ELSE false END) AND (NOT j ? 'validUntil' OR (jsonb_typeof((j->'validUntil'))='string' AND ((j->'validUntil')#>>'{}') ~ '^(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|(02)-(0[1-9]|1[0-9]|2[0-8])))T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z)$')) AND (jsonb_typeof((j->'value'))='string' AND CASE WHEN length(((j->'value')#>>'{}')) BETWEEN 1 AND 250 THEN true WHEN length(((j->'value')#>>'{}')) BETWEEN 1 AND 500 THEN length(((j->'value')#>>'{}'))+CASE WHEN octet_length(((j->'value')#>>'{}'))=length(((j->'value')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'value')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 1 AND 500 ELSE false END) AND CASE WHEN j->>'scope'='organization' THEN length(j->>'organizationRef')>0 ELSE j->'organizationRef'='null'::jsonb END) IS TRUE) THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 body:='{'||concat_ws(',','"field":'||((j->'field')::text),'"kind":'||((j->'kind')::text),'"observedAt":'||((j->'observedAt')::text),'"organizationRef":'||((j->'organizationRef')::text),CASE WHEN j ? 'qualifier' THEN '"qualifier":'||((j->'qualifier')::text) END,'"ref":'||((j->'ref')::text),CASE WHEN j ? 'revoked' THEN '"revoked":'||((j->'revoked')::text) END,'"scope":'||((j->'scope')::text),'"sourceVersion":'||((j->'sourceVersion')::text),CASE WHEN j ? 'validUntil' THEN '"validUntil":'||((j->'validUntil')::text) END,'"value":'||((j->'value')::text))||'}';
 WHEN 'evidence' THEN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 IF NOT ((jsonb_typeof(j)='object' AND j-ARRAY['candidateId','employment','facts','organizationRef','presentationSource','version']::text[]='{}'::jsonb AND j ?& ARRAY['candidateId','employment','facts','organizationRef','version']::text[] AND (jsonb_typeof((j->'candidateId'))='string' AND CASE WHEN length(((j->'candidateId')#>>'{}')) BETWEEN 1 AND 100 THEN true WHEN length(((j->'candidateId')#>>'{}')) BETWEEN 1 AND 200 THEN length(((j->'candidateId')#>>'{}'))+CASE WHEN octet_length(((j->'candidateId')#>>'{}'))=length(((j->'candidateId')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'candidateId')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 1 AND 200 ELSE false END) AND (CASE WHEN jsonb_typeof((j->'employment'))='array' THEN jsonb_array_length((j->'employment')) BETWEEN 0 AND 500 ELSE false END) AND (CASE WHEN jsonb_typeof((j->'facts'))='array' THEN jsonb_array_length((j->'facts')) BETWEEN 0 AND 1000 ELSE false END) AND (jsonb_typeof((j->'organizationRef'))='string' AND ((j->'organizationRef')#>>'{}') ~ '^[1-9][0-9]*$') AND (NOT j ? 'presentationSource' OR (jsonb_typeof((j->'presentationSource'))='string' AND ((j->'presentationSource')#>>'{}') = ANY(ARRAY['pool','pool_enriched','discovered']::text[]))) AND (jsonb_typeof((j->'version'))='string' AND ((j->'version')#>>'{}') = ANY(ARRAY['rubric-evidence-v1']::text[]))) IS TRUE) THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 SELECT bool_and((jsonb_typeof(e)='object' AND e-ARRAY['employmentType','end','ongoing','start','title']::text[]='{}'::jsonb AND e ?& ARRAY[]::text[] AND (NOT e ? 'employmentType' OR (jsonb_typeof((e->'employmentType'))='string' AND CASE WHEN length(((e->'employmentType')#>>'{}')) BETWEEN 0 AND 50 THEN true WHEN length(((e->'employmentType')#>>'{}')) BETWEEN 0 AND 100 THEN length(((e->'employmentType')#>>'{}'))+CASE WHEN octet_length(((e->'employmentType')#>>'{}'))=length(((e->'employmentType')#>>'{}')) THEN 0 ELSE length(regexp_replace(((e->'employmentType')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 100 ELSE false END)) AND (NOT e ? 'end' OR (((e->'end')='null'::jsonb OR (jsonb_typeof((e->'end'))='string' AND CASE WHEN length(((e->'end')#>>'{}')) BETWEEN 0 AND 20 THEN true WHEN length(((e->'end')#>>'{}')) BETWEEN 0 AND 40 THEN length(((e->'end')#>>'{}'))+CASE WHEN octet_length(((e->'end')#>>'{}'))=length(((e->'end')#>>'{}')) THEN 0 ELSE length(regexp_replace(((e->'end')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 40 ELSE false END)))) AND (NOT e ? 'ongoing' OR (jsonb_typeof((e->'ongoing'))='boolean')) AND (NOT e ? 'start' OR (((e->'start')='null'::jsonb OR (jsonb_typeof((e->'start'))='string' AND CASE WHEN length(((e->'start')#>>'{}')) BETWEEN 0 AND 20 THEN true WHEN length(((e->'start')#>>'{}')) BETWEEN 0 AND 40 THEN length(((e->'start')#>>'{}'))+CASE WHEN octet_length(((e->'start')#>>'{}'))=length(((e->'start')#>>'{}')) THEN 0 ELSE length(regexp_replace(((e->'start')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 40 ELSE false END)))) AND (NOT e ? 'title' OR (jsonb_typeof((e->'title'))='string' AND CASE WHEN length(((e->'title')#>>'{}')) BETWEEN 0 AND 250 THEN true WHEN length(((e->'title')#>>'{}')) BETWEEN 0 AND 500 THEN length(((e->'title')#>>'{}'))+CASE WHEN octet_length(((e->'title')#>>'{}'))=length(((e->'title')#>>'{}')) THEN 0 ELSE length(regexp_replace(((e->'title')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 500 ELSE false END))) IS TRUE), '['||coalesce(string_agg('{'||concat_ws(',',CASE WHEN e ? 'employmentType' THEN '"employmentType":'||((e->'employmentType')::text) END,CASE WHEN e ? 'end' THEN '"end":'||((e->'end')::text) END,CASE WHEN e ? 'ongoing' THEN '"ongoing":'||((e->'ongoing')::text) END,CASE WHEN e ? 'start' THEN '"start":'||((e->'start')::text) END,CASE WHEN e ? 'title' THEN '"title":'||((e->'title')::text) END)||'}' ,',' ORDER BY o),'')||']' INTO good,employment_text FROM jsonb_array_elements(j->'employment') WITH ORDINALITY a(e,o);
 IF jsonb_array_length(j->'employment')>0 AND good IS NOT TRUE THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 SELECT bool_and((jsonb_typeof(e)='object' AND e-ARRAY['field','kind','observedAt','organizationRef','qualifier','ref','revoked','scope','sourceVersion','validUntil','value']::text[]='{}'::jsonb AND e ?& ARRAY['field','kind','observedAt','organizationRef','ref','scope','sourceVersion','value']::text[] AND (jsonb_typeof((e->'field'))='string' AND ((e->'field')#>>'{}') = ANY(ARRAY['title','skill','seniority','function','domain','city','country','work_arrangement','certification','language','education_requirement','work_eligibility']::text[])) AND (jsonb_typeof((e->'kind'))='string' AND ((e->'kind')#>>'{}') = ANY(ARRAY['profile_evidence','candidate_provided','verified_document']::text[])) AND (jsonb_typeof((e->'observedAt'))='string') AND (((e->'organizationRef')='null'::jsonb OR (jsonb_typeof((e->'organizationRef'))='string'))) AND (NOT e ? 'qualifier' OR (jsonb_typeof((e->'qualifier'))='string' AND CASE WHEN length(((e->'qualifier')#>>'{}')) BETWEEN 0 AND 80 THEN true WHEN length(((e->'qualifier')#>>'{}')) BETWEEN 0 AND 160 THEN length(((e->'qualifier')#>>'{}'))+CASE WHEN octet_length(((e->'qualifier')#>>'{}'))=length(((e->'qualifier')#>>'{}')) THEN 0 ELSE length(regexp_replace(((e->'qualifier')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 160 ELSE false END)) AND (jsonb_typeof((e->'ref'))='string' AND CASE WHEN length(((e->'ref')#>>'{}')) BETWEEN 1 AND 80 THEN true WHEN length(((e->'ref')#>>'{}')) BETWEEN 1 AND 160 THEN length(((e->'ref')#>>'{}'))+CASE WHEN octet_length(((e->'ref')#>>'{}'))=length(((e->'ref')#>>'{}')) THEN 0 ELSE length(regexp_replace(((e->'ref')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 1 AND 160 ELSE false END) AND (NOT e ? 'revoked' OR (jsonb_typeof((e->'revoked'))='boolean')) AND (jsonb_typeof((e->'scope'))='string' AND ((e->'scope')#>>'{}') = ANY(ARRAY['public','organization']::text[])) AND (jsonb_typeof((e->'sourceVersion'))='string' AND CASE WHEN length(((e->'sourceVersion')#>>'{}')) BETWEEN 1 AND 50 THEN true WHEN length(((e->'sourceVersion')#>>'{}')) BETWEEN 1 AND 100 THEN length(((e->'sourceVersion')#>>'{}'))+CASE WHEN octet_length(((e->'sourceVersion')#>>'{}'))=length(((e->'sourceVersion')#>>'{}')) THEN 0 ELSE length(regexp_replace(((e->'sourceVersion')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 1 AND 100 ELSE false END) AND (NOT e ? 'validUntil' OR (jsonb_typeof((e->'validUntil'))='string')) AND (jsonb_typeof((e->'value'))='string' AND CASE WHEN length(((e->'value')#>>'{}')) BETWEEN 1 AND 250 THEN true WHEN length(((e->'value')#>>'{}')) BETWEEN 1 AND 500 THEN length(((e->'value')#>>'{}'))+CASE WHEN octet_length(((e->'value')#>>'{}'))=length(((e->'value')#>>'{}')) THEN 0 ELSE length(regexp_replace(((e->'value')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 1 AND 500 ELSE false END) AND CASE WHEN e->>'scope'='organization' THEN length(e->>'organizationRef')>0 ELSE e->'organizationRef'='null'::jsonb END) IS TRUE), '['||coalesce(string_agg('{'||concat_ws(',','"field":'||((e->'field')::text),'"kind":'||((e->'kind')::text),'"observedAt":'||((e->'observedAt')::text),'"organizationRef":'||((e->'organizationRef')::text),CASE WHEN e ? 'qualifier' THEN '"qualifier":'||((e->'qualifier')::text) END,'"ref":'||((e->'ref')::text),CASE WHEN e ? 'revoked' THEN '"revoked":'||((e->'revoked')::text) END,'"scope":'||((e->'scope')::text),'"sourceVersion":'||((e->'sourceVersion')::text),CASE WHEN e ? 'validUntil' THEN '"validUntil":'||((e->'validUntil')::text) END,'"value":'||((e->'value')::text))||'}' ,',' ORDER BY o),'')||']' INTO good,facts_text FROM jsonb_array_elements(j->'facts') WITH ORDINALITY a(e,o);
 IF jsonb_array_length(j->'facts')>0 AND good IS NOT TRUE THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 -- Validate every distinct timestamp once, after all fact types pass.
 IF EXISTS(SELECT 1 FROM (
  SELECT DISTINCT d.value FROM jsonb_array_elements(j->'facts') f
  CROSS JOIN LATERAL (VALUES(f->>'observedAt'),(f->>'validUntil')) d(value)
  WHERE d.value IS NOT NULL
 ) dates WHERE (value ~ '^(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|(02)-(0[1-9]|1[0-9]|2[0-8])))T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z)$'
) IS NOT TRUE)
 THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 IF octet_length(j::text)>65536 OR EXISTS(SELECT 1 FROM jsonb_array_elements(j->'facts') f WHERE f->>'scope'='organization' AND f->>'organizationRef' IS DISTINCT FROM j->>'organizationRef') THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 body:='{'||concat_ws(',','"candidateId":'||((j->'candidateId')::text),'"employment":'||(employment_text),'"facts":'||(facts_text),'"organizationRef":'||((j->'organizationRef')::text),CASE WHEN j ? 'presentationSource' THEN '"presentationSource":'||((j->'presentationSource')::text) END,'"version":'||((j->'version')::text))||'}';
 WHEN 'withheld' THEN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 IF NOT ((jsonb_typeof(j)='object' AND j-ARRAY['bytes','candidateId','evidenceHash','limit','reason']::text[]='{}'::jsonb AND j ?& ARRAY['bytes','candidateId','evidenceHash','limit','reason']::text[] AND (CASE WHEN jsonb_typeof((j->'bytes'))='number' THEN ((j->'bytes')#>>'{}')::numeric BETWEEN 65537 AND 9007199254740991 AND ((j->'bytes')#>>'{}')::numeric=trunc(((j->'bytes')#>>'{}')::numeric) ELSE false END) AND (jsonb_typeof((j->'candidateId'))='string' AND CASE WHEN length(((j->'candidateId')#>>'{}')) BETWEEN 1 AND 100 THEN true WHEN length(((j->'candidateId')#>>'{}')) BETWEEN 1 AND 200 THEN length(((j->'candidateId')#>>'{}'))+CASE WHEN octet_length(((j->'candidateId')#>>'{}'))=length(((j->'candidateId')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'candidateId')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 1 AND 200 ELSE false END) AND (jsonb_typeof((j->'evidenceHash'))='string' AND CASE WHEN length(((j->'evidenceHash')#>>'{}')) BETWEEN 64 AND 32 THEN true WHEN length(((j->'evidenceHash')#>>'{}')) BETWEEN 64 AND 64 THEN length(((j->'evidenceHash')#>>'{}'))+CASE WHEN octet_length(((j->'evidenceHash')#>>'{}'))=length(((j->'evidenceHash')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'evidenceHash')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 64 AND 64 ELSE false END AND ((j->'evidenceHash')#>>'{}') ~ '^[a-f0-9]{64}$') AND (CASE WHEN jsonb_typeof((j->'limit'))='number' THEN ((j->'limit')#>>'{}')::numeric BETWEEN 65536 AND 65536 AND ((j->'limit')#>>'{}')::numeric=trunc(((j->'limit')#>>'{}')::numeric) ELSE false END) AND (jsonb_typeof((j->'reason'))='string' AND CASE WHEN length(((j->'reason')#>>'{}')) BETWEEN 0 AND 250 THEN true WHEN length(((j->'reason')#>>'{}')) BETWEEN 0 AND 500 THEN length(((j->'reason')#>>'{}'))+CASE WHEN octet_length(((j->'reason')#>>'{}'))=length(((j->'reason')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'reason')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 500 ELSE false END AND ((j->'reason')#>>'{}') = ANY(ARRAY['evidence_too_large']::text[]))) IS TRUE) THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 body:='{'||concat_ws(',','"bytes":'||(CASE WHEN (j->'bytes')='null'::jsonb THEN 'null' ELSE (((j->'bytes')#>>'{}')::numeric::bigint)::text END),'"candidateId":'||((j->'candidateId')::text),'"evidenceHash":'||((j->'evidenceHash')::text),'"limit":'||(CASE WHEN (j->'limit')='null'::jsonb THEN 'null' ELSE (((j->'limit')#>>'{}')::numeric::bigint)::text END),'"reason":'||((j->'reason')::text))||'}';
 WHEN 'experience' THEN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 IF NOT ((jsonb_typeof(j)='object' AND j-ARRAY['asOf','display','lowerDays','reason','status','upperDays','version']::text[]='{}'::jsonb AND j ?& ARRAY['asOf','display','lowerDays','reason','status','upperDays','version']::text[] AND (jsonb_typeof((j->'asOf'))='string' AND ((j->'asOf')#>>'{}') ~ '^(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|(02)-(0[1-9]|1[0-9]|2[0-8])))T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z)$') AND (jsonb_typeof((j->'display'))='string' AND CASE WHEN length(((j->'display')#>>'{}')) BETWEEN 0 AND 100 THEN true WHEN length(((j->'display')#>>'{}')) BETWEEN 0 AND 200 THEN length(((j->'display')#>>'{}'))+CASE WHEN octet_length(((j->'display')#>>'{}'))=length(((j->'display')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'display')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 200 ELSE false END) AND (((j->'lowerDays')='null'::jsonb OR (CASE WHEN jsonb_typeof((j->'lowerDays'))='number' THEN ((j->'lowerDays')#>>'{}')::numeric BETWEEN 0 AND 9007199254740991 AND ((j->'lowerDays')#>>'{}')::numeric=trunc(((j->'lowerDays')#>>'{}')::numeric) ELSE false END))) AND (jsonb_typeof((j->'reason'))='string' AND CASE WHEN length(((j->'reason')#>>'{}')) BETWEEN 0 AND 50 THEN true WHEN length(((j->'reason')#>>'{}')) BETWEEN 0 AND 100 THEN length(((j->'reason')#>>'{}'))+CASE WHEN octet_length(((j->'reason')#>>'{}'))=length(((j->'reason')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'reason')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 100 ELSE false END) AND (jsonb_typeof((j->'status'))='string' AND ((j->'status')#>>'{}') = ANY(ARRAY['measured','bounded','incomplete','unavailable','uncertain_boundary']::text[])) AND (((j->'upperDays')='null'::jsonb OR (CASE WHEN jsonb_typeof((j->'upperDays'))='number' THEN ((j->'upperDays')#>>'{}')::numeric BETWEEN 0 AND 9007199254740991 AND ((j->'upperDays')#>>'{}')::numeric=trunc(((j->'upperDays')#>>'{}')::numeric) ELSE false END))) AND (jsonb_typeof((j->'version'))='string' AND ((j->'version')#>>'{}') = ANY(ARRAY['recorded-experience-v1']::text[]))) IS TRUE) THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 IF (CASE WHEN j->>'status' IN ('measured','bounded') THEN j->'lowerDays'<>'null'::jsonb AND j->'upperDays'<>'null'::jsonb AND (j->>'lowerDays')::numeric<=(j->>'upperDays')::numeric ELSE j->'lowerDays'='null'::jsonb AND j->'upperDays'='null'::jsonb END) IS NOT TRUE THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 body:='{'||concat_ws(',','"asOf":'||((j->'asOf')::text),'"display":'||((j->'display')::text),'"lowerDays":'||(CASE WHEN (j->'lowerDays')='null'::jsonb THEN 'null' ELSE (((j->'lowerDays')#>>'{}')::numeric::bigint)::text END),'"reason":'||((j->'reason')::text),'"status":'||((j->'status')::text),'"upperDays":'||(CASE WHEN (j->'upperDays')='null'::jsonb THEN 'null' ELSE (((j->'upperDays')#>>'{}')::numeric::bigint)::text END),'"version":'||((j->'version')::text))||'}';
 WHEN 'assessment' THEN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 IF NOT ((jsonb_typeof(j)='object' AND j-ARRAY['criterionIds','labels','localPoints','mapped','points','refs','state','subject','weight']::text[]='{}'::jsonb AND j ?& ARRAY['criterionIds','labels','localPoints','mapped','points','refs','state','subject','weight']::text[] AND (CASE WHEN jsonb_typeof((j->'criterionIds'))='array' THEN jsonb_array_length((j->'criterionIds')) BETWEEN 1 AND 12 ELSE false END) AND (CASE WHEN jsonb_typeof((j->'labels'))='array' THEN jsonb_array_length((j->'labels')) BETWEEN 1 AND 12 ELSE false END) AND (CASE WHEN jsonb_typeof((j->'localPoints'))='number' THEN ((j->'localPoints')#>>'{}')::numeric BETWEEN 0 AND 3000000 AND ((j->'localPoints')#>>'{}')::numeric=trunc(((j->'localPoints')#>>'{}')::numeric) ELSE false END) AND (jsonb_typeof((j->'mapped'))='boolean') AND (CASE WHEN jsonb_typeof((j->'points'))='number' THEN ((j->'points')#>>'{}')::numeric BETWEEN 0 AND 3 AND ((j->'points')#>>'{}')::numeric=trunc(((j->'points')#>>'{}')::numeric) ELSE false END) AND (CASE WHEN jsonb_typeof((j->'refs'))='array' THEN jsonb_array_length((j->'refs')) BETWEEN 0 AND 1000 ELSE false END) AND (jsonb_typeof((j->'state'))='string' AND ((j->'state')#>>'{}') = ANY(ARRAY['met','not_met','unknown']::text[])) AND (jsonb_typeof((j->'subject'))='string' AND CASE WHEN length(((j->'subject')#>>'{}')) BETWEEN 0 AND 20 THEN true WHEN length(((j->'subject')#>>'{}')) BETWEEN 0 AND 40 THEN length(((j->'subject')#>>'{}'))+CASE WHEN octet_length(((j->'subject')#>>'{}'))=length(((j->'subject')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'subject')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 40 ELSE false END) AND (CASE WHEN jsonb_typeof((j->'weight'))='number' THEN ((j->'weight')#>>'{}')::numeric BETWEEN 0 AND 3 AND ((j->'weight')#>>'{}')::numeric=trunc(((j->'weight')#>>'{}')::numeric) ELSE false END AND ((j->'weight')#>>'{}') = ANY(ARRAY['0','1','3']::text[]))) IS TRUE) THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 body:='{'||concat_ws(',','"criterionIds":'||('['||coalesce((SELECT string_agg(public.signal_ranking_rebuild('uuid',e),',' ORDER BY o) FROM jsonb_array_elements(j->'criterionIds') WITH ORDINALITY a(e,o)),'')||']'),'"labels":'||('['||coalesce((SELECT string_agg(public.signal_ranking_rebuild('label',e),',' ORDER BY o) FROM jsonb_array_elements(j->'labels') WITH ORDINALITY a(e,o)),'')||']'),'"localPoints":'||(CASE WHEN (j->'localPoints')='null'::jsonb THEN 'null' ELSE (((j->'localPoints')#>>'{}')::numeric::bigint)::text END),'"mapped":'||((j->'mapped')::text),'"points":'||(CASE WHEN (j->'points')='null'::jsonb THEN 'null' ELSE (((j->'points')#>>'{}')::numeric::bigint)::text END),'"refs":'||('['||coalesce((SELECT string_agg(public.signal_ranking_rebuild('ref',e),',' ORDER BY o) FROM jsonb_array_elements(j->'refs') WITH ORDINALITY a(e,o)),'')||']'),'"state":'||((j->'state')::text),'"subject":'||((j->'subject')::text),'"weight":'||(CASE WHEN (j->'weight')='null'::jsonb THEN 'null' ELSE (((j->'weight')#>>'{}')::numeric::bigint)::text END))||'}';
 WHEN 'item' THEN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 IF NOT ((jsonb_typeof(j)='object' AND j-ARRAY['D','L','N','assessments','candidateId','eligibility','experience','ordinal','selectedOrdinal','sourceType']::text[]='{}'::jsonb AND j ?& ARRAY['D','L','N','assessments','candidateId','eligibility','experience','ordinal','selectedOrdinal','sourceType']::text[] AND (CASE WHEN jsonb_typeof((j->'D'))='number' THEN ((j->'D')#>>'{}')::numeric BETWEEN 0 AND 36 AND ((j->'D')#>>'{}')::numeric=trunc(((j->'D')#>>'{}')::numeric) ELSE false END) AND (CASE WHEN jsonb_typeof((j->'L'))='number' THEN ((j->'L')#>>'{}')::numeric BETWEEN 0 AND 36000000 AND ((j->'L')#>>'{}')::numeric=trunc(((j->'L')#>>'{}')::numeric) ELSE false END) AND (CASE WHEN jsonb_typeof((j->'N'))='number' THEN ((j->'N')#>>'{}')::numeric BETWEEN 0 AND 36 AND ((j->'N')#>>'{}')::numeric=trunc(((j->'N')#>>'{}')::numeric) ELSE false END) AND (CASE WHEN jsonb_typeof((j->'assessments'))='array' THEN jsonb_array_length((j->'assessments')) BETWEEN 0 AND 12 ELSE false END) AND (jsonb_typeof((j->'candidateId'))='string' AND CASE WHEN length(((j->'candidateId')#>>'{}')) BETWEEN 1 AND 100 THEN true WHEN length(((j->'candidateId')#>>'{}')) BETWEEN 1 AND 200 THEN length(((j->'candidateId')#>>'{}'))+CASE WHEN octet_length(((j->'candidateId')#>>'{}'))=length(((j->'candidateId')#>>'{}')) THEN 0 ELSE length(regexp_replace(((j->'candidateId')#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 1 AND 200 ELSE false END) AND (jsonb_typeof((j->'eligibility'))='string' AND ((j->'eligibility')#>>'{}') = ANY(ARRAY['in_range','wider','unconstrained','outside_experience_range','experience_unavailable','uncertain_boundary','wider_skills_not_established']::text[])) AND (jsonb_typeof((j->'experience'))='object') AND (CASE WHEN jsonb_typeof((j->'ordinal'))='number' THEN ((j->'ordinal')#>>'{}')::numeric BETWEEN 1 AND 2000 AND ((j->'ordinal')#>>'{}')::numeric=trunc(((j->'ordinal')#>>'{}')::numeric) ELSE false END) AND (((j->'selectedOrdinal')='null'::jsonb OR (CASE WHEN jsonb_typeof((j->'selectedOrdinal'))='number' THEN ((j->'selectedOrdinal')#>>'{}')::numeric BETWEEN 1 AND 100 AND ((j->'selectedOrdinal')#>>'{}')::numeric=trunc(((j->'selectedOrdinal')#>>'{}')::numeric) ELSE false END))) AND (jsonb_typeof((j->'sourceType'))='string' AND ((j->'sourceType')#>>'{}') = ANY(ARRAY['pool','pool_enriched','discovered']::text[]))) IS TRUE) THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 body:='{'||concat_ws(',','"D":'||(CASE WHEN (j->'D')='null'::jsonb THEN 'null' ELSE (((j->'D')#>>'{}')::numeric::bigint)::text END),'"L":'||(CASE WHEN (j->'L')='null'::jsonb THEN 'null' ELSE (((j->'L')#>>'{}')::numeric::bigint)::text END),'"N":'||(CASE WHEN (j->'N')='null'::jsonb THEN 'null' ELSE (((j->'N')#>>'{}')::numeric::bigint)::text END),'"assessments":'||('['||coalesce((SELECT string_agg(public.signal_ranking_rebuild('assessment',e),',' ORDER BY o) FROM jsonb_array_elements(j->'assessments') WITH ORDINALITY a(e,o)),'')||']'),'"candidateId":'||((j->'candidateId')::text),'"eligibility":'||((j->'eligibility')::text),'"experience":'||(public.signal_ranking_rebuild('experience',j->'experience')),'"ordinal":'||(CASE WHEN (j->'ordinal')='null'::jsonb THEN 'null' ELSE (((j->'ordinal')#>>'{}')::numeric::bigint)::text END),'"selectedOrdinal":'||(CASE WHEN (j->'selectedOrdinal')='null'::jsonb THEN 'null' ELSE (((j->'selectedOrdinal')#>>'{}')::numeric::bigint)::text END),'"sourceType":'||((j->'sourceType')::text))||'}';
 WHEN 'uuid' THEN IF (jsonb_typeof(j)='string' AND CASE WHEN length((j#>>'{}')) BETWEEN 36 AND 18 THEN true WHEN length((j#>>'{}')) BETWEEN 36 AND 36 THEN length((j#>>'{}'))+CASE WHEN octet_length((j#>>'{}'))=length((j#>>'{}')) THEN 0 ELSE length(regexp_replace((j#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 36 AND 36 ELSE false END AND (j#>>'{}') ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') IS NOT TRUE THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF; body:=j::text;
 WHEN 'label' THEN IF (jsonb_typeof(j)='string' AND CASE WHEN length((j#>>'{}')) BETWEEN 1 AND 60 THEN true WHEN length((j#>>'{}')) BETWEEN 1 AND 120 THEN length((j#>>'{}'))+CASE WHEN octet_length((j#>>'{}'))=length((j#>>'{}')) THEN 0 ELSE length(regexp_replace((j#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 1 AND 120 ELSE false END) IS NOT TRUE THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF; body:=j::text;
 WHEN 'ref' THEN IF (jsonb_typeof(j)='string' AND CASE WHEN length((j#>>'{}')) BETWEEN 0 AND 80 THEN true WHEN length((j#>>'{}')) BETWEEN 0 AND 160 THEN length((j#>>'{}'))+CASE WHEN octet_length((j#>>'{}'))=length((j#>>'{}')) THEN 0 ELSE length(regexp_replace((j#>>'{}'),U&'[\0001-\FFFF]','','g')) END BETWEEN 0 AND 160 ELSE false END) IS NOT TRUE THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF; body:=j::text;
 ELSE RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE';
 END CASE;
 IF body IS NULL THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 RETURN body;
END;
$layout$;
REVOKE ALL ON FUNCTION public.signal_ranking_rebuild(text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.signal_ranking_transport_record(p_kind text,p_text text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $record$
DECLARE j jsonb; rebuilt text;
BEGIN
 IF p_kind='evidence' AND octet_length(p_text)>65536 THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
 j:=public.signal_ranking_transport_parse(p_text);
 rebuilt:=public.signal_ranking_rebuild(p_kind,j);
 IF (convert_to(rebuilt,'UTF8')=convert_to(p_text,'UTF8')) IS NOT TRUE
 THEN RAISE EXCEPTION 'RANKING_NONCANONICAL_TEXT'; END IF;
 RETURN j;
END;
$record$;
REVOKE ALL ON FUNCTION public.signal_ranking_transport_record(text,text) FROM PUBLIC;

-- END LAYOUT TRANSPORT

CREATE OR REPLACE FUNCTION public.signal_ranking_claim(p_tenant text,p_flow uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='30s' AS $$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; r public.job_sourcing_requests%ROWTYPE;
 g public.governed_ranking_runs%ROWTYPE; item jsonb; contract jsonb; pool jsonb; withheld jsonb; v_json jsonb; v_text text; evidence_hash text;
 prepared_ids text[]; prepared_texts text[]; prepared_hashes text[]; prepared_pool_text text; prepared_withheld_text text; max_age_ms integer;
 item_ordinal bigint; tagged boolean; tagged_withheld jsonb;
 prepared_items jsonb[]:=ARRAY[]::jsonb[]; withheld_items jsonb[]:=ARRAY[]::jsonb[];
 withheld_ids text[]:=ARRAY[]::text[]; all_ids text[]; logical_bytes bigint:=0;
 record_text text; last_id text; record_id text; n integer;
BEGIN
 tagged:=p_command ? 'transportVersion';
 IF tagged THEN
  IF (jsonb_typeof(p_command)='object' AND p_command->'transportVersion'='1'::jsonb
   AND p_command->'responseMode'='"compact"'::jsonb
   AND p_command ?& ARRAY['transportVersion','contractHash','executionAttemptId','processingLeaseId','responseMode','evidenceCanonical','withheldCanonical']
   AND p_command-ARRAY['transportVersion','contractHash','executionAttemptId','processingLeaseId','responseMode','evidenceCanonical','withheldCanonical']='{}'::jsonb
   AND jsonb_typeof(p_command->'evidenceCanonical')='array' AND jsonb_typeof(p_command->'withheldCanonical')='array'
   AND octet_length(p_command::text)<=268500992) IS NOT TRUE THEN RAISE EXCEPTION 'RANKING_INVALID_COMMAND'; END IF;
  IF jsonb_array_length(p_command->'evidenceCanonical')+jsonb_array_length(p_command->'withheldCanonical')>2000 THEN RAISE EXCEPTION 'RANKING_POOL_TOO_LARGE'; END IF;
  prepared_ids:=ARRAY[]::text[];prepared_texts:=ARRAY[]::text[];prepared_hashes:=ARRAY[]::text[];
  n:=0;last_id:=NULL;
  -- One input traversal, validated buffers, one final text join. Never subscript
  -- the large command or concatenate a growing pool text inside this loop.
  FOR item IN SELECT value FROM jsonb_array_elements(p_command->'evidenceCanonical') LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_TEXT'; END IF;
   record_text:=item#>>'{}';v_json:=public.signal_ranking_transport_record('evidence',record_text);
   record_id:=v_json->>'candidateId';
   IF last_id IS NOT NULL AND last_id COLLATE "C">=record_id COLLATE "C" THEN RAISE EXCEPTION 'RANKING_INPUT_ORDER'; END IF;
   n:=n+1;last_id:=record_id;
   prepared_items[n]:=v_json;prepared_ids[n]:=record_id;prepared_texts[n]:=record_text;
   prepared_hashes[n]:=encode(sha256(convert_to(record_text,'UTF8')),'hex');
   logical_bytes:=logical_bytes+octet_length(v_json::text);
  END LOOP;
  logical_bytes:=logical_bytes+greatest(n-1,0)*2;
  prepared_pool_text:='['||array_to_string(prepared_texts,',')||']';
  prepared_texts:=ARRAY[]::text[];
  n:=0;last_id:=NULL;
  FOR item IN SELECT value FROM jsonb_array_elements(p_command->'withheldCanonical') LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_TEXT'; END IF;
   record_text:=item#>>'{}';v_json:=public.signal_ranking_transport_record('withheld',record_text);
   record_id:=v_json->>'candidateId';
   IF last_id IS NOT NULL AND last_id COLLATE "C">=record_id COLLATE "C" THEN RAISE EXCEPTION 'RANKING_INPUT_ORDER'; END IF;
   n:=n+1;last_id:=record_id;withheld_ids[n]:=record_id;withheld_items[n]:=v_json;prepared_texts[n]:=record_text;
   logical_bytes:=logical_bytes+octet_length(v_json::text);
  END LOOP;
  logical_bytes:=logical_bytes+greatest(n-1,0)*2;
  prepared_withheld_text:='['||array_to_string(prepared_texts,',')||']';
  prepared_texts:=ARRAY[]::text[];withheld:=to_jsonb(withheld_items);withheld_items:=ARRAY[]::jsonb[];
  all_ids:=prepared_ids||withheld_ids;
  IF (SELECT count(DISTINCT id COLLATE "C") FROM unnest(all_ids) id)<>cardinality(all_ids) THEN RAISE EXCEPTION 'RANKING_DUPLICATE_IDENTITY'; END IF;
  -- Empty array placeholders account exactly for metadata/brackets. Add the
  -- per-record jsonb lengths and the same comma-space separators as jsonb::text.
  p_command:=(p_command-ARRAY['transportVersion','evidenceCanonical','withheldCanonical'])||jsonb_build_object('evidence','[]'::jsonb,'withheld','[]'::jsonb);
  logical_bytes:=logical_bytes+octet_length(p_command::text);
  IF logical_bytes>134217728 THEN RAISE EXCEPTION 'RANKING_INVALID_COMMAND'; END IF;
  v_json:=NULL;record_text:=NULL;item:=NULL;

 END IF;
 IF p_flow IS NULL OR nullif(p_tenant,'') IS NULL OR jsonb_typeof(p_command) IS DISTINCT FROM 'object'
  OR octet_length(p_command::text)>134217728 OR p_command-ARRAY['contractHash','responseMode','executionAttemptId','processingLeaseId','evidence','withheld']<>'{}'::jsonb
  OR NOT p_command ?& ARRAY['contractHash','executionAttemptId','processingLeaseId','evidence']
  OR jsonb_typeof(p_command->'contractHash') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p_command->'evidence') NOT IN ('array','null') THEN RAISE EXCEPTION 'RANKING_INVALID_COMMAND'; END IF;
 IF p_command ? 'responseMode' AND (p_command->'responseMode' IS DISTINCT FROM '"compact"'::jsonb
  OR jsonb_typeof(p_command->'evidence') IS DISTINCT FROM 'array') THEN RAISE EXCEPTION 'RANKING_INVALID_COMMAND'; END IF;
 IF jsonb_typeof(p_command->'evidence')='array' THEN
  IF jsonb_array_length(p_command->'evidence')>2000 THEN RAISE EXCEPTION 'RANKING_POOL_TOO_LARGE'; END IF;
 END IF;
 IF NOT tagged THEN
 withheld:=coalesce(p_command->'withheld','[]'::jsonb);
 IF jsonb_typeof(withheld) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'RANKING_INVALID_WITHHOLDING'; END IF;
 IF jsonb_array_length(withheld)>2000 THEN RAISE EXCEPTION 'RANKING_POOL_TOO_LARGE'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(withheld) LOOP
  IF (jsonb_typeof(item)='object' AND item ?& ARRAY['candidateId','reason','evidenceHash','bytes','limit']
   AND item-ARRAY['candidateId','reason','evidenceHash','bytes','limit']='{}'::jsonb
   AND jsonb_typeof(item->'candidateId')='string' AND length(item->>'candidateId') BETWEEN 1 AND 200
   AND item->>'reason'='evidence_too_large' AND item->>'evidenceHash' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(item->'bytes')='number' AND (item->>'bytes')::numeric BETWEEN 65537 AND 9007199254740991
   AND (item->>'bytes')::numeric=trunc((item->>'bytes')::numeric) AND item->'limit'='65536'::jsonb) IS NOT TRUE
   THEN RAISE EXCEPTION 'RANKING_INVALID_WITHHOLDING'; END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'candidateId' COLLATE "C"),'[]'::jsonb) INTO withheld FROM jsonb_array_elements(withheld);
 END IF;
 max_age_ms:=nullif(current_setting('signal.ranking_privacy_max_age_ms',true),'')::integer;
 IF max_age_ms IS NULL OR max_age_ms NOT BETWEEN 60000 AND 300000 THEN RAISE EXCEPTION 'candidate_privacy_configuration_invalid'; END IF;
 IF NOT tagged AND jsonb_typeof(p_command->'evidence')='array' THEN
  WITH rendered AS MATERIALIZED (
   SELECT e.value->>'candidateId' id,public.signal_ranking_canonical(e.value) body
    FROM jsonb_array_elements(p_command->'evidence') e(value)
  )
  SELECT coalesce(array_agg(id ORDER BY id COLLATE "C"),ARRAY[]::text[]),
         coalesce(array_agg(body ORDER BY id COLLATE "C"),ARRAY[]::text[]),
         coalesce(array_agg(encode(sha256(convert_to(body,'UTF8')),'hex') ORDER BY id COLLATE "C"),ARRAY[]::text[])
  INTO prepared_ids,prepared_texts,prepared_hashes FROM rendered;
  prepared_pool_text:='['||array_to_string(prepared_texts,',')||']';
  prepared_withheld_text:=public.signal_ranking_canonical(withheld);
 END IF;
 BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('discover_candidate_privacy_admission_v1',0));
 EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('state','busy','phase','claim');
 END;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.job_sourcing_requests WHERE "tenantId"=p_tenant AND id=b.request_id FOR UPDATE;
 IF r.protocol_version IS DISTINCT FROM 2 OR b.command->>'protocolVersion' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'GOVERNED_PROTOCOL_CONFLICT'; END IF;
 contract:=b.command->'rankingContract';
 IF (
 ((contract->>'policyVersion',contract->>'taxonomyVersion',contract->>'adapterVersion',contract->>'localMatchVersion') =
   ('rubric-range-v1','rubric-taxonomy-v3','rubric-evidence-v1','rubric-local-match-v3')
   AND contract->'payload'->'schemaVersion'='2'::jsonb AND contract->'payload'->'compilerVersion'='2'::jsonb AND contract->'payload'->'taxonomyVersion'='2'::jsonb)
 OR ((contract->>'policyVersion',contract->>'taxonomyVersion',contract->>'adapterVersion',contract->>'localMatchVersion') =
   ('rubric-approved-skills-v1','rubric-taxonomy-v4','rubric-evidence-v1','rubric-local-match-v4')
   AND contract->'payload'->'schemaVersion'='3'::jsonb AND contract->'payload'->'compilerVersion'='3'::jsonb AND contract->'payload'->'taxonomyVersion'='3'::jsonb)
) IS NOT TRUE THEN RAISE EXCEPTION 'GOVERNED_PROTOCOL_CONFLICT'; END IF;
 IF b.cancellation IS NOT NULL OR contract->>'contractHash' IS DISTINCT FROM p_command->>'contractHash' THEN RAISE EXCEPTION 'RANKING_CONTRACT_CONFLICT'; END IF;
 SELECT * INTO g FROM public.governed_ranking_runs WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF FOUND THEN
  SELECT coalesce(jsonb_agg(evidence ORDER BY candidate_id COLLATE "C"),'[]'::jsonb) INTO pool
    FROM public.governed_ranking_items WHERE tenant_id=p_tenant AND flow_run_id=p_flow AND revision_id=g.revision_id;
  IF tagged THEN
   IF jsonb_array_length(pool)<>cardinality(prepared_items) OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(pool) WITH ORDINALITY e(value,o)
    WHERE e.value IS DISTINCT FROM prepared_items[e.o])
    THEN RAISE EXCEPTION 'RANKING_INPUT_CONFLICT'; END IF;
  ELSIF p_command->'evidence'<>'null'::jsonb THEN
   IF pool IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY value->>'candidateId' COLLATE "C"),'[]'::jsonb) FROM jsonb_array_elements(p_command->'evidence'))
    THEN RAISE EXCEPTION 'RANKING_INPUT_CONFLICT'; END IF;
  END IF;
  IF ((p_command->'evidence'<>'null'::jsonb OR p_command ? 'withheld') AND withheld IS DISTINCT FROM g.withheld_profiles)
   THEN RAISE EXCEPTION 'RANKING_INPUT_CONFLICT'; END IF;
  withheld:=g.withheld_profiles;
  IF g.state='ready' THEN RETURN jsonb_build_object('state','ready','revisionId',g.revision_id,'outputHash',g.output_sha256); END IF;
 END IF;
 IF NOT tagged AND g.revision_id IS NULL AND p_command->'evidence'='null'::jsonb THEN RETURN NULL; END IF;
 IF NOT tagged THEN
  SELECT coalesce(array_agg(e->>'candidateId'),ARRAY[]::text[]) INTO all_ids
   FROM jsonb_array_elements(coalesce(pool,p_command->'evidence','[]'::jsonb)||withheld) e;
  SELECT coalesce(array_agg(e->>'candidateId'),ARRAY[]::text[]) INTO withheld_ids FROM jsonb_array_elements(withheld) e;
 END IF;
 IF g.revision_id IS NULL AND EXISTS(
  SELECT 1 FROM unnest(all_ids) e(id)
  JOIN public.candidate_privacy_projection p ON p.tenant_id=p_tenant AND p.candidate_id=e.id
  JOIN public.candidate_privacy_sync_state ps ON ps.consumer_name='discover'
   AND p.generation=ps.active_generation AND p.evaluated_cursor=ps.cursor
  WHERE p.decision IS DISTINCT FROM 'allow')
 THEN RETURN jsonb_build_object('state','reprepare','phase','claim'); END IF;
 IF NOT tagged THEN
 pool:=coalesce(pool,p_command->'evidence');
 IF jsonb_array_length(pool)+jsonb_array_length(withheld)>2000 THEN RAISE EXCEPTION 'RANKING_POOL_TOO_LARGE'; END IF;
 IF (SELECT count(DISTINCT value->>'candidateId') FROM jsonb_array_elements(pool||withheld))<>jsonb_array_length(pool)+jsonb_array_length(withheld)
  THEN RAISE EXCEPTION 'RANKING_DUPLICATE_IDENTITY'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM unnest(withheld_ids) e(id) WHERE NOT EXISTS(
  SELECT 1 FROM public.candidates c WHERE c."tenantId"=p_tenant AND c.id=e.id))
  THEN RAISE EXCEPTION 'RANKING_EVIDENCE_SCOPE'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(all_ids) e(id) WHERE NOT EXISTS(
   SELECT 1 FROM public.candidate_privacy_projection p JOIN public.candidate_privacy_sync_state s
    ON s.consumer_name='discover' AND p.generation=s.active_generation AND p.evaluated_cursor=s.cursor
   WHERE p.tenant_id=p_tenant AND p.candidate_id=e.id))
  THEN RAISE EXCEPTION 'candidate_privacy_unavailable'; END IF;
 -- The trusted wrapper supplies its configured 60–300s bound. Current health
 -- and admission are checked here while holding the shared lock.
 IF NOT EXISTS(SELECT 1 FROM public.candidate_privacy_sync_state s WHERE s.consumer_name='discover'
   AND s.status='healthy' AND s.active_generation>0 AND s.expected_candidates=s.projected_candidates
   AND s.last_success_at>=clock_timestamp()-(max_age_ms * interval '1 millisecond'))
  THEN RAISE EXCEPTION 'candidate_privacy_unavailable'; END IF;
 IF r.status<>'processing' OR r.execution_attempt_id IS DISTINCT FROM p_command->>'executionAttemptId'
   OR r.processing_lease_id IS NULL OR r.processing_lease_id IS DISTINCT FROM p_command->>'processingLeaseId'
   THEN RAISE EXCEPTION 'GOVERNED_EXECUTION_STALE'; END IF;
 IF g.revision_id IS NOT NULL THEN
  IF g.state<>'reserved' OR (g.lease_until>clock_timestamp() AND g.processing_lease_id=r.processing_lease_id) OR g.attempt_count>=3 THEN RAISE EXCEPTION 'RANKING_CLAIM_REFUSED'; END IF;
  UPDATE public.governed_ranking_runs SET lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '120 seconds',
    attempt_count=attempt_count+1,execution_attempt_id=r.execution_attempt_id,processing_lease_id=r.processing_lease_id,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND flow_run_id=p_flow RETURNING * INTO g;
 ELSE
  IF NOT tagged THEN
  pool:=p_command->'evidence';
  IF (SELECT count(DISTINCT value->>'candidateId') FROM jsonb_array_elements(pool))<>jsonb_array_length(pool)
    THEN RAISE EXCEPTION 'RANKING_DUPLICATE_IDENTITY'; END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'candidateId' COLLATE "C"),'[]'::jsonb) INTO pool FROM jsonb_array_elements(pool);
  END IF;
  g.as_of:=date_trunc('milliseconds',clock_timestamp());
  v_text:='{"asOf":'||to_jsonb(to_char(g.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text||
   ',"contractHash":'||(p_command->'contractHash')::text||',"evidence":'||prepared_pool_text||
   CASE WHEN jsonb_array_length(withheld)>0 THEN ',"withheld":'||prepared_withheld_text ELSE '' END||'}';

  INSERT INTO public.governed_ranking_runs(tenant_id,flow_run_id,revision_id,input_sha256,contract_sha256,policy_version,taxonomy_version,adapter_version,tie_version,
    as_of,input_count,state,lease_id,lease_until,execution_attempt_id,processing_lease_id,withheld_profiles)
    VALUES(p_tenant,p_flow,gen_random_uuid(),encode(sha256(convert_to(v_text,'UTF8')),'hex'),p_command->>'contractHash',
      contract->>'policyVersion',contract->>'taxonomyVersion',contract->>'adapterVersion',contract->>'localMatchVersion',
      g.as_of,CASE WHEN tagged THEN cardinality(prepared_items) ELSE jsonb_array_length(pool) END,'reserved',gen_random_uuid(),clock_timestamp()+interval '120 seconds',r.execution_attempt_id,r.processing_lease_id,withheld)
    RETURNING * INTO g;
  FOR item,item_ordinal IN
   SELECT prepared_items[i],i::bigint FROM generate_subscripts(prepared_items,1) i WHERE tagged
   UNION ALL
   SELECT value,ordinality FROM jsonb_array_elements(CASE WHEN tagged THEN '[]'::jsonb ELSE pool END) WITH ORDINALITY
  LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item->>'organizationRef' IS DISTINCT FROM b.organization_ref
      OR (NOT tagged AND EXISTS(SELECT 1 FROM jsonb_array_elements(item->'facts') fact WHERE fact->>'scope'='organization' AND fact->>'organizationRef' IS DISTINCT FROM b.organization_ref))
      THEN RAISE EXCEPTION 'RANKING_EVIDENCE_SCOPE'; END IF;
    IF NOT tagged THEN
    IF jsonb_typeof(item->'facts') IS DISTINCT FROM 'array' OR jsonb_typeof(item->'employment') IS DISTINCT FROM 'array'
      OR jsonb_array_length(item->'facts')>1000 OR jsonb_array_length(item->'employment')>500
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'facts') f WHERE (
        jsonb_typeof(f)='object' AND f ?& ARRAY['field','value','ref','kind','sourceVersion','observedAt','scope','organizationRef']
        AND f-ARRAY['field','value','ref','kind','sourceVersion','observedAt','scope','organizationRef','qualifier','validUntil','revoked']='{}'::jsonb
        AND f->>'field' IN ('title','skill','seniority','function','domain','city','country','work_arrangement','certification','language','education_requirement','work_eligibility')
        AND f->>'kind' IN ('profile_evidence','candidate_provided','verified_document')
        AND length(f->>'value') BETWEEN 1 AND 500 AND length(f->>'ref') BETWEEN 1 AND 160
        AND length(f->>'sourceVersion') BETWEEN 1 AND 100 AND jsonb_typeof(f->'observedAt')='string'
        AND ((f->>'scope'='public' AND f->'organizationRef'='null'::jsonb) OR (f->>'scope'='organization' AND f->>'organizationRef'=b.organization_ref))) IS NOT TRUE)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'employment') e WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
        OR e-ARRAY['title','employmentType','start','end','ongoing']<>'{}'::jsonb
        OR (e ? 'ongoing' AND jsonb_typeof(e->'ongoing') IS DISTINCT FROM 'boolean'))
      THEN RAISE EXCEPTION 'RANKING_INVALID_EVIDENCE'; END IF;
    END IF;
    evidence_hash:=prepared_hashes[item_ordinal];
    INSERT INTO public.governed_ranking_items(tenant_id,flow_run_id,revision_id,candidate_id,evidence,evidence_sha256)
      VALUES(p_tenant,p_flow,g.revision_id,item->>'candidateId',item,evidence_hash);
  END LOOP;
 END IF;
 -- Normal publication already owns the exact prepared evidence. Return only a
 -- sealed receipt so COMMIT does not wait for a second full-pool transfer/parse.
 -- Omitted mode retains the full recovery response; it never changes the hash.
 IF p_command->>'responseMode'='compact' THEN
  RETURN jsonb_build_object('state','reserved_compact','revisionId',g.revision_id,'lease',g.lease_id,'inputHash',g.input_sha256,
   'asOf',to_char(g.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'contractHash',g.contract_sha256);
 END IF;
 RETURN jsonb_build_object('state','reserved','revisionId',g.revision_id,'lease',g.lease_id,'inputHash',g.input_sha256,
   'asOf',to_char(g.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'contract',contract,'evidence',pool,'withheld',withheld);
END $$;
REVOKE ALL ON FUNCTION public.signal_ranking_claim(text,uuid,jsonb) FROM PUBLIC;


CREATE OR REPLACE FUNCTION public.signal_ranking_finish(p_tenant text,p_flow uuid,p_lease uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='30s' AS $$
DECLARE b public.governed_sourcing_bindings%ROWTYPE; r public.job_sourcing_requests%ROWTYPE;
 g public.governed_ranking_runs%ROWTYPE; item jsonb; v_json jsonb; v_text text; output_hash text; selected_ids jsonb; max_age_ms integer; tagged boolean;
BEGIN
 tagged:=p_result ? 'transportVersion';
 IF tagged THEN
  IF (jsonb_typeof(p_result)='object' AND p_result->'transportVersion'='1'::jsonb
   AND p_result ?& ARRAY['transportVersion','inputHash','outputHash','itemsCanonical']
   AND p_result-ARRAY['transportVersion','inputHash','outputHash','itemsCanonical']='{}'::jsonb
   AND jsonb_typeof(p_result->'inputHash')='string' AND p_result->>'inputHash' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(p_result->'outputHash')='string' AND p_result->>'outputHash' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(p_result->'itemsCanonical')='array' AND octet_length(p_result::text)<=134283264) IS NOT TRUE THEN RAISE EXCEPTION 'RANKING_INVALID_RESULT'; END IF;
  IF jsonb_array_length(p_result->'itemsCanonical')>2000 THEN RAISE EXCEPTION 'RANKING_POOL_TOO_LARGE'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'itemsCanonical') e WHERE jsonb_typeof(e)<>'string') THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_TEXT'; END IF;
  WITH checked AS MATERIALIZED (
   SELECT value body,ordinality o,public.signal_ranking_transport_record('item',value) parsed FROM jsonb_array_elements_text(p_result->'itemsCanonical') WITH ORDINALITY
  ) SELECT coalesce(jsonb_agg(parsed ORDER BY o),'[]'::jsonb),'['||coalesce(string_agg(body,',' ORDER BY o),'')||']' INTO v_json,v_text FROM checked;
  IF jsonb_array_length(v_json)<>jsonb_array_length(p_result->'itemsCanonical') THEN RAISE EXCEPTION 'RANKING_INVALID_CANONICAL_SHAPE'; END IF;
  v_text:='{"inputHash":'||(p_result->'inputHash')::text||',"items":'||v_text||'}';
  p_result:=(p_result-ARRAY['transportVersion','itemsCanonical'])||jsonb_build_object('items',v_json);
 END IF;
 IF p_lease IS NULL OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR octet_length(p_result::text)>67108864
  OR p_result-ARRAY['inputHash','items','outputHash']<>'{}'::jsonb OR NOT p_result ?& ARRAY['inputHash','items','outputHash']
  OR jsonb_typeof(p_result->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'RANKING_INVALID_RESULT'; END IF;
 max_age_ms:=nullif(current_setting('signal.ranking_privacy_max_age_ms',true),'')::integer;
 IF max_age_ms IS NULL OR max_age_ms NOT BETWEEN 60000 AND 300000 THEN RAISE EXCEPTION 'candidate_privacy_configuration_invalid'; END IF;
 IF NOT tagged THEN v_text:=public.signal_ranking_canonical(p_result-'outputHash'); END IF;
 output_hash:=encode(sha256(convert_to(v_text,'UTF8')),'hex');
 IF output_hash IS DISTINCT FROM p_result->>'outputHash' THEN RAISE EXCEPTION 'RANKING_OUTPUT_CONFLICT'; END IF;
 BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('discover_candidate_privacy_admission_v1',0));
 EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('state','busy','phase','finish');
 END;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'items') e WHERE NOT EXISTS(
   SELECT 1 FROM public.candidate_privacy_projection p JOIN public.candidate_privacy_sync_state s
    ON s.consumer_name='discover' AND p.generation=s.active_generation AND p.evaluated_cursor=s.cursor
   WHERE p.tenant_id=p_tenant AND p.candidate_id=e->>'candidateId'))
  THEN RAISE EXCEPTION 'candidate_privacy_unavailable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.candidate_privacy_sync_state s WHERE s.consumer_name='discover'
   AND s.status='healthy' AND s.active_generation>0 AND s.expected_candidates=s.projected_candidates
   AND s.last_success_at>=clock_timestamp()-(max_age_ms * interval '1 millisecond'))
  THEN RAISE EXCEPTION 'candidate_privacy_unavailable'; END IF;
 SELECT * INTO b FROM public.governed_sourcing_bindings WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.job_sourcing_requests WHERE id=b.request_id AND "tenantId"=p_tenant FOR UPDATE;
 SELECT * INTO g FROM public.governed_ranking_runs WHERE tenant_id=p_tenant AND flow_run_id=p_flow FOR UPDATE;
 IF NOT FOUND OR b.cancellation IS NOT NULL OR r.protocol_version IS DISTINCT FROM 2 OR g.input_sha256 IS DISTINCT FROM p_result->>'inputHash'
  THEN RAISE EXCEPTION 'RANKING_INPUT_CONFLICT'; END IF;
 IF (g.policy_version,g.taxonomy_version,g.adapter_version,g.tie_version) IS DISTINCT FROM
  (b.command->'rankingContract'->>'policyVersion',b.command->'rankingContract'->>'taxonomyVersion',
   b.command->'rankingContract'->>'adapterVersion',b.command->'rankingContract'->>'localMatchVersion')
  THEN RAISE EXCEPTION 'RANKING_CONTRACT_CONFLICT'; END IF;
 -- Canonical text and output hash were prepared/checked before admission.
 IF g.state='ready' THEN
  IF g.output_sha256<>output_hash THEN RAISE EXCEPTION 'RANKING_OUTPUT_CONFLICT'; END IF;
  RETURN jsonb_build_object('state','ready','revisionId',g.revision_id,'outputHash',g.output_sha256,'replayed',true);
 END IF;
 IF g.state<>'reserved' OR g.lease_id IS DISTINCT FROM p_lease OR g.lease_until<=clock_timestamp()
  OR r.status<>'processing' OR r.execution_attempt_id IS DISTINCT FROM g.execution_attempt_id
  OR r.processing_lease_id IS NULL OR r.processing_lease_id IS DISTINCT FROM g.processing_lease_id THEN RAISE EXCEPTION 'RANKING_LEASE_STALE'; END IF;
 IF jsonb_array_length(p_result->'items')<>g.input_count
  OR (SELECT count(DISTINCT value->>'candidateId') FROM jsonb_array_elements(p_result->'items'))<>g.input_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'items') x WHERE NOT EXISTS(
   SELECT 1 FROM public.governed_ranking_items i WHERE i.tenant_id=p_tenant AND i.flow_run_id=p_flow AND i.revision_id=g.revision_id AND i.candidate_id=x->>'candidateId'))
  OR (SELECT count(DISTINCT value->>'D') FROM jsonb_array_elements(p_result->'items'))>1
  THEN RAISE EXCEPTION 'RANKING_INPUT_CONFLICT'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_result->'items') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['candidateId','N','D','L','assessments','eligibility','experience','ordinal','selectedOrdinal','sourceType']<>'{}'::jsonb
   OR NOT item ?& ARRAY['candidateId','N','D','L','assessments','eligibility','experience','ordinal','selectedOrdinal','sourceType']
   OR jsonb_typeof(item->'N') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'D') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'L') IS DISTINCT FROM 'number'
   OR jsonb_typeof(item->'ordinal') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'assessments') IS DISTINCT FROM 'array'
   OR (item->>'sourceType' IN ('pool','pool_enriched','discovered')) IS NOT TRUE
   OR EXISTS(SELECT 1 FROM public.governed_ranking_items i WHERE i.tenant_id=p_tenant AND i.flow_run_id=p_flow AND i.revision_id=g.revision_id
     AND i.candidate_id=item->>'candidateId' AND i.evidence ? 'presentationSource' AND i.evidence->>'presentationSource' IS DISTINCT FROM item->>'sourceType')
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['N','D','L','ordinal']) k WHERE (item->>k)::numeric<>trunc((item->>k)::numeric))
   OR item->'experience'->>'asOf' IS DISTINCT FROM to_char(g.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   THEN RAISE EXCEPTION 'RANKING_INVALID_RESULT'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(item->'assessments') a WHERE jsonb_typeof(a) IS DISTINCT FROM 'object'
     OR a-ARRAY['criterionIds','labels','subject','state','mapped','weight','points','localPoints','refs']<>'{}'::jsonb
     OR NOT a ?& ARRAY['criterionIds','labels','subject','state','mapped','weight','points','localPoints','refs']
     OR (a->>'state' IN ('met','not_met','unknown')) IS NOT TRUE OR jsonb_typeof(a->'mapped') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(a->'criterionIds') IS DISTINCT FROM 'array' OR jsonb_typeof(a->'refs') IS DISTINCT FROM 'array'
     OR jsonb_typeof(a->'weight') IS DISTINCT FROM 'number' OR jsonb_typeof(a->'points') IS DISTINCT FROM 'number'
     OR jsonb_typeof(a->'localPoints') IS DISTINCT FROM 'number'
     OR EXISTS(SELECT 1 FROM unnest(ARRAY['weight','points','localPoints']) k WHERE (a->>k)::numeric<>trunc((a->>k)::numeric))
     OR (a->>'weight')::integer NOT IN (0,1,3)
     OR (a->>'mapped'='false' AND (a->>'weight')::integer<>0)
     OR jsonb_array_length(a->'criterionIds') NOT BETWEEN 1 AND 12 OR jsonb_array_length(a->'refs')>1000
     OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a->'criterionIds') id WHERE NOT EXISTS(
       SELECT 1 FROM jsonb_array_elements(b.command->'rankingContract'->'payload'->'criteria') c WHERE c->>'id'=id AND c->>'subject'=a->>'subject'))
     OR a->'labels' IS DISTINCT FROM (SELECT jsonb_agg(c->'label' ORDER BY ids.ordinality)
       FROM jsonb_array_elements_text(a->'criterionIds') WITH ORDINALITY ids(value,ordinality)
       JOIN LATERAL jsonb_array_elements(b.command->'rankingContract'->'payload'->'criteria') c ON c->>'id'=ids.value)
     OR (a->>'points')::integer IS DISTINCT FROM CASE WHEN a->>'state'='met' THEN (a->>'weight')::integer ELSE 0 END
     OR (a->>'localPoints')::integer NOT BETWEEN 0 AND (a->>'points')::integer*1000000)
   OR (item->>'N')::numeric IS DISTINCT FROM (SELECT coalesce(sum((a->>'points')::numeric),0) FROM jsonb_array_elements(item->'assessments') a)
   OR (item->>'D')::numeric IS DISTINCT FROM (SELECT coalesce(sum((a->>'weight')::numeric),0) FROM jsonb_array_elements(item->'assessments') a)
   OR (item->>'L')::numeric IS DISTINCT FROM (SELECT coalesce(sum((a->>'localPoints')::numeric),0) FROM jsonb_array_elements(item->'assessments') a)
   THEN RAISE EXCEPTION 'RANKING_INVALID_RESULT'; END IF;
 END LOOP;
 -- Rank over the complete sealed pool. Selection is not supplied independently:
 -- eligible in-range first, wider next, then N/L/bytewise identity; never padding.
 IF EXISTS(
  SELECT 1 FROM (
   SELECT x, row_number() OVER(ORDER BY CASE WHEN x->>'eligibility' IN ('in_range','unconstrained') THEN 0 WHEN x->>'eligibility'='wider' THEN 1 ELSE 2 END,
      (x->>'N')::numeric DESC,(x->>'L')::numeric DESC,x->>'candidateId' COLLATE "C") AS expected
   FROM jsonb_array_elements(p_result->'items') x
  ) ordered WHERE (x->>'ordinal')::numeric IS DISTINCT FROM expected
   OR (x->>'selectedOrdinal')::numeric IS DISTINCT FROM CASE WHEN expected<=100 AND x->>'eligibility' IN ('in_range','wider','unconstrained') THEN expected ELSE NULL END
 ) THEN RAISE EXCEPTION 'RANKING_ORDER_CONFLICT'; END IF;
 -- Every output field is filled once while the header is reserved.
 FOR item IN SELECT value FROM jsonb_array_elements(p_result->'items') LOOP
  UPDATE public.governed_ranking_items SET assessment=item->'assessments',score_n=(item->>'N')::integer,score_d=(item->>'D')::integer,
   local_match=(item->>'L')::integer,ordinal=(item->>'ordinal')::integer,eligibility_code=item->>'eligibility',experience_envelope=item->'experience',
   selected_ordinal=(item->>'selectedOrdinal')::integer
   WHERE tenant_id=p_tenant AND flow_run_id=p_flow AND revision_id=g.revision_id AND candidate_id=item->>'candidateId';
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.job_sourcing_candidates WHERE "tenantId"=p_tenant AND "sourcingRequestId"=b.request_id)
   THEN RAISE EXCEPTION 'RANKING_PUBLICATION_CONFLICT'; END IF;
 INSERT INTO public.job_sourcing_candidates(id,"tenantId","sourcingRequestId","candidateId","fitScore","fitBreakdown","sourceType","enrichmentStatus",rank)
  SELECT gen_random_uuid()::text,p_tenant,b.request_id,i.candidate_id,NULL,NULL,published.value->>'sourceType',c."enrichmentStatus",i.selected_ordinal
  FROM public.governed_ranking_items i JOIN public.candidates c ON c."tenantId"=i.tenant_id AND c.id=i.candidate_id
  JOIN jsonb_array_elements(p_result->'items') published(value) ON published.value->>'candidateId'=i.candidate_id
  WHERE i.tenant_id=p_tenant AND i.flow_run_id=p_flow AND i.revision_id=g.revision_id AND i.selected_ordinal IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.candidate_privacy_projection p JOIN public.candidate_privacy_sync_state s
    ON s.consumer_name='discover' AND p.generation=s.active_generation AND p.evaluated_cursor=s.cursor
    WHERE p.tenant_id=p_tenant AND p.candidate_id=i.candidate_id AND p.decision='allow');
 -- Suppression removes only that candidate. Preserve original ordinals and do
 -- not backfill the sealed top100 from previously unselected candidates.
 SELECT coalesce(jsonb_agg("candidateId" ORDER BY rank),'[]'::jsonb) INTO selected_ids FROM public.job_sourcing_candidates
  WHERE "tenantId"=p_tenant AND "sourcingRequestId"=b.request_id;
 UPDATE public.governed_sourcing_bindings SET delivery_ids=selected_ids,delivery_revision=1 WHERE tenant_id=p_tenant AND flow_run_id=p_flow;
 UPDATE public.job_sourcing_requests SET status='complete',"completedAt"=clock_timestamp(),"resultCount"=jsonb_array_length(selected_ids),
   diagnostics=coalesce(diagnostics,'{}'::jsonb)||jsonb_build_object('rubricRanking',jsonb_build_object(
     'protocolVersion',2,'consideredCount',g.input_count+jsonb_array_length(g.withheld_profiles),
     'withheldCount',jsonb_array_length(g.withheld_profiles),'withheldReasons',jsonb_build_object('evidence_too_large',jsonb_array_length(g.withheld_profiles)),
     'inputCount',jsonb_array_length(p_result->'items'),'publishedCount',jsonb_array_length(selected_ids),
     'shortfall',100-jsonb_array_length(selected_ids),'revisionId',g.revision_id,'outputHash',output_hash,
     'inRangeCount',(SELECT count(*) FROM jsonb_array_elements(p_result->'items') x WHERE x->>'eligibility' IN ('in_range','unconstrained')),
     'widerCount',(SELECT count(*) FROM jsonb_array_elements(p_result->'items') x WHERE x->>'eligibility'='wider'))),
   last_reranked_at=g.as_of,callback_status='pending' WHERE id=b.request_id AND "tenantId"=p_tenant;
 UPDATE public.governed_ranking_runs SET state='ready',output_sha256=output_hash,lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
  WHERE tenant_id=p_tenant AND flow_run_id=p_flow;
 RETURN jsonb_build_object('state','ready','revisionId',g.revision_id,'outputHash',output_hash,'replayed',false);
END $$;

REVOKE ALL ON FUNCTION public.signal_ranking_finish(text,uuid,uuid,jsonb) FROM PUBLIC;
