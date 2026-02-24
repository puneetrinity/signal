import { generateObject } from 'ai';
import { z } from 'zod';
import { createGroqModel } from '@/lib/ai/groq';
import { searchLinkedInProfilesWithMeta } from '@/lib/search/providers';
import { upsertDiscoveredCandidates } from './upsert-candidates';
import type { JobRequirements } from './jd-digest';
import type { SourcingConfig } from './config';
import type { JobTrack } from './types';
import { createLogger } from '@/lib/logger';

const log = createLogger('SourcingDiscovery');

export interface DiscoveredCandidate {
  candidateId: string;
  linkedinId: string;
  queryIndex: number;
}

export interface DiscoveryRunResult {
  candidates: DiscoveredCandidate[];
  queriesExecuted: number;
  queriesBuilt: number;
  telemetry: DiscoveryTelemetry;
}

export interface DiscoveryQueryRunTelemetry {
  queryIndex: number;
  phase: 'strict' | 'fallback';
  query: string;
  providerUsed: string;
  usedFallbackProvider: boolean;
  resultCount: number;
  acceptedCount: number;
  cumulativeDiscovered: number;
  latencyMs: number;
}

export interface DiscoveryTelemetry {
  mode: 'deterministic' | 'hybrid';
  strictQueriesBuilt: number;
  fallbackQueriesBuilt: number;
  strictQueriesExecuted: number;
  fallbackQueriesExecuted: number;
  strictYield: number;
  fallbackYield: number;
  providerUsage: Record<string, number>;
  stoppedReason:
    | 'target_reached'
    | 'strict_low_yield_shifted'
    | 'fallback_low_yield_stopped'
    | 'budget_exhausted'
    | 'no_queries'
    | 'completed_queries';
  groq: {
    enabled: boolean;
    used: boolean;
    retries: number;
    modelName: string | null;
    latencyMs: number | null;
    error: string | null;
  };
  queryRuns: DiscoveryQueryRunTelemetry[];
}

interface QueryPlan {
  strict: string[];
  fallback: string[];
}

const QueryPlanSchema = z.object({
  strictQueries: z.array(z.string().min(1)).max(12).default([]),
  fallbackQueries: z.array(z.string().min(1)).max(12).default([]),
});

const QUERY_PROMPT = `Generate LinkedIn profile search queries for candidate sourcing.

Rules:
- Always target public LinkedIn profiles with site:linkedin.com/in
- "strictQueries" must prioritize location-constrained matches
- "fallbackQueries" should broaden while preserving role/skills intent
- Keep each query concise (no long prose), plain search terms only
- Return valid JSON matching schema`;

function normalizeQuery(query: string): string | null {
  const compact = query.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  const siteScoped = compact.toLowerCase().includes('site:linkedin.com/in')
    ? compact
    : `site:linkedin.com/in ${compact}`;
  return siteScoped.slice(0, 240);
}

function dedupeQueries(queries: string[], maxQueries: number, exclude?: Set<string>): string[] {
  const seen = new Set<string>(exclude ?? []);
  const out: string[] = [];
  for (const raw of queries) {
    const normalized = normalizeQuery(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxQueries) break;
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Groq query generation timeout after ${ms}ms`)), ms),
    ),
  ]);
}

function buildDeterministicQueries(
  requirements: JobRequirements,
  maxQueries: number,
): QueryPlan {
  const roleFamily = requirements.roleFamily || '';
  const title = requirements.title?.trim() || '';
  const location = requirements.location || '';
  const skills = requirements.topSkills.slice(0, 3);
  const narrowSkills = skills.slice(0, 2);
  const strict: string[] = [];
  const fallback: string[] = [];

  // Strict pass: location-targeted queries
  if (location && skills.length > 0) {
    if (roleFamily) {
      strict.push(`site:linkedin.com/in "${roleFamily}" "${location}" ${skills.join(' ')}`);
    } else {
      strict.push(`site:linkedin.com/in "${location}" ${skills.join(' ')}`);
    }
    if (skills.length > 2) {
      if (roleFamily) {
        strict.push(`site:linkedin.com/in "${roleFamily}" "${location}" ${narrowSkills.join(' ')}`);
      } else {
        strict.push(`site:linkedin.com/in "${location}" ${narrowSkills.join(' ')}`);
      }
    }
  }
  if (location && title) {
    strict.push(`site:linkedin.com/in "${title}" "${location}"`);
  }
  if (location && roleFamily && skills.length === 0) {
    strict.push(`site:linkedin.com/in "${roleFamily}" "${location}"`);
  }

  // Fallback pass: without location (broader reach)
  if (roleFamily && skills.length > 0) {
    fallback.push(`site:linkedin.com/in "${roleFamily}" ${skills.join(' ')}`);
  }
  if (title) {
    fallback.push(`site:linkedin.com/in "${title}"`);
    if (skills.length > 0) {
      fallback.push(`site:linkedin.com/in "${title}" ${skills.join(' ')}`);
    }
  }
  if (skills.length > 0) {
    fallback.push(`site:linkedin.com/in ${skills.join(' ')}`);
  }
  if (skills.length > 2 && roleFamily) {
    fallback.push(`site:linkedin.com/in "${roleFamily}" ${narrowSkills.join(' ')}`);
  }
  if (roleFamily && skills.length === 0) {
    fallback.push(`site:linkedin.com/in "${roleFamily}"`);
  }
  if (!roleFamily && !title && location && skills.length === 0) {
    fallback.push(`site:linkedin.com/in "${location}"`);
  }

  const strictDeduped = dedupeQueries(strict, maxQueries);
  const strictSet = new Set(strictDeduped);
  const fallbackDeduped = dedupeQueries(fallback, maxQueries, strictSet);

  return { strict: strictDeduped, fallback: fallbackDeduped };
}

async function buildHybridQueries(
  requirements: JobRequirements,
  maxQueries: number,
  config: SourcingConfig,
  track?: JobTrack | null,
): Promise<{
  plan: QueryPlan;
  groq: DiscoveryTelemetry['groq'];
}> {
  const deterministic = buildDeterministicQueries(requirements, maxQueries);
  const groqMeta: DiscoveryTelemetry['groq'] = {
    enabled: config.queryGenMode === 'hybrid',
    used: false,
    retries: 0,
    modelName: null,
    latencyMs: null,
    error: null,
  };

  if (config.queryGenMode !== 'hybrid') {
    return { plan: deterministic, groq: groqMeta };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    groqMeta.error = 'GROQ_API_KEY not configured';
    return { plan: deterministic, groq: groqMeta };
  }

  const attempts = 1 + config.queryGroqMaxRetries;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      groqMeta.retries = attempt - 1;
      const startedAt = Date.now();
      const { model, modelName } = await createGroqModel(apiKey);
      groqMeta.modelName = modelName;

      const prompt = [
        QUERY_PROMPT,
        `Track: ${track ?? 'unknown'}`,
        `Title: ${requirements.title ?? ''}`,
        `Role family: ${requirements.roleFamily ?? ''}`,
        `Seniority: ${requirements.seniorityLevel ?? ''}`,
        `Domain: ${requirements.domain ?? ''}`,
        `Location: ${requirements.location ?? ''}`,
        `Top skills: ${requirements.topSkills.slice(0, 8).join(', ')}`,
        `Generate up to ${maxQueries} strict and ${maxQueries} fallback queries.`,
      ].join('\n');

      const { object } = await withTimeout(
        generateObject({
          model,
          schema: QueryPlanSchema,
          prompt,
        }),
        config.queryGroqTimeoutMs,
      );

      groqMeta.latencyMs = Date.now() - startedAt;

      const llmStrict = dedupeQueries(object.strictQueries, maxQueries);
      const strictSet = new Set(llmStrict);
      const llmFallback = dedupeQueries(object.fallbackQueries, maxQueries, strictSet);
      const mergedStrict = dedupeQueries([...llmStrict, ...deterministic.strict], maxQueries);
      const mergedStrictSet = new Set(mergedStrict);
      const mergedFallback = dedupeQueries(
        [...llmFallback, ...deterministic.fallback],
        maxQueries,
        mergedStrictSet,
      );

      groqMeta.used = llmStrict.length > 0 || llmFallback.length > 0;

      return {
        plan: {
          strict: mergedStrict,
          fallback: mergedFallback,
        },
        groq: groqMeta,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      groqMeta.error = message;
      log.warn({ attempt, maxAttempts: attempts, error: message }, 'Hybrid query generation attempt failed');
      if (attempt >= attempts) break;
    }
  }

  return { plan: deterministic, groq: groqMeta };
}

export async function discoverCandidates(
  tenantId: string,
  requirements: JobRequirements,
  targetCount: number,
  existingLinkedinIds: Set<string>,
  maxQueries: number = 3,
  options?: {
    config?: SourcingConfig;
    track?: JobTrack | null;
  },
): Promise<DiscoveryRunResult> {
  const config = options?.config;
  const deterministicPlan = buildDeterministicQueries(requirements, maxQueries);
  const hybridPlan = config
    ? await buildHybridQueries(requirements, maxQueries, config, options?.track)
    : null;
  const plan = hybridPlan?.plan ?? deterministicPlan;
  const strict = plan.strict;
  const fallback = plan.fallback;
  const discovered: DiscoveredCandidate[] = [];
  const seenLinkedinIds = new Set(existingLinkedinIds);
  let queriesExecuted = 0;
  let queryIndex = 0;
  let strictQueriesExecuted = 0;
  let fallbackQueriesExecuted = 0;
  let strictAccepted = 0;
  let fallbackAccepted = 0;
  const queryRuns: DiscoveryQueryRunTelemetry[] = [];
  const providerUsage: Record<string, number> = {};
  let stoppedReason: DiscoveryTelemetry['stoppedReason'] = 'completed_queries';

  const runQuery = async (
    query: string,
    phase: 'strict' | 'fallback',
  ): Promise<{ acceptedCount: number }> => {
    queriesExecuted++;
    const qi = queryIndex++;
    const startedAt = Date.now();
    log.info({ query, queryIndex: qi, phase }, 'Running discovery query');

    try {
      const searchResult = await searchLinkedInProfilesWithMeta(query, 20);
      const profiles = searchResult.results;
      providerUsage[searchResult.providerUsed] = (providerUsage[searchResult.providerUsed] || 0) + 1;
      const newProfiles = profiles.filter((p) => {
        const id = extractLinkedInIdFromUrl(p.linkedinUrl);
        return id && !seenLinkedinIds.has(id);
      });

      if (newProfiles.length === 0) {
        queryRuns.push({
          queryIndex: qi,
          phase,
          query,
          providerUsed: searchResult.providerUsed,
          usedFallbackProvider: searchResult.usedFallback,
          resultCount: profiles.length,
          acceptedCount: 0,
          cumulativeDiscovered: discovered.length,
          latencyMs: Date.now() - startedAt,
        });
        return { acceptedCount: 0 };
      }

      const candidateMap = await upsertDiscoveredCandidates(tenantId, newProfiles, query);
      let acceptedCount = 0;

      for (const profile of newProfiles) {
        const linkedinId = extractLinkedInIdFromUrl(profile.linkedinUrl);
        if (!linkedinId) continue;
        const candidateId = candidateMap.get(linkedinId);
        if (!candidateId) continue;
        if (seenLinkedinIds.has(linkedinId)) continue;

        seenLinkedinIds.add(linkedinId);
        discovered.push({ candidateId, linkedinId, queryIndex: qi });
        acceptedCount++;

        if (discovered.length >= targetCount) break;
      }

      queryRuns.push({
        queryIndex: qi,
        phase,
        query,
        providerUsed: searchResult.providerUsed,
        usedFallbackProvider: searchResult.usedFallback,
        resultCount: profiles.length,
        acceptedCount,
        cumulativeDiscovered: discovered.length,
        latencyMs: Date.now() - startedAt,
      });

      log.info(
        { queryIndex: qi, phase, provider: searchResult.providerUsed, acceptedCount, totalDiscovered: discovered.length },
        'Discovery query complete',
      );
      return { acceptedCount };
    } catch (err) {
      log.error({ query, error: err instanceof Error ? err.message : err }, 'Discovery query failed');
      queryRuns.push({
        queryIndex: qi,
        phase,
        query,
        providerUsed: 'unknown',
        usedFallbackProvider: false,
        resultCount: 0,
        acceptedCount: 0,
        cumulativeDiscovered: discovered.length,
        latencyMs: Date.now() - startedAt,
      });
      return { acceptedCount: 0 };
    }
  };

  // Pass 1: Strict (location-targeted) queries
  for (const query of strict) {
    if (discovered.length >= targetCount) {
      stoppedReason = 'target_reached';
      break;
    }
    if (queriesExecuted >= maxQueries) {
      stoppedReason = 'budget_exhausted';
      break;
    }
    strictQueriesExecuted++;
    const { acceptedCount } = await runQuery(query, 'strict');
    strictAccepted += acceptedCount;

    if (discovered.length >= targetCount) {
      stoppedReason = 'target_reached';
      break;
    }

    if (
      config &&
      strictQueriesExecuted >= config.adaptiveMinStrictAttempts &&
      strictAccepted / strictQueriesExecuted < config.adaptiveStrictMinYield &&
      fallback.length > 0
    ) {
      stoppedReason = 'strict_low_yield_shifted';
      break;
    }
  }

  // Pass 2: Fallback (non-location) queries if strict under-delivers
  if (discovered.length < targetCount && queriesExecuted < maxQueries) {
    log.info(
      { strictDiscovered: discovered.length, targetCount, fallbackQueriesAvailable: fallback.length },
      'Strict discovery under-delivered, running fallback queries',
    );
    for (const query of fallback) {
      if (discovered.length >= targetCount) {
        stoppedReason = 'target_reached';
        break;
      }
      if (queriesExecuted >= maxQueries) {
        stoppedReason = 'budget_exhausted';
        break;
      }
      fallbackQueriesExecuted++;
      const { acceptedCount } = await runQuery(query, 'fallback');
      fallbackAccepted += acceptedCount;

      if (discovered.length >= targetCount) {
        stoppedReason = 'target_reached';
        break;
      }

      if (
        config &&
        fallbackQueriesExecuted >= config.adaptiveMinFallbackAttempts &&
        fallbackAccepted / fallbackQueriesExecuted < config.adaptiveFallbackMinYield
      ) {
        stoppedReason = 'fallback_low_yield_stopped';
        break;
      }
    }
  }

  if (queriesExecuted === 0) {
    stoppedReason = 'no_queries';
  } else if (stoppedReason === 'completed_queries' && queriesExecuted >= maxQueries) {
    stoppedReason = 'budget_exhausted';
  }

  if (discovered.length === 0 && (strict.length + fallback.length) > 0) {
    log.warn({
      tenantId,
      queriesAttempted: strict.length + fallback.length,
      roleFamily: requirements.roleFamily,
      targetCount,
    }, 'All discovery queries returned zero new candidates');
  }

  const telemetry: DiscoveryTelemetry = {
    mode: config?.queryGenMode ?? 'deterministic',
    strictQueriesBuilt: strict.length,
    fallbackQueriesBuilt: fallback.length,
    strictQueriesExecuted,
    fallbackQueriesExecuted,
    strictYield: strictQueriesExecuted > 0
      ? Number((strictAccepted / strictQueriesExecuted).toFixed(4))
      : 0,
    fallbackYield: fallbackQueriesExecuted > 0
      ? Number((fallbackAccepted / fallbackQueriesExecuted).toFixed(4))
      : 0,
    providerUsage,
    stoppedReason,
    groq: hybridPlan?.groq ?? {
      enabled: false,
      used: false,
      retries: 0,
      modelName: null,
      latencyMs: null,
      error: null,
    },
    queryRuns,
  };

  return {
    candidates: discovered,
    queriesExecuted,
    queriesBuilt: strict.length + fallback.length,
    telemetry,
  };
}

function extractLinkedInIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/in\/([^/]+)/);
    if (match) return match[1].split(/[?#]/)[0].replace(/\/$/, '');
    return null;
  } catch {
    return null;
  }
}
