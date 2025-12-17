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
import type { SearchProvider, RawSearchResult, SearchProviderType } from './types';

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
const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

function getConfig() {
  return {
    apiKey: process.env.BRAVE_API_KEY,
    timeout: parseInt(process.env.BRAVE_TIMEOUT || String(DEFAULT_TIMEOUT), 10),
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
 */
async function executeSearch(
  query: string,
  maxResults: number = DEFAULT_MAX_RESULTS
): Promise<BraveResponse> {
  const config = getConfig();

  if (!config.apiKey) {
    throw new Error('BRAVE_API_KEY is not configured');
  }

  const url = new URL(BRAVE_API_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(maxResults, 20))); // Brave max is 20

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': config.apiKey,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Brave API error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
      );
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
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
  const location = extractLocationFromSnippet(result.description || '');

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
 * Extract location from search snippet
 */
function extractLocationFromSnippet(snippet: string): string | undefined {
  // Try "Location: X" pattern
  const locationMatch = snippet.match(/Location:\s*([^·]+)/i);
  if (locationMatch?.[1]) {
    return locationMatch[1].trim();
  }

  // Try last segment after " · "
  const parts = snippet.split(' · ');
  if (parts.length > 1) {
    const candidate = parts[parts.length - 1].trim();
    if (candidate && candidate.length <= 80) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Brave Search API Provider Implementation
 */
export const braveProvider: SearchProvider = {
  name: 'brave' as SearchProviderType,

  async searchLinkedInProfiles(
    query: string,
    maxResults: number = 10,
    countryCode?: string | null
  ): Promise<ProfileSummary[]> {
    console.log('[Brave] Searching for LinkedIn profiles:', { query, maxResults, countryCode });

    if (!isConfigured()) {
      console.warn('[Brave] API key not configured, returning empty results');
      return [];
    }

    try {
      // Build site-scoped query if not already scoped
      const scopedQuery = query.includes('site:linkedin.com')
        ? query
        : `site:linkedin.com/in ${query}`;

      const response = await executeSearch(scopedQuery, maxResults * 2);

      if (!response.web?.results?.length) {
        console.log('[Brave] No results found');
        return [];
      }

      // Filter to valid LinkedIn profile URLs and deduplicate
      const summaries: ProfileSummary[] = [];
      const seenIds = new Set<string>();

      for (const result of response.web.results) {
        if (!isValidLinkedInProfileUrl(result.url)) continue;

        const summary = extractProfileSummary(result);
        if (seenIds.has(summary.linkedinId)) continue;

        seenIds.add(summary.linkedinId);
        summaries.push(summary);

        if (summaries.length >= maxResults) break;
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
      const response = await executeSearch(query, maxResults);

      if (!response.web?.results?.length) {
        return [];
      }

      return response.web.results.map((r, idx) => ({
        url: r.url,
        title: r.title || '',
        snippet: r.description || '',
        position: idx + 1,
        score: 10 - idx, // Simple position-based score
      }));
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
