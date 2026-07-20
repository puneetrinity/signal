/**
 * debug-pipeline-logs.ts
 *
 * Writes per-step pipeline data to individual JSON files that are REPLACED
 * (not appended) on every run. Only active in development.
 *
 * Files written to: signal/pipeline-logs/
 *   - 01_sourcing.json     — raw Crustdata discovery results (300 profiles)
 *   - 02_ranking.json      — locally ranked candidates (top 100 + 200 reserve)
 *   - 03_enrichment.json   — Crustdata batch enrichment response map
 *   - 04_reranking.json    — final re-ranked list (= what gets persisted to DB)
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'pipeline-logs');

// Track session start and previous step time for elapsed calculations
let sessionStartMs: number | null = null;
let prevStepMs: number | null = null;

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function msToHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(0);
  return `${m}m ${s}s`;
}

function timing() {
  const now = Date.now();
  if (sessionStartMs === null) sessionStartMs = now;
  const fromStart = now - sessionStartMs;
  const fromPrev = prevStepMs !== null ? now - prevStepMs : 0;
  prevStepMs = now;
  return {
    timestamp: new Date(now).toISOString(),
    elapsedFromStartMs: fromStart,
    elapsedFromStart: msToHuman(fromStart),
    elapsedSincePrevStepMs: fromPrev,
    elapsedSincePrevStep: msToHuman(fromPrev),
  };
}

function write(filename: string, data: unknown) {
  if (process.env.NODE_ENV === 'production') return;
  try {
    ensureDir();
    const filePath = path.join(LOG_DIR, filename);
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, json, 'utf-8');
    const t = (data as Record<string, unknown>);
    console.log(
      `📝 [DEBUG-LOG] ${filename}  |  ${t.timestamp}  |  +${t.elapsedSincePrevStep} step  |  ${t.elapsedFromStart} total  |  ${json.length} bytes`,
    );
  } catch (err) {
    console.warn(`⚠️ [DEBUG-LOG] Failed to write ${filename}:`, err);
  }
}

/** Reset timers at the start of each orchestrator run */
export function resetPipelineLogTimers() {
  sessionStartMs = null;
  prevStepMs = null;
}

/** Step 1 — Raw Crustdata discovery profiles (before ranking) */
export function logSourcingRaw(requestId: string, profiles: unknown[]) {
  write('01_sourcing.json', {
    step: 'sourcing',
    requestId,
    ...timing(),
    count: profiles.length,
    profiles,
  });
}

/** Step 2 — After local ranking: top 100 primary + 200 reserve */
export function logRankingResult(
  requestId: string,
  primaryList: unknown[],
  reserveList: unknown[],
) {
  write('02_ranking.json', {
    step: 'ranking',
    requestId,
    ...timing(),
    primaryCount: primaryList.length,
    reserveCount: reserveList.length,
    primaryList,
    reserveList,
  });
}

/** Step 3 — Raw Crustdata batch enrichment map (keyed by LinkedIn URL) */
export function logEnrichmentRaw(requestId: string, enrichedMap: Map<string, unknown>) {
  const entries = Object.fromEntries(enrichedMap);
  write('03_enrichment.json', {
    step: 'enrichment',
    requestId,
    ...timing(),
    enrichedCount: enrichedMap.size,
    profiles: entries,
  });
}

/** Step 4 — Final re-ranked list after enrichment (= what gets written to DB) */
export function logRerankingResult(requestId: string, finalList: unknown[]) {
  write('04_reranking.json', {
    step: 'reranking',
    requestId,
    ...timing(),
    count: finalList.length,
    note: 'This is the final sourced candidates list persisted to jobSourcedCandidates',
    candidates: finalList,
  });
}
