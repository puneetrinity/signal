/**
 * Base Enrichment Source Implementation
 *
 * Abstract base class for all search-based enrichment sources.
 * Provides common functionality for:
 * - Query building from patterns
 * - Search execution via SearXNG/Brave
 * - Identity scoring and evidence creation
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type {
  EnrichmentSource,
  EnrichmentPlatform,
  CandidateHints,
  DiscoveredIdentity,
  BridgeDiscoveryResult,
  DiscoveryOptions,
  SourceHealthCheck,
  ScoreBreakdown,
  EvidencePointer,
} from './types';
import {
  searchForPlatform,
  buildQueryFromPattern,
  type EnrichmentSearchResult,
} from './search-executor';
import { checkProvidersHealth } from '@/lib/search/providers';

/**
 * Default discovery options
 */
const DEFAULT_OPTIONS: Required<DiscoveryOptions> = {
  maxResults: 5,
  maxQueries: 3,
  timeout: 30000,
  minConfidence: 0.3, // Lowered to allow name-based matches
};

/**
 * Name matching utilities
 */
function normalizeString(str: string | null): string {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function calculateNameSimilarity(name1: string | null, name2: string | null): number {
  const n1 = normalizeString(name1);
  const n2 = normalizeString(name2);

  if (!n1 || !n2) return 0;
  if (n1 === n2) return 1.0;

  // Check if one contains the other
  if (n1.includes(n2) || n2.includes(n1)) return 0.8;

  // Token-based matching
  const tokens1 = new Set(n1.split(' '));
  const tokens2 = new Set(n2.split(' '));
  const intersection = [...tokens1].filter((t) => tokens2.has(t));
  const union = new Set([...tokens1, ...tokens2]);

  return intersection.length / union.size;
}

function calculateCompanyMatch(
  candidateHint: string | null,
  platformCompany: string | null
): number {
  if (!candidateHint || !platformCompany) return 0;

  const c1 = normalizeString(candidateHint);
  const c2 = normalizeString(platformCompany);

  if (!c1 || !c2) return 0;
  if (c1 === c2) return 1.0;
  if (c1.includes(c2) || c2.includes(c1)) return 0.7;

  return 0;
}

function calculateLocationMatch(
  candidateLocation: string | null,
  platformLocation: string | null
): number {
  if (!candidateLocation || !platformLocation) return 0;

  const l1 = normalizeString(candidateLocation);
  const l2 = normalizeString(platformLocation);

  if (!l1 || !l2) return 0;
  if (l1 === l2) return 1.0;

  // Partial match for cities/regions
  const tokens1 = l1.split(' ');
  const tokens2 = l2.split(' ');

  for (const t1 of tokens1) {
    for (const t2 of tokens2) {
      if (t1 === t2 && t1.length > 2) return 0.6;
    }
  }

  return 0;
}

/**
 * Abstract base class for search-based enrichment sources
 */
export abstract class BaseEnrichmentSource implements EnrichmentSource {
  abstract readonly platform: EnrichmentPlatform;
  abstract readonly displayName: string;
  abstract readonly supportedRoles: RoleType[];
  abstract readonly baseWeight: number;
  abstract readonly queryPattern: string;

  /**
   * Build search queries for this platform
   * Can be overridden for platform-specific query construction
   */
  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    const queries: string[] = [];

    // Primary query from pattern
    const primary = buildQueryFromPattern(this.queryPattern, hints);
    if (primary) {
      queries.push(primary);
    }

    // Name-only query
    if (hints.nameHint && queries.length < maxQueries) {
      const nameQuery = `site:${this.getSiteDomain()} "${hints.nameHint}"`;
      if (!queries.includes(nameQuery)) {
        queries.push(nameQuery);
      }
    }

    // Name + company variant
    if (hints.nameHint && hints.companyHint && queries.length < maxQueries) {
      const companyQuery = `site:${this.getSiteDomain()} "${hints.nameHint}" "${hints.companyHint}"`;
      if (!queries.includes(companyQuery)) {
        queries.push(companyQuery);
      }
    }

    return queries.slice(0, maxQueries);
  }

  /**
   * Get the site domain for search queries
   * Can be overridden for platforms with different domains
   */
  protected getSiteDomain(): string {
    const domainMap: Partial<Record<EnrichmentPlatform, string>> = {
      github: 'github.com',
      stackoverflow: 'stackoverflow.com/users',
      npm: 'npmjs.com',
      pypi: 'pypi.org',
      kaggle: 'kaggle.com',
      huggingface: 'huggingface.co',
      orcid: 'orcid.org',
      scholar: 'scholar.google.com',
      medium: 'medium.com',
      devto: 'dev.to',
      twitter: 'twitter.com',
      dribbble: 'dribbble.com',
      behance: 'behance.net',
      leetcode: 'leetcode.com',
      gitlab: 'gitlab.com',
      crunchbase: 'crunchbase.com/person',
      researchgate: 'researchgate.net/profile',
      semanticscholar: 'semanticscholar.org/author',
      arxiv: 'arxiv.org',
      patents: 'patents.google.com',
      youtube: 'youtube.com',
      substack: 'substack.com',
      codepen: 'codepen.io',
      dockerhub: 'hub.docker.com/u',
      angellist: 'angel.co/u',
      paperswithcode: 'paperswithcode.com',
      hackerearth: 'hackerearth.com',
      gist: 'gist.github.com',
      openreview: 'openreview.net',
      university: 'edu', // Special case - searches across .edu domains
      companyteam: '', // Special case - searches company domains
      sec: 'sec.gov',
    };
    return domainMap[this.platform] || `${this.platform}.com`;
  }

  /**
   * Extract profile information from search result snippet
   * Override in subclasses for platform-specific extraction
   */
  protected extractProfileInfo(result: EnrichmentSearchResult): {
    name: string | null;
    bio: string | null;
    company: string | null;
    location: string | null;
    followers?: number;
    reputation?: number;
    publicRepos?: number;
    publications?: number;
  } {
    // Default extraction from title and snippet
    const titleParts = result.title.split(' - ');
    const name = titleParts[0]?.trim() || null;

    return {
      name,
      bio: result.snippet || null,
      company: null,
      location: null,
    };
  }

  /**
   * Calculate confidence score for a discovered identity
   */
  protected calculateScore(
    hints: CandidateHints,
    result: EnrichmentSearchResult,
    profileInfo: ReturnType<typeof this.extractProfileInfo>,
    hasBridgeEvidence: boolean = false
  ): ScoreBreakdown {
    const nameMatch = calculateNameSimilarity(hints.nameHint, profileInfo.name);

    // Extract company from headline if not in hints
    let companyHint = hints.companyHint;
    if (!companyHint && hints.headlineHint) {
      const match = hints.headlineHint.match(/(?:at|@|,)\s*([A-Z][A-Za-z0-9\s&]+?)(?:\s*[-|·]|$)/);
      if (match) companyHint = match[1].trim();
    }

    const companyMatch = calculateCompanyMatch(companyHint, profileInfo.company);
    const locationMatch = calculateLocationMatch(hints.locationHint, profileInfo.location);

    // Profile completeness (0-1)
    const completenessFactors = [
      profileInfo.name ? 1 : 0,
      profileInfo.bio ? 1 : 0,
      profileInfo.company ? 1 : 0,
      profileInfo.location ? 1 : 0,
    ];
    const profileCompleteness =
      completenessFactors.reduce((a, b) => a + b, 0) / completenessFactors.length;

    // Activity score based on platform metrics
    let activityScore = 0;
    if (profileInfo.followers && profileInfo.followers > 10) activityScore += 0.3;
    if (profileInfo.reputation && profileInfo.reputation > 100) activityScore += 0.3;
    if (profileInfo.publicRepos && profileInfo.publicRepos > 5) activityScore += 0.3;
    if (profileInfo.publications && profileInfo.publications > 0) activityScore += 0.3;
    activityScore = Math.min(activityScore, 1);

    // Bridge weight (profile link to LinkedIn is strongest signal)
    const bridgeWeight = hasBridgeEvidence ? 0.5 : 0;

    // Calculate total score
    const total = Math.min(
      1,
      this.baseWeight * (
        bridgeWeight * 1.0 +
        nameMatch * 0.35 +
        companyMatch * 0.25 +
        locationMatch * 0.15 +
        profileCompleteness * 0.15 +
        activityScore * 0.1
      )
    );

    return {
      bridgeWeight,
      nameMatch,
      companyMatch,
      locationMatch,
      profileCompleteness,
      activityScore,
      total,
    };
  }

  /**
   * Create evidence pointers for a discovered identity
   */
  protected createEvidence(
    result: EnrichmentSearchResult,
    additionalEvidence?: EvidencePointer[]
  ): EvidencePointer[] {
    const evidence: EvidencePointer[] = [
      {
        type: 'profile_link',
        sourceUrl: result.platformProfileUrl || result.url,
        sourcePlatform: this.platform,
        description: `${this.displayName} profile discovered via search`,
        capturedAt: new Date().toISOString(),
        metadata: {
          searchTitle: result.title,
          searchSnippet: result.snippet,
        },
      },
    ];

    if (additionalEvidence) {
      evidence.push(...additionalEvidence);
    }

    return evidence;
  }

  /**
   * Detect contradictions between candidate hints and platform profile
   */
  protected detectContradictions(
    hints: CandidateHints,
    profileInfo: ReturnType<typeof this.extractProfileInfo>
  ): { hasContradiction: boolean; note: string | null } {
    const issues: string[] = [];

    // Check for name contradiction (completely different names)
    if (hints.nameHint && profileInfo.name) {
      const similarity = calculateNameSimilarity(hints.nameHint, profileInfo.name);
      if (similarity < 0.2) {
        issues.push(`Name mismatch: "${hints.nameHint}" vs "${profileInfo.name}"`);
      }
    }

    // Check for company contradiction
    if (hints.companyHint && profileInfo.company) {
      const companyMatch = calculateCompanyMatch(hints.companyHint, profileInfo.company);
      if (companyMatch === 0) {
        // Only flag if both are well-known companies (not just different)
        const known1 = hints.companyHint.length > 3;
        const known2 = profileInfo.company.length > 3;
        if (known1 && known2) {
          issues.push(`Company differs: "${hints.companyHint}" vs "${profileInfo.company}"`);
        }
      }
    }

    return {
      hasContradiction: issues.length > 0,
      note: issues.length > 0 ? issues.join('; ') : null,
    };
  }

  /**
   * Classify confidence into buckets
   */
  protected classifyConfidence(
    confidence: number
  ): 'auto_merge' | 'suggest' | 'low' | 'rejected' {
    if (confidence >= 0.9) return 'auto_merge';
    if (confidence >= 0.7) return 'suggest';
    if (confidence >= 0.3) return 'low';
    return 'rejected';
  }

  /**
   * Main discovery method - discovers identities from search results
   */
  async discover(
    hints: CandidateHints,
    options?: DiscoveryOptions
  ): Promise<BridgeDiscoveryResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startTime = Date.now();
    const identities: DiscoveredIdentity[] = [];
    const searchQueries: string[] = [];
    let queriesExecuted = 0;

    // Build queries
    const queries = this.buildQueries(hints, opts.maxQueries);

    if (queries.length === 0) {
      console.log(`[${this.displayName}] No queries to execute for ${hints.linkedinId}`);
      return {
        platform: this.platform,
        identities: [],
        queriesExecuted: 0,
        searchQueries: [],
        durationMs: Date.now() - startTime,
        error: 'no_queries',
      };
    }

    const seenIds = new Set<string>();

    // Execute queries
    for (const query of queries) {
      try {
        queriesExecuted++;
        searchQueries.push(query);

        console.log(`[${this.displayName}] Query ${queriesExecuted}/${queries.length}: "${query}"`);

        const results = await searchForPlatform(this.platform, query, opts.maxResults);

        for (const result of results) {
          if (!result.platformId) continue;

          // Skip duplicates
          if (seenIds.has(result.platformId.toLowerCase())) continue;
          seenIds.add(result.platformId.toLowerCase());

          // Extract profile info
          const profileInfo = this.extractProfileInfo(result);

          // Calculate score
          const scoreBreakdown = this.calculateScore(hints, result, profileInfo);

          // Skip if below threshold
          if (scoreBreakdown.total < opts.minConfidence) {
            console.log(
              `[${this.displayName}] Skipping ${result.platformId} (confidence: ${scoreBreakdown.total.toFixed(2)} < ${opts.minConfidence})`
            );
            continue;
          }

          // Detect contradictions
          const contradictions = this.detectContradictions(hints, profileInfo);

          // Create identity
          const identity: DiscoveredIdentity = {
            platform: this.platform,
            platformId: result.platformId,
            profileUrl: result.platformProfileUrl || result.url,
            displayName: profileInfo.name,
            confidence: scoreBreakdown.total,
            confidenceBucket: this.classifyConfidence(scoreBreakdown.total),
            scoreBreakdown,
            evidence: this.createEvidence(result),
            hasContradiction: contradictions.hasContradiction,
            contradictionNote: contradictions.note,
            platformProfile: profileInfo,
          };

          identities.push(identity);

          console.log(
            `[${this.displayName}] Found: ${result.platformId} (confidence: ${scoreBreakdown.total.toFixed(2)}, bucket: ${identity.confidenceBucket})`
          );

          // Early stop on high confidence match
          if (scoreBreakdown.total >= 0.9) {
            console.log(`[${this.displayName}] Early stop: high confidence match found`);
            break;
          }
        }

        // Early stop if we found high confidence match
        if (identities.some((i) => i.confidence >= 0.9)) {
          break;
        }
      } catch (error) {
        console.error(
          `[${this.displayName}] Query failed: "${query}"`,
          error instanceof Error ? error.message : error
        );
      }
    }

    // Sort by confidence
    identities.sort((a, b) => b.confidence - a.confidence);

    const result: BridgeDiscoveryResult = {
      platform: this.platform,
      identities,
      queriesExecuted,
      searchQueries,
      durationMs: Date.now() - startTime,
    };

    console.log(
      `[${this.displayName}] Completed for ${hints.linkedinId}: ${identities.length} identities, ${queriesExecuted} queries, ${result.durationMs}ms`
    );

    return result;
  }

  /**
   * Health check using search provider health
   */
  async healthCheck(): Promise<SourceHealthCheck> {
    try {
      const health = await checkProvidersHealth();
      return {
        healthy: health.primary.healthy || (health.fallback?.healthy ?? false),
        error: health.primary.error || health.fallback?.error,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

export default BaseEnrichmentSource;
