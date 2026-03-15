import { getSkillSurfaceForms } from '../src/lib/sourcing/jd-digest';

const testSkills = ['flink','databricks','fastapi','next.js','elixir','erlang','azure','jenkins','selenium','cypress','vault','consul','nextjs','flask','svelte','deno','bun','prisma','drizzle','supabase','vercel','grafana','prometheus','ansible','puppet','chef','nginx','caddy','rabbitmq','celery','airflow','dbt','snowflake','redshift','bigquery','neo4j','cassandra','dynamodb','elasticsearch','solr','webpack','vite','esbuild','rollup','jest','vitest','playwright','storybook','tailwind','sass','less','rxjs','ngrx','redux','mobx','zustand','nuxt','remix','astro','solid','htmx','turbo'];

const noAlias: string[] = [];
for (const skill of testSkills) {
  const forms = getSkillSurfaceForms(skill);
  if (forms.length === 1 && forms[0] === skill) {
    noAlias.push(skill);
  }
}
console.log(`Skills with NO aliases (${noAlias.length}):`);
console.log(noAlias.join(', '));

const ambiguous = ['go', 'rust', 'swift', 'dart', 'r', 'c', 'ruby', 'spark', 'flask', 'spring', 'express', 'nest', 'next'];
console.log('\nAmbiguous word check:');
for (const w of ambiguous) {
  const forms = getSkillSurfaceForms(w);
  console.log(`  ${w}: [${forms.join(', ')}]`);
}
