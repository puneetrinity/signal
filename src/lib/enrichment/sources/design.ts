/**
 * Design Enrichment Sources
 *
 * Discovers profiles for designers:
 * - Dribbble: Design portfolio and shots
 * - Behance: Creative portfolio
 * - CodePen: Frontend/creative coding
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, CandidateHints, QueryCandidate } from './types';
import { BaseEnrichmentSource } from './base-source';
import type { EnrichmentSearchResult } from './search-executor';
import { generateHandleVariants } from './handle-variants';

/**
 * Dribbble profile extraction
 */
function extractDribbbleProfile(result: EnrichmentSearchResult) {
  // Title format: "Name on Dribbble" or "Name - Dribbble"
  const titleParts = result.title.replace(/\s*(?:on|[-·])\s*Dribbble.*$/i, '').split(' - ');
  const name = titleParts[0]?.trim() || null;

  // Extract follower count
  let followers: number | undefined;
  const followersMatch = result.snippet?.match(/(\d+(?:,\d+)?)\s*followers?/i);
  if (followersMatch) {
    followers = parseInt(followersMatch[1].replace(/,/g, ''), 10);
  }

  // Extract shot count
  let publicRepos: number | undefined;
  const shotsMatch = result.snippet?.match(/(\d+)\s*shots?/i);
  if (shotsMatch) {
    publicRepos = parseInt(shotsMatch[1], 10);
  }

  // Extract location
  let location: string | null = null;
  const locationMatch = result.snippet?.match(/(?:based in|located in|from)\s+([^.·]+)/i);
  if (locationMatch) {
    location = locationMatch[1].trim();
  }

  // Extract company/team
  let company: string | null = null;
  const companyMatch = result.snippet?.match(/(?:Designer at|works at)\s+([A-Z][A-Za-z0-9\s&]+)/i);
  if (companyMatch) {
    company = companyMatch[1].trim();
  }

  return {
    name,
    bio: result.snippet || null,
    company,
    location,
    followers,
    reputation: undefined,
    publicRepos,
    publications: undefined,
  };
}

/**
 * Behance profile extraction
 */
function extractBehanceProfile(result: EnrichmentSearchResult) {
  // Title format: "Name on Behance" or "Name - Behance"
  const titleParts = result.title.replace(/\s*(?:on|[-·])\s*Behance.*$/i, '').split(' - ');
  const name = titleParts[0]?.trim() || null;

  // Extract follower count
  let followers: number | undefined;
  const followersMatch = result.snippet?.match(/(\d+(?:,\d+)?)\s*followers?/i);
  if (followersMatch) {
    followers = parseInt(followersMatch[1].replace(/,/g, ''), 10);
  }

  // Extract project count
  let publicRepos: number | undefined;
  const projectsMatch = result.snippet?.match(/(\d+)\s*projects?/i);
  if (projectsMatch) {
    publicRepos = parseInt(projectsMatch[1], 10);
  }

  // Extract appreciations (Behance's like system)
  let reputation: number | undefined;
  const appreciationsMatch = result.snippet?.match(/(\d+(?:,\d+)?)\s*appreciations?/i);
  if (appreciationsMatch) {
    reputation = parseInt(appreciationsMatch[1].replace(/,/g, ''), 10);
  }

  // Extract location
  let location: string | null = null;
  const locationMatch = result.snippet?.match(/(?:based in|located in|from)\s+([^.·]+)/i);
  if (locationMatch) {
    location = locationMatch[1].trim();
  }

  return {
    name,
    bio: result.snippet || null,
    company: null,
    location,
    followers,
    reputation,
    publicRepos,
    publications: undefined,
  };
}

/**
 * CodePen profile extraction
 */
function extractCodePenProfile(result: EnrichmentSearchResult) {
  // Title format: "Username on CodePen" or "Name - CodePen"
  const titleParts = result.title.replace(/\s*(?:on|[-·])\s*CodePen.*$/i, '').split(' - ');
  const name = titleParts[0]?.trim() || null;

  // Extract follower count
  let followers: number | undefined;
  const followersMatch = result.snippet?.match(/(\d+(?:,\d+)?)\s*followers?/i);
  if (followersMatch) {
    followers = parseInt(followersMatch[1].replace(/,/g, ''), 10);
  }

  // Extract pen count
  let publicRepos: number | undefined;
  const pensMatch = result.snippet?.match(/(\d+)\s*(?:pens?|projects?)/i);
  if (pensMatch) {
    publicRepos = parseInt(pensMatch[1], 10);
  }

  return {
    name,
    bio: result.snippet || null,
    company: null,
    location: null,
    followers,
    reputation: undefined,
    publicRepos,
    publications: undefined,
  };
}

/**
 * Dribbble enrichment source
 */
export class DribbbleSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'dribbble';
  readonly displayName = 'Dribbble';
  readonly supportedRoles: RoleType[] = ['designer'];
  readonly baseWeight = 0.15;
  readonly queryPattern = 'site:dribbble.com "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractDribbbleProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 2);

    // HANDLE_MODE: Dribbble URLs are handle-based: dribbble.com/username
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;
      candidates.push({
        query: `site:dribbble.com/${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'linkedinId' ? 'handle:clean' : 'handle:derived',
      });
    }

    // NAME_MODE: Name-based search
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:dribbble.com "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    // NAME + LOCATION: Common for design portfolios
    if (hints.nameHint && hints.locationHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:dribbble.com "${hints.nameHint}" "${hints.locationHint}"`,
        mode: 'name',
        variantId: 'name+location',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

/**
 * Behance enrichment source
 */
export class BehanceSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'behance';
  readonly displayName = 'Behance';
  readonly supportedRoles: RoleType[] = ['designer'];
  readonly baseWeight = 0.15;
  readonly queryPattern = 'site:behance.net "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractBehanceProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 2);

    // HANDLE_MODE: Behance URLs are handle-based: behance.net/username
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;
      candidates.push({
        query: `site:behance.net/${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'linkedinId' ? 'handle:clean' : 'handle:derived',
      });
    }

    // NAME_MODE: Name-based search
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:behance.net "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

/**
 * CodePen enrichment source
 */
export class CodePenSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'codepen';
  readonly displayName = 'CodePen';
  readonly supportedRoles: RoleType[] = ['designer', 'engineer'];
  readonly baseWeight = 0.15;
  readonly queryPattern = 'site:codepen.io "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractCodePenProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 2);

    // HANDLE_MODE: CodePen URLs are handle-based: codepen.io/username
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;
      candidates.push({
        query: `site:codepen.io/${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'linkedinId' ? 'handle:clean' : 'handle:derived',
      });
    }

    // NAME_MODE: Name-based search
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:codepen.io "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

// Export singleton instances
export const dribbbleSource = new DribbbleSource();
export const behanceSource = new BehanceSource();
export const codepenSource = new CodePenSource();

export default {
  dribbbleSource,
  behanceSource,
  codepenSource,
};
