import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { createRequire } from 'node:module';
import ts from 'typescript';
import type { CandidateForRanking } from '../src/lib/sourcing/ranking-new';

async function main() {
  assert.equal(process.versions.node.split('.')[0], '20');
  assert.equal(process.env.SIGNAL_CANDIDATE_PRIVACY_TEST_ADAPTER, undefined);
  const require = createRequire(__filename);
  const orchestrator = await readFile('src/lib/sourcing/orchestrator.ts', 'utf8');
  // Exercise the production entry graphs without starting consumers/timers or
  // connecting Redis. The sourcing worker statically imports queue + import worker;
  // the maintenance .mjs entry dynamically imports these TypeScript modules.
  if (process.env.MODULE_TEST_ENTRY === 'maintenance') {
    await import('../src/lib/sourcing/public-memory-ingest-outbox');
    await import('../src/lib/sourcing/public-memory-ingest-worker');
  } else {
    require('../src/lib/sourcing/queue');
    require('../src/lib/sourcing/public-memory-ingest-worker');
  }
  // Load this boundary before any test imports can accidentally prime its cache.
  const ingest: typeof import('../src/lib/sourcing/immutable-memory-ingest') =
    /await import\('\.\/immutable-memory-ingest'\)/.test(orchestrator)
      ? await import('../src/lib/sourcing/immutable-memory-ingest')
      : require('../src/lib/sourcing/immutable-memory-ingest');
  const { ImmutableMemoryRepository, prepareMemoryPacket } = ingest;
  const { prisma }: typeof import('../src/lib/prisma') = require('../src/lib/prisma');
  const { memoryPreparationFailure }: typeof import('../src/lib/sourcing/memory-preparation-diagnostics') = require('../src/lib/sourcing/memory-preparation-diagnostics');
  const owner = new Client({ connectionString: process.env.MODULE_TEST_OWNER_URL });
  await owner.connect();
  let snapshots = 0, changeState = false;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { void (async () => {
      response.setHeader('content-type', 'application/json');
      if (request.url?.startsWith('/candidate-privacy/snapshot')) {
        snapshots++;
        if (changeState && snapshots === 2) await owner.query("UPDATE candidate_privacy_sync_state SET cursor=40 WHERE consumer_name='discover'");
        response.end(JSON.stringify({ high_water_cursor: 39, directives: [], count: 0 })); return;
      }
      if (request.url === '/candidate-privacy/eligibility/batch') {
        const subjects = JSON.parse(body).subjects as Array<{ request_ref: string }>;
        response.end(JSON.stringify({ results: subjects.map(s => ({ request_ref: s.request_ref, decision: 'allow' })), count: subjects.length })); return;
      }
      response.writeHead(404); response.end();
    })().catch(() => { response.writeHead(500); response.end(); }); });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    process.env.ACTIVEGRAPH_URL = `http://127.0.0.1:${address.port}`;
    process.env.SIGNAL_JWT_ACTIVE_KID = 'local-only';
    process.env.SIGNAL_JWT_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, process.env.ACTIVEGRAPH_URL, 'nonlocal HTTP refused');
      return originalFetch(input, init);
    };
    await owner.query(`UPDATE candidate_privacy_sync_state SET cursor=39,active_generation=57,status='healthy',
      last_success_at=clock_timestamp(),expected_candidates=10,projected_candidates=10 WHERE consumer_name='discover'`);
    const repository = new ImmutableMemoryRepository();
    const fixture = async () => {
      const id = randomUUID(), fence = { executionAttemptId: 'synthetic-execution', processingLeaseId: 'synthetic-lease' };
      const acquisition = { tenantId: 'org_32', sourcingRequestId: id, acquisitionReceiptId: `receipt-${id}`, acquisitionGeneration: 1, acquisitionSlot: 'exact' as const };
      await owner.query(`INSERT INTO job_sourcing_requests(id,"tenantId","externalJobId","jobContextHash","jobContext","callbackUrl",status,protocol_version,execution_attempt_id,processing_lease_id,flow_run_id,artifact_hash)
        VALUES($1::text,'org_32',$1::text,$1::text,'{}','https://example.invalid','processing',2,$2,$3,$1::text::uuid,repeat('a',64))`, [id, fence.executionAttemptId, fence.processingLeaseId]);
      await owner.query(`INSERT INTO crustdata_acquisition_receipts(id,"tenantId","sourcingRequestId","acquisitionGeneration",slot,status,"requestFingerprint","requestInput","requestMetadata",result,"updatedAt",memory_delivery_contract)
        VALUES($1,'org_32',$2,1,'exact','complete',repeat('a',64),'{}','{}',$3::jsonb,clock_timestamp(),2)`,
        [acquisition.acquisitionReceiptId, id, JSON.stringify({ profiles: Array.from({ length: 300 }, (_, i) => ({ crustdata_person_id: i + 1 })) })]);
      const at = new Date();
      const packets = Array.from({ length: 300 }, (_, i) => prepareMemoryPacket(acquisition, {
        id: `https://linkedin.com/in/synthetic-${i}`, crustdata: { crustdata_person_id: i + 1, basic_profile: { name: 'Synthetic' } },
      } as CandidateForRanking, { ...acquisition, acquiredAt: at, profileObservedAt: at, expectedGlobalCandidateId: null }));
      return { acquisition, fence, packets };
    };
    const first = await fixture();
    const result = await repository.prepare(first.acquisition, first.packets, first.fence);
    assert.equal(result.sealed, true); assert.equal(result.members.length, 300);
    console.log(`PASS ${process.env.MODULE_TEST_ENTRY} graph / real prepare / 300 sealed members / restricted runtime`);
    const { createCandidateAdmissionProofs }: typeof import('../src/lib/candidate-privacy/decision') = require('../src/lib/candidate-privacy/decision');
    const { CandidatePrivacyAdmissionProof, assertAdmissionProofCurrent }: typeof import('../src/lib/candidate-privacy/repository') = require('../src/lib/candidate-privacy/repository');
    const proofs = await createCandidateAdmissionProofs([{ key: 'synthetic', linkedinUrl: 'https://linkedin.com/in/synthetic' }]);
    const proof = proofs.get('synthetic'); assert.ok(proof);
    await assertAdmissionProofCurrent(prisma, proof);
    const forged = [{ ...proof, isOpaque: () => true }, Object.assign(Object.create(Object.getPrototypeOf(proof)), proof)];
    // Force an independent module instance even on Node patch releases which
    // happen to unify ESM/CJS caches. Never weaken the issuer-identity guard.
    const repositoryPath = require.resolve('../src/lib/candidate-privacy/repository');
    const compiled = ts.transpileModule(await readFile(repositoryPath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const foreign: typeof import('../src/lib/candidate-privacy/repository') = {} as typeof import('../src/lib/candidate-privacy/repository');
    new Function('exports', 'require', compiled)(foreign, createRequire(repositoryPath));
    assert.notEqual(foreign.CandidatePrivacyAdmissionProof, CandidatePrivacyAdmissionProof);
    forged.push(foreign.CandidatePrivacyAdmissionProof.issue({ requestRef: randomUUID(), generation: BigInt(57), cursor: BigInt(39), decision: 'allow' }));
    for (const value of forged) await assert.rejects(assertAdmissionProofCurrent(prisma, value), /candidate_privacy_conflict/);
    console.log('PASS genuine proof / forged, copied, foreign proof rejection');
    const mixed = await fixture();
    const { partitionMemoryCandidates }: typeof import('../src/lib/sourcing/memory-candidate-validation') =
      require('../src/lib/sourcing/memory-candidate-validation');
    const synthetic = mixed.packets.map((p, i) => ({
      id: i === 299 ? 'https://linkedin.com/in/synthetic+invalid' : p.signalCandidateId,
      crustdata: { crustdata_person_id: i + 1, basic_profile: {name: 'Synthetic'} },
    } as CandidateForRanking));
    const mixedAt = new Date();
    const options = {...mixed.acquisition, acquiredAt: mixedAt, profileObservedAt: mixedAt, expectedGlobalCandidateId: null};
    const partition = partitionMemoryCandidates(synthetic, () => ({owner: mixed.acquisition, options}));
    assert.equal(partition.excluded.length, 1);
    const mixedResult = await repository.prepare(mixed.acquisition,
      partition.accepted.map(c => prepareMemoryPacket(mixed.acquisition, c, options)), mixed.fence, partition.excluded);
    assert.equal(mixedResult.members.length, 299);
    assert.equal(mixedResult.sealed, true);
    assert.equal((await owner.query('SELECT jsonb_array_length(memory_exclusions) n FROM crustdata_acquisition_receipts WHERE id=$1',
      [mixed.acquisition.acquisitionReceiptId])).rows[0].n, 1);
    console.log('PASS real Node20 loader / 299 accepted + 1 durable exclusion / no provider calls');
    const second = await fixture(); snapshots = 0; changeState = true;
    let failure: unknown;
    try { await repository.prepare(second.acquisition, second.packets, second.fence); } catch (error) { failure = error; }
    assert.ok(failure, 'privacy state change must refuse');
    assert.equal(memoryPreparationFailure(failure).stage, 'privacy_recheck');
    assert.equal(memoryPreparationFailure(failure).reason, 'privacy_conflict');
    assert.equal((await owner.query('SELECT count(*)::int n FROM public_memory_ingest_requests WHERE request_id=$1', [second.acquisition.sourcingRequestId])).rows[0].n, 0);
    assert.ok(/import \{ memoryPreparationStage, memoryPreparationFailure \} from '\.\/memory-preparation-diagnostics'/.test(orchestrator), 'orchestrator must share static diagnostic graph');
    assert.ok(!/await import\('\.\/memory-preparation-diagnostics'\)/.test(orchestrator));
    for (const file of ['orchestrator.ts', 'public-memory-ingest-outbox.ts', 'public-memory-ingest-worker.ts']) {
      const source = await readFile(`src/lib/sourcing/${file}`, 'utf8');
      assert.ok(!/import\(['"]\.\/immutable-memory-ingest['"]\)/.test(source), `${file}: dynamic ingest boundary`);
      assert.ok(/from ['"]\.\/immutable-memory-ingest['"]/.test(source), `${file}: static ingest import missing`);
    }
    console.log('PASS real privacy conflict stays closed / rollback / orchestrator stage label');
  } finally {
    await prisma.$disconnect();
    // Dynamic Node20 imports may instantiate another Prisma pool; the parent removes only its own DB.
    await owner.end(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
