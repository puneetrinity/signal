import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { MEMORY_PACKET_LIMITS, memoryPacketManifest, prepareMemoryPacket, readMemoryPacket,
  awaitMemoryAcquisition, confirmedMemoryPacketResult,
  type FrozenMemoryPacket, type MemoryAcquisitionOwner, type MemoryDeliveryMember } from '../immutable-memory-ingest';
import type { CandidateIngestResult } from '../activegraph-client';
import type { CandidateForRanking } from '../ranking-new';

describe('orchestrator RC kill switch regression', () => {
  // Execute the actual two production blocks, not a copied flag predicate.
  // External identity/link effects are spies; no orchestrator network or DB runs.
  const source = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('orchestrator.ts', source, ts.ScriptTarget.Latest, true);
  const blocks: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(tree).includes('governedCommand?.protocolVersion') &&
        (node.thenStatement.getText(tree).includes('addExpectedGlobalIdentityReceipt(') ||
         node.thenStatement.getText(tree).includes('await ensureCandidateGlobalLink(')) &&
        node.getText(tree).length < 2000) blocks.push(node.getText(tree));
    ts.forEachChild(node, visit);
  }
  visit(tree);
  async function run(flag: string | undefined, protocolVersion: number, slug: string | null) {
    expect(blocks).toHaveLength(2);
    const record = vi.fn();
    const link = vi.fn(async () => ({candidateId:'local'}));
    const js = ts.transpileModule(`async function check(){${blocks.join('\n')}}; return check();`,
      {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    await new Function('process','governedCommand','result','candidate','extractLinkedInIdFromUrl',
      'addExpectedGlobalIdentityReceipt','publicGlobalIdByIdentity','conflictedPublicIdentityKeys',
      'mappedForRanking','expectedGlobalCandidateIdForCandidate','candidateIdByLinkedinId',
      'ensureCandidateGlobalLink','tenantId',js)(
      {env:{RC_SKILLS_ENABLED:flag}}, {protocolVersion}, {globalCandidateId:'global'}, {linkedinUrl:null},
      () => slug, record, new Map(), new Set(), [{linkedinUrl:null}], () => 'global',
      new Map([['person','local']]), link, 'synthetic');
    return {record,link};
  }
  it.each([undefined,'false'])('RC=%s skips identity requirements and link writes with protocol 2 and no LinkedIn', async flag => {
    const effects = await run(flag,2,null);
    expect(effects.record).not.toHaveBeenCalled(); expect(effects.link).not.toHaveBeenCalled();
  });
  it('RC-on protocol 2 retains both identity effects', async () => {
    const effects = await run('true',2,'person');
    expect(effects.record).toHaveBeenCalledTimes(1); expect(effects.link).toHaveBeenCalledTimes(1);
  });
  it('RC-on protocol 2 still refuses missing LinkedIn identity', async () => {
    await expect(run('true',2,null)).rejects.toThrow('RC_IDENTITY_CONFLICT');
  });
  it('legacy protocol does not enter either RC-only block', async () => {
    const effects = await run('true',1,null);
    expect(effects.record).not.toHaveBeenCalled(); expect(effects.link).not.toHaveBeenCalled();
  });
});

const owner: MemoryAcquisitionOwner = { tenantId: 'org_32', sourcingRequestId: 'synthetic-request',
  acquisitionReceiptId: 'synthetic-purchase', acquisitionGeneration: 1, acquisitionSlot: 'exact' };
const at = new Date('2026-10-19T00:00:00.000Z');
const expected = '11111111-1111-4111-8111-111111111111';
const description = 'Built and operated backend services, reviewed designs, improved database queries, '
  + 'tested release automation and supported production incidents. '.repeat(6);

/** Synthetic, not copied from a candidate: six jobs, fifty skills, education,
 * two certificates and a populated summary/location. No provider/model calls. */
function person(index = 1): CandidateForRanking & { linkedinUrl: string; name: string } {
  const url = `https://linkedin.com/in/synthetic-person-${index}`;
  return {
    id: url, linkedinUrl: url, name: 'Synthetic Engineer', searchTitle: 'Backend Engineer',
    searchSnippet: 'Synthetic backend profile', headlineHint: 'Backend Engineer',
    locationHint: 'Bengaluru, India', snapshot: null, enrichmentStatus: 'pending', lastEnrichedAt: null,
    crustdata: { crustdata_person_id: 100000 + index,
      basic_profile: { name: 'Synthetic Engineer', headline: 'Backend Engineer',
        summary: description, languages: ['English', 'हिन्दी'],
        location: { city: 'Bengaluru', country: 'India', country_code: 'IN' } },
      experience: { employment_details: {
        current: [{ title: 'Backend Engineer', company_name: 'Synthetic Current',
          start_date: '2023-01-01', description }],
        past: Array.from({ length: 5 }, (_, i) => ({ title: 'Software Engineer',
          company_name: `Synthetic Previous ${i}`, start_date: `${2013 + i * 2}-01-01`,
          end_date: `${2015 + i * 2}-01-01`, description })),
      } },
      skills: { professional_network_skills: Array.from({ length: 50 }, (_, i) => `Synthetic Skill ${i}`) },
      education: [{ school: 'Synthetic University', degree: 'Computer Science', start_year: 2009, end_year: 2013 }],
      certifications: [{ name: 'Synthetic Certification A' }, { name: 'Synthetic Certification B' }],
      years_of_experience_raw: 13,
    },
  } as unknown as CandidateForRanking & { linkedinUrl: string; name: string };
}
function packet(index = 1, expectedGlobalCandidateId?: string): FrozenMemoryPacket {
  return prepareMemoryPacket(owner, person(index), { ...owner, acquiredAt: at,
    profileObservedAt: at, expectedGlobalCandidateId, publicCandidateRoleFamily: 'backend' });
}
function rewrite(value: FrozenMemoryPacket, change: (body: Record<string, unknown>) => void) {
  const body = JSON.parse(value.requestBody); change(body);
  const requestBody = JSON.stringify(body);
  return { ...value, requestBody, wireSha256: createHash('sha256').update(requestBody).digest('hex') };
}

describe('immutable Memory packet preparation (no transport)', () => {
  it('uses the existing adapter and freezes bytes before the candidate is mutated', () => {
    const candidate = person();
    const first = prepareMemoryPacket(owner, candidate, { ...owner, acquiredAt: at, profileObservedAt: at });
    const original = first.requestBody;
    candidate.name = 'Later display change'; candidate.searchSnippet = 'Later search change';
    expect(readMemoryPacket(first, owner).normalized_profile.display_name).toBe('Synthetic Engineer');
    expect(first.requestBody).toBe(original);
    expect(Object.isFrozen(first)).toBe(true);
  });
  it('keeps unknown identity absent, never serialises it as null', () => {
    const value = packet();
    expect(value.expectedGlobalCandidateId).toBeNull();
    expect(value.requestBody).not.toContain('expected_global_candidate_id');
    expect(() => readMemoryPacket(rewrite(value, body => { body.expected_global_candidate_id = null; }), owner)).toThrow();
  });
  it('keeps known identity unchanged even if a later lookup finds another ID', () => {
    const value = packet(1, expected);
    expect(readMemoryPacket(value, owner).expected_global_candidate_id).toBe(expected);
    expect(() => readMemoryPacket({ ...value, expectedGlobalCandidateId: '22222222-2222-4222-8222-222222222222' }, owner)).toThrow();
  });
  it.each(['tenantId', 'sourcingRequestId', 'acquisitionReceiptId', 'acquisitionGeneration', 'acquisitionSlot'] as const)(
    'rejects a different acquisition owner: %s', key => {
      const other = { ...owner, [key]: key === 'acquisitionGeneration' ? 2 : key === 'acquisitionSlot' ? 'spill' : 'other' };
      expect(() => readMemoryPacket(packet(), other as MemoryAcquisitionOwner)).toThrow();
    });
  it('refuses invalid preparation ownership before adaptation', () => {
    expect(() => prepareMemoryPacket(owner, person(), { ...owner, acquisitionSlot: 'spill',
      acquiredAt: at, profileObservedAt: at })).toThrow();
  });
  it('rejects bytes changed without the original hash', () => {
    expect(() => readMemoryPacket({ ...packet(), requestBody: packet().requestBody + ' ' }, owner)).toThrow();
  });
  it.each(['provider_record_id', 'acquisition_receipt_id', 'idempotency_key', 'linkedin_url'])(
    'rejects a changed identity even with a recomputed hash: %s', key => {
      expect(() => readMemoryPacket(rewrite(packet(), body => { body[key] = 'different'; }), owner)).toThrow();
    });
  it('rejects malformed JSON without logging the body', () => {
    const requestBody = '{';
    expect(() => readMemoryPacket({ ...packet(), requestBody,
      wireSha256: createHash('sha256').update(requestBody).digest('hex') }, owner)).toThrow('memory_packet_integrity');
  });
  it('measures the whole body in UTF-8 bytes, not JavaScript characters', () => {
    const value = packet();
    const remaining = MEMORY_PACKET_LIMITS.bodyBytes - Buffer.byteLength(value.requestBody);
    // Legal JSON whitespace gives an exact wire boundary without changing profile data.
    const requestBody = value.requestBody + ' '.repeat(remaining);
    const exact = { ...value, requestBody, wireSha256: createHash('sha256').update(requestBody).digest('hex') };
    expect(() => readMemoryPacket(exact, owner)).not.toThrow();
    expect(() => readMemoryPacket({ ...exact, requestBody: requestBody + ' ',
      wireSha256: createHash('sha256').update(requestBody + ' ').digest('hex') }, owner)).toThrow();
    const multibyte = rewrite(value, body => { body.normalized_profile = { summary: 'ह'.repeat(70_000) }; });
    expect(multibyte.requestBody.length).toBeLessThan(MEMORY_PACKET_LIMITS.profileBytes);
    expect(() => readMemoryPacket(multibyte, owner)).toThrow();
  });
  it('has a stable manifest regardless of caller iteration order', () => {
    const a = packet(1), b = packet(2);
    expect(memoryPacketManifest(owner, [a, b]).manifestSha256).toBe(memoryPacketManifest(owner, [b, a]).manifestSha256);
  });
  it('deduplicates identical members but refuses differing content for the same member', () => {
    const a = packet();
    expect(memoryPacketManifest(owner, [a, a])).toMatchObject({ inputCount: 2, memberCount: 1 });
    const different = rewrite(a, body => { (body.normalized_profile as Record<string, unknown>).headline = 'Different'; });
    expect(() => memoryPacketManifest(owner, [a, different])).toThrow();
  });
  it('does not share a key across two purchases of the same person', () => {
    const other = { ...owner, acquisitionReceiptId: 'second-purchase' };
    const value = prepareMemoryPacket(other, person(), { ...other, acquiredAt: at, profileObservedAt: at });
    expect(value.idempotencyKey).not.toBe(packet().idempotencyKey);
  });
  it('caps input at 300 even if duplicate members would collapse', () => {
    expect(() => memoryPacketManifest(owner, Array(301).fill(packet()))).toThrow();
  });
  it('records actual local 300-profile preparation size and time (not end-to-end latency)', () => {
    const before = process.memoryUsage().rss;
    const start = performance.now();
    const values = Array.from({ length: 300 }, (_, i) => packet(i + 1));
    const adaptedAt = performance.now();
    const manifest = memoryPacketManifest(owner, values);
    const end = performance.now();
    const bytes = values.map(value => Buffer.byteLength(value.requestBody)).sort((a, b) => a - b);
    expect(manifest.memberCount).toBe(300);
    expect(bytes[0]).toBeGreaterThan(4000);
    expect(bytes[299]).toBeLessThan(MEMORY_PACKET_LIMITS.bodyBytes);
    console.info('SYNTHETIC_MEMORY_PREPARATION', JSON.stringify({ members: 300,
      minBytes: bytes[0], medianBytes: bytes[149], maxBytes: bytes[299], totalBytes: bytes.reduce((a, b) => a + b, 0),
      adaptationMs: Math.round(adaptedAt - start), manifestMs: Math.round(end - adaptedAt),
      rssDeltaBytes: process.memoryUsage().rss - before }));
  });
});

function accepted(value: FrozenMemoryPacket): CandidateIngestResult {
  return { success: true, signalCandidateId: value.signalCandidateId, memoryCandidateId: null,
    globalCandidateId: expected, sourceRecordId: value.idempotencyKey, resolutionStatus: 'refreshed',
    deliveryStatus: 'recorded', sourceIdentityId: expected, sourceObservationId: expected,
    ingestReceiptId: value.idempotencyKey, errorCode: null };
}

describe('receipt-scoped ACK readback coordinator (repository stand-in, not SQL proof)', () => {
  function setup() {
    let clock = 1000;
    const value = packet(1, expected);
    let members: MemoryDeliveryMember[] = [{ packet: value, state: 'leased', result: null }];
    const reader = { read: vi.fn(async () => ({ sealed: true,
      manifestSha256: memoryPacketManifest(owner, [value]).manifestSha256, members })),
      drain: vi.fn(async () => {}) };
    const options = { now: () => clock, sleep: vi.fn(async (ms: number) => { clock += ms; }),
      assertExecution: vi.fn(async () => {}) };
    return { value, reader, options, set: (rows: MemoryDeliveryMember[]) => { members = rows; },
      advance: (ms: number) => { clock += ms; } };
  }
  it('uses an ACK already stored by the queue, without sending again', async () => {
    const t = setup(); t.set([{ packet: t.value, state: 'succeeded', result: accepted(t.value) }]);
    const rows = await awaitMemoryAcquisition(owner, t.reader, 2000, t.options);
    expect(rows[0].result?.globalCandidateId).toBe(expected);
    expect(t.reader.drain).not.toHaveBeenCalled();
    expect(t.options.assertExecution).toHaveBeenCalledTimes(2);
  });
  it('waits/readbacks when another process holds the lease, without adapting', async () => {
    const t = setup();
    t.reader.drain.mockImplementation(async () => {
      t.set([{ packet: t.value, state: 'succeeded', result: accepted(t.value) }]);
    });
    expect((await awaitMemoryAcquisition(owner, t.reader, 2000, t.options))[0].state).toBe('succeeded');
    expect(t.reader.drain).toHaveBeenCalledExactlyOnceWith(owner, 2000);
  });
  it('ends at the supplied deadline when the live lease never settles', async () => {
    const t = setup();
    await expect(awaitMemoryAcquisition(owner, t.reader, 1500, t.options)).rejects.toThrow('memory_ingest_wait_expired');
    expect(t.options.now()).toBe(1500);
    // A restarted waiter with the same absolute deadline gets no fresh allowance.
    const reads = t.reader.read.mock.calls.length;
    await expect(awaitMemoryAcquisition(owner, t.reader, 1500, t.options)).rejects.toThrow('memory_ingest_wait_expired');
    expect(t.reader.read).toHaveBeenCalledTimes(reads);
  });
  it('settles an accepted stale-anchor conflict with no RC identity, without rewriting bytes', async () => {
    const t = setup(); const original = t.value.requestBody;
    t.set([{ packet: t.value, state: 'succeeded', result: { ...accepted(t.value),
      resolutionStatus: 'conflict_review_required', globalCandidateId: null, sourceIdentityId: null } }]);
    const rows = await awaitMemoryAcquisition(owner, t.reader, 2000, t.options);
    expect(rows[0].result?.globalCandidateId).toBeNull();
    expect(rows[0].packet.requestBody).toBe(original);
    expect(t.reader.drain).not.toHaveBeenCalled();
  });
  it('does not treat a digest conflict/409 as an accepted identity conflict', async () => {
    const t = setup(); t.set([{ packet: t.value, state: 'blocked',
      result: { ...accepted(t.value), success: false, errorCode: 'http_409' } }]);
    await expect(awaitMemoryAcquisition(owner, t.reader, 2000, t.options)).rejects.toThrow('memory_ingest_needs_review');
    expect(t.reader.drain).not.toHaveBeenCalled();
  });
  it('rejects an ACK for another purchase of the same person', async () => {
    const t = setup(); t.set([{ packet: t.value, state: 'succeeded',
      result: { ...accepted(t.value), ingestReceiptId: 'a'.repeat(64) } }]);
    await expect(awaitMemoryAcquisition(owner, t.reader, 2000, t.options)).rejects.toThrow('memory_packet_integrity');
  });
  it.each(['created', 'refreshed', 'matched', 'stale'])(
    'preserves the existing resolved Memory outcome %s', resolutionStatus => {
      const value = packet();
      expect(confirmedMemoryPacketResult(value, { ...accepted(value), resolutionStatus })).toBe(true);
    });
  it('refuses conflict outcomes with invented identities', () => {
    const value = packet();
    expect(confirmedMemoryPacketResult(value, { ...accepted(value), resolutionStatus: 'conflict_review_required' })).toBe(false);
  });
  it('rejects execution revocation before allowing the RC handoff', async () => {
    const t = setup(); t.set([{ packet: t.value, state: 'succeeded', result: accepted(t.value) }]);
    t.options.assertExecution.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('execution_stale'));
    await expect(awaitMemoryAcquisition(owner, t.reader, 2000, t.options)).rejects.toThrow('execution_stale');
  });
  it('does not pass a late read to RC after the deadline', async () => {
    const t = setup();
    t.reader.read.mockImplementation(async () => { t.advance(2000); return { sealed: true,
      manifestSha256: memoryPacketManifest(owner, [t.value]).manifestSha256,
      members: [{ packet: t.value, state: 'succeeded', result: accepted(t.value) }] }; });
    await expect(awaitMemoryAcquisition(owner, t.reader, 2000, t.options)).rejects.toThrow('memory_ingest_wait_expired');
    expect(t.reader.drain).not.toHaveBeenCalled();
  });
  it('requires the complete seal rather than a parent completion timestamp', async () => {
    const t = setup(); t.reader.read.mockResolvedValue({ sealed: false, manifestSha256: '', members: [] });
    await expect(awaitMemoryAcquisition(owner, t.reader, 2000, t.options)).rejects.toThrow('memory_preparation_required');
    expect(t.reader.drain).not.toHaveBeenCalled();
  });
});
