/**
 * Search Provider Factory
 *
 * Handles provider selection via environment variables and implements
 * fallback logic when primary provider fails or returns no results.
 *
 * Environment Variables:
 * - SEARCH_PROVIDER: 'crustdata' | 'brightdata' | 'searxng' | 'brave' | 'serper' (default: 'crustdata')
 * - SEARCH_FALLBACK_PROVIDER: Optional fallback provider (default: 'serper' when primary is crustdata)
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 4
 */

import type { ProfileSummary } from '@/types/linkedin';
import type {
  SearchProvider,
  SearchProviderType,
  RawSearchResult,
  SearchGeoContext,
} from './types';
import { brightdataProvider } from './brightdata';
import { searxngProvider } from './searxng';
import { braveProvider } from './brave';
import { serperProvider } from './serper';
import { crustdataProvider } from './crustdata';

// Re-export types
export * from './types';

/**
 * Provider registry
 */
const providers: Record<SearchProviderType, SearchProvider> = {
  crustdata: crustdataProvider,
  brightdata: brightdataProvider,
  searxng: searxngProvider,
  brave: braveProvider,
  serper: serperProvider,
};

/**
 * Get the configured primary provider
 */
export function getPrimaryProvider(): SearchProviderType {
  const env = process.env.SEARCH_PROVIDER?.toLowerCase();
  if (env && env in providers) {
    return env as SearchProviderType;
  }
  return 'crustdata';
}

/**
 * Get the configured fallback provider (if any)
 */
function getFallbackProvider(): SearchProviderType | null {
  const env = process.env.SEARCH_FALLBACK_PROVIDER?.toLowerCase();
  if (env && env in providers) {
    return env as SearchProviderType;
  }
  const primary = getPrimaryProvider();
  if (primary === 'crustdata') return 'serper';
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
  countryCode?: string | null,
  geo?: SearchGeoContext
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
      countryCode,
      geo
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
        countryCode,
        geo
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
  countryCode?: string | null,
  geo?: SearchGeoContext
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
      countryCode,
      geo
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
        countryCode,
        geo
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

/**
 * Structured-spec search via the primary provider, if it supports it.
 *
 * Returns null if the primary provider does not implement searchByJobSpec —
 * caller should fall back to the legacy SERP-style multi-query path.
 *
 * If the primary provider supports it but throws or returns 0 results, we
 * report that explicitly so the caller can decide whether to invoke the
 * SERP fallback (typically yes — same behaviour as searchLinkedInProfilesWithMeta).
 */
export async function searchByJobSpecWithMeta(
  spec: import('./types').StructuredJobSearchSpec,
  maxResults: number = 100,
  geo?: SearchGeoContext,
): Promise<{
  results: ProfileSummary[];
  providerUsed: SearchProviderType;
  usedFallback: false;
  error?: string;
} | null> {
  const primaryType = getPrimaryProvider();
  const primary = getProvider(primaryType);

  if (!primary.searchByJobSpec) {
    return null;
  }

  try {
    const results = await primary.searchByJobSpec(spec, maxResults, geo);
    console.log(
      `[SearchProviders] ${primaryType} structured search returned ${results.length} results`,
    );
    return { results, providerUsed: primaryType, usedFallback: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[SearchProviders] ${primaryType} structured search failed:`, message);
    return {
      results: [],
      providerUsed: primaryType,
      usedFallback: false,
      error: message,
    };
  }
}
