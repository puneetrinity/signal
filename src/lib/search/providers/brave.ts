/**
 * Brave Search API Provider
 *
 * High-quality search API with excellent reliability.
 * Used as fallback when SearXNG returns no results.
 *
 * Cost: $5/1000 queries (Free tier: 2K/month)
 * Rate Limit: 1-50 req/sec depending on plan
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 4.4
 */

import type { ProfileSummary } from '@/types/linkedin';
import type {
  SearchGeoContext,
  SearchProvider,
  RawSearchResult,
  SearchProviderType,
} from './types';
import { getProviderLimiter } from './limit';
import { extractLocationFromSnippet } from '@/lib/enrichment/hint-extraction';

interface BraveWebResult {
  url: string;
  title: string;
  description: string;
  page_age?: string;
  language?: string;
  family_friendly?: boolean;
}

interface BraveResponse {
  query: {
    original: string;
    show_strict_warning?: boolean;
  };
  mixed?: {
    type: string;
    main: unknown[];
  };
  web?: {
    type: string;
    results: BraveWebResult[];
    family_friendly_results?: boolean;
  };
}

const DEFAULT_TIMEOUT = 8000;
const DEFAULT_MAX_RESULTS = 20;
const BRAVE_MAX_PER_PAGE = 20; // Brave API max per request
const BRAVE_MAX_OFFSET = 9; // Brave API limit: offset must be <= 9
const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

function getConfig() {
  return {
    apiKey: process.env.BRAVE_API_KEY,
    timeout: parseInt(process.env.BRAVE_TIMEOUT || String(DEFAULT_TIMEOUT), 10),
    maxPages: parseInt(process.env.BRAVE_MAX_PAGES || '3', 10),
  };
}

/**
 * Check if Brave API is configured
 */
function isConfigured(): boolean {
  return !!process.env.BRAVE_API_KEY;
}

/**
 * Execute a raw search via Brave API
 *
 * @param query - Search query string
 * @param count - Number of results to fetch (max 20 per request)
 * @param offset - Starting offset for pagination (0-based)
 */
async function executeSearch(
  query: string,
  count: number = DEFAULT_MAX_RESULTS,
  offset: number = 0
): Promise<BraveResponse> {
  const config = getConfig();

  if (!config.apiKey) {
    throw new Error('BRAVE_API_KEY is not configured');
  }
  const apiKey = config.apiKey;

  const url = new URL(BRAVE_API_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(count, BRAVE_MAX_PER_PAGE)));
  // Brave API requires offset <= 9, skip pagination if offset exceeds limit
  if (offset > 0) {
    if (offset > BRAVE_MAX_OFFSET) {
      console.warn(`[Brave] Offset ${offset} exceeds API limit (${BRAVE_MAX_OFFSET}), skipping pagination`);
      return { query: { original: query } }; // Return empty response
    }
    url.searchParams.set('offset', String(offset));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);
  const limiter = getProviderLimiter('brave');

  try {
    const response = await limiter.run(async () => {
      return await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKey,
        },
        signal: controller.signal,
      });
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const error = new Error(
        `Brave API error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
      );
      (error as Error & { status?: number; retryAfter?: string | null }).status = response.status;
      (error as Error & { status?: number; retryAfter?: string | null }).retryAfter =
        response.headers.get('Retry-After');
      throw error;
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    const status = (error as { status?: number }).status;
    const retryAfterHeader = (error as { retryAfter?: string | null }).retryAfter;
    // Bounded retry once on 429/503.
    if (status === 429 || status === 503) {
      const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const delayMs = Number.isFinite(retryAfterSeconds)
        ? Math.max(250, retryAfterSeconds * 1000)
        : 1000 + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await executeSearch(query, count, offset);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Brave API request timed out');
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
function extractProfileSummary(result: BraveWebResult): ProfileSummary {
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

  // Extract location from description
  const location = extractLocationFromSnippet(result.description || '') ?? undefined;

  return {
    linkedinUrl,
    linkedinId,
    title: result.title,
    snippet: result.description || '',
    name,
    headline,
    location,
  };
}

/**
 * Brave Search API Provider Implementation
 */
export const braveProvider: SearchProvider = {
  name: 'brave' as SearchProviderType,

  async searchLinkedInProfiles(
    query: string,
    maxResults: number = 10,
    countryCode?: string | null,
    _geo?: SearchGeoContext
  ): Promise<ProfileSummary[]> {
    console.log('[Brave] Searching for LinkedIn profiles:', { query, maxResults, countryCode });

    if (!isConfigured()) {
      console.warn('[Brave] API key not configured, returning empty results');
      return [];
    }

    try {
      // Build site-scoped query if not already scoped
      const scopedQuery = hasLinkedInSiteConstraint(query)
        ? query
        : `site:linkedin.com/in ${query}`;

      // Filter to valid LinkedIn profile URLs and deduplicate
      const summaries: ProfileSummary[] = [];
      const seenIds = new Set<string>();
      const config = getConfig();
      const maxPages = Number.isFinite(config.maxPages) && config.maxPages > 0 ? config.maxPages : 3;
      let offset = 0;

      // Paginate when needed (Brave max is 20 per request)
      for (let page = 0; page < maxPages && summaries.length < maxResults; page++) {
        const count = BRAVE_MAX_PER_PAGE;
        if (page > 0) {
          console.log(`[Brave] Fetching LinkedIn page ${page + 1} (offset=${offset}, count=${count})`);
        }

        const response = await executeSearch(scopedQuery, count, offset);
        const results = response.web?.results ?? [];
        if (results.length === 0) break;

        let newProfilesThisPage = 0;
        for (const result of results) {
          if (!isValidLinkedInProfileUrl(result.url)) continue;

          const summary = extractProfileSummary(result);
          if (seenIds.has(summary.linkedinId)) continue;

          seenIds.add(summary.linkedinId);
          summaries.push(summary);
          newProfilesThisPage++;

          if (summaries.length >= maxResults) break;
        }

        // Stop if this page added no new unique profiles (noisy tail)
        if (newProfilesThisPage === 0) {
          console.log(`[Brave] LinkedIn page ${page + 1} yielded 0 new profiles, stopping pagination`);
          break;
        }

        // If we got fewer results than requested, no more pages are available
        if (results.length < count) break;
        offset += BRAVE_MAX_PER_PAGE;
      }

      console.log(`[Brave] Found ${summaries.length} LinkedIn profiles`);
      return summaries;
    } catch (error) {
      console.error('[Brave] Error searching LinkedIn profiles:', error);
      throw new Error(
        `Brave search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  },

	  async searchRaw(
	    query: string,
	    maxResults: number = DEFAULT_MAX_RESULTS
	  ): Promise<RawSearchResult[]> {
    console.log('[Brave] Raw search:', { query, maxResults });

    if (!isConfigured()) {
      console.warn('[Brave] API key not configured, returning empty results');
      return [];
    }

    try {
      const allResults: RawSearchResult[] = [];
      const seenUrls = new Set<string>(); // Dedupe URLs across pages
      let offset = 0;
      const maxPages = Math.ceil(maxResults / BRAVE_MAX_PER_PAGE);
      const config = getConfig();
      const maxPagesLimit = Number.isFinite(config.maxPages) && config.maxPages > 0 ? config.maxPages : 3;

      // Paginate if maxResults > 20
      for (let page = 0; page < Math.min(maxPages, maxPagesLimit); page++) {
        const remaining = maxResults - allResults.length;
        if (remaining <= 0) break;

        const count = Math.min(remaining, BRAVE_MAX_PER_PAGE);

        if (page > 0) {
          console.log(`[Brave] Fetching page ${page + 1} (offset=${offset}, count=${count})`);
        }

        const response = await executeSearch(query, count, offset);

        if (!response.web?.results?.length) {
          // No more results available
          break;
        }

        let newResultsThisPage = 0;
        for (const r of response.web.results) {
          if (allResults.length >= maxResults) break;

          // Dedupe by URL (normalized to lowercase)
          const normalizedUrl = r.url.toLowerCase();
          if (seenUrls.has(normalizedUrl)) continue;
          seenUrls.add(normalizedUrl);

          allResults.push({
            url: r.url,
            title: r.title || '',
            snippet: r.description || '',
            position: allResults.length + 1,
            score: 1 / (allResults.length + 1), // Position-based score
          });
          newResultsThisPage++;
        }

        // Stop if this page added no new unique results (noisy tail)
        if (newResultsThisPage === 0) {
          console.log(`[Brave] Page ${page + 1} yielded 0 new unique URLs, stopping pagination`);
          break;
        }

        // If we got fewer results than requested, no more pages available
        if (response.web.results.length < count) {
          break;
        }

        offset += BRAVE_MAX_PER_PAGE;
      }

      console.log(`[Brave] Raw search completed: ${allResults.length} results`);
      return allResults;
    } catch (error) {
      console.error('[Brave] Error in raw search:', error);
      throw error;
    }
  },

  async healthCheck(): Promise<{
    healthy: boolean;
    latency?: number;
    error?: string;
  }> {
    if (!isConfigured()) {
      return {
        healthy: false,
        error: 'BRAVE_API_KEY not configured',
      };
    }

    const start = Date.now();

    try {
      const url = new URL(BRAVE_API_URL);
      url.searchParams.set('q', 'test');
      url.searchParams.set('count', '1');

      const config = getConfig();
      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': config.apiKey!,
        },
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

export default braveProvider;
