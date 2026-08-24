import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCandidatePrivacySurfaces } from './check-candidate-privacy-surfaces.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = await evaluateCandidatePrivacySurfaces(root);
assert(baseline.length === 0, `Baseline privacy guard rejected:\n${baseline.join('\n')}`);

const temporaryRoot = await mkdtemp(join(tmpdir(), 'signal-privacy-guard-'));
const copyRoot = join(temporaryRoot, 'repo');
let mutationCount = 0;
try {
  await cp(root, copyRoot, {
    recursive: true,
    filter: (source) => !/(?:^|\/)(?:\.git|node_modules|\.next)(?:\/|$)/.test(source),
  });

  const manifestPath = resolve(copyRoot, 'src/lib/candidate-privacy/surfaces.json');
  const retiredPath = resolve(copyRoot, 'src/lib/legacy-retirement.ts');
  const clientPath = resolve(copyRoot, 'src/lib/candidate-privacy/memory-client.ts');
  const processorPath = resolve(copyRoot, 'src/lib/candidate-privacy/processor.ts');

  const mutations = [
    async () => {
      const original = await readFile(manifestPath);
      const manifest = JSON.parse(original.toString('utf8'));
      manifest.surfaces = manifest.surfaces.filter(
        (row) => row.file !== 'src/lib/sourcing/discovery.ts',
      );
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { paths: [[manifestPath, original]] };
    },
    async () => {
      const path = resolve(copyRoot, 'src/lib/sourcing/unguarded-provider.ts');
      await writeFile(path, 'export async function callProvider(candidate) { return searchPeople(candidate); }\n');
      return { paths: [[path, null]] };
    },
    async () => {
      const path = resolve(copyRoot, 'src/lib/sourcing/unguarded-writer.ts');
      await writeFile(path, 'export async function writeCandidate(prisma, candidate) { return prisma.candidate.create({ data: candidate }); }\n');
      return { paths: [[path, null]] };
    },
    async () => {
      const path = resolve(copyRoot, 'src/lib/sourcing/unguarded-callback.ts');
      await writeFile(path, 'export async function emitCandidate(candidate) { return deliverCallback(candidate); }\n');
      return { paths: [[path, null]] };
    },
    async () => {
      const original = await readFile(retiredPath);
      await writeFile(
        retiredPath,
        original.toString('utf8').replace(/status:\s*410/g, 'status: 200'),
      );
      return { paths: [[retiredPath, original]] };
    },
    async () => {
      const original = await readFile(clientPath);
      await writeFile(
        clientPath,
        original.toString('utf8')
          .replace(/signCandidatePrivacyJWT/g, 'signActiveGraphJWT'),
      );
      return { paths: [[clientPath, original]] };
    },
    async () => {
      const original = await readFile(processorPath);
      await writeFile(
        processorPath,
        original.toString('utf8').replace(
          'async function heartbeatRebuildClaim(',
          'async function extendRebuildClaim(',
        ),
      );
      return { paths: [[processorPath, original]] };
    },
    async () => {
      const original = await readFile(processorPath);
      await writeFile(
        processorPath,
        original.toString('utf8').replace(
          'rebuildLeaseExpiresAt: { gt: new Date() },',
          'rebuildLeaseExpiresAt: { not: null },',
        ),
      );
      return { paths: [[processorPath, original]] };
    },
    async () => {
      const original = await readFile(processorPath);
      const source = original.toString('utf8');
      const start = source.indexOf('async function markRebuildFailure(');
      const end = source.indexOf('export async function rebuildCandidatePrivacyProjection(');
      const mutated = `${source.slice(0, start)}${source.slice(start, end).replace(
        'rebuildClaimToken: claim.token,',
        'rebuildClaimToken: undefined,',
      )}${source.slice(end)}`;
      await writeFile(processorPath, mutated);
      return { paths: [[processorPath, original]] };
    },
    async () => {
      const original = await readFile(processorPath);
      const source = original.toString('utf8');
      const start = source.indexOf('async function markRebuildFailure(');
      const end = source.indexOf('export async function rebuildCandidatePrivacyProjection(');
      const mutated = `${source.slice(0, start)}${source.slice(start, end).replace(
          'if (updated.count !== 1) throw new Error(REBUILD_CLAIM_LOST);',
          'if (updated.count < 0) throw new Error(REBUILD_CLAIM_LOST);',
        )}${source.slice(end)}`;
      await writeFile(processorPath, mutated);
      return { paths: [[processorPath, original]] };
    },
  ];
  mutationCount = mutations.length;

  for (const mutate of mutations) {
    const { paths } = await mutate();
    const originals = new Map(
      paths.map(([path, bytes]) => [path, bytes === null ? null : sha256(bytes)]),
    );
    const offenders = await evaluateCandidatePrivacySurfaces(copyRoot);
    assert(offenders.length > 0, 'Candidate privacy guard lost a negative mutation');
    for (const [path, bytes] of paths) {
      if (bytes === null) await rm(path, { force: true });
      else await writeFile(path, bytes);
    }
    for (const [path, expected] of originals) {
      if (expected === null) continue;
      assert(sha256(await readFile(path)) === expected, `Byte restoration failed: ${path}`);
    }
    const restored = await evaluateCandidatePrivacySurfaces(copyRoot);
    assert(restored.length === 0, `Privacy guard did not recover:\n${restored.join('\n')}`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(`[Candidate privacy guard test] ${mutationCount} negative mutations failed red and byte restoration returned green`);
