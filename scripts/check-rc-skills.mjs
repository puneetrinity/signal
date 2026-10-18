import {readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
export const RC_TABLES=['rc_rate_policies','rc_org_policies','rc_sourcing_runs','rc_purchase_members','rc_lookup_attempts','rc_skill_outbox','rc_account_windows','rc_operations_events'];
export const RC_FUNCTIONS=['signal_rc_admit(text,uuid,jsonb)','signal_rc_prepare(text,uuid,jsonb)','signal_rc_claim(text,uuid,jsonb)',
 'signal_rc_dispatch(text,uuid,uuid,jsonb)','signal_rc_finish(text,uuid,uuid,jsonb)','signal_rc_read(text,uuid)',
 'signal_rc_seal(text,uuid,jsonb)','signal_rc_outbox(text,uuid,jsonb)','signal_rc_maintain(jsonb)','signal_rc_work(text,uuid,jsonb)'];
export const RC_PREPARE_PRIVATE_FUNCTIONS=['signal_rc_prepare_rebuild(text,jsonb)','signal_rc_prepare_transport(jsonb)'];
export const RC_OWNER_FUNCTIONS=['signal_rc_set_policy(jsonb)','signal_rc_recover(text,uuid,jsonb)',...RC_PREPARE_PRIVATE_FUNCTIONS,'signal_rc_free_rejection_valid(jsonb)','signal_rc_validate_baseline_write()'];
export const RC_CATALOG_SHA256='3de5ea6302225fbf4e83c3c308e02ee01e60dfe9b0e84ebc930d3201e5306bbb';
export const RC_CATALOG_SQL=`WITH relations AS (
 SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'rc\\_%' ESCAPE '\\' AND c.relkind IN ('r','p')
), functions AS (
 SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'signal_rc_%'
), facts AS (SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_array(relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT relowner FROM pg_class WHERE oid='public.job_sourcing_requests'::regclass)) ORDER BY relname COLLATE "C") FROM relations),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname COLLATE "C",a.attnum)
 FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conname,pg_get_constraintdef(c.oid),c.convalidated,c.condeferrable,c.condeferred) ORDER BY c.conname COLLATE "C") FROM pg_constraint c WHERE c.conrelid IN(SELECT oid FROM relations)),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text COLLATE "C") FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM relations)),
 'policies',(SELECT jsonb_agg(jsonb_build_array(c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles=ARRAY[c.relowner],pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname COLLATE "C",p.polname COLLATE "C") FROM pg_policy p JOIN relations c ON c.oid=p.polrelid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgrelid::regclass::text COLLATE "C",t.tgname COLLATE "C") FROM pg_trigger t WHERE NOT t.tgisinternal AND (t.tgrelid IN(SELECT oid FROM relations) OR t.tgfoid IN(SELECT oid FROM functions))),
 'rules',(SELECT jsonb_agg(jsonb_build_array(r.rulename,pg_get_ruledef(r.oid),r.ev_enabled) ORDER BY r.ev_class::regclass::text COLLATE "C",r.rulename COLLATE "C") FROM pg_rewrite r WHERE r.ev_class IN(SELECT oid FROM relations)),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.job_sourcing_requests'::regclass)) ORDER BY p.oid::regprocedure::text COLLATE "C") FROM functions p)
 ) value) SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') digest FROM facts`;
export async function assertRcCatalog(tx,{role,allowOwner=false}={}){
 const [catalog]=await tx.$queryRawUnsafe(RC_CATALOG_SQL);
 if(catalog?.digest!==RC_CATALOG_SHA256)throw Error('RC catalog mismatch');
 if(allowOwner)return;
 const [rights]=await tx.$queryRawUnsafe(`SELECT
 NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege(coalesce($1,current_user),'public.'||n,p))
 AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p WHERE has_any_column_privilege(coalesce($1,current_user),'public.'||n,p))
 AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) n WHERE NOT has_function_privilege(coalesce($1,current_user),n,'EXECUTE'))
 AND NOT EXISTS(SELECT 1 FROM unnest($4::text[]) n WHERE has_function_privilege(coalesce($1,current_user),n,'EXECUTE'))
 AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]||$4::text[]) n JOIN pg_proc p ON p.oid=to_regprocedure(n)
 CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 OR (a.grantee<>p.proowner AND a.is_grantable)) AS ok`,role??null,RC_TABLES,RC_FUNCTIONS,RC_OWNER_FUNCTIONS);
 if(rights?.ok!==true)throw Error('RC runtime privileges mismatch');
}
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function checkRcSkillsSource(base=root,read=path=>readFileSync(resolve(base,path),'utf8')){
 const migration='prisma/migrations/20261009000000_rc_skills/migration.sql',sql=read(migration);
 const correction=read('prisma/migrations/20261011000000_rc_clock_tolerance/migration.sql');
 const extract=name=>{const start=sql.indexOf('CREATE FUNCTION public.'+name+'('),end=sql.indexOf(';',sql.indexOf('REVOKE ALL ON FUNCTION',start))+1;return sql.slice(start,end);};
 const expected=['signal_rc_prepare','signal_rc_finish'].map(name=>extract(name).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
  .replaceAll("(base->>'asOf')::timestamptz>clock_timestamp()","(base->>'asOf')::timestamptz>clock_timestamp()+interval '5 seconds'")
  .replaceAll("(item->>'observedAt')::timestamptz>clock_timestamp()","(item->>'observedAt')::timestamptz>clock_timestamp()+interval '5 seconds'")
  .replaceAll("(obs->>'observedAt')::timestamptz>clock_timestamp()","(obs->>'observedAt')::timestamptz>clock_timestamp()+interval '5 seconds'")).join('\n\n');
 if(correction.slice(correction.indexOf('CREATE OR REPLACE FUNCTION')).trim()!==expected.trim())throw Error('RC clock tolerance delta mismatch');
 if(/\b\w*(?:paise|price_expir|crustdata_expires|rc_expires)\w*\b/i.test(sql))throw Error('RC monetary policy forbidden');
 for(const name of RC_TABLES)if(!sql.includes('CREATE TABLE public.'+name+' ('))throw Error('RC table missing');
 for(const signature of [...RC_FUNCTIONS.filter(s=>!s.startsWith('signal_rc_work(')),...RC_OWNER_FUNCTIONS.filter(s=>!RC_PREPARE_PRIVATE_FUNCTIONS.includes(s)&&!s.startsWith('signal_rc_free_rejection_valid(')&&s!=='signal_rc_validate_baseline_write()')])
  if(!sql.includes('REVOKE ALL ON FUNCTION public.'+signature+' FROM PUBLIC;'))throw Error('RC PUBLIC revocation missing');
 for(const token of ['FORCE ROW LEVEL SECURITY','COLLATE "C"','RC_RECEIPT_BINDING_CONFLICT','RC_EXECUTION_STALE',
  'RC_LOOKUP_LIMIT','RC_OUTCOME_CONFLICT','RC_CHECK_SNAPSHOT_CONFLICT','RC_RECOVERY_STALE','retention_hold',
  'safe_to_clean_at','memory_ingested_at',"interval '24 hours'",'discover_candidate_privacy_admission_v1'])
  if(!sql.includes(token))throw Error('RC authority missing: '+token);
 if(RC_CATALOG_SHA256==='UNSEALED_AUTHORING')throw Error('RC catalog not sealed');
 // CI/source verification only: assertRcCatalog never loads authoring files.
 const preparePath='prisma/migrations/20261013000000_rc_prepare_transport/migration.sql',prepare=read(preparePath);
 const layout=JSON.parse(read('scripts/rc-layout-contract.json'));
 for(const [path,hash] of Object.entries(layout.sources))if(createHash('sha256').update(read(path)).digest('hex')!==hash)throw Error('RC layout source changed: '+path);
 if(createHash('sha256').update(prepare).digest('hex')!==layout.sqlSha256)throw Error('RC prepare layout changed');
 for(const signature of RC_PREPARE_PRIVATE_FUNCTIONS)if(!prepare.includes('REVOKE ALL ON FUNCTION public.'+signature+' FROM PUBLIC;'))throw Error('RC prepare helper ACL missing');
 for(const token of ['ANY(candidate_ids)) IS NOT TRUE','pg_input_is_valid','IF NOT tagged THEN','aclexplode'])if(!prepare.includes(token))throw Error('RC prepare invariant missing');
 const repository=read('src/lib/sourcing/rc-skills/repository.ts');
 for(const token of ["SET LOCAL statement_timeout='30s'","SET LOCAL statement_timeout='5s'","SET LOCAL lock_timeout='2s'","SET LOCAL idle_in_transaction_session_timeout='35s'",'maxWait:2000,timeout:compact?7000:35000'])if(!repository.includes(token))throw Error('RC prepare deadline missing');
 const lock=JSON.parse(read('prisma/migrations.lock.json'));
 const searchCorrection=read('prisma/migrations/20261014000000_rc_search_correction/migration.sql');
 const searchHash=createHash('sha256').update(searchCorrection).digest('hex');
 for(const token of ['RC_BASELINE_VALIDATION_SOURCE_REFUSED','LOCK TABLE public.rc_sourcing_runs IN ACCESS EXCLUSIVE MODE',
  "pg_get_constraintdef(oid)='CHECK (((jsonb_typeof(baseline)", 'FROM pg_rewrite WHERE ev_class=',
  'REVOKE ALL ON FUNCTION public.signal_rc_validate_baseline_write() FROM PUBLIC;',
  'AFTER INSERT OR UPDATE OF baseline','ENABLE ALWAYS TRIGGER rc_baseline_write_guard',
  "octet_length(NEW.baseline::text)<=134217728) IS FALSE","ERRCODE='23514',MESSAGE='RC_BASELINE_INVALID'"])
  if(!searchCorrection.includes(token))throw Error('RC baseline write validation missing');
 if(layout.searchCorrectionSqlSha256!==searchHash||lock.migrations.find(m=>m.name==='20261014000000_rc_search_correction')?.sha256!==searchHash)throw Error('RC search correction fingerprint mismatch');
 for(const token of ['REVOKE ALL ON FUNCTION public.signal_rc_work(text,uuid,jsonb) FROM PUBLIC;',
  'REVOKE ALL ON FUNCTION public.signal_rc_free_rejection_valid(jsonb) FROM PUBLIC;',
  'EMPTY_REVIEWED_429_POLICY','rc_one_unexonerated_fetch','RC_RETRY_PROOF_REFUSED',
  'protocol_mode smallint NOT NULL DEFAULT 1','RC_EXECUTION_STALE','RC_OUTCOME_CONFLICT','aclexplode',
  'run.protocol_mode=1',"'fetch_updated_at'","'expectedRevision'","'observations'"])
  if(!searchCorrection.includes(token))throw Error('RC search correction invariant missing');
 if(lock.migrations.find(m=>m.name==='20261013000000_rc_prepare_transport')?.sha256!==createHash('sha256').update(prepare).digest('hex'))throw Error('RC prepare migration fingerprint mismatch');
 if(lock.migrations.find(m=>m.name==='20261011000000_rc_clock_tolerance')?.sha256!==createHash('sha256').update(correction).digest('hex'))throw Error('RC tolerance fingerprint mismatch');
 if(lock.migrations.find(m=>m.name==='20261009000000_rc_skills')?.sha256!==createHash('sha256').update(sql).digest('hex'))throw Error('RC migration fingerprint mismatch');
 const provider=read('src/lib/sourcing/rc-skills/provider.ts');
 if(!provider.includes("'/v2/fetch/persons/check'")||!provider.includes("'/v2/fetch/persons'")||!provider.includes("redirect:'error'"))throw Error('RC provider boundary missing');
 const wire=read('src/lib/sourcing/rc-skills/contracts.ts');
 if(/\bemail\s*:/.test(wire))throw Error('RC contact field forbidden');
 // Discover new raw writers rather than trusting a checksum-only census.
 function visit(dir){for(const entry of readdirSync(resolve(base,dir),{withFileTypes:true})){
  const path=dir+'/'+entry.name;if(entry.isDirectory()){if(!['__tests__','fixtures'].includes(entry.name))visit(path);continue;}
  if(!/\.(ts|mjs)$/.test(path)||path.includes('test-')||path.endsWith('check-rc-skills.mjs'))continue;
  if(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?["`]?rc_(?:sourcing_runs|lookup_attempts|purchase_members|skill_outbox|rate_policies|org_policies|account_windows|operations_events)\b/i.test(read(path)))
   throw Error('RC raw runtime writer: '+path);
 }}visit('src');visit('scripts');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{checkRcSkillsSource();console.log('RC skills guard: PASS');}catch(error){console.error(error.message);process.exitCode=1;}
}
