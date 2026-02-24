/**
 * Serper.dev Google Search API Provider
 *
 * Serper uses POST + JSON body (not query params like Brave).
 * We use only the /search endpoint (web results).
 *
 * Docs: https://serper.dev/
 */

import type { ProfileSummary } from '@/types/linkedin';
import type { RawSearchResult, SearchProvider, SearchProviderType } from './types';
import { getProviderLimiter } from './limit';
import { extractLocationFromSnippet } from '@/lib/enrichment/hint-extraction';

interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

interface SerperKnowledgeGraph {
  title?: string;
  type?: string;
  description?: string;
  attributes?: Record<string, string>;
}

interface SerperAnswerBox {
  title?: string;
  answer?: string;
  snippet?: string;
}

interface SerperResponse {
  organic?: SerperOrganicResult[];
  knowledgeGraph?: SerperKnowledgeGraph;
  answerBox?: SerperAnswerBox;
}

const DEFAULT_TIMEOUT = 8000;
const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_NUM_PER_PAGE = 20;
const SERPER_DEFAULT_URL = 'https://google.serper.dev/search';

function getConfig() {
  return {
    apiKey: process.env.SERPER_API_KEY,
    url: process.env.SERPER_URL || SERPER_DEFAULT_URL,
    timeout: parseInt(process.env.SERPER_TIMEOUT || String(DEFAULT_TIMEOUT), 10),
    maxPages: parseInt(process.env.SERPER_MAX_PAGES || String(DEFAULT_MAX_PAGES), 10),
    numPerPage: parseInt(process.env.SERPER_NUM_PER_PAGE || String(DEFAULT_NUM_PER_PAGE), 10),
  };
}

function isConfigured(): boolean {
  return !!process.env.SERPER_API_KEY;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeSerperSearch(
  query: string,
  options: { num: number; page: number }
): Promise<SerperResponse> {
  const config = getConfig();
  if (!config.apiKey) {
    throw new Error('SERPER_API_KEY is not configured');
  }
  const apiKey = config.apiKey;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);
  const limiter = getProviderLimiter('serper');

  const doRequest = async () => {
    const response = await limiter.run(async () => {
      return await fetch(config.url, {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          q: query,
          num: options.num,
          page: options.page,
        }),
        signal: controller.signal,
      });
    });

    // Serper returns JSON error bodies; include text for debugging.
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const err = new Error(
        `Serper API error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
      );
      (err as Error & { status?: number; retryAfter?: string | null }).status = response.status;
      (err as Error & { status?: number; retryAfter?: string | null }).retryAfter =
        response.headers.get('Retry-After');
      throw err;
    }

    return (await response.json()) as SerperResponse;
  };

  try {
    return await doRequest();
  } catch (error) {
    const status = (error as { status?: number }).status;
    const retryAfterHeader = (error as { retryAfter?: string | null }).retryAfter;
    // Bounded retry once on 429/503.
    if (status === 429 || status === 503) {
      const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const delayMs = Number.isFinite(retryAfterSeconds)
        ? Math.max(250, retryAfterSeconds * 1000)
        : 1000 + Math.floor(Math.random() * 250);
      await sleep(delayMs);
      return await doRequest();
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Serper API request timed out');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

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

function normalizeLinkedInUrl(url: string): string {
  const id = extractLinkedInId(url);
  return id ? `https://www.linkedin.com/in/${id}` : url;
}

function buildProviderMeta(response: SerperResponse): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (response.knowledgeGraph) meta.knowledgeGraph = response.knowledgeGraph;
  if (response.answerBox) meta.answerBox = response.answerBox;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function extractProfileSummary(result: SerperOrganicResult, providerMeta?: Record<string, unknown>): ProfileSummary {
  const url = normalizeLinkedInUrl(result.link || '');
  const linkedinId = extractLinkedInId(url) || url;

  const title = result.title || '';
  const snippet = result.snippet || '';

  // Parse title: "Name - Headline | LinkedIn"
  const titleParts = title.split(' - ');
  const rawName = titleParts[0]?.replace(' | LinkedIn', '').trim() || '';
  const name = rawName || undefined;
  const headlineCandidate = titleParts
    .slice(1)
    .join(' - ')
    .replace(' | LinkedIn', '')
    .trim();
  const headline = headlineCandidate || undefined;
  const location = extractLocationFromSnippet(snippet) ?? undefined;

  return {
    linkedinUrl: url,
    linkedinId,
    title,
    snippet,
    name,
    headline,
    location,
    ...(providerMeta ? { providerMeta } : {}),
  };
}

export const serperProvider: SearchProvider = {
  name: 'serper' as SearchProviderType,

  async searchLinkedInProfiles(
    query: string,
    maxResults: number = 10,
    _countryCode?: string | null
  ): Promise<ProfileSummary[]> {
    console.log('[Serper] Searching for LinkedIn profiles:', { query, maxResults });

    if (!isConfigured()) {
      console.warn('[Serper] API key not configured, returning empty results');
      return [];
    }

    try {
      const config = getConfig();

      const scopedQuery = query.includes('site:linkedin.com')
        ? query
        : `site:linkedin.com/in ${query}`;

      const desiredRawResults = maxResults * 2;
      const numPerPage = Math.min(
        100,
        Math.max(1, config.numPerPage || DEFAULT_NUM_PER_PAGE)
      );
      const maxPages = Math.max(1, config.maxPages || DEFAULT_MAX_PAGES);

      const summaries: ProfileSummary[] = [];
      const seenIds = new Set<string>();
      let page = 1;

      while (page <= maxPages && summaries.length < maxResults) {
        const response = await executeSerperSearch(scopedQuery, { num: numPerPage, page });
        const organic = response.organic ?? [];
        if (organic.length === 0) break;

        const providerMeta = buildProviderMeta(response);

        let addedThisPage = 0;
        for (const r of organic) {
          const link = r.link || '';
          if (!link || !isValidLinkedInProfileUrl(link)) continue;

          const summary = extractProfileSummary(r, providerMeta);
          if (seenIds.has(summary.linkedinId)) continue;
          seenIds.add(summary.linkedinId);
          summaries.push(summary);
          addedThisPage++;
          if (summaries.length >= maxResults) break;
        }

        if (addedThisPage === 0) {
          // Stop if the page contributes no new profiles.
          break;
        }

        page++;
      }

      console.log(`[Serper] Found ${summaries.length} LinkedIn profiles`);
      return summaries.slice(0, maxResults);
    } catch (error) {
      console.error('[Serper] Error searching LinkedIn profiles:', error);
      throw new Error(
        `Serper search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  },

  async searchRaw(
    query: string,
    maxResults: number = DEFAULT_MAX_RESULTS
  ): Promise<RawSearchResult[]> {
    console.log('[Serper] Raw search:', { query, maxResults });

    if (!isConfigured()) {
      console.warn('[Serper] API key not configured, returning empty results');
      return [];
    }

    const config = getConfig();
    const numPerPage = Math.min(100, Math.max(1, config.numPerPage || DEFAULT_NUM_PER_PAGE));
    const maxPages = Math.max(1, config.maxPages || DEFAULT_MAX_PAGES);

    const results: RawSearchResult[] = [];
    const seenUrls = new Set<string>();

    for (let page = 1; page <= maxPages && results.length < maxResults; page++) {
      const remaining = maxResults - results.length;
      const num = Math.min(numPerPage, remaining);
      const response = await executeSerperSearch(query, { num, page });
      const organic = response.organic ?? [];
      if (organic.length === 0) break;

      const providerMeta = buildProviderMeta(response);

      const pageOffset = (page - 1) * numPerPage;
      let added = 0;
      for (const [idx, r] of organic.entries()) {
        const url = (r.link || '').trim();
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        const pos = pageOffset + (r.position ?? (idx + 1));
        results.push({
          url,
          title: r.title || '',
          snippet: r.snippet || '',
          position: pos,
          score: 1 / pos,
          ...(providerMeta ? { providerMeta } : {}),
        });
        added++;
        if (results.length >= maxResults) break;
      }

      if (added === 0) break; // Stop on 0 new unique URLs
    }

    return results;
  },

  async healthCheck(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
    if (!isConfigured()) {
      return { healthy: false, error: 'SERPER_API_KEY not configured' };
    }

    const start = Date.now();
    try {
      await executeSerperSearch('test', { num: 1, page: 1 });
      return { healthy: true, latency: Date.now() - start };
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - start,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};

export default serperProvider;
