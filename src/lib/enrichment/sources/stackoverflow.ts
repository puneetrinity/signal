/**
 * Stack Overflow Enrichment Source
 *
 * Discovers Stack Overflow profiles for engineers and developers.
 * Uses search to find profiles, then extracts reputation and activity metrics.
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, CandidateHints, QueryCandidate } from './types';
import { BaseEnrichmentSource } from './base-source';
import type { EnrichmentSearchResult } from './search-executor';

/**
 * Stack Overflow specific profile extraction
 */
function extractStackOverflowProfile(result: EnrichmentSearchResult) {
  // Title format: "User Name - Stack Overflow" or "User Name - Stack Exchange"
  const titleParts = result.title.replace(/ - Stack (Overflow|Exchange).*$/i, '').split(' - ');
  const name = titleParts[0]?.trim() || null;

  // Extract reputation from snippet if available
  // Common patterns: "123 reputation", "123k reputation", "gold badges", etc.
  let reputation: number | undefined;
  const repMatch = result.snippet?.match(/(\d+(?:,\d+)?(?:\.\d+)?k?)\s*reputation/i);
  if (repMatch) {
    const repStr = repMatch[1].replace(/,/g, '');
    if (repStr.endsWith('k')) {
      reputation = parseFloat(repStr) * 1000;
    } else {
      reputation = parseInt(repStr, 10);
    }
  }

  // Extract location from snippet
  let location: string | null = null;
  const locationMatch = result.snippet?.match(/(?:located in|from|based in)\s+([^.·]+)/i);
  if (locationMatch) {
    location = locationMatch[1].trim();
  }

  // Extract bio/about from snippet
  const bio = result.snippet || null;

  return {
    name,
    bio,
    company: null,
    location,
    reputation,
    followers: undefined,
    publicRepos: undefined,
    publications: undefined,
  };
}

/**
 * Stack Overflow enrichment source
 */
export class StackOverflowSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'stackoverflow';
  readonly displayName = 'Stack Overflow';
  readonly supportedRoles: RoleType[] = ['engineer', 'data_scientist', 'general'];
  readonly baseWeight = 0.15;
  readonly queryPattern = 'site:stackoverflow.com/users "{name}"';

  protected getSiteDomain(): string {
    return 'stackoverflow.com/users';
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractStackOverflowProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];

    // Primary: Full name search (name-based platform)
    if (hints.nameHint) {
      candidates.push({
        query: `site:stackoverflow.com/users "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    // Secondary: Name + company
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:stackoverflow.com/users "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    // Tertiary: Name + location
    if (hints.nameHint && hints.locationHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:stackoverflow.com/users "${hints.nameHint}" "${hints.locationHint}"`,
        mode: 'name',
        variantId: 'name+location',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

// Export singleton instance
export const stackOverflowSource = new StackOverflowSource();
export default stackOverflowSource;
