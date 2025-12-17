/**
 * BrightData Search Provider (v1 Legacy)
 *
 * Wrapper around existing BrightData implementation to match
 * the SearchProvider interface. This is the default provider
 * for backward compatibility.
 *
 * @see src/lib/brightdata/search.ts
 */

import type { ProfileSummary } from '@/types/linkedin';
import type { SearchProvider, RawSearchResult, SearchProviderType } from './types';
import {
  searchLinkedInProfiles as brightdataSearchLinkedIn,
  searchGoogle,
} from '@/lib/brightdata/search';

/**
 * Check if BrightData is configured
 */
function isConfigured(): boolean {
  return !!process.env.BRIGHTDATA_API_TOKEN;
}

/**
 * BrightData Search Provider Implementation
 *
 * Wraps the existing BrightData implementation for the provider interface.
 */
export const brightdataProvider: SearchProvider = {
  name: 'brightdata' as SearchProviderType,

  async searchLinkedInProfiles(
    query: string,
    maxResults: number = 10,
    countryCode?: string | null
  ): Promise<ProfileSummary[]> {
    console.log('[BrightData] Searching for LinkedIn profiles:', {
      query,
      maxResults,
      countryCode,
    });

    if (!isConfigured()) {
      console.warn('[BrightData] API token not configured, returning empty results');
      return [];
    }

    try {
      // Pass query as-is - the original implementation expects the full
      // site-scoped query (e.g., 'site:linkedin.com/in "Engineer" "SF"')
      // and filters results post-search via isValidLinkedInProfileUrl
      const summaries = await brightdataSearchLinkedIn(
        query,
        maxResults,
        countryCode
      );

      console.log(`[BrightData] Found ${summaries.length} LinkedIn profiles`);
      return summaries;
    } catch (error) {
      console.error('[BrightData] Error searching LinkedIn profiles:', error);
      throw new Error(
        `BrightData search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  },

  async searchRaw(
    query: string,
    maxResults: number = 20
  ): Promise<RawSearchResult[]> {
    console.log('[BrightData] Raw search:', { query, maxResults });

    if (!isConfigured()) {
      console.warn('[BrightData] API token not configured, returning empty results');
      return [];
    }

    try {
      const response = await searchGoogle(query, 0);

      if (!response.organic?.length) {
        return [];
      }

      return response.organic.slice(0, maxResults).map((r, idx) => ({
        url: r.link,
        title: r.title || '',
        snippet: r.snippet || '',
        position: r.position ?? idx + 1,
        score: 10 - idx,
      }));
    } catch (error) {
      console.error('[BrightData] Error in raw search:', error);
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
        error: 'BRIGHTDATA_API_TOKEN not configured',
      };
    }

    const start = Date.now();

    try {
      // Simple test search - result not needed, just checking connectivity
      await searchGoogle('test', 0);
      const latency = Date.now() - start;

      return {
        healthy: true,
        latency,
      };
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - start,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};

export default brightdataProvider;
