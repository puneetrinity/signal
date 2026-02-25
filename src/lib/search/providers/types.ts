/**
 * Search Provider Abstraction Types
 *
 * Common interfaces for all search providers (Serper, Brave; legacy: BrightData, SearXNG).
 * This abstraction allows switching providers via environment variables
 * while maintaining identical return types.
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 4
 */

import type { ProfileSummary } from '@/types/linkedin';

/**
 * Supported search providers
 */
export type SearchProviderType = 'serper' | 'brave' | 'brightdata' | 'searxng'; // legacy: brightdata, searxng

/**
 * Raw search result from any provider (normalized)
 */
export interface RawSearchResult {
  url: string;
  title: string;
  snippet: string;
  position: number;
  score?: number;
  engines?: string[]; // legacy SearXNG only
  providerMeta?: Record<string, unknown>;
}

/**
 * Search provider configuration
 */
export interface SearchProviderConfig {
  timeout?: number;
  maxResults?: number;
}

/**
 * Optional geo-targeting context forwarded to providers.
 */
export interface SearchGeoContext {
  /**
   * Optional 2-letter country code (ISO-3166 alpha-2), e.g. "IN", "US".
   */
  countryCode?: string | null;
  /**
   * Optional free-form location text, e.g. "Hyderabad, Telangana, India".
   */
  locationText?: string | null;
  /**
   * Optional Serper-compatible time filter, e.g. "qdr:y2" (last 2 years).
   */
  tbs?: string | null;
}

/**
 * Search provider interface
 *
 * All providers must implement this interface to be interchangeable.
 */
export interface SearchProvider {
  /**
   * Provider name for logging/debugging
   */
  readonly name: SearchProviderType;

  /**
   * Execute a LinkedIn profile search
   *
   * @param query - Search query (already formatted with site:linkedin.com/in)
   * @param maxResults - Maximum number of results to return
   * @param countryCode - Optional 2-letter country code for geo-targeting
   * @returns Array of profile summaries
   */
  searchLinkedInProfiles(
    query: string,
    maxResults?: number,
    countryCode?: string | null,
    geo?: SearchGeoContext
  ): Promise<ProfileSummary[]>;

  /**
   * Execute a raw search (not LinkedIn-specific)
   *
   * @param query - Raw search query
   * @param maxResults - Maximum number of results
   * @returns Array of raw search results
   */
  searchRaw(query: string, maxResults?: number): Promise<RawSearchResult[]>;

  /**
   * Check if the provider is healthy/available
   */
  healthCheck(): Promise<{
    healthy: boolean;
    latency?: number;
    error?: string;
  }>;
}

/**
 * Search result with provider metadata
 */
export interface SearchResultWithMeta extends ProfileSummary {
  provider: SearchProviderType;
  engines?: string[];
  rawScore?: number;
}

/**
 * Provider factory options
 */
export interface ProviderFactoryOptions {
  primary: SearchProviderType;
  fallback?: SearchProviderType;
  timeout?: number;
}
