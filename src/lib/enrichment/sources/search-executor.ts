/**
 * Search Executor for Enrichment Discovery
 *
 * Uses search providers to execute enrichment queries against various platforms.
 *
 * Priority order:
 * 1. GitHub API (for GitHub-specific queries) - handled separately
 * 2. Brave Search (primary) - official paid API, predictable, compliant
 * 3. SearXNG (fallback) - best-effort recall boost when Brave fails/returns 0
 *
 * Environment Variables:
 * - ENRICHMENT_SEARCH_PROVIDER: Primary provider for enrichment (default: 'brave')
 * - ENRICHMENT_SEARCH_FALLBACK_PROVIDER: Fallback provider (default: 'searxng')
 * - MIN_RESULTS_BEFORE_FALLBACK: Minimum results before trying fallback (default: 2)
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import { getProvider, type RawSearchResult, type SearchProviderType } from '@/lib/search/providers';
import type { EnrichmentPlatform, CandidateHints } from './types';

/**
 * Get enrichment-specific search provider configuration
 * Separate from main search to allow different strategies
 */
export function getEnrichmentProviderConfig(): {
  primary: SearchProviderType;
  fallback: SearchProviderType | null;
  minResultsBeforeFallback: number;
} {
  const primary = (process.env.ENRICHMENT_SEARCH_PROVIDER?.toLowerCase() || 'brave') as SearchProviderType;
  const fallback = (process.env.ENRICHMENT_SEARCH_FALLBACK_PROVIDER?.toLowerCase() || 'searxng') as SearchProviderType | null;
  const minResults = parseInt(process.env.MIN_RESULTS_BEFORE_FALLBACK || '2', 10);

  return {
    primary: ['brave', 'searxng', 'brightdata'].includes(primary) ? primary : 'brave',
    fallback: fallback && ['brave', 'searxng', 'brightdata'].includes(fallback) ? fallback : 'searxng',
    minResultsBeforeFallback: minResults,
  };
}

/**
 * Execute raw search with enrichment-specific fallback logic
 */
async function searchRawWithFallback(
  query: string,
  maxResults: number = 20
): Promise<RawSearchResult[]> {
  const config = getEnrichmentProviderConfig();
  const primary = getProvider(config.primary);

  console.log(`[EnrichmentSearch] Primary: ${config.primary}, Fallback: ${config.fallback || 'none'}`);

  // Try primary provider (Brave)
  try {
    const results = await primary.searchRaw(query, maxResults);

    if (results.length >= config.minResultsBeforeFallback) {
      console.log(`[EnrichmentSearch] Primary (${config.primary}) returned ${results.length} results`);
      return results;
    }

    console.log(`[EnrichmentSearch] Primary (${config.primary}) returned only ${results.length} results (min: ${config.minResultsBeforeFallback})`);
  } catch (error) {
    console.error(
      `[EnrichmentSearch] Primary (${config.primary}) failed:`,
      error instanceof Error ? error.message : error
    );
  }

  // Try fallback provider (SearXNG) if configured
  if (config.fallback && config.fallback !== config.primary) {
    try {
      const fallback = getProvider(config.fallback);
      console.log(`[EnrichmentSearch] Trying fallback: ${config.fallback}`);

      const results = await fallback.searchRaw(query, maxResults);

      if (results.length > 0) {
        console.log(`[EnrichmentSearch] Fallback (${config.fallback}) returned ${results.length} results`);
        return results;
      }

      console.log(`[EnrichmentSearch] Fallback (${config.fallback}) returned 0 results`);
    } catch (error) {
      console.error(
        `[EnrichmentSearch] Fallback (${config.fallback}) failed:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  // Both failed or returned insufficient results
  console.log('[EnrichmentSearch] No results from any provider');
  return [];
}

/**
 * Search result with platform metadata
 */
export interface EnrichmentSearchResult extends RawSearchResult {
  platform: EnrichmentPlatform;
  platformId: string | null;
  platformProfileUrl: string | null;
}

/**
 * Platform URL patterns for ID extraction
 */
const PLATFORM_PATTERNS: Record<
  EnrichmentPlatform,
  {
    urlPattern: RegExp;
    idExtractor: (url: string) => string | null;
    profileUrlBuilder: (id: string) => string;
  }
> = {
  github: {
    urlPattern: /github\.com\/([a-zA-Z0-9_-]+)(?:\/|$|\?)/,
    idExtractor: (url) => {
      const match = url.match(/github\.com\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://github.com/${id}`,
  },
  stackoverflow: {
    urlPattern: /stackoverflow\.com\/users\/(\d+)/,
    idExtractor: (url) => {
      const match = url.match(/stackoverflow\.com\/users\/(\d+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://stackoverflow.com/users/${id}`,
  },
  npm: {
    urlPattern: /npmjs\.com\/~([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/npmjs\.com\/~([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://www.npmjs.com/~${id}`,
  },
  pypi: {
    urlPattern: /pypi\.org\/user\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/pypi\.org\/user\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://pypi.org/user/${id}/`,
  },
  dockerhub: {
    urlPattern: /hub\.docker\.com\/u\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/hub\.docker\.com\/u\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://hub.docker.com/u/${id}`,
  },
  leetcode: {
    urlPattern: /leetcode\.com\/(?:u\/)?([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/leetcode\.com\/(?:u\/)?([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://leetcode.com/u/${id}`,
  },
  hackerearth: {
    urlPattern: /hackerearth\.com\/@([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/hackerearth\.com\/@([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://www.hackerearth.com/@${id}`,
  },
  codepen: {
    urlPattern: /codepen\.io\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/codepen\.io\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://codepen.io/${id}`,
  },
  gitlab: {
    urlPattern: /gitlab\.com\/([a-zA-Z0-9_.-]+)/,
    idExtractor: (url) => {
      const match = url.match(/gitlab\.com\/([a-zA-Z0-9_.-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://gitlab.com/${id}`,
  },
  gist: {
    urlPattern: /gist\.github\.com\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/gist\.github\.com\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://gist.github.com/${id}`,
  },
  kaggle: {
    urlPattern: /kaggle\.com\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/kaggle\.com\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://www.kaggle.com/${id}`,
  },
  huggingface: {
    urlPattern: /huggingface\.co\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/huggingface\.co\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://huggingface.co/${id}`,
  },
  paperswithcode: {
    urlPattern: /paperswithcode\.com\/author\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/paperswithcode\.com\/author\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://paperswithcode.com/author/${id}`,
  },
  openreview: {
    urlPattern: /openreview\.net\/profile\?id=([^&]+)/,
    idExtractor: (url) => {
      const match = url.match(/openreview\.net\/profile\?id=([^&]+)/);
      return match?.[1] ? decodeURIComponent(match[1]) : null;
    },
    profileUrlBuilder: (id) => `https://openreview.net/profile?id=${encodeURIComponent(id)}`,
  },
  orcid: {
    urlPattern: /orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/,
    idExtractor: (url) => {
      const match = url.match(/orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://orcid.org/${id}`,
  },
  scholar: {
    urlPattern: /scholar\.google\.com\/citations\?user=([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/scholar\.google\.com\/citations\?user=([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://scholar.google.com/citations?user=${id}`,
  },
  semanticscholar: {
    urlPattern: /semanticscholar\.org\/author\/[^/]+\/(\d+)/,
    idExtractor: (url) => {
      const match = url.match(/semanticscholar\.org\/author\/[^/]+\/(\d+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://www.semanticscholar.org/author/${id}`,
  },
  researchgate: {
    urlPattern: /researchgate\.net\/profile\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/researchgate\.net\/profile\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://www.researchgate.net/profile/${id}`,
  },
  arxiv: {
    // Match any arxiv URL - papers, author pages, or search results
    urlPattern: /arxiv\.org\/(?:abs|pdf|list|search|a)\/([a-zA-Z0-9._-]+)/,
    idExtractor: (url) => {
      // Try to extract paper ID or author ID
      const absMatch = url.match(/arxiv\.org\/abs\/([0-9.]+)/);
      if (absMatch) return absMatch[1];
      const authorMatch = url.match(/arxiv\.org\/a\/([a-zA-Z0-9._-]+)/);
      if (authorMatch) return authorMatch[1];
      // Fallback: extract last path segment
      const pathMatch = url.match(/arxiv\.org\/[^/]+\/([a-zA-Z0-9._-]+)/);
      return pathMatch?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://arxiv.org/search/?searchtype=author&query=${encodeURIComponent(id)}`,
  },
  patents: {
    // Match any patents.google.com URL - individual patents or search results
    urlPattern: /patents\.google\.com/,
    idExtractor: (url) => {
      // Try to get inventor from URL params
      const inventorMatch = url.match(/[?&]inventor=([^&]+)/);
      if (inventorMatch) return decodeURIComponent(inventorMatch[1]);
      // Try to get patent number
      const patentMatch = url.match(/patents\.google\.com\/patent\/([A-Z0-9]+)/);
      if (patentMatch) return patentMatch[1];
      // Fallback: use URL as ID since it's a valid reference
      return url.includes('patents.google.com') ? url.split('/').pop() || null : null;
    },
    profileUrlBuilder: (id) => `https://patents.google.com/?inventor=${encodeURIComponent(id)}`,
  },
  university: {
    // Match both .edu (US) and .ac.uk (UK) academic domains
    urlPattern: /(?:\.edu|\.ac\.uk)\//,
    idExtractor: (url) => {
      // Try faculty/people/profile pattern
      const profileMatch = url.match(/(?:\.edu|\.ac\.uk)\/.*(?:faculty|people|profile|staff|about)\/([a-zA-Z0-9_-]+)/);
      if (profileMatch) return profileMatch[1];
      // Try ~username pattern common in academia
      const tildeMatch = url.match(/(?:\.edu|\.ac\.uk)\/~([a-zA-Z0-9_]+)/);
      if (tildeMatch) return tildeMatch[1];
      // Try department/name pattern
      const deptMatch = url.match(/(?:\.edu|\.ac\.uk)\/[^/]+\/([a-zA-Z0-9_-]+)\/?$/);
      if (deptMatch && deptMatch[1].length > 3) return deptMatch[1];
      // Fallback: use last meaningful path segment
      const pathParts = new URL(url).pathname.split('/').filter(Boolean);
      return pathParts.length > 0 ? pathParts[pathParts.length - 1] : null;
    },
    profileUrlBuilder: (id) => id, // University profiles vary too much
  },
  sec: {
    // Match any SEC EDGAR page - filings, company pages, or search results
    urlPattern: /sec\.gov/,
    idExtractor: (url) => {
      // Try CIK extraction
      const cikMatch = url.match(/CIK=([0-9]+)/i);
      if (cikMatch) return cikMatch[1];
      // Try accession number from filing URL
      const accMatch = url.match(/Archives\/edgar\/data\/([0-9]+)/);
      if (accMatch) return accMatch[1];
      // Fallback: use URL hash for reference
      return url.includes('sec.gov') ? url.split('/').filter(s => /\d+/.test(s))[0] || null : null;
    },
    profileUrlBuilder: (id) => `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${id}`,
  },
  companyteam: {
    // More flexible pattern - any URL with team/about/people/leadership/staff in path
    urlPattern: /\/(?:team|about|people|leadership|staff|our-team|meet-the-team|company|who-we-are)/i,
    idExtractor: (url) => {
      // Try to extract person slug after team/about/people keywords
      const personMatch = url.match(/\/(?:team|about|people|leadership|staff)\/([a-zA-Z0-9_-]+)/i);
      if (personMatch) return personMatch[1];
      // Try hash anchor for team member links
      const hashMatch = url.match(/#([a-zA-Z0-9_-]+)/);
      if (hashMatch) return hashMatch[1];
      // Use the URL as the ID since it's a valid team page reference
      try {
        const urlObj = new URL(url);
        return urlObj.pathname.split('/').filter(Boolean).pop() || urlObj.hostname;
      } catch {
        return null;
      }
    },
    profileUrlBuilder: (id) => id,
  },
  angellist: {
    urlPattern: /angel\.co\/u\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/angel\.co\/u\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://angel.co/u/${id}`,
  },
  crunchbase: {
    urlPattern: /crunchbase\.com\/person\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/crunchbase\.com\/person\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://www.crunchbase.com/person/${id}`,
  },
  medium: {
    urlPattern: /medium\.com\/@([a-zA-Z0-9_.-]+)/,
    idExtractor: (url) => {
      const match = url.match(/medium\.com\/@([a-zA-Z0-9_.-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://medium.com/@${id}`,
  },
  devto: {
    urlPattern: /dev\.to\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/dev\.to\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://dev.to/${id}`,
  },
  substack: {
    urlPattern: /([a-zA-Z0-9_-]+)\.substack\.com/,
    idExtractor: (url) => {
      const match = url.match(/([a-zA-Z0-9_-]+)\.substack\.com/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://${id}.substack.com`,
  },
  youtube: {
    urlPattern: /youtube\.com\/(?:@|channel\/|c\/)([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/youtube\.com\/(?:@|channel\/|c\/)([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://www.youtube.com/@${id}`,
  },
  twitter: {
    urlPattern: /(?:twitter|x)\.com\/([a-zA-Z0-9_]+)/,
    idExtractor: (url) => {
      const match = url.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://twitter.com/${id}`,
  },
  dribbble: {
    urlPattern: /dribbble\.com\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/dribbble\.com\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://dribbble.com/${id}`,
  },
  behance: {
    urlPattern: /behance\.net\/([a-zA-Z0-9_-]+)/,
    idExtractor: (url) => {
      const match = url.match(/behance\.net\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    },
    profileUrlBuilder: (id) => `https://www.behance.net/${id}`,
  },
};

/**
 * Execute search for a specific platform
 * Uses Brave as primary, SearXNG as fallback (configurable via env)
 */
export async function searchForPlatform(
  platform: EnrichmentPlatform,
  query: string,
  maxResults: number = 10
): Promise<EnrichmentSearchResult[]> {
  console.log(`[SearchExecutor] Searching ${platform}: "${query}"`);

  try {
    const results = await searchRawWithFallback(query, maxResults * 2); // Get extra for filtering
    const pattern = PLATFORM_PATTERNS[platform];

    if (!pattern) {
      console.warn(`[SearchExecutor] No pattern defined for platform: ${platform}`);
      return [];
    }

    // Filter and enhance results
    const enrichedResults: EnrichmentSearchResult[] = [];
    const seenIds = new Set<string>();

    for (const result of results) {
      // Check if URL matches the platform pattern
      if (!pattern.urlPattern.test(result.url)) {
        continue;
      }

      const platformId = pattern.idExtractor(result.url);
      if (!platformId) continue;

      // Deduplicate by platform ID
      if (seenIds.has(platformId.toLowerCase())) continue;
      seenIds.add(platformId.toLowerCase());

      enrichedResults.push({
        ...result,
        platform,
        platformId,
        platformProfileUrl: pattern.profileUrlBuilder(platformId),
      });

      if (enrichedResults.length >= maxResults) break;
    }

    console.log(
      `[SearchExecutor] Found ${enrichedResults.length} ${platform} results from ${results.length} total`
    );

    return enrichedResults;
  } catch (error) {
    console.error(`[SearchExecutor] Search failed for ${platform}:`, error);
    return [];
  }
}

/**
 * Build search query from candidate hints and query pattern
 */
export function buildQueryFromPattern(
  pattern: string,
  hints: CandidateHints
): string {
  let query = pattern;

  // Extract company from headline if available
  let company = hints.companyHint;
  if (!company && hints.headlineHint) {
    const companyMatch = hints.headlineHint.match(
      /(?:at|@|,)\s*([A-Z][A-Za-z0-9\s&]+?)(?:\s*[-|·]|$)/
    );
    if (companyMatch) {
      company = companyMatch[1].trim();
    }
  }

  // Replace placeholders
  query = query.replace(/\{name\}/g, hints.nameHint || '');
  query = query.replace(/\{company\}/g, company || '');
  query = query.replace(/\{location\}/g, hints.locationHint || '');

  // Clean up empty placeholders and extra whitespace
  query = query.replace(/"\s*"/g, '').replace(/\s+/g, ' ').trim();

  return query;
}

/**
 * Extract platform ID from URL
 */
export function extractPlatformId(
  platform: EnrichmentPlatform,
  url: string
): string | null {
  const pattern = PLATFORM_PATTERNS[platform];
  if (!pattern) return null;
  return pattern.idExtractor(url);
}

/**
 * Get canonical profile URL for platform
 */
export function getProfileUrl(
  platform: EnrichmentPlatform,
  platformId: string
): string {
  const pattern = PLATFORM_PATTERNS[platform];
  if (!pattern) return '';
  return pattern.profileUrlBuilder(platformId);
}

/**
 * Check if a URL matches a platform
 */
export function matchesPlatform(
  platform: EnrichmentPlatform,
  url: string
): boolean {
  const pattern = PLATFORM_PATTERNS[platform];
  if (!pattern) return false;
  return pattern.urlPattern.test(url);
}

export default {
  searchForPlatform,
  buildQueryFromPattern,
  extractPlatformId,
  getProfileUrl,
  matchesPlatform,
};
