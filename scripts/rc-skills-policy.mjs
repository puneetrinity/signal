// Explicit owner-only manual setup, never automatic billing or price discovery.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';

export async function main(args=process.argv.slice(2)){
 if(args.length!==3||args[0]!=='--command-file'||args[2]!=='--approve-policy')throw Error('RC_EXPLICIT_POLICY_REQUIRED');
 const bytes=readFileSync(resolve(args[1]));if(bytes.length>8192)throw Error('RC_INVALID_COMMAND');
 const command=JSON.parse(bytes.toString('utf8'));
 if(!command||command.version!==1||!['rates','organization'].includes(command.action))throw Error('RC_INVALID_COMMAND');
 const dsn=process.env.RC_SKILLS_OWNER_DATABASE_URL;if(!dsn)throw Error('RC_EXPLICIT_OWNER_CONNECTION_REQUIRED');
 const client=new pg.Client({connectionString:dsn,connectionTimeoutMillis:5000,query_timeout:10000});
 await client.connect();
 try{
  await client.query('BEGIN');
  const role=await client.query("SELECT current_user=(SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='rc_rate_policies') AS owner");
  if(role.rows[0]?.owner!==true)throw Error('RC_OWNER_REQUIRED');
  const result=await client.query('SELECT public.signal_rc_set_policy($1::jsonb) result',[JSON.stringify(command)]);
  await client.query('COMMIT');
  console.log(JSON.stringify(result.rows[0]?.result));
 }catch{await client.query('ROLLBACK').catch(()=>{});throw Error('RC_POLICY_REFUSED');}
 finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(()=>{console.error('RC policy command failed; no raw connection or database details emitted.');process.exitCode=1;});
}
