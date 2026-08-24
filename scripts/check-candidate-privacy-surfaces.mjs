import { access, readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_ROW_KEYS = [
  'direction',
  'enforcement',
  'file',
  'model',
  'reachability',
  'scope',
  'symbol',
  'testId',
];

const CANDIDATE_BEARING =
  /\b(candidate|candidates|Candidate|JobSourcingCandidate|ContactEnrichmentOperation|PublicMemoryIngestOutbox|CrustdataAcquisitionReceipt)\b/;
const ACTIVE_BOUNDARY =
  /\b(prisma\.(?:candidate|jobSourcingCandidate|candidateGlobalLink|contactEnrichmentOperation|publicMemoryIngestOutbox|crustdataAcquisitionReceipt)|searchPeople\s*\(|searchLinkedinProfiles\s*\(|deliverCallback\s*\(|enqueueGraphSync\s*\()/;

const REQUIRED_PATTERNS = new Map([
  ['src/app/api/v3/jobs/[id]/source/route.ts', [
    /requireHealthyCandidatePrivacyContext\(\)/,
    /candidate_privacy_unavailable/,
  ]],
  ['src/app/api/v3/jobs/[id]/results/route.ts', [
    /candidatePrivacyAllowedRelationWhere\(privacyContext\)/,
    /take:\s*limit/,
  ]],
  ['src/app/api/v3/candidates/[id]/find-contact/route.ts', [
    /requireCandidatePrivacyAllowed\(/,
    /candidate_privacy_unavailable/,
  ]],
  ['src/app/api/v3/pool/backfill/route.ts', [
    /candidatePrivacyAllowedRelationWhere\(privacyContext\)/,
    /requireHealthyCandidatePrivacyContext\(\)/,
  ]],
  ['src/lib/sourcing/worker.ts', [
    /startCandidatePrivacyProcessor\(\)/,
    /stopCandidatePrivacyProcessor\(\)/,
  ]],
  ['src/lib/sourcing/orchestrator.ts', [
    /candidatePrivacyAllowedRelationWhere\(privacyContext\)/,
    /JOIN "candidate_privacy_projection"/,
  ]],
  ['src/lib/sourcing/discovery.ts', [
    /requireHealthyCandidatePrivacyContext\(\)/,
    /upsertDiscoveredCandidates\(/,
  ]],
  ['src/lib/sourcing/upsert-candidates.ts', [
    /createCandidateAdmissionProofs\(/,
    /persistAdmissionProjection\(/,
  ]],
  ['src/lib/sourcing/sourcing-candidate-persistence.ts', [
    /CANDIDATE_PRIVACY_ADMISSION_LOCK/,
    /filterCandidateIdsBeforeLimit\(/,
  ]],
  ['src/lib/sourcing/callback.ts', [
    /requireHealthyCandidatePrivacyContext\(\)/,
    /candidatePrivacyAllowedRelationWhere\(privacyContext\)/,
  ]],
  ['src/lib/sourcing/rescore.ts', [/requireCandidatePrivacyAllowed\(/]],
  ['src/lib/sourcing/novelty.ts', [/candidatePrivacyAllowedRelationWhere\(privacyContext\)/]],
  ['src/lib/sourcing/crustdata-acquisition.ts', [
    /requireHealthyCandidatePrivacyContext\(\)/,
    /createCandidateAdmissionProofs\(/,
  ]],
  ['src/lib/sourcing/public-memory-materialization.ts', [
    /createCandidateAdmissionProofs\(/,
    /admissionProofs/,
  ]],
  ['src/lib/sourcing/public-memory-ingest-outbox.ts', [
    /createCandidateAdmissionProofs\(/,
    /assertAdmissionProofCurrent\(/,
    /JOIN "candidate_privacy_projection"/,
  ]],
  ['src/lib/sourcing/public-memory-ingest-worker.ts', [/requireCandidatePrivacyAllowed\(/]],
  ['src/lib/integrations/candidate-graph-sync.ts', [/requireCandidatePrivacyAllowed\(/]],
  ['src/lib/integrations/candidate-graph-worker.ts', [/requireCandidatePrivacyAllowed\(/]],
  ['src/lib/contact-enrichment/store.ts', [
    /CANDIDATE_PRIVACY_ADMISSION_LOCK/,
    /JOIN "candidate_privacy_projection"/,
  ]],
  ['src/lib/contact-enrichment/worker.ts', [/requireCandidatePrivacyAllowed\(/]],
  ['src/lib/contact-enrichment/webhook-handler.ts', [/requireCandidatePrivacyAllowed\(/]],
  ['src/lib/candidate-privacy/memory-client.ts', [
    /signCandidatePrivacyJWT\(/,
    /MAX_RESPONSE_BYTES/,
    /AbortSignal\.timeout/,
  ]],
  ['src/lib/candidate-privacy/processor.ts', [
    /status:\s*'rebuilding'/,
    /CANDIDATE_PRIVACY_ADMISSION_LOCK/,
    /finalProjectionCount !== expectedCandidates/,
  ]],
]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sourceFiles(root, directory) {
  const absolute = resolve(root, directory);
  if (!(await exists(absolute))) return [];
  const result = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const path = join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      result.push(...await sourceFiles(root, relative(root, path)));
    } else if (extname(entry.name) === '.ts') {
      result.push(path);
    }
  }
  return result;
}

export async function evaluateCandidatePrivacySurfaces(root) {
  const offenders = [];
  const manifestPath = resolve(root, 'src/lib/candidate-privacy/surfaces.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return ['candidate privacy surface manifest is missing or invalid JSON'];
  }
  if (
    manifest?.formatVersion !== 1 ||
    manifest?.system !== 'discover' ||
    !Array.isArray(manifest?.surfaces) ||
    !Array.isArray(manifest?.retired)
  ) {
    return ['candidate privacy surface manifest has an unsupported shape'];
  }

  const manifestFiles = new Set();
  const identities = new Set();
  const surfaceContractTests = await readFile(
    resolve(root, 'src/lib/candidate-privacy/__tests__/surface-contract.test.ts'),
    'utf8',
  );
  for (const row of manifest.surfaces) {
    if (
      !row ||
      typeof row !== 'object' ||
      JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(REQUIRED_ROW_KEYS)
    ) {
      offenders.push('candidate privacy surface row has missing or unknown fields');
      continue;
    }
    if (Object.values(row).some((value) => typeof value !== 'string' || value.length === 0)) {
      offenders.push('candidate privacy surface row contains an empty/non-string field');
      continue;
    }
    const identity = `${row.file}#${row.symbol}`;
    if (identities.has(identity)) offenders.push(`duplicate candidate privacy surface: ${identity}`);
    identities.add(identity);
    manifestFiles.add(row.file);
    const absolute = resolve(root, row.file);
    if (!(await exists(absolute))) {
      offenders.push(`candidate privacy surface file is missing: ${row.file}`);
      continue;
    }
    const source = await readFile(absolute, 'utf8');
    if (!source.includes(row.symbol)) {
      offenders.push(`candidate privacy surface symbol is missing: ${identity}`);
    }
    if (!surfaceContractTests.includes(`'${row.testId}'`)) {
      offenders.push(`candidate privacy surface test id is unregistered: ${row.testId}`);
    }
  }

  const productionFiles = [
    ...await sourceFiles(root, 'src/app'),
    ...await sourceFiles(root, 'src/lib'),
  ];
  for (const absolute of productionFiles) {
    const rel = relative(root, absolute);
    const source = await readFile(absolute, 'utf8');
    if ((CANDIDATE_BEARING.test(source) || ACTIVE_BOUNDARY.test(source)) && !manifestFiles.has(rel)) {
      offenders.push(`unclassified candidate-bearing surface: ${rel}`);
    }
  }

  for (const [file, patterns] of REQUIRED_PATTERNS) {
    const source = await readFile(resolve(root, file), 'utf8');
    for (const pattern of patterns) {
      if (!pattern.test(source)) offenders.push(`${file} lost privacy enforcement ${pattern}`);
    }
  }

  const sourceRoute = await readFile(
    resolve(root, 'src/app/api/v3/jobs/[id]/source/route.ts'),
    'utf8',
  );
  if (sourceRoute.indexOf('requireHealthyCandidatePrivacyContext()') > sourceRoute.indexOf('request.json()')) {
    offenders.push('source route parses its body before the privacy health gate');
  }
  const worker = await readFile(resolve(root, 'src/lib/sourcing/worker.ts'), 'utf8');
  const processorStart = worker.indexOf('startCandidatePrivacyProcessor()');
  for (const later of [
    'startPublicMemoryIngestWorker()',
    'startContactEnrichmentWorker()',
    'startSourcingWorker()',
  ]) {
    const index = worker.indexOf(later);
    if (processorStart < 0 || (index >= 0 && processorStart > index)) {
      offenders.push(`sourcing worker does not start privacy before ${later}`);
    }
  }

  const privacyClient = await readFile(
    resolve(root, 'src/lib/candidate-privacy/memory-client.ts'),
    'utf8',
  );
  if (/sign(?:ActiveGraph|Service)JWT/.test(privacyClient)) {
    offenders.push('candidate privacy client uses a generic signer');
  }
  const privacyConfig = await readFile(
    resolve(root, 'src/lib/candidate-privacy/config.ts'),
    'utf8',
  );
  if (
    !/env\.NODE_ENV === 'test'\s*&&\s*\n?\s*env\.SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER === 'disposable_passthrough'/.test(
      privacyConfig,
    )
  ) {
    offenders.push('candidate privacy disposable adapter lost its two-part test-only gate');
  }
  for (const absolute of productionFiles) {
    const rel = relative(root, absolute);
    const source = await readFile(absolute, 'utf8');
    if (
      rel !== 'src/lib/candidate-privacy/memory-client.ts' &&
      rel !== 'src/lib/sourcing/activegraph-auth.ts' &&
      (
        source.includes('signCandidatePrivacyJWT') ||
        /['"`]\/candidate-privacy\/(?:eligibility|changes|snapshot)/.test(source)
      )
    ) {
      offenders.push(`candidate privacy signer/endpoint has an undeclared caller: ${rel}`);
    }
  }

  for (const retired of manifest.retired) {
    if (
      !retired ||
      typeof retired.file !== 'string' ||
      retired.behavior !== '410'
    ) {
      offenders.push('retired candidate surface has an unsupported contract');
      continue;
    }
    const files = await sourceFiles(root, retired.file);
    if (files.length === 0) offenders.push(`retired surface is missing: ${retired.file}`);
    for (const path of files) {
      const source = await readFile(path, 'utf8');
      if (!/legacy(?:V2|ImageProxy)GoneResponse\(\)/.test(source)) {
        offenders.push(`retired route is no longer a 410 tombstone: ${relative(root, path)}`);
      }
    }
  }
  const retirementHelper = await readFile(
    resolve(root, 'src/lib/legacy-retirement.ts'),
    'utf8',
  );
  if ((retirementHelper.match(/status:\s*410/g) ?? []).length < 3) {
    offenders.push('legacy retirement helpers no longer fail with HTTP 410');
  }

  const migration = await readFile(
    resolve(root, 'prisma/migrations/20260823000000_add_candidate_privacy_projection/migration.sql'),
    'utf8',
  );
  if (/^\s*(?:DELETE\s+FROM|TRUNCATE\b)|ON\s+DELETE\s+CASCADE/im.test(migration)) {
    offenders.push('candidate privacy migration contains destructive candidate-data authority');
  }
  if (!/ON DELETE RESTRICT/.test(migration)) {
    offenders.push('candidate privacy projection foreign key is not restrictive');
  }

  const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  if (/^\s+services:\s*$/m.test(workflow)) {
    offenders.push('CI database tests use a service-container bridge instead of runner-local PostgreSQL');
  }
  for (const required of [
    'check:candidate-privacy',
    'test:candidate-privacy-surfaces',
    'test:candidate-privacy:pg',
    'signal_candidate_privacy_test_runner',
    'server_version_num',
    '127.0.0.1',
  ]) {
    if (!workflow.includes(required)) offenders.push(`CI lost candidate privacy proof: ${required}`);
  }
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  for (const command of [
    packageJson.scripts?.start,
    packageJson.scripts?.['worker:sourcing'],
    packageJson.scripts?.['db:migrate:release'],
  ]) {
    if (String(command).includes('SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER')) {
      offenders.push('a production command activates the candidate privacy test adapter');
    }
  }
  if (
    !String(packageJson.scripts?.test).startsWith(
      'SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER=disposable_passthrough ',
    )
  ) {
    offenders.push('the legacy unit suite lacks its explicit disposable privacy marker');
  }

  return [...new Set(offenders)].sort();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders = await evaluateCandidatePrivacySurfaces(root);
  if (offenders.length > 0) {
    throw new Error(`Discover candidate privacy surface guard rejected:\n- ${offenders.join('\n- ')}`);
  }
  console.log('[Candidate privacy guard] Discover candidate-bearing surfaces are classified and fenced');
}
