// Local authoring helper: emit the forward delta on stdout; never touch old SQL.
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='prisma/migrations';
const definitions=new Map();
for(const name of readdirSync(root).sort().filter(n=>n<'20261018000000')) {
  const sql=readFileSync(`${root}/${name}/migration.sql`,'utf8');
  const re=/CREATE(?: OR REPLACE)? FUNCTION public\.(\w+)\([\s\S]*?\bAS (\$[a-zA-Z_0-9]*\$)[\s\S]*?\2;/g;
  for(const m of sql.matchAll(re))definitions.set(m[1],m[0].replace(/^CREATE FUNCTION/,'CREATE OR REPLACE FUNCTION'));
}
let edits=[];
function replace(sql,from,to,count=1) {
  if(sql.split(from).length-1!==count)throw Error(`Forward SQL witness mismatch: ${from.slice(0,90)}`);
  edits.push({from,to,count});
  return sql.replaceAll(from,to);
}
const signatures={signal_sourcing_bind:'text,uuid,jsonb',signal_ranking_claim:'text,uuid,jsonb',
  signal_ranking_rebuild:'text,jsonb',signal_rc_admit:'text,uuid,jsonb',signal_rc_read:'text,uuid',signal_rc_prepare:'text,uuid,jsonb'};
function emit(name){
  const original=definitions.get(name),marker=/\bAS (\$[a-zA-Z_0-9]*\$)/.exec(original);
  const body=original.slice(marker.index+marker[0].length,original.lastIndexOf(marker[1]));
  const hash=createHash('sha256').update(body).digest('hex');
  const quote=v=>"'"+v.replaceAll("'","''")+"'";
  output.push(`-- Preserve the frozen body except these counted substitutions.\nDO $forward$ DECLARE definition text; source text; BEGIN\n SELECT pg_get_functiondef(p.oid),p.prosrc INTO STRICT definition,source FROM pg_proc p WHERE p.oid='public.${name}(${signatures[name]})'::regprocedure;\n IF encode(sha256(convert_to(source,'UTF8')),'hex')<>${quote(hash)} THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;\n`+
    edits.map(({from,to,count})=>` IF (length(definition)-length(replace(definition,${quote(from)},'')))/length(${quote(from)})<>${count} THEN RAISE EXCEPTION 'PRIVATE_RESUME_ROUTINE_DRIFT'; END IF;\n definition:=replace(definition,${quote(from)},${quote(to)});`).join('\n')+
    `\n EXECUTE definition;\nEND $forward$;`);
  edits=[];
}
function addVersion(sql,variable) {
  const branch=` OR ((${variable}->>'policyVersion',${variable}->>'taxonomyVersion',${variable}->>'adapterVersion',${variable}->>'localMatchVersion') =\n   ('rubric-approved-skills-v1','rubric-taxonomy-v4','rubric-evidence-v1','rubric-local-match-v4')\n   AND ${variable}->'payload'->'schemaVersion'='3'::jsonb AND ${variable}->'payload'->'compilerVersion'='3'::jsonb AND ${variable}->'payload'->'taxonomyVersion'='3'::jsonb)`;
  return replace(sql,branch,branch+branch.replaceAll('rubric-approved-skills-v1','rubric-resume-evidence-v1').replaceAll('rubric-evidence-v1','rubric-evidence-v2').replaceAll("='3'::jsonb","='4'::jsonb"));
}
const output=[];
let sql=addVersion(definitions.get('signal_sourcing_bind'),'v_json');
sql=replace(sql,"IF v_json->'payload'->'schemaVersion'='3'::jsonb THEN","IF v_json->'payload'->>'schemaVersion' IN ('3','4') THEN");
for(const field of ['schemaVersion','compilerVersion','taxonomyVersion'])
  sql=replace(sql,`p_payload->'${field}' IS DISTINCT FROM '3'::jsonb`,`p_payload->>'${field}' NOT IN ('3','4')`);
emit('signal_sourcing_bind');
sql=addVersion(definitions.get('signal_ranking_claim'),'contract');
// Bind each profile's evidence version to the immutable approved contract too.
sql=replace(sql,"contract:=b.command->'rankingContract';",`contract:=b.command->'rankingContract';
 IF EXISTS(SELECT 1 FROM (
   SELECT e FROM unnest(prepared_items) e WHERE tagged
   UNION ALL SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_command->'evidence')='array' THEN p_command->'evidence' ELSE '[]'::jsonb END) e WHERE NOT tagged
  ) input WHERE e->>'version' IS DISTINCT FROM contract->>'adapterVersion'
    OR NOT public.signal_private_evidence_bound(p_tenant,e)) THEN RAISE EXCEPTION 'RANKING_EVIDENCE_VERSION_MISMATCH'; END IF;`);
emit('signal_ranking_claim');
sql=definitions.get('signal_ranking_rebuild');
sql=replace(sql,'DECLARE body text;','DECLARE source jsonb; role jsonb; body text;');
sql=replace(sql,'BEGIN\n CASE p_kind',`BEGIN\n${readFileSync('scripts/private-resume-evidence-v2.sql','utf8')}\n CASE p_kind`);
emit('signal_ranking_rebuild');
for(const name of ['signal_rc_admit','signal_rc_read']) {
  sql=definitions.get(name);
  if(name==='signal_rc_admit')sql=replace(sql,"b.command->'rankingContract'->'payload'->>'schemaVersion' IS DISTINCT FROM '3'",
    "coalesce(b.command->'rankingContract'->'payload'->>'schemaVersion','') NOT IN ('3','4')");
  else sql=replace(sql,"b.command->'rankingContract'->'payload'->>'schemaVersion'='3'",
    "b.command->'rankingContract'->'payload'->>'schemaVersion' IN ('3','4')");
  emit(name);
}
sql=definitions.get('signal_rc_prepare');
sql=replace(sql,"e->>'version' IS DISTINCT FROM 'rubric-evidence-v1'","e->>'version' IS DISTINCT FROM b.command->'rankingContract'->>'adapterVersion'");
sql=replace(sql,"e-ARRAY['candidateId','organizationRef','presentationSource','facts','employment','version']",
  "e-(CASE WHEN e->>'version'='rubric-evidence-v2' THEN ARRAY['employmentSources','resumeIdentity'] ELSE ARRAY[]::text[] END)-ARRAY['candidateId','organizationRef','presentationSource','facts','employment','version']");
emit('signal_rc_prepare');
const oldSkills=readFileSync(`${root}/20261009010000_approved_skill_alternatives/migration.sql`,'utf8');
const constraint=oldSkills.slice(oldSkills.indexOf('ALTER TABLE public.governed_ranking_runs'),oldSkills.indexOf('CREATE OR REPLACE FUNCTION public.signal_sourcing_bind'));
output.push(replace(constraint,"('rubric-approved-skills-v1','rubric-taxonomy-v4','rubric-evidence-v1','rubric-local-match-v4')",
  "('rubric-approved-skills-v1','rubric-taxonomy-v4','rubric-evidence-v1','rubric-local-match-v4'),\n ('rubric-resume-evidence-v1','rubric-taxonomy-v4','rubric-evidence-v2','rubric-local-match-v4')"));
const oldItems=readFileSync(`${root}/20261008000000_rubric_evidence_isolation/migration.sql`,'utf8');
let items=oldItems.slice(oldItems.indexOf('ALTER TABLE public.governed_ranking_items'),oldItems.indexOf('CREATE OR REPLACE FUNCTION public.signal_ranking_claim'));
items=replace(items,"evidence-ARRAY['candidateId','organizationRef','facts','employment','version','presentationSource']",
  "evidence-(CASE WHEN evidence->>'version'='rubric-evidence-v2' THEN ARRAY['employmentSources','resumeIdentity'] ELSE ARRAY[]::text[] END)-ARRAY['candidateId','organizationRef','facts','employment','version','presentationSource']");
items=replace(items,"evidence->>'version'='rubric-evidence-v1'","evidence->>'version' IN ('rubric-evidence-v1','rubric-evidence-v2')\n  AND (evidence->>'version'<>'rubric-evidence-v2' OR (evidence->'employment'='[]'::jsonb AND jsonb_typeof(evidence->'employmentSources')='array' AND jsonb_array_length(evidence->'employmentSources')<=2))");
output.push(items);
console.log(output.join('\n\n'));
