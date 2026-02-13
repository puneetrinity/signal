/**
 * Enrichment Source Registry
 *
 * Central registry for all enrichment sources with role-based routing.
 * Provides:
 * - Source registration and lookup
 * - Role-based source selection
 * - Parallel discovery across multiple sources
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type {
  EnrichmentSource,
  EnrichmentPlatform,
  CandidateHints,
  BridgeDiscoveryResult,
  DiscoveryOptions,
  DiscoveredIdentity,
} from './types';
import { ROLE_SOURCE_PRIORITY, getSourcesForRole } from './types';
import { createLogger } from '@/lib/logger';

const log = createLogger('SourceRegistry');

// Import all sources
import { stackOverflowSource } from './stackoverflow';
import { npmSource, pypiSource } from './npm-pypi';
import {
  orcidSource,
  scholarSource,
  semanticScholarSource,
  researchGateSource,
  arxivSource,
  patentsSource,
} from './academic';
import { kaggleSource, huggingFaceSource, papersWithCodeSource } from './data-science';
import {
  mediumSource,
  devtoSource,
  twitterSource,
  youtubeSource,
  substackSource,
  crunchbaseSource,
  secSource,
} from './content-founder';
import { dribbbleSource, behanceSource, codepenSource } from './design';
import { leetcodeSource, gitlabSource, dockerhubSource } from './code-platforms';
import {
  hackerEarthSource,
  gistSource,
  openReviewSource,
  universitySource,
  companyTeamSource,
  angelListSource,
} from './misc-platforms';

// Re-export types
export * from './types';
export { searchForPlatform, buildQueryFromPattern } from './search-executor';
export { BaseEnrichmentSource } from './base-source';

/**
 * Source registry - all available enrichment sources
 */
const SOURCE_REGISTRY = new Map<EnrichmentPlatform, EnrichmentSource>();

// Code & Engineering
SOURCE_REGISTRY.set('stackoverflow', stackOverflowSource);
SOURCE_REGISTRY.set('npm', npmSource);
SOURCE_REGISTRY.set('pypi', pypiSource);
SOURCE_REGISTRY.set('codepen', codepenSource);
SOURCE_REGISTRY.set('leetcode', leetcodeSource);
SOURCE_REGISTRY.set('gitlab', gitlabSource);
SOURCE_REGISTRY.set('dockerhub', dockerhubSource);
// Note: GitHub uses direct API, not search-based discovery
// It's handled separately in bridge-discovery.ts

// Data Science & ML
SOURCE_REGISTRY.set('kaggle', kaggleSource);
SOURCE_REGISTRY.set('huggingface', huggingFaceSource);
SOURCE_REGISTRY.set('paperswithcode', papersWithCodeSource);

// Academic & Authority
SOURCE_REGISTRY.set('orcid', orcidSource);
SOURCE_REGISTRY.set('scholar', scholarSource);
SOURCE_REGISTRY.set('semanticscholar', semanticScholarSource);
SOURCE_REGISTRY.set('researchgate', researchGateSource);
SOURCE_REGISTRY.set('arxiv', arxivSource);
SOURCE_REGISTRY.set('patents', patentsSource);

// Business & Founder
SOURCE_REGISTRY.set('sec', secSource);
SOURCE_REGISTRY.set('crunchbase', crunchbaseSource);
// companyteam requires custom implementation

// Content & Thought Leadership
SOURCE_REGISTRY.set('medium', mediumSource);
SOURCE_REGISTRY.set('devto', devtoSource);
SOURCE_REGISTRY.set('substack', substackSource);
SOURCE_REGISTRY.set('youtube', youtubeSource);
SOURCE_REGISTRY.set('twitter', twitterSource);

// Design
SOURCE_REGISTRY.set('dribbble', dribbbleSource);
SOURCE_REGISTRY.set('behance', behanceSource);

// Miscellaneous / Additional Platforms
SOURCE_REGISTRY.set('hackerearth', hackerEarthSource);
SOURCE_REGISTRY.set('gist', gistSource);
SOURCE_REGISTRY.set('openreview', openReviewSource);
SOURCE_REGISTRY.set('university', universitySource);
SOURCE_REGISTRY.set('companyteam', companyTeamSource);
SOURCE_REGISTRY.set('angellist', angelListSource);

/**
 * Platforms known to be unreliable (often blocked, rate limited, or slow).
 * These are deprioritized and may be skipped if SKIP_UNRELIABLE_PLATFORMS=true.
 *
 * Configure via environment:
 * - SKIP_UNRELIABLE_PLATFORMS=true: Skip these platforms entirely
 * - UNRELIABLE_PLATFORMS: Comma-separated list of additional platforms to mark as unreliable
 */
const DEFAULT_UNRELIABLE_PLATFORMS = new Set<EnrichmentPlatform>([
  'crunchbase',  // Often blocked by bot detection
  'angellist',   // Frequently rate limited or blocked
]);

function getUnreliablePlatforms(): Set<EnrichmentPlatform> {
  const platforms = new Set(DEFAULT_UNRELIABLE_PLATFORMS);
  const envPlatforms = process.env.UNRELIABLE_PLATFORMS;
  if (envPlatforms) {
    for (const p of envPlatforms.split(',')) {
      platforms.add(p.trim() as EnrichmentPlatform);
    }
  }
  return platforms;
}

function shouldSkipUnreliable(): boolean {
  return process.env.SKIP_UNRELIABLE_PLATFORMS === 'true';
}

/**
 * Check if a platform is marked as unreliable
 */
export function isPlatformUnreliable(platform: EnrichmentPlatform): boolean {
  return getUnreliablePlatforms().has(platform);
}

/**
 * Get a source by platform
 */
export function getSource(platform: EnrichmentPlatform): EnrichmentSource | undefined {
  return SOURCE_REGISTRY.get(platform);
}

/**
 * Get all registered sources
 */
export function getAllSources(): EnrichmentSource[] {
  return Array.from(SOURCE_REGISTRY.values());
}

/**
 * Get sources for a specific role type, in priority order.
 * If SKIP_UNRELIABLE_PLATFORMS=true, unreliable platforms are excluded.
 * Otherwise, unreliable platforms are moved to the end of the list.
 */
export function getSourcesForRoleType(roleType: RoleType): EnrichmentSource[] {
  const sourceConfigs = getSourcesForRole(roleType);
  const sources: EnrichmentSource[] = [];
  const unreliableSources: EnrichmentSource[] = [];
  const skipUnreliable = shouldSkipUnreliable();
  const unreliablePlatforms = getUnreliablePlatforms();

  for (const config of sourceConfigs) {
    const source = SOURCE_REGISTRY.get(config.platform);
    if (source) {
      if (unreliablePlatforms.has(config.platform)) {
        if (skipUnreliable) {
          // Skip entirely if configured
          log.info({ platform: config.platform }, 'Skipping unreliable platform');
          continue;
        }
        // Deprioritize - add to end
        unreliableSources.push(source);
      } else {
        sources.push(source);
      }
    }
  }

  // Add unreliable sources at the end (if not skipping)
  return [...sources, ...unreliableSources];
}

/**
 * Get platform priorities for a role
 */
export function getPlatformPriorities(roleType: RoleType): EnrichmentPlatform[] {
  return ROLE_SOURCE_PRIORITY[roleType] || ROLE_SOURCE_PRIORITY.general;
}

/**
 * Multi-source discovery result
 */
export interface MultiSourceDiscoveryResult {
  linkedinId: string;
  roleType: RoleType;
  platformResults: BridgeDiscoveryResult[];
  allIdentities: DiscoveredIdentity[];
  bestIdentity: DiscoveredIdentity | null;
  totalQueriesExecuted: number;
  totalDurationMs: number;
  sourcesQueried: EnrichmentPlatform[];
  errors: Array<{ platform: EnrichmentPlatform; error: string }>;
}

/**
 * Discover identities across multiple sources for a candidate
 *
 * @param hints - Candidate hints from search results
 * @param roleType - Role type for source prioritization
 * @param options - Discovery options
 * @returns Results from all queried sources
 */
export async function discoverAcrossSources(
  hints: CandidateHints,
  roleType: RoleType = 'general',
  options?: DiscoveryOptions & {
    maxSources?: number;
    parallelism?: number;
  }
): Promise<MultiSourceDiscoveryResult> {
  const startTime = Date.now();
  const maxSources = options?.maxSources ?? 5;
  const parallelism = options?.parallelism ?? 3;

  // Get sources for this role in priority order
  const sourcesToQuery = getSourcesForRoleType(roleType).slice(0, maxSources);

  log.info(
    {
      linkedinId: hints.linkedinId,
      roleType,
      platforms: sourcesToQuery.map((s) => s.platform),
    },
    'Discovering across sources'
  );

  const platformResults: BridgeDiscoveryResult[] = [];
  const errors: Array<{ platform: EnrichmentPlatform; error: string }> = [];
  const sourcesQueried: EnrichmentPlatform[] = [];

  // Process sources in batches for controlled parallelism
  for (let i = 0; i < sourcesToQuery.length; i += parallelism) {
    const batch = sourcesToQuery.slice(i, i + parallelism);

    const batchPromises = batch.map(async (source) => {
      try {
        sourcesQueried.push(source.platform);
        const result = await source.discover(hints, options);
        return { success: true as const, result, platform: source.platform };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ platform: source.platform, error: errorMessage }, 'Source discovery failed');
        return {
          success: false as const,
          platform: source.platform,
          error: errorMessage,
        };
      }
    });

    const batchResults = await Promise.all(batchPromises);

    for (const result of batchResults) {
      if (result.success) {
        platformResults.push(result.result);
      } else {
        errors.push({ platform: result.platform, error: result.error });
      }
    }

    // Early stop if we found a high-confidence match
    const highConfidenceFound = platformResults.some((r) =>
      r.identities.some((i) => i.confidence >= 0.9)
    );
    if (highConfidenceFound) {
      log.info('High confidence match found, stopping early');
      break;
    }
  }

  // Aggregate all identities
  const allIdentities = platformResults.flatMap((r) => r.identities);

  // Sort by confidence
  allIdentities.sort((a, b) => b.confidence - a.confidence);

  // Find best identity
  const bestIdentity = allIdentities.length > 0 ? allIdentities[0] : null;

  // Calculate totals
  const totalQueriesExecuted = platformResults.reduce((sum, r) => sum + r.queriesExecuted, 0);
  const totalDurationMs = Date.now() - startTime;

  log.info(
    {
      linkedinId: hints.linkedinId,
      identitiesFound: allIdentities.length,
      sourcesQueried: sourcesQueried.length,
      durationMs: totalDurationMs,
    },
    'Discovery completed'
  );

  return {
    linkedinId: hints.linkedinId,
    roleType,
    platformResults,
    allIdentities,
    bestIdentity,
    totalQueriesExecuted,
    totalDurationMs,
    sourcesQueried,
    errors,
  };
}

/**
 * Check health of all registered sources
 */
export async function checkAllSourcesHealth(): Promise<
  Map<EnrichmentPlatform, { healthy: boolean; error?: string }>
> {
  const results = new Map<EnrichmentPlatform, { healthy: boolean; error?: string }>();

  // Check all sources in parallel
  const healthPromises = Array.from(SOURCE_REGISTRY.entries()).map(
    async ([platform, source]) => {
      try {
        const health = await source.healthCheck();
        return { platform, health };
      } catch (error) {
        return {
          platform,
          health: {
            healthy: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        };
      }
    }
  );

  const healthResults = await Promise.all(healthPromises);

  for (const { platform, health } of healthResults) {
    results.set(platform, { healthy: health.healthy, error: health.error });
  }

  return results;
}

/**
 * Get source statistics
 */
export function getSourceStats(): {
  totalSources: number;
  sourcesByRole: Record<RoleType, number>;
  platforms: EnrichmentPlatform[];
} {
  const platforms = Array.from(SOURCE_REGISTRY.keys());
  const roles: RoleType[] = ['engineer', 'data_scientist', 'researcher', 'founder', 'designer', 'general'];

  const sourcesByRole: Record<RoleType, number> = {} as Record<RoleType, number>;
  for (const role of roles) {
    sourcesByRole[role] = getSourcesForRoleType(role).length;
  }

  return {
    totalSources: SOURCE_REGISTRY.size,
    sourcesByRole,
    platforms,
  };
}

export default {
  getSource,
  getAllSources,
  getSourcesForRoleType,
  getPlatformPriorities,
  discoverAcrossSources,
  checkAllSourcesHealth,
  getSourceStats,
  isPlatformUnreliable,
};
