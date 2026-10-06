import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';

export const GOVERNED_TABLES=['governed_sourcing_tenants','governed_sourcing_bindings','governed_sourcing_grants','governed_sourcing_previews'];
export const GOVERNED_FUNCTIONS=[
  'signal_sourcing_tenant(text)','signal_sourcing_bind(text,uuid,jsonb)','signal_sourcing_execution(text,text,jsonb,jsonb)',
  'signal_sourcing_grant_transition(text,uuid,text,jsonb)','signal_sourcing_receipt_evidence(text,text,text)',
  'signal_sourcing_delivery(text,text,text,jsonb,timestamp with time zone)','signal_sourcing_cancel(text,text,jsonb)',
  'signal_sourcing_cancel_evidence(text,text)','signal_sourcing_bound_command(text,text)',
  'signal_sourcing_preview_admit(text,text,jsonb)','signal_sourcing_preview_claim(text,uuid,uuid)',
  'signal_sourcing_preview_finish(text,uuid,uuid,jsonb)',
];
export const GOVERNED_CATALOG_SHA256='3c4e189c56009a9180fc7f85afa7ecfc7ae68bb39dcfdf4564b62a9a0cc93c2f';
export const GOVERNED_CATALOG_SQL=`WITH relations AS (
 SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname LIKE 'governed_sourcing_%' AND c.relkind IN ('r','p')
), functions AS (
 SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'signal_sourcing_%'
), facts AS (SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_array(relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT relowner FROM pg_class WHERE oid='public.job_sourcing_requests'::regclass)) ORDER BY relname COLLATE "C") FROM relations),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname COLLATE "C",a.attnum)
 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE a.attnum>0 AND NOT a.attisdropped AND (c.oid IN(SELECT oid FROM relations) OR
 (c.oid='public.job_sourcing_requests'::regclass AND a.attname IN ('flow_run_id','artifact_hash','protocol_version')))),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conname,pg_get_constraintdef(c.oid),c.convalidated,c.condeferrable,c.condeferred) ORDER BY c.conname COLLATE "C")
 FROM pg_constraint c WHERE c.conrelid IN(SELECT oid FROM relations) OR c.conname LIKE 'gov_%' OR c.conname='crustdata_acquisition_receipts_status_check'),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text COLLATE "C")
 FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM relations) OR i.indexrelid::regclass::text LIKE 'gov_%'),
 'policies',(SELECT jsonb_agg(jsonb_build_array(c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles=ARRAY[c.relowner],pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname COLLATE "C",p.polname COLLATE "C")
 FROM pg_policy p JOIN relations c ON c.oid=p.polrelid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgrelid::regclass::text COLLATE "C",t.tgname COLLATE "C")
 FROM pg_trigger t WHERE NOT t.tgisinternal AND (t.tgrelid IN(SELECT oid FROM relations) OR t.tgfoid IN(SELECT oid FROM functions))),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.job_sourcing_requests'::regclass)) ORDER BY p.oid::regprocedure::text COLLATE "C") FROM functions p)
 ) value) SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') digest FROM facts`;

export async function assertGovernedSourcingCatalog(tx,{role,allowOwner=false}={}) {
  const [catalog]=await tx.$queryRawUnsafe(GOVERNED_CATALOG_SQL);
  if(catalog?.digest!==GOVERNED_CATALOG_SHA256)throw Error('Governed sourcing catalog mismatch');
  if(allowOwner)return; // caller permits this only for an attested disposable target
  const [rights]=await tx.$queryRawUnsafe(`SELECT
    NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege WHERE has_table_privilege(coalesce($1,current_user),'public.'||n,privilege))
    AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) privilege WHERE has_any_column_privilege(coalesce($1,current_user),'public.'||n,privilege))
    AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) n WHERE NOT has_function_privilege(coalesce($1,current_user),n,'EXECUTE'))
    AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) n JOIN pg_proc p ON p.oid=to_regprocedure(n)
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 OR (a.grantee<>p.proowner AND a.is_grantable)) AS ok`,
    role??null,GOVERNED_TABLES,GOVERNED_FUNCTIONS);
  if(rights?.ok!==true)throw Error('Governed sourcing runtime privileges mismatch');
}

export function checkGovernedSource(root=resolve(dirname(fileURLToPath(import.meta.url)),'..')) {
  const migration=readFileSync(resolve(root,'prisma/migrations/20261004000000_governed_sourcing/migration.sql'),'utf8');
  for(const name of GOVERNED_TABLES)if(!migration.includes(`CREATE TABLE public.${name} (`))throw Error('Governed table missing');
  for(const signature of GOVERNED_FUNCTIONS)if(!migration.includes(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC;`) &&
    !migration.includes(`REVOKE ALL ON FUNCTION public.${signature.replace('timestamp with time zone','timestamptz')} FROM PUBLIC;`))throw Error('Governed function PUBLIC revocation missing');
  if(GOVERNED_CATALOG_SHA256==='UNSEALED_AUTHORING')throw Error('Governed catalog not sealed');
  const ordered=(file,start,anchors)=>{
    const text=readFileSync(resolve(root,file),'utf8'),begin=text.indexOf(start);
    if(begin<0)throw Error('Governed authority entry missing: '+file);
    let cursor=begin;
    for(const anchor of anchors){const next=text.indexOf(anchor,cursor);if(next<0)throw Error('Governed authority order missing: '+file+' / '+anchor);cursor=next+anchor.length;}
  };
  ordered('src/lib/sourcing/crustdata-acquisition.ts','export async function acquireCrustdataSearch(',
    ['await dependencies.beforeReserve?.()','await dependencies.store.reserve','await dependencies.search']);
  ordered('src/app/api/v3/jobs/[id]/source/route.ts','export async function POST(',
    ['await verifyServiceJWT(request)','requireScope(auth.context','await requireHealthyCandidatePrivacyContext()','await readSourcingBody(request)',
      'if(!governedEnabled())','await bindGovernedSource','getSourcingQueue().add']);
  ordered('src/app/api/v3/jobs/[id]/preview/route.ts','export async function POST(',
    ['await verifyServiceJWT(request)','requireScope(auth.context','if(!governedEnabled())','await admitGovernedPreview','getSourcingQueue().add']);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{checkGovernedSource();console.log('governed sourcing guard: PASS');}
  catch(error){console.error(error.message);process.exitCode=1;}
}
