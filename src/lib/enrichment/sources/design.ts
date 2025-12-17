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
import type { EnrichmentPlatform, CandidateHints } from './types';
import { BaseEnrichmentSource } from './base-source';
import type { EnrichmentSearchResult } from './search-executor';

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
