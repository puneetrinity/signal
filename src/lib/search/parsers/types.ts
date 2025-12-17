/**
 * Parser Provider Abstraction Types
 *
 * Common interfaces for query parsers (Gemini, Groq).
 * This abstraction allows switching parsers via environment variables.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

/**
 * Supported parser providers
 */
export type ParserProviderType = 'gemini' | 'groq';

/**
 * Parsed search query structure
 *
 * This is the canonical output format for all parsers.
 * Must remain backward-compatible with existing code.
 */
export interface ParsedSearchQuery {
  /** Number of profiles to find (1-50) */
  count: number;

  /** Job title or role (null for individual name searches) */
  role: string | null;

  /** Location or region (can also be company name) */
  location?: string | null;

  /** 2-letter ISO country code (only for geographic locations) */
  countryCode?: string | null;

  /** Additional keywords or qualifications */
  keywords: string[];

  /** Optimized search query for LinkedIn discovery */
  searchQuery: string;

  /** @deprecated Use searchQuery instead */
  googleQuery?: string;

  /** Optional: Role type classification for v2 enrichment */
  roleType?: 'engineer' | 'data_scientist' | 'researcher' | 'founder' | 'designer' | 'general';

  /** Optional: Additional discovery queries for v2 */
  linkedinDiscoveryQueries?: string[];

  /** Optional: Suggested enrichment sources for v2 */
  enrichmentSources?: string[];
}

/**
 * Parser provider interface
 *
 * All parsers must implement this interface to be interchangeable.
 */
export interface ParserProvider {
  /**
   * Provider name for logging/debugging
   */
  readonly name: ParserProviderType;

  /**
   * Parse a natural language query into structured data
   *
   * @param query - Natural language query (e.g., "5 AI Engineers in Israel")
   * @returns Structured search query
   */
  parseSearchQuery(query: string): Promise<ParsedSearchQuery>;
}
