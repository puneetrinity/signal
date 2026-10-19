export const MEMORY_TABLES=['public_memory_ingest_requests'];
export const MEMORY_FUNCTIONS=['signal_memory_ingest(jsonb,jsonb)','signal_memory_ingest_lag_ids(text[],timestamp with time zone,integer)','signal_memory_ingest_work(text,text,integer)'];
export const MEMORY_PRIVATE_FUNCTIONS=['signal_memory_packet_guard()','signal_memory_acquisition_guard()','signal_memory_legacy_guard()'];
export const MEMORY_CATALOG_SHA256='a40ab0ff62efd89d5c1e31e3f2606dc678065ec93f0f1d72cd0b169737ca330f';
export const MEMORY_CATALOG_SQL=`WITH relations AS (
 SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('public_memory_ingest_requests','crustdata_acquisition_receipts') AND c.relkind IN ('r','p')
), owned_constraints AS (
 -- Migration 34 owns the new table entirely, and on the pre-existing receipts table only these.
 -- Older receipts-table objects (e.g. production's generation/slot CHECKs that the fresh baseline
 -- lacks) are outside this fingerprint; schema-control drift checks cover them.
 SELECT c.* FROM pg_constraint c JOIN relations r ON r.oid=c.conrelid WHERE r.relname='public_memory_ingest_requests'
  OR c.conname IN ('memory_preparation_shape','memory_acquisition_owner_key','crustdata_acquisition_receipts_memory_delivery_contract_check')
), functions AS (
 SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'signal_memory_%'
), facts AS (SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_array(relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT relowner FROM pg_class WHERE oid='public.job_sourcing_requests'::regclass)) ORDER BY relname COLLATE "C") FROM relations),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname COLLATE "C",a.attnum)
 FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped
  AND (c.relname='public_memory_ingest_requests' OR a.attname LIKE 'memory\_%')),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conname,pg_get_constraintdef(c.oid),c.convalidated,c.condeferrable,c.condeferred) ORDER BY c.conname COLLATE "C") FROM owned_constraints c),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text COLLATE "C") FROM pg_index i WHERE i.indrelid=(SELECT oid FROM relations WHERE relname='public_memory_ingest_requests')
  OR i.indexrelid IN(SELECT conindid FROM owned_constraints WHERE contype IN('p','u','x'))),
 'policies',(SELECT jsonb_agg(jsonb_build_array(c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles=ARRAY[c.relowner],pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname COLLATE "C",p.polname COLLATE "C") FROM pg_policy p JOIN relations c ON c.oid=p.polrelid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgrelid::regclass::text COLLATE "C",t.tgname COLLATE "C") FROM pg_trigger t WHERE NOT t.tgisinternal AND (t.tgrelid=(SELECT oid FROM relations WHERE relname='public_memory_ingest_requests') OR t.tgfoid IN(SELECT oid FROM functions))),
 'rules',(SELECT jsonb_agg(jsonb_build_array(r.rulename,pg_get_ruledef(r.oid),r.ev_enabled) ORDER BY r.ev_class::regclass::text COLLATE "C",r.rulename COLLATE "C") FROM pg_rewrite r WHERE r.ev_class IN(SELECT oid FROM relations)),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.job_sourcing_requests'::regclass)) ORDER BY p.oid::regprocedure::text COLLATE "C") FROM functions p)
 ) value) SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') digest FROM facts`;
export async function assertImmutableMemoryCatalog(tx,{role,allowOwner=false}={}){
 const [catalog]=await tx.$queryRawUnsafe(MEMORY_CATALOG_SQL);
 if(catalog?.digest!==MEMORY_CATALOG_SHA256)throw Error('Immutable Memory catalog mismatch');
 if(allowOwner)return;
 const [rights]=await tx.$queryRawUnsafe(`SELECT
 NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege(coalesce($1,current_user),'public.'||n,p))
 AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p WHERE has_any_column_privilege(coalesce($1,current_user),'public.'||n,p))
 AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) n WHERE NOT has_function_privilege(coalesce($1,current_user),n,'EXECUTE'))
 AND NOT EXISTS(SELECT 1 FROM unnest($4::text[]) n WHERE has_function_privilege(coalesce($1,current_user),n,'EXECUTE'))
 AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]||$4::text[]) n JOIN pg_proc p ON p.oid=to_regprocedure(n)
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 OR (a.grantee<>p.proowner AND a.is_grantable))
 AS ok`,role??null,MEMORY_TABLES,MEMORY_FUNCTIONS,MEMORY_PRIVATE_FUNCTIONS);
 if(rights?.ok!==true)throw Error('Immutable Memory runtime privileges mismatch');
}
