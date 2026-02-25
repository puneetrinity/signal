/**
 * SearXNG Search Provider
 *
 * Self-hosted metasearch engine that aggregates results from multiple
 * search engines (Google, Brave, DuckDuckGo, Startpage).
 *
 * Cost: $0 (self-hosted)
 * Rate Limit: Upstream-limited
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 4.3
 */

import type { ProfileSummary } from '@/types/linkedin';
import type {
  SearchGeoContext,
  SearchProvider,
  RawSearchResult,
  SearchProviderType,
} from './types';
import { extractLocationFromSnippet } from '@/lib/enrichment/hint-extraction';

interface SearXNGResult {
  url: string;
  title: string;
  content: string;
  engine: string;
  engines?: string[];
  score?: number;
  position?: number;
  positions?: number[];
}

interface SearXNGResponse {
  query: string;
  number_of_results: number;
  results: SearXNGResult[];
  unresponsive_engines?: string[];
}

const DEFAULT_TIMEOUT = 10000;
const DEFAULT_MAX_RESULTS = 20;

function getConfig() {
  return {
    baseUrl:
      process.env.SEARXNG_URL ||
      'https://searxng-railway-production-9236.up.railway.app',
    timeout: parseInt(process.env.SEARXNG_TIMEOUT || String(DEFAULT_TIMEOUT), 10),
  };
}

/**
 * Execute a raw search via SearXNG
 * Note: SearXNG doesn't support result limits in the API; filtering is done post-query
 */
async function executeSearch(
  query: string,
  _maxResults: number = DEFAULT_MAX_RESULTS
): Promise<SearXNGResponse> {
  const config = getConfig();
  const url = new URL('/search', config.baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`SearXNG error: ${response.status} ${response.statusText}`);
    }

    const data: SearXNGResponse = await response.json();

    // Log unresponsive engines for debugging
    if (data.unresponsive_engines?.length) {
      console.warn(
        `[SearXNG] Unresponsive engines: ${data.unresponsive_engines.join(', ')}`
      );
    }

    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('SearXNG request timed out');
    }
    throw error;
  }
}

/**
 * Extract LinkedIn ID from URL
 */
function extractLinkedInId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/in\/([^/]+)/);
    if (match) {
      return match[1].split(/[?#]/)[0].replace(/\/$/, '');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if URL is a valid LinkedIn profile URL
 */
function isValidLinkedInProfileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === 'linkedin.com' ||
        parsed.hostname === 'www.linkedin.com' ||
        parsed.hostname.endsWith('.linkedin.com')) &&
      parsed.pathname.startsWith('/in/')
    );
  } catch {
    return false;
  }
}

/**
 * Normalize LinkedIn URL to canonical form
 */
function normalizeLinkedInUrl(url: string): string {
  const id = extractLinkedInId(url);
  return id ? `https://www.linkedin.com/in/${id}` : url;
}

function hasLinkedInSiteConstraint(query: string): boolean {
  return /\bsite:(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\b\/?/i.test(query);
}

/**
 * Extract profile summary from search result
 */
function extractProfileSummary(result: SearXNGResult): ProfileSummary {
  const linkedinUrl = normalizeLinkedInUrl(result.url);
  const linkedinId = extractLinkedInId(linkedinUrl) || result.url;

  // Parse title: "Name - Headline | LinkedIn"
  const titleParts = result.title.split(' - ');
  const rawName = titleParts[0]?.replace(' | LinkedIn', '').trim() || '';
  const name = rawName || undefined;
  const headlineCandidate = titleParts
    .slice(1)
    .join(' - ')
    .replace(' | LinkedIn', '')
    .trim();
  const headline = headlineCandidate || undefined;

  // Extract location from snippet
  const location = extractLocationFromSnippet(result.content || '') ?? undefined;

  return {
    linkedinUrl,
    linkedinId,
    title: result.title,
    snippet: result.content || '',
    name,
    headline,
    location,
  };
}

/**
 * SearXNG Search Provider Implementation
 */
export const searxngProvider: SearchProvider = {
  name: 'searxng' as SearchProviderType,

  async searchLinkedInProfiles(
    query: string,
    maxResults: number = 10,
    countryCode?: string | null,
    _geo?: SearchGeoContext
  ): Promise<ProfileSummary[]> {
    console.log('[SearXNG] Searching for LinkedIn profiles:', { query, maxResults, countryCode });

    try {
      // Build site-scoped query if not already scoped
      const scopedQuery = hasLinkedInSiteConstraint(query)
        ? query
        : `site:linkedin.com/in ${query}`;

      const response = await executeSearch(scopedQuery, maxResults * 2);

      if (!response.results?.length) {
        console.log('[SearXNG] No results found');
        return [];
      }

      // Filter to valid LinkedIn profile URLs and deduplicate
      const summaries: ProfileSummary[] = [];
      const seenIds = new Set<string>();

      for (const result of response.results) {
        if (!isValidLinkedInProfileUrl(result.url)) continue;

        const summary = extractProfileSummary(result);
        if (seenIds.has(summary.linkedinId)) continue;

        seenIds.add(summary.linkedinId);
        summaries.push(summary);

        if (summaries.length >= maxResults) break;
      }

      console.log(`[SearXNG] Found ${summaries.length} LinkedIn profiles`);
      return summaries;
    } catch (error) {
      console.error('[SearXNG] Error searching LinkedIn profiles:', error);
      throw new Error(
        `SearXNG search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  },

  async searchRaw(
    query: string,
    maxResults: number = DEFAULT_MAX_RESULTS
  ): Promise<RawSearchResult[]> {
    console.log('[SearXNG] Raw search:', { query, maxResults });

    try {
      const response = await executeSearch(query, maxResults);

      if (!response.results?.length) {
        return [];
      }

      // Rank by multi-engine agreement
      return response.results
        .map((r, idx) => ({
          url: r.url,
          title: r.title || '',
          snippet: r.content || '',
          position: idx + 1,
          score: (r.engines?.length || 1) * 10 + (r.score || 0),
          engines: r.engines || [r.engine],
        }))
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, maxResults);
    } catch (error) {
      console.error('[SearXNG] Error in raw search:', error);
      throw error;
    }
  },

  async healthCheck(): Promise<{
    healthy: boolean;
    latency?: number;
    error?: string;
  }> {
    const config = getConfig();
    const start = Date.now();

    try {
      const url = new URL('/search', config.baseUrl);
      url.searchParams.set('q', 'test');
      url.searchParams.set('format', 'json');

      const response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      const latency = Date.now() - start;

      if (!response.ok) {
        return {
          healthy: false,
          latency,
          error: `HTTP ${response.status}`,
        };
      }

      return { healthy: true, latency };
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - start,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};

export default searxngProvider;
