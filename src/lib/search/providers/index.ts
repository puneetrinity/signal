/**
 * Search Provider Factory
 *
 * Handles provider selection via environment variables and implements
 * fallback logic when primary provider fails or returns no results.
 *
 * Environment Variables:
 * - SEARCH_PROVIDER: 'brightdata' | 'searxng' | 'brave' (default: 'brightdata')
 * - SEARCH_FALLBACK_PROVIDER: Optional fallback provider
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 4
 */

import type { ProfileSummary } from '@/types/linkedin';
import type {
  SearchProvider,
  SearchProviderType,
  RawSearchResult,
} from './types';
import { brightdataProvider } from './brightdata';
import { searxngProvider } from './searxng';
import { braveProvider } from './brave';

// Re-export types
export * from './types';

/**
 * Provider registry
 */
const providers: Record<SearchProviderType, SearchProvider> = {
  brightdata: brightdataProvider,
  searxng: searxngProvider,
  brave: braveProvider,
};

/**
 * Get the configured primary provider
 */
function getPrimaryProvider(): SearchProviderType {
  const env = process.env.SEARCH_PROVIDER?.toLowerCase();
  if (env && env in providers) {
    return env as SearchProviderType;
  }
  return 'brightdata'; // Default for backward compatibility
}

/**
 * Get the configured fallback provider (if any)
 */
function getFallbackProvider(): SearchProviderType | null {
  const env = process.env.SEARCH_FALLBACK_PROVIDER?.toLowerCase();
  if (env && env in providers) {
    return env as SearchProviderType;
  }
  return null;
}

/**
 * Get a provider instance by type
 */
export function getProvider(type: SearchProviderType): SearchProvider {
  const provider = providers[type];
  if (!provider) {
    throw new Error(`Unknown search provider: ${type}`);
  }
  return provider;
}

/**
 * Get the current primary provider instance
 */
export function getCurrentProvider(): SearchProvider {
  return getProvider(getPrimaryProvider());
}

/**
 * Search for LinkedIn profiles with automatic fallback
 *
 * Strategy:
 * 1. Try primary provider
 * 2. If primary returns 0 results or fails, try fallback (if configured)
 * 3. Return results from whichever succeeds
 *
 * @param query - Search query (role, location, keywords)
 * @param maxResults - Maximum number of profiles to return
 * @param countryCode - Optional 2-letter country code
 * @returns Array of profile summaries
 */
export async function searchLinkedInProfiles(
  query: string,
  maxResults: number = 10,
  countryCode?: string | null
): Promise<ProfileSummary[]> {
  const primaryType = getPrimaryProvider();
  const fallbackType = getFallbackProvider();
  const primary = getProvider(primaryType);

  console.log(`[SearchProviders] Using primary: ${primaryType}${fallbackType ? `, fallback: ${fallbackType}` : ''}`);

  // Try primary provider
  try {
    const results = await primary.searchLinkedInProfiles(
      query,
      maxResults,
      countryCode
    );

    if (results.length > 0) {
      console.log(`[SearchProviders] Primary (${primaryType}) returned ${results.length} results`);
      return results;
    }

    console.log(`[SearchProviders] Primary (${primaryType}) returned 0 results`);
  } catch (error) {
    console.error(
      `[SearchProviders] Primary (${primaryType}) failed:`,
      error instanceof Error ? error.message : error
    );
  }

  // Try fallback if configured
  if (fallbackType) {
    const fallback = getProvider(fallbackType);

    try {
      console.log(`[SearchProviders] Trying fallback: ${fallbackType}`);
      const results = await fallback.searchLinkedInProfiles(
        query,
        maxResults,
        countryCode
      );

      if (results.length > 0) {
        console.log(`[SearchProviders] Fallback (${fallbackType}) returned ${results.length} results`);
        return results;
      }

      console.log(`[SearchProviders] Fallback (${fallbackType}) returned 0 results`);
    } catch (error) {
      console.error(
        `[SearchProviders] Fallback (${fallbackType}) failed:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  // Both failed or returned no results
  console.log('[SearchProviders] No results from any provider');
  return [];
}

/**
 * Execute a raw search with automatic fallback
 */
export async function searchRaw(
  query: string,
  maxResults: number = 20
): Promise<RawSearchResult[]> {
  const primaryType = getPrimaryProvider();
  const fallbackType = getFallbackProvider();
  const primary = getProvider(primaryType);

  // Try primary provider
  try {
    const results = await primary.searchRaw(query, maxResults);

    if (results.length > 0) {
      return results;
    }
  } catch (error) {
    console.error(
      `[SearchProviders] Primary (${primaryType}) raw search failed:`,
      error instanceof Error ? error.message : error
    );
  }

  // Try fallback if configured
  if (fallbackType) {
    const fallback = getProvider(fallbackType);

    try {
      const results = await fallback.searchRaw(query, maxResults);

      if (results.length > 0) {
        return results;
      }
    } catch (error) {
      console.error(
        `[SearchProviders] Fallback (${fallbackType}) raw search failed:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return [];
}

/**
 * Check health of all configured providers
 */
export async function checkProvidersHealth(): Promise<{
  primary: {
    type: SearchProviderType;
    healthy: boolean;
    latency?: number;
    error?: string;
  };
  fallback?: {
    type: SearchProviderType;
    healthy: boolean;
    latency?: number;
    error?: string;
  };
}> {
  const primaryType = getPrimaryProvider();
  const fallbackType = getFallbackProvider();
  const primary = getProvider(primaryType);

  const primaryHealth = await primary.healthCheck();

  const result: {
    primary: {
      type: SearchProviderType;
      healthy: boolean;
      latency?: number;
      error?: string;
    };
    fallback?: {
      type: SearchProviderType;
      healthy: boolean;
      latency?: number;
      error?: string;
    };
  } = {
    primary: {
      type: primaryType,
      ...primaryHealth,
    },
  };

  if (fallbackType) {
    const fallback = getProvider(fallbackType);
    const fallbackHealth = await fallback.healthCheck();
    result.fallback = {
      type: fallbackType,
      ...fallbackHealth,
    };
  }

  return result;
}

/**
 * Get current provider configuration
 */
export function getProviderConfig(): {
  primary: SearchProviderType;
  fallback: SearchProviderType | null;
  available: SearchProviderType[];
} {
  return {
    primary: getPrimaryProvider(),
    fallback: getFallbackProvider(),
    available: Object.keys(providers) as SearchProviderType[],
  };
}

/**
 * Search result with provider metadata
 */
export interface SearchResultWithMeta {
  results: ProfileSummary[];
  providerUsed: SearchProviderType;
  usedFallback: boolean;
}

/**
 * Search for LinkedIn profiles with automatic fallback and provider metadata
 *
 * Same as searchLinkedInProfiles but returns metadata about which provider
 * actually returned the results.
 *
 * @param query - Search query (role, location, keywords)
 * @param maxResults - Maximum number of profiles to return
 * @param countryCode - Optional 2-letter country code
 * @returns Results with provider metadata
 */
export async function searchLinkedInProfilesWithMeta(
  query: string,
  maxResults: number = 10,
  countryCode?: string | null
): Promise<SearchResultWithMeta> {
  const primaryType = getPrimaryProvider();
  const fallbackType = getFallbackProvider();
  const primary = getProvider(primaryType);

  console.log(`[SearchProviders] Using primary: ${primaryType}${fallbackType ? `, fallback: ${fallbackType}` : ''}`);

  // Try primary provider
  try {
    const results = await primary.searchLinkedInProfiles(
      query,
      maxResults,
      countryCode
    );

    if (results.length > 0) {
      console.log(`[SearchProviders] Primary (${primaryType}) returned ${results.length} results`);
      return {
        results,
        providerUsed: primaryType,
        usedFallback: false,
      };
    }

    console.log(`[SearchProviders] Primary (${primaryType}) returned 0 results`);
  } catch (error) {
    console.error(
      `[SearchProviders] Primary (${primaryType}) failed:`,
      error instanceof Error ? error.message : error
    );
  }

  // Try fallback if configured
  if (fallbackType) {
    const fallback = getProvider(fallbackType);

    try {
      console.log(`[SearchProviders] Trying fallback: ${fallbackType}`);
      const results = await fallback.searchLinkedInProfiles(
        query,
        maxResults,
        countryCode
      );

      if (results.length > 0) {
        console.log(`[SearchProviders] Fallback (${fallbackType}) returned ${results.length} results`);
        return {
          results,
          providerUsed: fallbackType,
          usedFallback: true,
        };
      }

      console.log(`[SearchProviders] Fallback (${fallbackType}) returned 0 results`);
    } catch (error) {
      console.error(
        `[SearchProviders] Fallback (${fallbackType}) failed:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  // Both failed or returned no results
  console.log('[SearchProviders] No results from any provider');
  return {
    results: [],
    providerUsed: primaryType, // Report primary even if it failed
    usedFallback: false,
  };
}
