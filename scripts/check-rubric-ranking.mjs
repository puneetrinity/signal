import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
export const RANKING_TABLES=['governed_ranking_runs','governed_ranking_items'];
export const RANKING_FUNCTIONS=['signal_ranking_claim(text,uuid,jsonb)','signal_ranking_finish(text,uuid,uuid,jsonb)','signal_ranking_read(text,uuid,uuid)'];
export const RANKING_PRIVATE_FUNCTIONS=['signal_ranking_immutable()'];
export const RANKING_CATALOG_SHA256='559fe596daf0e6b1acf9335768069842de870ca0de02c5d6a036262c6f326106';
export const RANKING_CATALOG_SQL=`WITH relations AS (
 SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname LIKE 'governed_ranking_%' AND c.relkind IN ('r','p')
), functions AS (
 SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'signal_ranking_%'
), facts AS (SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_array(relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT relowner FROM pg_class WHERE oid='public.job_sourcing_requests'::regclass)) ORDER BY relname COLLATE "C") FROM relations),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname COLLATE "C",a.attnum)
 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE a.attnum>0 AND NOT a.attisdropped AND (c.oid IN(SELECT oid FROM relations) OR
 (c.oid='public.job_sourcing_requests'::regclass AND a.attname IN ('flow_run_id','artifact_hash','protocol_version')))),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conname,pg_get_constraintdef(c.oid),c.convalidated,c.condeferrable,c.condeferred) ORDER BY c.conname COLLATE "C")
 FROM pg_constraint c WHERE c.conrelid IN(SELECT oid FROM relations) OR c.conname LIKE 'gr_%'),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text COLLATE "C")
 FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM relations) OR i.indexrelid::regclass::text LIKE 'gr_%'),
 'policies',(SELECT jsonb_agg(jsonb_build_array(c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles=ARRAY[c.relowner],pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname COLLATE "C",p.polname COLLATE "C")
 FROM pg_policy p JOIN relations c ON c.oid=p.polrelid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgrelid::regclass::text COLLATE "C",t.tgname COLLATE "C")
 FROM pg_trigger t WHERE NOT t.tgisinternal AND (t.tgrelid IN(SELECT oid FROM relations) OR t.tgfoid IN(SELECT oid FROM functions))),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.job_sourcing_requests'::regclass)) ORDER BY p.oid::regprocedure::text COLLATE "C") FROM functions p)
 ) value) SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') digest FROM facts`;
export async function assertRankingCatalog(tx,{role,allowOwner=false}={}) {
  const [catalog]=await tx.$queryRawUnsafe(RANKING_CATALOG_SQL);
  if(catalog?.digest!==RANKING_CATALOG_SHA256)throw Error('Ranking catalog mismatch');
  if(allowOwner)return;
  const [rights]=await tx.$queryRawUnsafe(`SELECT
    NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege WHERE has_table_privilege(coalesce($1,current_user),'public.'||n,privilege))
    AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) privilege WHERE has_any_column_privilege(coalesce($1,current_user),'public.'||n,privilege))
    AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) n WHERE NOT has_function_privilege(coalesce($1,current_user),n,'EXECUTE'))
    AND NOT EXISTS(SELECT 1 FROM unnest($4::text[]) n WHERE has_function_privilege(coalesce($1,current_user),n,'EXECUTE'))
    AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]||$4::text[]) n JOIN pg_proc p ON p.oid=to_regprocedure(n)
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 OR (a.grantee<>p.proowner AND a.is_grantable)) AS ok`,
    role??null,RANKING_TABLES,RANKING_FUNCTIONS,RANKING_PRIVATE_FUNCTIONS);
  if(rights?.ok!==true)throw Error('Ranking runtime privileges mismatch');
}
export const rankingSourceTokens={
 'prisma/migrations/20261008000000_rubric_evidence_isolation/migration.sql':[
  'withheld_profiles','RANKING_INVALID_WITHHOLDING','RANKING_DUPLICATE_IDENTITY','RANKING_EVIDENCE_SCOPE',
  'g.withheld_profiles','evidence_too_large','<=65536','>134217728','COLLATE "C"','candidate_privacy_unavailable',
 ],
 'prisma/migrations/20261006000000_rubric_ranking/migration.sql':[
  'RANKING_INPUT_CONFLICT','RANKING_ORDER_CONFLICT','RANKING_LEASE_STALE','RANKING_IMMUTABLE','RANKING_CONTRACT_CONFLICT',
  'FORCE ROW LEVEL SECURITY','COLLATE "C"','g.attempt_count>=3',"callback_status='pending'",'presentationSource',
  "pg_advisory_xact_lock(hashtextextended('discover_candidate_privacy_admission_v1',0))",'candidate_privacy_unavailable',
  "p.decision='allow'",'p.evaluated_cursor=s.cursor',
 ],
 'src/lib/sourcing/rubric/score.ts':['evidenceSchema.parse','experienceEligibility','automaticallyMapped','compareRanking','slice(0,100)','RUBRIC_DUPLICATE_IDENTITY'],
 'src/lib/sourcing/rubric/repository.ts':['claimSchema.parse','rankingReadSchema.parse','RANKING_INPUT_CONFLICT','RANKING_OUTPUT_CONFLICT','async resume'],
 'src/lib/sourcing/queue/index.ts':['new RankingRepository().resume','new RankingRepository().read'],
 'src/lib/sourcing/orchestrator.ts':['GOVERNED_DISCOVERY_REQUIRED','GOVERNED_DISCOVERY_BUDGET_REFUSED','RANKING_PUBLICATION_REQUIRED'],
};
export function checkRankingSource(root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),read=path=>readFileSync(resolve(root,path),'utf8')) {
  const sql=read('prisma/migrations/20261006000000_rubric_ranking/migration.sql');
  for(const name of RANKING_TABLES)if(!sql.includes('CREATE TABLE public.'+name+' ('))throw Error('Ranking table missing');
  for(const signature of [...RANKING_FUNCTIONS,...RANKING_PRIVATE_FUNCTIONS])
    if(!sql.includes('REVOKE ALL ON FUNCTION public.'+signature+' FROM PUBLIC;'))throw Error('Ranking PUBLIC revocation missing');
  if(RANKING_CATALOG_SHA256==='UNSEALED_AUTHORING')throw Error('Ranking catalog not sealed');
  const lock=JSON.parse(read('prisma/migrations.lock.json'));
  const isolation='20261008000000_rubric_evidence_isolation';
  if(lock.migrations.find(m=>m.name===isolation)?.sha256!==createHash('sha256').update(read('prisma/migrations/'+isolation+'/migration.sql')).digest('hex'))throw Error('Ranking isolation fingerprint mismatch');
  if(lock.migrations.find(m=>m.name==='20261006000000_rubric_ranking')?.sha256!==createHash('sha256').update(sql).digest('hex'))throw Error('Ranking migration fingerprint mismatch');
  const score=read('src/lib/sourcing/rubric/score.ts');
  if(/semanticSimilarity|fitScore|profileCompleteness|activityFreshness/.test(score))throw Error('Unapproved ranking signal');
  for(const file of ['src/lib/sourcing/rubric/contracts.ts','src/lib/sourcing/rubric/repository.ts'])
    if(!read(file).length)throw Error('Missing ranking implementation');
  for(const [file,tokens] of Object.entries(rankingSourceTokens))for(const token of tokens)
    if(!read(file).includes(token))throw Error('Ranking authority missing: '+file+' / '+token);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try{checkRankingSource();console.log('rubric ranking guard: PASS');}
  catch(error){console.error(error.message);process.exitCode=1;}
}
