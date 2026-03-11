/**
 * Candidate Graph Sync Worker (BullMQ)
 *
 * Processes candidate-graph-sync jobs: loads a tenant-scoped candidate,
 * resolves identity anchors, and upserts into the global ActiveKG graph.
 */

import { Worker, Job } from 'bullmq';
import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { resolveLocationDeterministic } from '@/lib/taxonomy/location-service';
import { activeKGClient } from './activekg-client';
import {
  GRAPH_SYNC_QUEUE_NAME,
  getRedisConnection,
  type CandidateGraphSyncJobData,
} from './candidate-graph-sync';

const log = createLogger('candidate-graph-sync');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CandidateWithRelations = NonNullable<
  Awaited<ReturnType<typeof loadCandidateWithRelations>>
>;

async function loadCandidateWithRelations(candidateId: string) {
  return prisma.candidate.findUnique({
    where: { id: candidateId },
    include: {
      intelligenceSnapshots: { orderBy: { computedAt: 'desc' }, take: 1 },
      identityCandidates: {
        where: { status: 'confirmed', confidence: { gte: 0.85 } },
        orderBy: { confidence: 'desc' },
      },
      confirmedIdentities: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Identity anchors
// ---------------------------------------------------------------------------

interface IdentityAnchors {
  linkedin_id?: string;
  github_id?: string;
  email_hash?: string;
  /** Per-anchor confidence for merge decisions */
  github_confidence?: number;
  email_confidence?: number;
}

function buildIdentityAnchors(candidate: CandidateWithRelations): IdentityAnchors {
  const anchors: IdentityAnchors = {};

  // LinkedIn ID is always available on Candidate
  if (candidate.linkedinId) {
    anchors.linkedin_id = candidate.linkedinId.toLowerCase();
  }

  // GitHub ID from confirmed/high-confidence identity candidates
  const githubIdentity = candidate.identityCandidates?.find(
    (ic) => ic.platform === 'github' && ic.confidence >= 0.85,
  );
  if (githubIdentity) {
    anchors.github_id = githubIdentity.platformId.toLowerCase();
    anchors.github_confidence = githubIdentity.confidence;
  }

  // Email hash from confirmed identities
  const confirmedWithEmail = candidate.confirmedIdentities?.find((ci) => {
    const contact = ci.contactInfo as Record<string, unknown> | null;
    return contact?.email;
  });
  if (confirmedWithEmail) {
    const email = (confirmedWithEmail.contactInfo as Record<string, unknown>)
      ?.email as string;
    anchors.email_hash = createHash('sha256')
      .update(email.toLowerCase())
      .digest('hex');
    // Confirmed identities are high confidence by definition
    anchors.email_confidence = 0.95;
  }

  return anchors;
}

// ---------------------------------------------------------------------------
// Global candidate field mapping
// ---------------------------------------------------------------------------

function buildGlobalCandidateFields(
  candidate: CandidateWithRelations,
  anchors: IdentityAnchors,
) {
  const snapshot = candidate.intelligenceSnapshots?.[0];

  // Resolve structured location from snapshot or candidate hint.
  // Only use resolved location if confidence >= 0.5 to avoid garbage
  // (e.g. locationHint containing headline text like "Vice President, Marketing").
  const locationText = snapshot?.location ?? candidate.locationHint;
  const resolved = locationText
    ? resolveLocationDeterministic(locationText)
    : null;
  const locationUsable = resolved && resolved.confidence >= 0.5;

  return {
    // Identity anchors — must be in payload so ActiveKG can find/merge
    linkedin_id: anchors.linkedin_id,
    github_id: anchors.github_id,
    email_hash: anchors.email_hash,
    linkedin_url: candidate.linkedinUrl,
    name: candidate.nameHint || undefined,
    headline: candidate.headlineHint || undefined,
    location_city: locationUsable ? (resolved.city ?? undefined) : undefined,
    location_country_code: locationUsable ? (resolved.countryCode ?? undefined) : undefined,
    location_confidence: candidate.locationConfidence ?? undefined,
    location_source: candidate.locationSource ?? undefined,
    role_family: snapshot?.roleType ?? candidate.roleType ?? undefined,
    seniority_band: snapshot?.seniorityBand ?? undefined,
    skills_normalized: snapshot?.skillsNormalized?.length
      ? snapshot.skillsNormalized
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

async function processCandidateGraphSync(
  job: Job<CandidateGraphSyncJobData>,
): Promise<void> {
  const { candidateId, tenantId, trigger } = job.data;

  // 1. Load candidate with relations
  const candidate = await loadCandidateWithRelations(candidateId);

  if (!candidate) {
    log.warn({ candidateId }, 'Candidate not found, skipping');
    return;
  }

  // 2. Build identity anchors
  const anchors = buildIdentityAnchors(candidate);

  // 3. Try to find existing global candidate
  const existingGlobal = await activeKGClient.findGlobalCandidate(tenantId, {
    linkedin_id: anchors.linkedin_id,
    github_id: anchors.github_id,
    email_hash: anchors.email_hash,
  });

  // 4. Determine merge action using the merge policy:
  //    - linkedin_id exact = 1.0 confidence, auto-merge
  //    - github/email exact = apply 0.85 gate
  //    - conflict (different linkedin_id) = split + review
  let globalCandidateId: string;
  let matchMethod: string | null = null;
  let matchConfidence: number | null = null;
  let action: 'created' | 'updated';

  if (existingGlobal) {
    // Check for conflicts
    if (
      anchors.linkedin_id &&
      existingGlobal.linkedin_id &&
      anchors.linkedin_id !== existingGlobal.linkedin_id
    ) {
      // CONFLICT: github/email matched a record with different linkedin_id
      // Create separate record, mark for review.
      // Strip ambiguous anchors (github_id, email_hash) so ActiveKG creates
      // a new record instead of re-matching the existing one.
      log.warn(
        {
          candidateId,
          existingGlobalId: existingGlobal.id,
          conflict: 'linkedin_id_mismatch',
        },
        'Identity conflict detected, creating separate record',
      );

      const splitAnchors: IdentityAnchors = {
        linkedin_id: anchors.linkedin_id,
      };
      const result = await activeKGClient.upsertGlobalCandidate(tenantId, {
        ...buildGlobalCandidateFields(candidate, splitAnchors),
        merge_status: 'split',
      });
      globalCandidateId = result.global_candidate_id;
      action = result.action;
      matchMethod = 'conflict_split';
      matchConfidence = 0;
    } else {
      // Determine match confidence
      if (
        anchors.linkedin_id &&
        existingGlobal.linkedin_id === anchors.linkedin_id
      ) {
        matchConfidence = 1.0;
        matchMethod = 'linkedin_id_exact';
      } else if (
        anchors.github_id &&
        existingGlobal.github_id === anchors.github_id
      ) {
        matchConfidence = anchors.github_confidence ?? 0.85;
        matchMethod = 'github_exact';
      } else if (
        anchors.email_hash &&
        existingGlobal.email_hash === anchors.email_hash
      ) {
        matchConfidence = anchors.email_confidence ?? 0.85;
        matchMethod = 'email_hash_exact';
      }

      // Apply merge threshold (linkedin_id bypasses, others need >= 0.85)
      if (
        matchMethod === 'linkedin_id_exact' ||
        (matchConfidence !== null && matchConfidence >= 0.85)
      ) {
        // Merge: update existing
        const result = await activeKGClient.upsertGlobalCandidate(tenantId, {
          ...buildGlobalCandidateFields(candidate, anchors),
          identity_confidence: matchConfidence ?? undefined,
          merge_status: 'merged',
        });
        globalCandidateId = result.global_candidate_id;
        action = result.action;
      } else {
        // Low confidence: create separate record.
        // Strip ambiguous anchors (github_id, email_hash) so ActiveKG creates
        // a new record instead of re-matching the existing one.
        log.info(
          { candidateId, matchConfidence, matchMethod },
          'Low confidence match, creating separate record',
        );
        const splitAnchors: IdentityAnchors = {
          linkedin_id: anchors.linkedin_id,
        };
        const result = await activeKGClient.upsertGlobalCandidate(tenantId, {
          ...buildGlobalCandidateFields(candidate, splitAnchors),
          merge_status: 'split',
          identity_confidence: matchConfidence ?? undefined,
        });
        globalCandidateId = result.global_candidate_id;
        action = result.action;
        matchMethod = 'low_confidence_split';
      }
    }
  } else {
    // New candidate
    const result = await activeKGClient.upsertGlobalCandidate(tenantId, {
      ...buildGlobalCandidateFields(candidate, anchors),
      identity_confidence: anchors.linkedin_id ? 1.0 : undefined,
    });
    globalCandidateId = result.global_candidate_id;
    action = result.action;
    matchMethod = 'new';
    matchConfidence = anchors.linkedin_id ? 1.0 : null;
  }

  // 5. Attach provenance
  await activeKGClient.upsertProvenance(tenantId, globalCandidateId, {
    source_type: 'web_discovery',
    tenant_id: undefined, // public
    source_detail: {
      signal_candidate_id: candidate.id,
      serp_query: candidate.searchQuery,
      serp_provider: candidate.searchProvider,
      discovered_at: candidate.createdAt.toISOString(),
      tenant_id: tenantId,
    },
  });

  // 6. Create local link
  await prisma.candidateGlobalLink.upsert({
    where: {
      tenantId_candidateId: { tenantId, candidateId },
    },
    create: {
      tenantId,
      candidateId,
      globalCandidateId,
      linkConfidence: matchConfidence,
      matchMethod,
    },
    update: {
      globalCandidateId,
      linkConfidence: matchConfidence,
      matchMethod,
    },
  });

  log.info(
    {
      candidateId,
      globalCandidateId,
      action,
      matchMethod,
      matchConfidence,
      trigger,
    },
    'Graph sync completed',
  );
}

// ---------------------------------------------------------------------------
// Worker singleton
// ---------------------------------------------------------------------------

let worker: Worker<CandidateGraphSyncJobData> | null = null;

export function startGraphSyncWorker(): void {
  if (worker) return;

  worker = new Worker<CandidateGraphSyncJobData>(
    GRAPH_SYNC_QUEUE_NAME,
    async (job) => processCandidateGraphSync(job),
    {
      connection: getRedisConnection(),
      concurrency: 2,
    },
  );

  worker.on('completed', (job) => {
    log.info({ jobId: job.id }, 'Job completed');
  });

  worker.on('failed', (job, error) => {
    log.error({ jobId: job?.id, error: error.message }, 'Job failed');
  });

  worker.on('error', (error) => {
    log.error({ error }, 'Worker error');
  });

  log.info('Graph sync worker started');
}

export async function stopGraphSyncWorker(): Promise<void> {
  if (!worker) return;
  const w = worker;
  worker = null;
  await w.close();
  log.info('Graph sync worker stopped');
}
