// TEST ONLY. Loaded with `node --import` by scripts/test-rc-skills-process.mjs so the
// disposable process proof can exercise the maintenance cycle on a raw-SQL test
// database that has no schema-control identity/ledger. It replaces exactly one
// import (schema-ready) of exactly one entrypoint; production never loads it.
// Readiness itself is proven by scripts/schema-control/test-schema-control-postgres.mjs,
// and the process proof separately asserts maintenance refuses to start without it.
import {register} from 'node:module';
register('data:text/javascript,'+encodeURIComponent(`
export async function resolve(specifier,context,next){
  if(specifier==='./schema-control/schema-ready.mjs'&&context.parentURL?.endsWith('/scripts/rc-skills-maintenance.mjs'))
    return {url:'data:text/javascript,',shortCircuit:true};
  return next(specifier,context);
}`));
