import { ROOT_DIR } from '../lib/database-bootstrap.mjs';
import { evaluateSchemaControl } from './authority-guard.mjs';

const offenders = await evaluateSchemaControl(ROOT_DIR);
if (offenders.length > 0) {
  throw new Error(`Discover schema-control guard rejected:\n- ${offenders.join('\n- ')}`);
}
console.log('[Schema control guard] Discover migration authority is singular and runtime startup is read-only');
