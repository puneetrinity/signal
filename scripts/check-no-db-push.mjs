import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { ROOT_DIR } from './lib/database-bootstrap.mjs';

const forbidden = /\bprisma\s+db\s+push\b/i;
const packageJson = JSON.parse(
  await readFile(resolve(ROOT_DIR, 'package.json'), 'utf8'),
);
const offenders = [];

async function executableScripts(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await executableScripts(path)));
    } else if (['.js', '.mjs', '.sh', '.ts'].includes(extname(entry.name))) {
      files.push(relative(ROOT_DIR, path));
    }
  }
  return files;
}

for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
  if (forbidden.test(String(command))) offenders.push(`package.json#scripts.${name}`);
}

const activeFiles = ['README.md', 'railway.toml'];
const workflowDirectory = resolve(ROOT_DIR, '.github/workflows');
for (const entry of await readdir(workflowDirectory, { withFileTypes: true })) {
  if (entry.isFile()) activeFiles.push(`.github/workflows/${entry.name}`);
}
activeFiles.push(...await executableScripts(resolve(ROOT_DIR, 'scripts')));

for (const relativePath of activeFiles) {
  if (relativePath === 'scripts/check-no-db-push.mjs') continue;
  const contents = await readFile(resolve(ROOT_DIR, relativePath), 'utf8');
  if (forbidden.test(contents)) offenders.push(relativePath);
}

if (offenders.length > 0) {
  throw new Error(
    `prisma db push is forbidden in active setup paths: ${offenders.join(', ')}`,
  );
}
console.log('[Database guard] No active prisma db push path found');
