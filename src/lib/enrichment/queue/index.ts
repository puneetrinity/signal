/**
 * Async Enrichment Queue
 *
 * BullMQ-based job queue for background enrichment processing.
 * Supports:
 * - Async job creation with immediate response
 * - Progress tracking and status updates
 * - Retry and error handling
 * - Budget/rate limiting
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import type { RoleType } from '@/types/linkedin';
import type { EnrichmentBudget, EnrichmentGraphOutput, EnrichmentRunTrace } from '../graph/types';
import { runEnrichment } from '../graph/builder';
import { generateCandidateSummary, type SummaryMeta } from '../summary/generate';
import type { DiscoveredIdentity } from '../sources/types';

/**
 * Queue names
 */
export const QUEUE_NAMES = {
  ENRICHMENT: 'enrichment',
} as const;

/**
 * Job types for enrichment queue
 * - enrich: Full discovery + summary (default)
 * - summary_only: Regenerate summary from confirmed identities only
 */
export type EnrichmentJobType = 'enrich' | 'summary_only';

/**
 * Job data for enrichment jobs
 */
export interface EnrichmentJobData {
  sessionId: string;
  candidateId: string;
  tenantId: string; // Required for multi-tenancy
  jobType?: EnrichmentJobType;
  roleType?: RoleType;
  budget?: Partial<EnrichmentBudget>;
  priority?: number;
}

/**
 * Job result from enrichment
 */
export interface EnrichmentJobResult {
  sessionId: string;
  candidateId: string;
  status: EnrichmentGraphOutput['status'];
  identitiesFound: number;
  bestConfidence: number | null;
  durationMs: number;
  error?: string;
}

/**
 * Session status for tracking
 */
export type EnrichmentSessionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Session record in database (matches Prisma schema)
 */
export interface EnrichmentSession {
  id: string;
  candidateId: string;
  status: EnrichmentSessionStatus;
  roleType: RoleType | null;
  sourcesPlanned: string[] | null;
  sourcesExecuted: string[] | null;
  queriesPlanned: number | null;
  queriesExecuted: number | null;
  earlyStopReason: string | null;
  identitiesFound: number;
  identitiesConfirmed: number;
  finalConfidence: number | null;
  errorMessage: string | null;
  errorDetails: unknown | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;

  // Optional summary output (v2.1)
  summary?: string | null;
  summaryStructured?: unknown | null;
  summaryEvidence?: unknown | null;
  summaryModel?: string | null;
  summaryTokens?: number | null;
  summaryGeneratedAt?: string | null;

  createdAt: string;
  updatedAt: string;
}

/**
 * Redis connection singleton
 * Uses lazyConnect so connection is deferred until first use
 */
let redisConnection: IORedis | null = null;

function getRedisConnection(): IORedis {
  if (!redisConnection) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
      lazyConnect: true, // Don't connect immediately - safe during build
    });
  }
  return redisConnection;
}

/**
 * Queue singleton
 */
let enrichmentQueue: Queue<EnrichmentJobData, EnrichmentJobResult> | null = null;

export function getEnrichmentQueue(): Queue<EnrichmentJobData, EnrichmentJobResult> {
  if (!enrichmentQueue) {
    enrichmentQueue = new Queue(QUEUE_NAMES.ENRICHMENT, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          count: 1000,
          age: 24 * 3600, // Keep completed jobs for 24 hours
        },
        removeOnFail: {
          count: 5000,
          age: 7 * 24 * 3600, // Keep failed jobs for 7 days
        },
      },
    });
  }
  return enrichmentQueue;
}

/**
 * Queue events for progress tracking
 */
let queueEvents: QueueEvents | null = null;

export function getQueueEvents(): QueueEvents {
  if (!queueEvents) {
    queueEvents = new QueueEvents(QUEUE_NAMES.ENRICHMENT, {
      connection: getRedisConnection(),
    });
  }
  return queueEvents;
}

/**
 * Create an enrichment session and enqueue the job
 */
export async function createEnrichmentSession(
  tenantId: string,
  candidateId: string,
  options?: {
    roleType?: RoleType;
    budget?: Partial<EnrichmentBudget>;
    priority?: number;
  }
): Promise<{ sessionId: string; jobId: string }> {
  const sessionId = uuidv4();

  // Create session record using Prisma (tenant-scoped)
  try {
    await prisma.enrichmentSession.create({
      data: {
        id: sessionId,
        tenantId,
        candidateId,
        status: 'queued',
        roleType: options?.roleType ?? null,
        sourcesExecuted: [] as unknown as Prisma.InputJsonValue,
        queriesPlanned: options?.budget?.maxQueries || null,
        queriesExecuted: 0,
        identitiesFound: 0,
        identitiesConfirmed: 0,
        // Leave nullable fields unset (defaults to null)
      },
    });
  } catch (error) {
    console.error('[EnrichmentQueue] Failed to create session:', error);
    throw new Error(`Failed to create enrichment session: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Enqueue the job with tenantId
  const queue = getEnrichmentQueue();
  const job = await queue.add(
    'enrich',
    {
      sessionId,
      candidateId,
      tenantId,
      roleType: options?.roleType,
      budget: options?.budget,
      priority: options?.priority,
    },
    {
      priority: options?.priority || 0,
      jobId: sessionId, // Use sessionId as jobId for easy lookup
    }
  );

  console.log(
    `[EnrichmentQueue] Created session ${sessionId} for candidate ${candidateId} (tenant: ${tenantId}), job ${job.id}`
  );

  return { sessionId, jobId: job.id! };
}

/**
 * Create a summary-only session and enqueue the job
 * Used to regenerate verified summary after identity confirmation
 */
export async function createSummaryOnlySession(
  tenantId: string,
  candidateId: string,
  options?: {
    priority?: number;
  }
): Promise<{ sessionId: string; jobId: string }> {
  const sessionId = uuidv4();

  // Create session record (tenant-scoped)
  try {
    await prisma.enrichmentSession.create({
      data: {
        id: sessionId,
        tenantId,
        candidateId,
        status: 'queued',
        roleType: null,
        sourcesExecuted: [] as unknown as Prisma.InputJsonValue,
        queriesPlanned: 0,
        queriesExecuted: 0,
        identitiesFound: 0,
        identitiesConfirmed: 0,
      },
    });
  } catch (error) {
    console.error('[EnrichmentQueue] Failed to create summary-only session:', error);
    throw new Error(`Failed to create summary-only session: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Enqueue the summary-only job with tenantId
  const queue = getEnrichmentQueue();
  const job = await queue.add(
    'summary_only',
    {
      sessionId,
      candidateId,
      tenantId,
      jobType: 'summary_only',
      priority: options?.priority,
    },
    {
      priority: options?.priority || 0,
      jobId: sessionId,
    }
  );

  console.log(
    `[EnrichmentQueue] Created summary-only session ${sessionId} for candidate ${candidateId} (tenant: ${tenantId}), job ${job.id}`
  );

  return { sessionId, jobId: job.id! };
}

/**
 * Get session status
 */
export async function getEnrichmentSession(
  sessionId: string
): Promise<EnrichmentSession | null> {
  const session = await prisma.enrichmentSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    return null;
  }

  // Convert Prisma dates to ISO strings
  // Prisma client types may be stale until `prisma generate` runs in the target environment.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionAny: any = session;
  return {
    ...sessionAny,
    sourcesPlanned: session.sourcesPlanned as string[] | null,
    sourcesExecuted: session.sourcesExecuted as string[] | null,
    startedAt: session.startedAt?.toISOString() || null,
    completedAt: session.completedAt?.toISOString() || null,
    summaryGeneratedAt: sessionAny.summaryGeneratedAt?.toISOString?.() || null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  } as EnrichmentSession;
}

/**
 * Get recent sessions for a candidate
 */
export async function getRecentSessions(
  candidateId: string,
  limit: number = 5
): Promise<EnrichmentSession[]> {
  const sessions = await prisma.enrichmentSession.findMany({
    where: { candidateId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  // Convert Prisma dates to ISO strings
  return sessions.map((session) => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(session as any),
    sourcesPlanned: session.sourcesPlanned as string[] | null,
    sourcesExecuted: session.sourcesExecuted as string[] | null,
    startedAt: session.startedAt?.toISOString() || null,
    completedAt: session.completedAt?.toISOString() || null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summaryGeneratedAt: (session as any).summaryGeneratedAt?.toISOString?.() || null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  })) as EnrichmentSession[];
}

/**
 * Update session status
 */
async function updateSessionStatus(
  sessionId: string,
  updates: Partial<{
    status: EnrichmentSessionStatus;
    sourcesPlanned: string[];
    sourcesExecuted: string[];
    queriesExecuted: number;
    identitiesFound: number;
    finalConfidence: number;
    earlyStopReason: string;
    errorMessage: string;
    errorDetails: unknown;
    startedAt: Date;
    completedAt: Date;
    durationMs: number;
  }>
): Promise<void> {
  try {
    const data: Prisma.EnrichmentSessionUpdateInput = {};

    if (updates.status !== undefined) data.status = updates.status;
    if (updates.queriesExecuted !== undefined) data.queriesExecuted = updates.queriesExecuted;
    if (updates.identitiesFound !== undefined) data.identitiesFound = updates.identitiesFound;
    if (updates.finalConfidence !== undefined) data.finalConfidence = updates.finalConfidence;
    if (updates.earlyStopReason !== undefined) data.earlyStopReason = updates.earlyStopReason;
    if (updates.errorMessage !== undefined) data.errorMessage = updates.errorMessage;
    if (updates.durationMs !== undefined) data.durationMs = updates.durationMs;
    if (updates.startedAt !== undefined) data.startedAt = updates.startedAt;
    if (updates.completedAt !== undefined) data.completedAt = updates.completedAt;

    if (updates.sourcesPlanned !== undefined) {
      data.sourcesPlanned = JSON.parse(JSON.stringify(updates.sourcesPlanned)) as Prisma.InputJsonValue;
    }
    if (updates.sourcesExecuted !== undefined) {
      data.sourcesExecuted = JSON.parse(JSON.stringify(updates.sourcesExecuted)) as Prisma.InputJsonValue;
    }
    if (updates.errorDetails !== undefined) {
      data.errorDetails = JSON.parse(JSON.stringify(updates.errorDetails)) as Prisma.InputJsonValue;
    }

    await prisma.enrichmentSession.update({
      where: { id: sessionId },
      data,
    });
  } catch (error) {
    console.error('[EnrichmentQueue] Failed to update session:', error);
  }
}

/**
 * Process summary-only job
 * Regenerates summary from confirmed identities only (no discovery)
 */
async function processSummaryOnlyJob(
  job: Job<EnrichmentJobData, EnrichmentJobResult>
): Promise<EnrichmentJobResult> {
  const { sessionId, candidateId, tenantId } = job.data;
  const startTime = Date.now();

  console.log(`[EnrichmentWorker] Processing summary-only job ${job.id} for candidate ${candidateId} (tenant: ${tenantId})`);

  // Update session to running
  await updateSessionStatus(sessionId, {
    status: 'running',
    startedAt: new Date(),
  });

  try {
    // Load candidate hints (defense-in-depth: verify tenant ownership)
    const candidate = await prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: {
        linkedinId: true,
        linkedinUrl: true,
        nameHint: true,
        headlineHint: true,
        locationHint: true,
        roleType: true,
      },
    });

    if (!candidate) {
      throw new Error(`Candidate not found or access denied: ${candidateId}`);
    }

    // Load confirmed identities from ConfirmedIdentity table (tenant-scoped)
    const confirmedIdentities = await prisma.confirmedIdentity.findMany({
      where: { candidateId, tenantId },
    });

    if (confirmedIdentities.length === 0) {
      throw new Error('No confirmed identities found for verified summary');
    }

    // Load corresponding IdentityCandidates for full details
    const identityCandidateIds = confirmedIdentities
      .map((ci) => ci.identityCandidateId)
      .filter((id): id is string => id !== null);

    const identityCandidates = identityCandidateIds.length > 0
      ? await prisma.identityCandidate.findMany({
          where: { id: { in: identityCandidateIds }, tenantId },
        })
      : [];

    // Create a map for quick lookup
    const icMap = new Map(identityCandidates.map((ic) => [ic.id, ic]));

    // Convert to DiscoveredIdentity format for summary generator
    const identities: DiscoveredIdentity[] = confirmedIdentities.map((ci) => {
      // Try to get full details from IdentityCandidate, fall back to ConfirmedIdentity fields
      const ic = ci.identityCandidateId ? icMap.get(ci.identityCandidateId) : null;
      // Extract profile data from ConfirmedIdentity if available
      const profileData = ci.profileData as Record<string, unknown> | null;
      const profileName = (profileData?.name as string) || (profileData?.login as string) || null;
      return {
        platform: ci.platform as DiscoveredIdentity['platform'],
        platformId: ci.platformId,
        profileUrl: ci.profileUrl,
        displayName: profileName,
        confidence: ic?.confidence || 0.8, // Default high confidence for confirmed
        confidenceBucket: (ic?.confidenceBucket || 'auto_merge') as DiscoveredIdentity['confidenceBucket'],
        scoreBreakdown: (ic?.scoreBreakdown as unknown as DiscoveredIdentity['scoreBreakdown']) || {
          bridgeWeight: 0.5,
          nameMatch: 0.8,
          handleMatch: 0.5,
          companyMatch: 0,
          locationMatch: 0,
          activityMatch: 0,
          profileStrength: 0.5,
          crossReference: 0,
        },
        evidence: (ic?.evidence as unknown as DiscoveredIdentity['evidence']) || [],
        hasContradiction: ic?.hasContradiction || false,
        contradictionNote: ic?.contradictionNote || null,
        platformProfile: {
          name: profileName,
          bio: (profileData?.bio as string) || null,
          company: (profileData?.company as string) || null,
          location: (profileData?.location as string) || null,
        },
      };
    });

    // Generate verified summary
    const { summary, evidence, model, tokens, meta } = await generateCandidateSummary({
      candidate: {
        linkedinId: candidate.linkedinId,
        linkedinUrl: candidate.linkedinUrl || '',
        nameHint: candidate.nameHint,
        headlineHint: candidate.headlineHint,
        locationHint: candidate.locationHint,
        companyHint: candidate.companyHint || null,
        roleType: candidate.roleType,
      },
      identities,
      platformData: [], // Skip platform data fetch for now (can be enhanced later)
      mode: 'verified',
      confirmedCount: confirmedIdentities.length,
    });

    console.log(
      `[EnrichmentWorker] Generated verified summary from ${confirmedIdentities.length} confirmed identities`
    );

    // Build runTrace with summary metadata
    const runTrace: Partial<EnrichmentRunTrace> = {
      input: {
        candidateId,
        linkedinId: candidate.linkedinId,
        linkedinUrl: candidate.linkedinUrl || '',
      },
      seed: {
        nameHint: candidate.nameHint,
        headlineHint: candidate.headlineHint,
        locationHint: candidate.locationHint,
        companyHint: candidate.companyHint || null,
        roleType: candidate.roleType,
      },
      platformResults: {},
      final: {
        totalQueriesExecuted: 0,
        platformsQueried: 0,
        platformsWithHits: 0,
        identitiesFoundTotal: confirmedIdentities.length,
        identitiesAboveMinConfidence: confirmedIdentities.length,
        identitiesPassingPersistGuard: confirmedIdentities.length,
        identitiesPersisted: confirmedIdentities.length,
        bestConfidence: Math.max(...identities.map(i => i.confidence)),
        durationMs: Date.now() - startTime,
        summaryMeta: meta,
      },
    };

    // Persist summary to session
    await prisma.enrichmentSession.update({
      where: { id: sessionId },
      data: {
        status: 'completed',
        summary: summary.summary,
        summaryStructured: summary.structured as unknown as Prisma.InputJsonValue,
        summaryEvidence: evidence as unknown as Prisma.InputJsonValue,
        summaryModel: model,
        summaryTokens: tokens,
        summaryGeneratedAt: new Date(),
        runTrace: runTrace as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
      },
    });

    console.log(
      `[EnrichmentWorker] Completed summary-only job ${job.id}: verified summary persisted`
    );

    return {
      sessionId,
      candidateId,
      status: 'completed',
      identitiesFound: confirmedIdentities.length,
      bestConfidence: Math.max(...identities.map(i => i.confidence)),
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await updateSessionStatus(sessionId, {
      status: 'failed',
      errorMessage,
      completedAt: new Date(),
      durationMs: Date.now() - startTime,
    });

    console.error(`[EnrichmentWorker] Summary-only job ${job.id} failed:`, errorMessage);

    return {
      sessionId,
      candidateId,
      status: 'failed',
      identitiesFound: 0,
      bestConfidence: null,
      durationMs: 0,
      error: errorMessage,
    };
  }
}

/**
 * Process enrichment job (full discovery + summary)
 */
async function processFullEnrichmentJob(
  job: Job<EnrichmentJobData, EnrichmentJobResult>
): Promise<EnrichmentJobResult> {
  const { sessionId, candidateId, tenantId, roleType, budget } = job.data;
  const startTime = Date.now();

  console.log(`[EnrichmentWorker] Processing full enrichment job ${job.id} for candidate ${candidateId} (tenant: ${tenantId})`);

  // Update session to running
  await updateSessionStatus(sessionId, {
    status: 'running',
    startedAt: new Date(),
  });

  try {
    // Run the enrichment graph (with tenantId for multi-tenancy)
    const result = await runEnrichment(
      { tenantId, candidateId, sessionId, roleType, budget },
      {
        onProgress: async (event) => {
          // Update job progress
          await job.updateProgress({
            event: event.type,
            platform: event.platform,
            data: event.data,
            timestamp: event.timestamp,
          });
        },
      }
    );

    // Update session with results
    await updateSessionStatus(sessionId, {
      status: result.status === 'failed' ? 'failed' : 'completed',
      identitiesFound: result.identitiesFound.length,
      finalConfidence: result.bestConfidence || undefined,
      queriesExecuted: result.queriesExecuted,
      sourcesExecuted: result.sourcesExecuted,
      earlyStopReason: result.earlyStopReason || undefined,
      errorMessage: result.errors.length > 0 ? result.errors[0].message : undefined,
      completedAt: new Date(),
      durationMs: Date.now() - startTime,
    });

    console.log(
      `[EnrichmentWorker] Completed full enrichment job ${job.id}: ${result.identitiesFound.length} identities found`
    );

    return {
      sessionId,
      candidateId,
      status: result.status,
      identitiesFound: result.identitiesFound.length,
      bestConfidence: result.bestConfidence,
      durationMs: result.durationMs,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Update session with error
    await updateSessionStatus(sessionId, {
      status: 'failed',
      errorMessage,
      completedAt: new Date(),
      durationMs: Date.now() - startTime,
    });

    console.error(`[EnrichmentWorker] Full enrichment job ${job.id} failed:`, errorMessage);

    return {
      sessionId,
      candidateId,
      status: 'failed',
      identitiesFound: 0,
      bestConfidence: null,
      durationMs: 0,
      error: errorMessage,
    };
  }
}

/**
 * Process enrichment job (routes to full or summary-only based on jobType)
 */
async function processEnrichmentJob(
  job: Job<EnrichmentJobData, EnrichmentJobResult>
): Promise<EnrichmentJobResult> {
  const jobType = job.data.jobType || 'enrich';

  if (jobType === 'summary_only') {
    return processSummaryOnlyJob(job);
  }

  return processFullEnrichmentJob(job);
}

/**
 * Worker singleton
 */
let enrichmentWorker: Worker<EnrichmentJobData, EnrichmentJobResult> | null = null;

/**
 * Start the enrichment worker
 */
export function startEnrichmentWorker(options?: {
  concurrency?: number;
}): Worker<EnrichmentJobData, EnrichmentJobResult> {
  if (enrichmentWorker) {
    return enrichmentWorker;
  }

  enrichmentWorker = new Worker<EnrichmentJobData, EnrichmentJobResult>(
    QUEUE_NAMES.ENRICHMENT,
    processEnrichmentJob,
    {
      connection: getRedisConnection(),
      concurrency: options?.concurrency || 3,
    }
  );

  enrichmentWorker.on('completed', (job, result) => {
    console.log(
      `[EnrichmentWorker] Job ${job.id} completed: ${result.identitiesFound} identities`
    );
  });

  enrichmentWorker.on('failed', (job, error) => {
    console.error(`[EnrichmentWorker] Job ${job?.id} failed:`, error.message);
  });

  enrichmentWorker.on('error', (error) => {
    console.error('[EnrichmentWorker] Worker error:', error);
  });

  console.log('[EnrichmentWorker] Worker started');

  return enrichmentWorker;
}

/**
 * Stop the enrichment worker
 */
export async function stopEnrichmentWorker(): Promise<void> {
  if (enrichmentWorker) {
    await enrichmentWorker.close();
    enrichmentWorker = null;
    console.log('[EnrichmentWorker] Worker stopped');
  }
}

/**
 * Get queue statistics
 */
export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getEnrichmentQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Cleanup on shutdown
 */
export async function cleanupQueue(): Promise<void> {
  await stopEnrichmentWorker();

  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }

  if (enrichmentQueue) {
    await enrichmentQueue.close();
    enrichmentQueue = null;
  }

  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }

  console.log('[EnrichmentQueue] Cleaned up');
}

export default {
  createEnrichmentSession,
  getEnrichmentSession,
  getRecentSessions,
  getEnrichmentQueue,
  getQueueEvents,
  getQueueStats,
  startEnrichmentWorker,
  stopEnrichmentWorker,
  cleanupQueue,
};
