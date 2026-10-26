-- Applicant résumé location for the recruiter card.
-- A separate read-only function, so the existing signal_private_ranking_sources
-- response (parsed strictly by deployed code) is unchanged.
-- Returns only the candidate-provided résumé city/country already sealed in this
-- run's private ranking evidence. Never public facts, never inferred values.
CREATE FUNCTION public.signal_private_ranking_locations(p_tenant text,p_flow uuid,p_revision uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
SET statement_timeout='3s' SET lock_timeout='1s' AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.governed_ranking_runs r WHERE r.tenant_id=p_tenant
   AND r.flow_run_id=p_flow AND r.revision_id=p_revision AND r.state='ready') THEN
   RAISE EXCEPTION 'PRIVATE_RANKING_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM public.governed_ranking_items i WHERE i.tenant_id=p_tenant
   AND i.flow_run_id=p_flow AND i.revision_id=p_revision
   AND NOT public.signal_private_evidence_bound(p_tenant,i.evidence)) THEN
   RAISE EXCEPTION 'PRIVATE_RANKING_UNAVAILABLE'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('candidateId',i.candidate_id,'location',jsonb_build_object(
   'city',(SELECT min(f->>'value' COLLATE "C") FROM jsonb_array_elements(i.evidence->'facts') f
     WHERE f->>'field'='city' AND f->>'ref'='resume.city' AND f->>'kind'='candidate_provided' AND f->>'scope'='organization'),
   'country',(SELECT min(f->>'value' COLLATE "C") FROM jsonb_array_elements(i.evidence->'facts') f
     WHERE f->>'field'='country' AND f->>'ref'='resume.country' AND f->>'kind'='candidate_provided' AND f->>'scope'='organization')))
  ORDER BY i.candidate_id COLLATE "C"),'[]'::jsonb) INTO result
 FROM public.governed_ranking_items i WHERE i.tenant_id=p_tenant AND i.flow_run_id=p_flow AND i.revision_id=p_revision
  AND i.evidence ? 'resumeIdentity';
 IF jsonb_array_length(result)>100 OR octet_length(result::text)>65536 THEN RAISE EXCEPTION 'PRIVATE_RANKING_UNAVAILABLE'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.signal_private_ranking_locations(text,uuid,uuid) FROM PUBLIC;
