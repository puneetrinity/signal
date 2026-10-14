import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const enforcementContracts = [
  ['rc-contract-boundary','src/lib/sourcing/rc-skills/contracts.ts',['observationBodySchema=z.object','contentHash!==rankingHash(body)']],
  ['rc-evidence-boundary','src/lib/sourcing/rc-skills/evidence.ts',['RC_EVIDENCE_IDENTITY_CONFLICT','throw new OversizedEvidenceError']],
  ['rc-compute-boundary','src/lib/sourcing/rc-skills/rc-compute-worker.ts',['RC_COMPUTE_IDENTITY_CONFLICT','maxOldGenerationSizeMb:512','RC_COMPUTE_INVALID']],
  ['rc-membership-boundary','src/lib/sourcing/rc-skills/membership.ts',['RC_RECEIPT_BINDING_CONFLICT','RC_PURCHASE_LIMIT']],
  ['rc-memory-boundary','src/lib/sourcing/rc-skills/memory.ts',["scope:'rc-skills:read'|'rc-skills:write'",'parsed.data.contentHash!==body.observation.contentHash']],
  ['rc-provider-boundary','src/lib/sourcing/rc-skills/provider.ts',['AbortSignal.timeout','rcSkillsSchema.safeParse(data.skills)']],
  ['rc-repository-boundary','src/lib/sourcing/rc-skills/repository.ts',['pg_advisory_xact_lock','await requireHealthyCandidatePrivacyContext(tx)']],
  ['rc-worker-boundary','src/lib/sourcing/rc-skills/worker.ts',['await repository.dispatch','await filterCandidateIdsBeforeLimit']],
  ['rc-outbox-boundary','src/lib/sourcing/rc-skills/outbox.ts',['entry.payloadHash!==rcOutboxPayloadHash(entry.payload)','await input.memory.finish']],
  ['rc-alert-boundary','src/lib/sourcing/rc-skills/alerts.ts',['rcAlertSchema.parse(event)',"redirect:'error'"]],
  ['rc-maintenance-boundary','src/lib/sourcing/rc-skills/maintenance.ts',['if(!input.enabled)return summary',"await call('cleanup')"]],
  ['rubric-contract-boundary','src/lib/sourcing/rubric/contracts.ts',['rankingContractSchema','rankingHash(body)!==contractHash']],
  ['rubric-evidence-boundary','src/lib/sourcing/rubric/evidence.ts',['Foreign private evidence','evidenceShape.parse','new OversizedEvidenceError']],
  ['rubric-experience-boundary','src/lib/sourcing/rubric/experience.ts',['calculateExperience','roles.filter(role => !isInternship(role))']],
  ['rubric-score-boundary','src/lib/sourcing/rubric/score.ts',['evidenceSchema.parse','experienceEligibility']],
  ['rubric-repository-boundary','src/lib/sourcing/rubric/repository.ts',["SET LOCAL lock_timeout='2s'","set_config('signal.ranking_privacy_max_age_ms'","transaction.$queryRawUnsafe"]],
  [
    'route-source-restrictive',
    'src/app/api/v3/jobs/[id]/source/route.ts',
    ['requireHealthyCandidatePrivacyContext()', 'readSourcingBody(request)'],
  ],
  [
    'route-contact-restrictive',
    'src/app/api/v3/candidates/[id]/find-contact/route.ts',
    ['requireCandidatePrivacyAllowed(', 'findOrCreateContactOperation('],
  ],
  [
    'route-backfill-prelimit',
    'src/app/api/v3/pool/backfill/route.ts',
    ['candidatePrivacyAllowedRelationWhere(privacyContext)', 'take: 5000'],
  ],
  [
    'queued-source-restrictive',
    'src/lib/sourcing/queue/index.ts',
    ['requireHealthyCandidatePrivacyContext()', 'runSourcingOrchestrator('],
  ],
  [
    'orchestrator-prelimit',
    'src/lib/sourcing/orchestrator.ts',
    ['JOIN "candidate_privacy_projection"', 'LIMIT ${config.poolLayer1Cap}'],
  ],
  [
    'approved-source-convergence',
    'src/lib/sourcing/orchestrator.ts',
    ['enqueuePublicMemoryIngestOutbox(', 'ingestCandidateBatchWithResults('],
  ],
  [
    'approved-source-adapter',
    'src/lib/sourcing/sourced-candidate-adapter.ts',
    ['provider_namespace: PROVIDER_NAMESPACE', 'normalized_profile: buildProfile('],
  ],
  [
    'approved-source-last-moment',
    'src/lib/sourcing/activegraph-client.ts',
    ['requireNewCandidateAllowed(', 'signSourcedCandidateIngestJWT('],
  ],
  [
    'serper-zero-call',
    'src/lib/sourcing/discovery.ts',
    ['requireHealthyCandidatePrivacyContext()', 'searchLinkedInProfilesWithMeta('],
  ],
  [
    'crustdata-zero-persistence',
    'src/lib/sourcing/crustdata-acquisition.ts',
    ['privacyFilterCrustdataResult(', 'dependencies.store.complete('],
  ],
  [
    'result-persist-restrictive',
    'src/lib/sourcing/sourcing-candidate-persistence.ts',
    ['filterCandidateIdsBeforeLimit(', 'deleteMany('],
  ],
  [
    'callback-last-moment',
    'src/lib/sourcing/callback.ts',
    ['requireHealthyCandidatePrivacyContext()', 'fetch(callbackUrl'],
  ],
  [
    'rescore-zero-call',
    'src/lib/sourcing/rescore.ts',
    ['requireCandidatePrivacyAllowed(', 'resolveRolesBatch('],
  ],
  [
    'novelty-prelimit',
    'src/lib/sourcing/novelty.ts',
    [
      'requireHealthyCandidatePrivacyContext()',
      'candidate: candidatePrivacyAllowedRelationWhere(privacyContext)',
    ],
  ],
  [
    'memory-result-admission',
    'src/lib/sourcing/activegraph-client.ts',
    ['assertMemoryCandidatesPrivacyAllowed(', 'return results'],
  ],
  [
    'materialization-admission',
    'src/lib/sourcing/public-memory-materialization.ts',
    ['createCandidateAdmissionProofs(', 'upsertDiscoveredCandidates('],
  ],
  [
    'outbox-last-moment',
    'src/lib/sourcing/public-memory-ingest-worker.ts',
    ['requireCandidatePrivacyAllowed(', 'const result = await ingest(row)'],
  ],
  [
    'graph-stale-job',
    'src/lib/integrations/candidate-graph-worker.ts',
    ['await assertStillAllowed()', 'upsertGlobalCandidate('],
  ],
  [
    'contact-claim-prelimit',
    'src/lib/contact-enrichment/store.ts',
    ['JOIN "candidate_privacy_projection"', 'LIMIT ${limit}'],
  ],
  [
    'contact-provider-zero-call',
    'src/lib/contact-enrichment/worker.ts',
    ['requireCandidatePrivacyAllowed(', 'providers.startFullEnrich('],
  ],
  [
    'late-webhook-restrictive',
    'src/lib/contact-enrichment/webhook-handler.ts',
    ['requireCandidatePrivacyAllowed(', 'applyFullEnrichWebhookTransition('],
  ],
] as const;

// Some contract ids are exercised in the focused Memory/JWT tests or the
// disposable PostgreSQL matrix rather than by the static surface cases above.
// Keeping the complete registry here lets the CI guard reject a manifest row
// that points at no declared verification contract.
const registeredSurfaceTestIds = new Set([
  ...enforcementContracts.map(([testId]) => testId),
  'admission-atomic',
  'approved-source-jwt',
  'no-leak-canary',
  'privacy-config-contract',
  'privacy-jwt-contract',
  'privacy-memory-contract',
  'privacy-postgres-matrix',
  'retired-surfaces',
  'route-results-prelimit',
  'surface-census',
  'worker-start-order',
]);

async function routeFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await routeFiles(path));
    else if (entry.name === 'route.ts') result.push(path);
  }
  return result;
}

describe('candidate privacy surface contracts', () => {
  it('rubric-repository-boundary: claim and finish retain lock-before-privacy checks in SQL', async () => {
    const sql = await readFile(resolve(root, 'prisma/migrations/20261012000000_ranking_lock_work/migration.sql'), 'utf8');
    for (const name of ['signal_ranking_claim', 'signal_ranking_finish']) {
      // Extract directly by the next declaration; a missing declaration fails closed.
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const next = sql.indexOf('CREATE OR REPLACE FUNCTION', start + 1);
      const body = sql.slice(start, next < 0 ? undefined : next);
      expect(body).toContain("pg_advisory_xact_lock(hashtextextended('discover_candidate_privacy_admission_v1',0))");
      expect(body).toContain('candidate_privacy_unavailable');
      expect(body.indexOf('pg_advisory_xact_lock')).toBeLessThan(body.indexOf('candidate_privacy_unavailable'));
      expect(body).toContain('max_age_ms');
    }
  });
  it('surface-census: every manifest row maps to a real symbol', async () => {
    const manifest = JSON.parse(await readFile(
      resolve(root, 'src/lib/candidate-privacy/surfaces.json'),
      'utf8',
    )) as { surfaces: Array<{ file: string; symbol: string; testId: string }> };
    expect(manifest.surfaces.length).toBeGreaterThan(40);
    const identities = new Set<string>();
    for (const surface of manifest.surfaces) {
      const source = await readFile(resolve(root, surface.file), 'utf8');
      expect(source, `${surface.file}#${surface.symbol}`).toContain(surface.symbol);
      expect(surface.testId).toMatch(/^[a-z0-9-]+$/);
      expect(registeredSurfaceTestIds.has(surface.testId)).toBe(true);
      identities.add(`${surface.file}#${surface.symbol}`);
    }
    expect(identities.size).toBe(manifest.surfaces.length);
  });

  it.each(enforcementContracts)(
    '%s: keeps the declared fence in its production surface',
    async (_testId, file, required) => {
      const source = await readFile(resolve(root, file), 'utf8');
      for (const marker of required) expect(source).toContain(marker);
      expect(source.indexOf(required[0])).toBeLessThan(source.lastIndexOf(required[1]));
    },
  );

  it('retired-surfaces: all five legacy handlers remain 410 tombstones', async () => {
    const helper = await readFile(resolve(root, 'src/lib/legacy-retirement.ts'), 'utf8');
    expect(helper.match(/status:\s*410/g)).toHaveLength(3);
    for (const file of [
      'src/app/api/v2/sessions/route.ts',
      'src/app/api/v2/search/route.ts',
      'src/app/api/v2/review/route.ts',
      'src/app/api/research/route.ts',
      'src/app/api/proxy-image/route.ts',
    ]) {
      expect(await readFile(resolve(root, file), 'utf8')).toMatch(
        /legacy(?:V2|ImageProxy)GoneResponse\(\)/,
      );
    }
  });

  it('preserves the exact 18 Next route registrations including the bounded preview', async () => {
    const files = await routeFiles(resolve(root, 'src/app/api'));
    let registrations = 0;
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      registrations += (source.match(/export async function (?:GET|POST|PUT|PATCH|DELETE)\b/g) ?? []).length;
    }
    expect(registrations).toBe(18);
  });

  it('worker-start-order: privacy starts before candidate-bearing loops', async () => {
    const source = await readFile(resolve(root, 'src/lib/sourcing/worker.ts'), 'utf8');
    const privacy = source.indexOf('startCandidatePrivacyProcessor()');
    expect(privacy).toBeGreaterThan(-1);
    for (const call of [
      'startPublicMemoryIngestWorker()',
      'startContactEnrichmentWorker()',
      'startSourcingWorker()',
    ]) {
      const index = source.indexOf(call);
      if (index >= 0) expect(privacy).toBeLessThan(index);
    }
  });

  it('no-leak-canary: debug persistence contains safe counters, not payloads', async () => {
    const source = await readFile(
      resolve(root, 'src/lib/sourcing/debug-pipeline-logs.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/JSON\.stringify\((?:candidates|profiles|providerResponse|ranked)/);
    expect(source).toContain('primaryCount');
    expect(source).toContain('enrichedCount');
  });

  it('admission-atomic: writers recheck opaque proofs under the shared lock', async () => {
    const repository = await readFile(
      resolve(root, 'src/lib/candidate-privacy/repository.ts'),
      'utf8',
    );
    expect(repository).toContain('issuedAdmissionProofs');
    expect(repository).toContain('pg_advisory_xact_lock');
    expect(repository).toContain('active_generation" = ${proof.generation}');
    const upsert = await readFile(
      resolve(root, 'src/lib/sourcing/upsert-candidates.ts'),
      'utf8',
    );
    expect(upsert).toContain('persistAdmissionProjection');
  });
});
