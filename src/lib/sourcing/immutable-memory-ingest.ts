import { createHash } from 'node:crypto';
import { memoryPreparationStage as stage } from './memory-preparation-diagnostics';
// Keep proof issuance and verification in the same static module graph. Node 20
// + tsx can give dynamic imports a distinct instance (and therefore WeakSet).
import { createCandidateAdmissionProofs } from '@/lib/candidate-privacy/decision';
import { requireHealthyCandidatePrivacyContext, assertAdmissionProofCurrent, CANDIDATE_PRIVACY_ADMISSION_LOCK } from '@/lib/candidate-privacy/repository';
import type { CandidateIngestResult } from './activegraph-client';
import type { CandidateExclusion } from './memory-candidate-validation';
import {
  adaptCrustdataCandidateForMemory,
  computeSourcedCandidateIdempotencyKey,
  type ApprovedProviderCandidateIngestRequest,
  type SourcedCandidateAdapterOptions,
} from './sourced-candidate-adapter';

/** Wire limits are Memory's limits, not permission to truncate a profile. */
export const MEMORY_PACKET_LIMITS = Object.freeze({
  bodyBytes: 256 * 1024,
  profileBytes: 192 * 1024,
  members: 300,
});

export type MemoryAcquisitionOwner = Readonly<{
  tenantId: string;
  sourcingRequestId: string;
  acquisitionReceiptId: string;
  acquisitionGeneration: number;
  acquisitionSlot: 'exact' | 'spill';
}>;

export type FrozenMemoryPacket = Readonly<MemoryAcquisitionOwner & {
  version: 1;
  signalCandidateId: string;
  providerRecordId: string;
  linkedinUrl: string;
  expectedGlobalCandidateId: string | null;
  idempotencyKey: string;
  requestBody: string;
  wireSha256: string;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function invalid(): never { throw new Error('memory_packet_integrity'); }

function checkOwner(owner: MemoryAcquisitionOwner): void {
  if (!/^org_[1-9][0-9]*$/.test(owner.tenantId) ||
      !identifier.test(owner.sourcingRequestId) || !identifier.test(owner.acquisitionReceiptId) ||
      !Number.isSafeInteger(owner.acquisitionGeneration) || owner.acquisitionGeneration < 1 ||
      owner.acquisitionGeneration > 2_147_483_647 ||
      !['exact', 'spill'].includes(owner.acquisitionSlot)) invalid();
}

/** Only the pre-ranking preparation path calls the adapter. Delivery accepts
 * an immutable string and has no candidate object from which to rebuild it. */
export function prepareMemoryPacket(
  owner: MemoryAcquisitionOwner,
  candidate: Parameters<typeof adaptCrustdataCandidateForMemory>[0],
  options: SourcedCandidateAdapterOptions,
): FrozenMemoryPacket {
  checkOwner(owner);
  if (options.acquisitionReceiptId !== owner.acquisitionReceiptId ||
      options.acquisitionGeneration !== owner.acquisitionGeneration ||
      options.acquisitionSlot !== owner.acquisitionSlot) invalid();
  const payload = adaptCrustdataCandidateForMemory(candidate, options);
  const requestBody = JSON.stringify(payload);
  const packet = Object.freeze({
    ...owner, version: 1 as const, signalCandidateId: candidate.id,
    providerRecordId: payload.provider_record_id, linkedinUrl: payload.linkedin_url,
    expectedGlobalCandidateId: payload.expected_global_candidate_id ?? null,
    idempotencyKey: payload.idempotency_key, requestBody, wireSha256: sha256(requestBody),
  });
  readMemoryPacket(packet, owner);
  return packet;
}

/** Verify stored bytes without serialising them again. The parsed object is
 * only for validating the response/authority, never the outgoing fetch body.
 * A database read must additionally prove membership in a sealed acquisition. */
export function readMemoryPacket(
  packet: FrozenMemoryPacket,
  owner: MemoryAcquisitionOwner,
): ApprovedProviderCandidateIngestRequest {
  checkOwner(owner);
  for (const key of ['tenantId', 'sourcingRequestId', 'acquisitionReceiptId',
    'acquisitionGeneration', 'acquisitionSlot'] as const) {
    if (packet[key] !== owner[key]) invalid();
  }
  if (packet.version !== 1 || typeof packet.requestBody !== 'string' ||
      Buffer.byteLength(packet.requestBody, 'utf8') > MEMORY_PACKET_LIMITS.bodyBytes ||
      sha256(packet.requestBody) !== packet.wireSha256 ||
      typeof packet.signalCandidateId !== 'string' || !packet.signalCandidateId ||
      packet.signalCandidateId.length > 2048 ||
      !/^[1-9][0-9]{0,18}$/.test(packet.providerRecordId) ||
      (packet.expectedGlobalCandidateId !== null && !uuid.test(packet.expectedGlobalCandidateId))) invalid();
  let payload: ApprovedProviderCandidateIngestRequest;
  try { payload = JSON.parse(packet.requestBody); } catch { return invalid(); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.schema_version !== 1 || payload.provider_namespace !== 'crustdata' ||
      payload.record_type !== 'person' || payload.adapter_version !== 'crustdata_person_v1' ||
      payload.acquisition_receipt_id !== owner.acquisitionReceiptId ||
      payload.acquisition_generation !== owner.acquisitionGeneration ||
      payload.acquisition_slot !== owner.acquisitionSlot ||
      payload.provider_record_id !== packet.providerRecordId ||
      payload.linkedin_url !== packet.linkedinUrl ||
      payload.idempotency_key !== packet.idempotencyKey ||
      (payload.expected_global_candidate_id ?? null) !== packet.expectedGlobalCandidateId ||
      ('expected_global_candidate_id' in payload && typeof payload.expected_global_candidate_id !== 'string') ||
      !payload.normalized_profile || typeof payload.normalized_profile !== 'object' ||
      Array.isArray(payload.normalized_profile) ||
      Buffer.byteLength(JSON.stringify(payload.normalized_profile), 'utf8') > MEMORY_PACKET_LIMITS.profileBytes ||
      computeSourcedCandidateIdempotencyKey({
        providerRecordId: packet.providerRecordId,
        acquisitionReceiptId: owner.acquisitionReceiptId,
        acquisitionGeneration: owner.acquisitionGeneration,
        acquisitionSlot: owner.acquisitionSlot,
      }) !== packet.idempotencyKey) invalid();
  return payload;
}

/** Ordering uses ASCII provider IDs, never locale-sensitive collation. Reject
 * conflicting duplicates, rather than allowing a map's last writer to win. */
export function memoryPacketManifest(owner: MemoryAcquisitionOwner, packets: readonly FrozenMemoryPacket[]) {
  if (packets.length > MEMORY_PACKET_LIMITS.members) invalid();
  const members = new Map<string, FrozenMemoryPacket>();
  for (const packet of packets) {
    readMemoryPacket(packet, owner);
    const prior = members.get(packet.providerRecordId);
    if (prior && (prior.requestBody !== packet.requestBody ||
        prior.signalCandidateId !== packet.signalCandidateId)) invalid();
    members.set(packet.providerRecordId, packet);
  }
  const ordered = [...members.values()].sort((a, b) =>
    a.providerRecordId < b.providerRecordId ? -1 : a.providerRecordId > b.providerRecordId ? 1 : 0);
  return Object.freeze({
    inputCount: packets.length,
    memberCount: ordered.length,
    manifestSha256: memoryManifestHash(ordered),
    packets: Object.freeze(ordered),
  });
}

function memoryManifestHash(packets: readonly FrozenMemoryPacket[]) {
  return sha256([...packets].sort((a,b) => a.providerRecordId < b.providerRecordId ? -1 : a.providerRecordId > b.providerRecordId ? 1 : 0)
    .map(p => `${p.idempotencyKey}:${p.wireSha256}`).join('\n'));
}

export type MemoryDeliveryMember = Readonly<{
  packet: FrozenMemoryPacket;
  state: 'pending' | 'leased' | 'retry_wait' | 'succeeded' | 'suppressed' | 'blocked';
  result: CandidateIngestResult | null;
}>;

/** SQL must return members for this exact sealed purchase, never a person-wide
 * queue receipt. A caller cannot infer completion from a parent timestamp. */
export interface MemoryDeliveryReader {
  /** By default a read first reconciles privacy for every unsuppressed member,
   * including already-acknowledged ones. Polling reads pass `privacy: 'skip'`:
   * each send keeps its own fresh check, and the handoff read reconciles. */
  read(owner: MemoryAcquisitionOwner, options?: { privacy?: 'reconcile' | 'skip' }): Promise<{
    sealed: boolean;
    manifestSha256: string | null;
    members: readonly MemoryDeliveryMember[];
  }>;
  /** Drains only eligible work. It must leave another worker's live lease alone. */
  drain(owner: MemoryAcquisitionOwner, deadlineAt: number): Promise<void>;
}

export function confirmedMemoryPacketResult(packet: FrozenMemoryPacket, result: CandidateIngestResult | null): boolean {
  if (!result || !result.success || result.signalCandidateId !== packet.signalCandidateId ||
      !['recorded', 'replayed'].includes(result.deliveryStatus ?? '') ||
      result.ingestReceiptId !== packet.idempotencyKey || result.sourceRecordId !== packet.idempotencyKey ||
      !uuid.test(result.sourceObservationId ?? '')) return false;
  if (result.resolutionStatus === 'conflict_review_required') {
    return result.globalCandidateId === null && result.sourceIdentityId === null;
  }
  return ['created', 'refreshed', 'matched', 'stale'].includes(result.resolutionStatus ?? '') &&
    uuid.test(result.globalCandidateId ?? '') && uuid.test(result.sourceIdentityId ?? '') &&
    (!packet.expectedGlobalCandidateId || result.globalCandidateId === packet.expectedGlobalCandidateId);
}

/** Queue-first and restart-safe readback. The caller supplies its existing
 * absolute budget; retrying this function must not create a new deadline.
 * No adaptation, identity lookup, provider purchase or RC call is available here.
 * Suppressed members retain only the ownership/manifest needed for readback. */
export async function awaitMemoryAcquisition(
  owner: MemoryAcquisitionOwner,
  reader: MemoryDeliveryReader,
  deadlineAt: number,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void>; assertExecution: () => Promise<void> },
): Promise<readonly MemoryDeliveryMember[]> {
  checkOwner(owner);
  if (!Number.isFinite(deadlineAt)) invalid();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const settled = (members: readonly MemoryDeliveryMember[]) =>
    members.every(member => member.state === 'succeeded' || member.state === 'suppressed');
  const validate = (snapshot: Awaited<ReturnType<MemoryDeliveryReader['read']>>, blockedIsFatal: boolean) => {
    if (!snapshot.sealed) throw new Error('memory_preparation_required');
    for (const member of snapshot.members) {
      if (member.state !== 'suppressed') readMemoryPacket(member.packet, owner);
      else for (const key of ['tenantId','sourcingRequestId','acquisitionReceiptId','acquisitionGeneration','acquisitionSlot'] as const) {
        if (member.packet[key]!==owner[key]) invalid();
      }
    }
    if (memoryManifestHash(snapshot.members.map(member=>member.packet)) !== snapshot.manifestSha256 ||
        new Set(snapshot.members.map(member=>member.packet.providerRecordId)).size !== snapshot.members.length) invalid();
    if (blockedIsFatal && snapshot.members.some(member => member.state === 'blocked')) {
      throw new Error('memory_ingest_needs_review');
    }
    for (const member of snapshot.members) {
      if (member.state === 'succeeded' && !confirmedMemoryPacketResult(member.packet, member.result)) invalid();
    }
  };
  while (now() < deadlineAt) {
    await options.assertExecution();
    if (now() >= deadlineAt) break;
    // Polling does not re-prove the whole purchase: every send re-checks its
    // own candidate immediately before disclosure.
    const snapshot = await reader.read(owner, { privacy: 'skip' });
    if (now() >= deadlineAt) break;
    // A blocked member is not fatal until privacy has been reconciled: a
    // withdrawn candidate is suppressed, not left to fail the whole search.
    validate(snapshot, false);
    if (settled(snapshot.members) || snapshot.members.some(member => member.state === 'blocked')) {
      // Full privacy reconciliation before handoff (including members already
      // acknowledged that may since have been withdrawn) or before failing on
      // a blocked member.
      const reconciled = await reader.read(owner, { privacy: 'reconcile' });
      if (now() >= deadlineAt) break;
      validate(reconciled, true);
      if (settled(reconciled.members)) {
        // Fresh execution check also fences the readback-to-RC handoff. It
        // proves ownership only; privacy was reconciled just above.
        await options.assertExecution();
        if (now() >= deadlineAt) break;
        return reconciled.members;
      }
    }
    await reader.drain(owner, deadlineAt);
    if (now() >= deadlineAt) break;
    await sleep(Math.min(250, deadlineAt - now()));
  }
  throw new Error('memory_ingest_wait_expired');
}

type SqlClient = { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> };
type Snapshot = Awaited<ReturnType<MemoryDeliveryReader['read']>> & { deadlineAt: string | null; memberCount: number | null };
type ClaimedPacket = { packet: FrozenMemoryPacket; id: string; leaseToken: string };
type Fence = { executionAttemptId: string; processingLeaseId: string };

async function command(db: SqlClient, owner: MemoryAcquisitionOwner, value: Record<string, unknown>): Promise<unknown> {
  const rows = await db.$queryRawUnsafe<Array<{ result: unknown }>>(
    'SELECT public.signal_memory_ingest($1::jsonb,$2::jsonb) AS result', JSON.stringify(owner), JSON.stringify(value));
  if (rows.length !== 1) invalid();
  return rows[0].result;
}

/** Every caller uses this repository/executor; no caller gets a mapper or a
 * provider client during delivery. SQL owns the lease and eight-attempt cap. */
export class ImmutableMemoryRepository implements MemoryDeliveryReader {
  private async db() { return (await import('@/lib/prisma')).prisma; }

  async prepare(owner: MemoryAcquisitionOwner, packets: readonly FrozenMemoryPacket[], fence: Fence,
    exclusions: readonly CandidateExclusion[] = []): Promise<Snapshot> {
    const db = await this.db();
    const unique = await stage('manifest', () => memoryPacketManifest(owner, packets).packets);
    const context = await stage('privacy_context', () => requireHealthyCandidatePrivacyContext());
    const proofs = await stage('privacy_proofs', () => createCandidateAdmissionProofs(unique.map(p => ({ key: p.idempotencyKey,
      linkedinUrl: p.linkedinUrl, globalCandidateId: p.expectedGlobalCandidateId }))));
    await stage('transaction', () => db.$transaction(async tx => {
      await stage('privacy_lock', () => tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', CANDIDATE_PRIVACY_ADMISSION_LOCK));
      await stage('privacy_recheck', async () => {
      const current = await requireHealthyCandidatePrivacyContext(tx);
      if (current.generation !== context.generation || current.cursor !== context.cursor) throw Error('candidate_privacy_conflict');
      const first = proofs.values().next().value;
      if (first) await assertAdmissionProofCurrent(tx, first);
      // All proofs were just issued by one high-water-checked batch, above.
      for (const proof of proofs.values()) if (proof.generation !== current.generation || proof.cursor !== current.cursor) throw Error('candidate_privacy_conflict');
      });
      for (let i = 0; i < unique.length; i += 25) {
        await stage('append', () => command(tx, owner, { action: 'append', ...fence,
          packets: unique.slice(i, i + 25).map(p => ({ ...p, initialSuppressed: !proofs.has(p.idempotencyKey) })) }));
      }
      await stage('seal', () => command(tx, owner, { action: 'seal', ...fence, exclusions }));
    }, { maxWait: 2000, timeout: 5000 }));
    return stage('readback', () => this.read(owner));
  }

  private async privacy(owner: MemoryAcquisitionOwner): Promise<void> {
    const db = await this.db();
    const anchors = await command(db, owner, { action: 'anchors' }) as Array<FrozenMemoryPacket & { id: string; state: string; resolvedId: string | null }>;
    if (!Array.isArray(anchors) || anchors.length > 300) invalid();
    const active = anchors.filter(p => p.state !== 'suppressed');
    const proofs = await createCandidateAdmissionProofs(active.map(p => ({ key: p.id,
      linkedinUrl: p.linkedinUrl, globalCandidateId: p.resolvedId ?? p.expectedGlobalCandidateId })));
    for (const p of active) if (!proofs.has(p.id)) await command(db, owner, { action: 'suppress_member', id: p.id });
  }

  async read(owner: MemoryAcquisitionOwner, options: { privacy?: 'reconcile' | 'skip' } = {}): Promise<Snapshot> {
    if (options.privacy !== 'skip') await this.privacy(owner);
    const result = await command(await this.db(), owner, { action: 'read' }) as Snapshot;
    if (!result || typeof result.sealed !== 'boolean' || !Array.isArray(result.members) || result.members.length > 300) invalid();
    return result;
  }

  async drain(owner: MemoryAcquisitionOwner, deadlineAt: number): Promise<void> {
    if (Date.now() >= deadlineAt) return;
    // No whole-purchase privacy pass here: each claimed packet gets a fresh
    // privacy check immediately before it is sent (sendFrozenMemoryPacket), and
    // a withdrawn or review member is suppressed by that check.
    const db = await this.db();
    const rows = await command(db, owner, { action: 'claim', limit: 10 }) as ClaimedPacket[];
    if (!Array.isArray(rows) || rows.length > 10) invalid();
    const { sendFrozenMemoryPacket } = await import('./activegraph-client');
    await Promise.all(rows.map(async row => {
      try {
        readMemoryPacket(row.packet, owner);
        // Transport has its own last-moment privacy check; privacy and storage have separate limits.
        if (Date.now() >= deadlineAt) throw Error('memory_wait_expired');
        const result = await sendFrozenMemoryPacket(row.packet, deadlineAt);
        if (confirmedMemoryPacketResult(row.packet, result)) {
          await command(db, owner, { action: 'ack', id: row.id, leaseToken: row.leaseToken, result });
        } else if (result.errorCode === 'privacy_restricted') {
          await command(db, owner, { action: 'suppress', id: row.id, leaseToken: row.leaseToken });
        } else {
          const raw = result.errorCode;
          const code = raw === 'http_409' ? 'idempotency_conflict' :
            ['transport','timeout','privacy_unavailable','invalid_contract','identity_mismatch','auth_configuration'].includes(raw ?? '') ? raw! :
              /^http_(408|425|429|5\d\d)$/.test(raw ?? '') ? 'http_retryable' : /^http_4\d\d$/.test(raw ?? '') ? 'http_terminal' : 'unexpected';
          await command(db, owner, { action: 'fail', id: row.id, leaseToken: row.leaseToken, code,
            terminal: ['idempotency_conflict','invalid_contract','identity_mismatch','auth_configuration','http_terminal'].includes(code) });
        }
      } catch (error) {
        await command(db, owner, { action: 'fail', id: row.id, leaseToken: row.leaseToken,
          code: error instanceof Error && error.message === 'memory_packet_integrity' ? 'packet_integrity' : 'unexpected',
          terminal: error instanceof Error && error.message === 'memory_packet_integrity' });
      }
    }));
  }

  async finish(owner: MemoryAcquisitionOwner): Promise<boolean> {
    await this.privacy(owner);
    return await command(await this.db(), owner, { action: 'complete' }) === true;
  }
}

export async function immutableAcquisitions(tenantId?: string, requestId?: string): Promise<MemoryAcquisitionOwner[]> {
  const { prisma } = await import('@/lib/prisma');
  const rows=await prisma.$queryRawUnsafe<Array<{result:MemoryAcquisitionOwner[]}>>(
    'SELECT public.signal_memory_ingest_work($1::text,$2::text,10) result',tenantId??null,requestId??null);
  if(rows.length!==1||!Array.isArray(rows[0].result)||rows[0].result.length>10)invalid();
  return rows[0].result;
}

export async function runImmutableMemoryCycle(): Promise<void> {
  const repository = new ImmutableMemoryRepository();
  for (const owner of await immutableAcquisitions()) {
    const snapshot = await repository.read(owner);
    if (!snapshot.sealed) continue; // preparation_required; never reconstruct.
    await repository.drain(owner, Date.now() + 5000);
    await repository.finish(owner);
  }
  const { prisma } = await import('@/lib/prisma');
  const delivered = await prisma.$queryRawUnsafe<MemoryAcquisitionOwner[]>(`SELECT a."tenantId" AS "tenantId",a."sourcingRequestId" AS "sourcingRequestId",
    a.id AS "acquisitionReceiptId",a."acquisitionGeneration" AS "acquisitionGeneration",a.slot AS "acquisitionSlot"
    FROM public.crustdata_acquisition_receipts a JOIN public.job_sourcing_requests j ON j.id=a."sourcingRequestId" AND j."tenantId"=a."tenantId"
    WHERE a.memory_delivery_contract=2 AND a.memory_ingested_at<clock_timestamp()-interval '24 hours'
     AND a.memory_ingest_metadata->>'compactedAt' IS NULL
     AND j.status='complete' AND j.callback_status='delivered'
    ORDER BY a.memory_ingested_at DESC LIMIT 10`);
  for (const owner of delivered) await command(prisma, owner, { action: 'compact' });
}
