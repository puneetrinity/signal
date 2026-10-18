export const PRIVATE_RESUME_TABLES = ['private_candidate_sources'];
export const PRIVATE_RESUME_FUNCTIONS = [
  'signal_private_candidate_materialize(text,jsonb)',
  'signal_private_contact_allowed(text,text)',
  'signal_private_ranking_sources(text,uuid,uuid)',
];
export const PRIVATE_RESUME_OWNER_FUNCTIONS = ['signal_private_identity_immutable()','signal_private_evidence_bound(text,jsonb)'];
export const PRIVATE_RESUME_CATALOG_SHA256='6b077b11e8d789a5a596948ccbad989f05a09fa60edea9d0b4fd810973d3588b';
export const PRIVATE_RESUME_CATALOG_SQL=`WITH relations AS (
 SELECT * FROM pg_class WHERE oid='public.private_candidate_sources'::regclass
), functions AS (
 SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname LIKE 'signal_private_%'
), facts AS (SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_array(relname,relrowsecurity,relforcerowsecurity,
   relowner=(SELECT relowner FROM pg_class WHERE oid='public.candidates'::regclass))) FROM relations),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname COLLATE "C",a.attnum)
   FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
   WHERE a.attnum>0 AND NOT a.attisdropped AND (c.oid IN(SELECT oid FROM relations) OR
    (c.oid='public.candidates'::regclass AND a.attname IN ('identityKind','privateCandidateRef','linkedinId','linkedinUrl')))),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid),convalidated,condeferrable,condeferred) ORDER BY conname COLLATE "C")
   FROM pg_constraint WHERE conrelid IN(SELECT oid FROM relations) OR (conrelid='public.candidates'::regclass AND conname='candidates_identity_shape')),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(indexrelid),indisvalid,indisready) ORDER BY indexrelid::regclass::text COLLATE "C")
   FROM pg_index WHERE indrelid IN(SELECT oid FROM relations) OR indexrelid='public."candidates_tenantId_privateCandidateRef_key"'::regclass),
 'policies',(SELECT jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,p.polroles=ARRAY[c.relowner],pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname COLLATE "C")
   FROM pg_policy p JOIN relations c ON c.oid=p.polrelid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(tgname,pg_get_triggerdef(oid),tgenabled) ORDER BY tgname COLLATE "C")
   FROM pg_trigger WHERE NOT tgisinternal AND (tgrelid IN(SELECT oid FROM relations) OR tgfoid IN(SELECT oid FROM functions))),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.candidates'::regclass)) ORDER BY p.oid::regprocedure::text COLLATE "C") FROM functions p)
 ) value) SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') digest FROM facts`;

/** Read back effective rights after the broad runtime grants, including column grants. */
export async function assertPrivateResumeAccess(tx, { role, allowOwner = false } = {}) {
  const [catalog]=await tx.$queryRawUnsafe(PRIVATE_RESUME_CATALOG_SQL);
  if(catalog?.digest!==PRIVATE_RESUME_CATALOG_SHA256)throw Error('Private resume catalog mismatch');
  const [shape] = await tx.$queryRawUnsafe(`SELECT
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
      WHERE oid=to_regclass('public.private_candidate_sources'))
    AND (SELECT count(*)=3 AND bool_and(p.prosecdef
      AND p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.candidates'::regclass)
      AND p.proconfig @> ARRAY['search_path=pg_catalog, public','statement_timeout=3s','lock_timeout=1s'])
      FROM pg_proc p WHERE p.oid=ANY(ARRAY[
        to_regprocedure('public.signal_private_candidate_materialize(text,jsonb)'),
        to_regprocedure('public.signal_private_contact_allowed(text,text)'),
        to_regprocedure('public.signal_private_ranking_sources(text,uuid,uuid)')])) AS ok`);
  if (shape?.ok !== true) throw Error('Private resume schema mismatch');
  if (allowOwner) return;
  const [rights] = await tx.$queryRawUnsafe(`SELECT
    NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
      WHERE has_table_privilege(coalesce($1,current_user),'public.'||n,privilege))
    AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) privilege
      WHERE has_any_column_privilege(coalesce($1,current_user),'public.'||n,privilege))
    AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) n
      WHERE NOT has_function_privilege(coalesce($1,current_user),n,'EXECUTE'))
    AND NOT EXISTS(SELECT 1 FROM unnest($4::text[]) n
      WHERE has_function_privilege(coalesce($1,current_user),n,'EXECUTE'))
    AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]||$4::text[]) n JOIN pg_proc p ON p.oid=to_regprocedure(n)
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 OR (a.grantee<>p.proowner AND a.is_grantable)) AS ok`,
    role ?? null, PRIVATE_RESUME_TABLES, PRIVATE_RESUME_FUNCTIONS,PRIVATE_RESUME_OWNER_FUNCTIONS);
  if (rights?.ok !== true) throw Error('Private resume runtime privileges mismatch');
}
