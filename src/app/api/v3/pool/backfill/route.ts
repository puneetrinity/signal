/**
 * POST /api/v3/pool/backfill
 *
 * Admin-only endpoint to backfill the candidate pool for specific role+location
 * buckets. Runs targeted SERP discovery and enqueues enrichment for new candidates.
 * Tenant-scoped: backfills pool for the calling tenant only.
 *
 * Scope: pool:backfill
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyServiceJWT } from '@/lib/auth/service-jwt';
import { requireScope } from '@/lib/auth/service-scopes';
import { prisma } from '@/lib/prisma';
import { buildJobRequirements, type SourcingJobContextInput } from '@/lib/sourcing/jd-digest';
import { resolveTrack } from '@/lib/sourcing/track-resolver';
import { discoverCandidates } from '@/lib/sourcing/discovery';
import { createEnrichmentSession } from '@/lib/enrichment/queue';
import { getSourcingConfig } from '@/lib/sourcing/config';
import type { JobTrack } from '@/lib/sourcing/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('PoolBackfill');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function topN(items: (string | null | undefined)[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item) continue;
    const key = item.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

const SENIORITY_PATTERNS: [RegExp, string][] = [
  [/\b(intern|internship)\b/i, 'intern'],
  [/\b(junior|jr\.?|entry[- ]level)\b/i, 'junior'],
  [/\b(mid[- ]?level|mid[- ]?senior)\b/i, 'mid'],
  [/\b(senior|sr\.?)\b/i, 'senior'],
  [/\b(staff)\b/i, 'staff'],
  [/\b(lead|tech lead|team lead)\b/i, 'lead'],
  [/\b(principal|distinguished|fellow)\b/i, 'principal'],
  [/\b(director|vp|head of|chief)\b/i, 'director'],
];

function parseSeniority(headline: string | null | undefined): string {
  if (!headline) return 'unknown';
  for (const [pattern, label] of SENIORITY_PATTERNS) {
    if (pattern.test(headline)) return label;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // 1. Auth
  const auth = await verifyServiceJWT(request);
  if (!auth.authorized) return auth.response;

  const scopeCheck = requireScope(auth.context, 'pool:backfill');
  if (!scopeCheck.authorized) return scopeCheck.response;

  const tenantId = auth.context.tenantId;

  // 2. Parse + validate body
  let body: {
    title?: string;
    skills?: string[];
    location?: string;
    targetCount?: number;
    maxQueries?: number;
    enrichPriority?: number;
    trackHint?: string;
    dryRun?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
    return NextResponse.json({ success: false, error: 'title is required' }, { status: 400 });
  }
  if (!Array.isArray(body.skills) || body.skills.length === 0) {
    return NextResponse.json({ success: false, error: 'skills must be a non-empty array' }, { status: 400 });
  }

  // Safety guard: require location OR at least 2 skills
  if (!body.location && body.skills.length < 2) {
    return NextResponse.json(
      { success: false, error: 'Provide location, or at least 2 skills to narrow the search' },
      { status: 400 },
    );
  }

  const targetCount = Math.min(50, Math.max(1, body.targetCount ?? 20));
  const maxQueries = Math.min(3, Math.max(1, body.maxQueries ?? 3));
  const enrichPriority = body.enrichPriority ?? 0;
  const dryRun = body.dryRun === true;
  const trackHint = (body.trackHint === 'tech' || body.trackHint === 'non_tech')
    ? body.trackHint as JobTrack
    : undefined;

  // 3. Build requirements + resolve track
  const jobContext: SourcingJobContextInput = {
    jdDigest: JSON.stringify({ topSkills: body.skills }),
    title: body.title.trim(),
    skills: body.skills,
    location: body.location,
  };
  const requirements = buildJobRequirements(jobContext);

  let track: JobTrack;
  if (trackHint) {
    track = trackHint;
  } else {
    const trackDecision = await resolveTrack(jobContext, requirements);
    track = trackDecision.track;
  }

  // 4. Load existing pool LinkedIn IDs (recent 5000)
  const poolRows = await prisma.candidate.findMany({
    where: { tenantId },
    select: { linkedinId: true },
    take: 5000,
    orderBy: { updatedAt: 'desc' },
  });
  const existingLinkedinIds = new Set(poolRows.map(r => r.linkedinId));

  // 5. dryRun path — no SERP spend
  if (dryRun) {
    return NextResponse.json({
      success: true,
      dryRun: true,
      track,
      location: body.location ?? null,
      discovered: 0,
      alreadyInPool: 0,
      queriesExecuted: 0,
      eligibleForEnrichment: 0,
      skippedGoodLocation: 0,
      skippedRecentlyEnriched: 0,
      skippedActiveSession: 0,
      queuedForEnrichment: 0,
      enrichmentErrors: 0,
      topObservedTitles: [],
      topObservedLocations: [],
      seniorityBuckets: {},
      estimatedQueries: maxQueries,
      existingPoolCount: existingLinkedinIds.size,
    });
  }

  // 6. Discover candidates via SERP
  log.info({ tenantId, title: body.title, location: body.location, targetCount, maxQueries, track }, 'Starting pool backfill');

  const config = getSourcingConfig();
  const discovery = await discoverCandidates(
    tenantId, requirements, targetCount, existingLinkedinIds, maxQueries,
    { config, track },
  );

  const candidateIds = discovery.candidates.map(c => c.candidateId);
  const alreadyInPool = discovery.telemetry
    ? (discovery.telemetry.strictYield + discovery.telemetry.fallbackYield) - discovery.candidates.length
    : 0;

  if (candidateIds.length === 0) {
    log.info({ tenantId, queriesExecuted: discovery.queriesExecuted }, 'No candidates discovered');
    return NextResponse.json({
      success: true,
      dryRun: false,
      track,
      location: body.location ?? null,
      discovered: 0,
      alreadyInPool: Math.max(0, alreadyInPool),
      queriesExecuted: discovery.queriesExecuted,
      eligibleForEnrichment: 0,
      skippedGoodLocation: 0,
      skippedRecentlyEnriched: 0,
      skippedActiveSession: 0,
      queuedForEnrichment: 0,
      enrichmentErrors: 0,
      topObservedTitles: [],
      topObservedLocations: [],
      seniorityBuckets: {},
    });
  }

  // 7. Load candidate state for skip rules + metrics
  const candidates = await prisma.candidate.findMany({
    where: { id: { in: candidateIds }, tenantId },
    select: {
      id: true,
      enrichmentStatus: true,
      lastEnrichedAt: true,
      locationHint: true,
      headlineHint: true,
      searchTitle: true,
    },
  });
  const candidateMap = new Map(candidates.map(c => [c.id, c]));

  // Skip rules
  function skipReason(c: typeof candidates[number]): 'good_location' | 'recently_enriched' | null {
    const recentlyEnriched =
      c.enrichmentStatus === 'completed' &&
      c.lastEnrichedAt &&
      Date.now() - c.lastEnrichedAt.getTime() < 30 * 86400 * 1000;
    const hasGoodLocation = !!c.locationHint;

    if (recentlyEnriched && hasGoodLocation) return 'good_location';
    if (recentlyEnriched) return 'recently_enriched';
    return null;
  }

  // Active session dedupe
  const activeSessions = await prisma.enrichmentSession.findMany({
    where: { candidateId: { in: candidateIds }, tenantId, status: { in: ['queued', 'running'] } },
    select: { candidateId: true },
  });
  const activeSessionIds = new Set(activeSessions.map(s => s.candidateId));

  // 8. Enqueue enrichment
  let skippedGoodLocation = 0;
  let skippedRecentlyEnriched = 0;
  let skippedActiveSession = 0;
  let queuedForEnrichment = 0;
  let enrichmentErrors = 0;

  for (const candidateId of candidateIds) {
    const c = candidateMap.get(candidateId);
    if (!c) continue;

    const skip = skipReason(c);
    if (skip === 'good_location') { skippedGoodLocation++; continue; }
    if (skip === 'recently_enriched') { skippedRecentlyEnriched++; continue; }
    if (activeSessionIds.has(candidateId)) { skippedActiveSession++; continue; }

    try {
      await createEnrichmentSession(tenantId, candidateId, { priority: enrichPriority });
      queuedForEnrichment++;
    } catch (err) {
      enrichmentErrors++;
      log.warn({ candidateId, error: err instanceof Error ? err.message : 'Unknown' }, 'Enrichment enqueue failed');
    }
  }

  // 9. Lightweight summary metrics
  const titles = candidates.map(c => c.headlineHint ?? c.searchTitle);
  const locations = candidates.map(c => c.locationHint);
  const topObservedTitles = topN(titles, 5);
  const topObservedLocations = topN(locations, 5);

  const seniorityBuckets: Record<string, number> = {};
  for (const c of candidates) {
    const seniority = parseSeniority(c.headlineHint ?? c.searchTitle);
    seniorityBuckets[seniority] = (seniorityBuckets[seniority] ?? 0) + 1;
  }

  const eligibleForEnrichment = candidateIds.length - skippedGoodLocation - skippedRecentlyEnriched - skippedActiveSession;

  log.info({
    tenantId,
    discovered: candidateIds.length,
    queuedForEnrichment,
    skippedGoodLocation,
    skippedRecentlyEnriched,
    skippedActiveSession,
    enrichmentErrors,
    queriesExecuted: discovery.queriesExecuted,
  }, 'Pool backfill completed');

  return NextResponse.json({
    success: true,
    dryRun: false,
    track,
    location: body.location ?? null,
    discovered: candidateIds.length,
    alreadyInPool: Math.max(0, alreadyInPool),
    queriesExecuted: discovery.queriesExecuted,
    eligibleForEnrichment,
    skippedGoodLocation,
    skippedRecentlyEnriched,
    skippedActiveSession,
    queuedForEnrichment,
    enrichmentErrors,
    topObservedTitles,
    topObservedLocations,
    seniorityBuckets,
  });
}
