/**
 * Content & Founder Enrichment Sources
 *
 * Discovers profiles for founders and thought leaders:
 * - Medium: Blog posts and publications
 * - Dev.to: Developer blog posts
 * - Twitter/X: Social presence
 * - YouTube: Video content
 * - Substack: Newsletter authors
 * - Crunchbase: Founder/executive profiles
 * - SEC: Officer/director filings
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, CandidateHints, QueryCandidate } from './types';
import { BaseEnrichmentSource } from './base-source';
import type { EnrichmentSearchResult } from './search-executor';
import { generateHandleVariants } from './handle-variants';

/**
 * Medium profile extraction
 */
function extractMediumProfile(result: EnrichmentSearchResult) {
  // Title format: "Name – Medium" or "@username – Medium"
  const titleParts = result.title.replace(/\s*[–·-]\s*Medium.*$/i, '').split(' – ');
  let name = titleParts[0]?.trim() || null;

  // Remove @ prefix
  if (name?.startsWith('@')) {
    name = name.slice(1);
  }

  // Extract follower count
  let followers: number | undefined;
  const followersMatch = result.snippet?.match(/(\d+(?:\.\d+)?[KkMm]?)\s*(?:followers?)/i);
  if (followersMatch) {
    const count = followersMatch[1];
    if (count.toLowerCase().endsWith('k')) {
      followers = parseFloat(count) * 1000;
    } else if (count.toLowerCase().endsWith('m')) {
      followers = parseFloat(count) * 1000000;
    } else {
      followers = parseInt(count, 10);
    }
  }

  return {
    name,
    bio: result.snippet || null,
    company: null,
    location: null,
    followers,
    reputation: undefined,
    publicRepos: undefined,
    publications: undefined,
  };
}

/**
 * Dev.to profile extraction
 */
function extractDevtoProfile(result: EnrichmentSearchResult) {
  // Title format: "Name - DEV Community"
  const titleParts = result.title.replace(/\s*[-·]\s*DEV.*$/i, '').split(' - ');
  const name = titleParts[0]?.trim() || null;

  // Extract followers
  let followers: number | undefined;
  const followersMatch = result.snippet?.match(/(\d+(?:,\d+)?)\s*followers?/i);
  if (followersMatch) {
    followers = parseInt(followersMatch[1].replace(/,/g, ''), 10);
  }

  // Extract post count
  let publicRepos: number | undefined;
  const postsMatch = result.snippet?.match(/(\d+)\s*(?:posts?|articles?)/i);
  if (postsMatch) {
    publicRepos = parseInt(postsMatch[1], 10);
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
 * Twitter/X profile extraction
 */
function extractTwitterProfile(result: EnrichmentSearchResult) {
  // Title format: "Name (@handle) / X" or "@handle / X"
  let name: string | null = null;
  const nameMatch = result.title.match(/^([^(@]+?)(?:\s*\(@|\s*\/\s*X)/);
  if (nameMatch) {
    name = nameMatch[1].trim();
  }

  // Extract followers
  let followers: number | undefined;
  const followersMatch = result.snippet?.match(/(\d+(?:\.\d+)?[KkMm]?)\s*(?:followers?)/i);
  if (followersMatch) {
    const count = followersMatch[1];
    if (count.toLowerCase().endsWith('k')) {
      followers = parseFloat(count) * 1000;
    } else if (count.toLowerCase().endsWith('m')) {
      followers = parseFloat(count) * 1000000;
    } else {
      followers = parseInt(count, 10);
    }
  }

  // Extract location from bio
  let location: string | null = null;
  const locationMatch = result.snippet?.match(/📍\s*([^·]+)/);
  if (locationMatch) {
    location = locationMatch[1].trim();
  }

  return {
    name,
    bio: result.snippet || null,
    company: null,
    location,
    followers,
    reputation: undefined,
    publicRepos: undefined,
    publications: undefined,
  };
}

/**
 * YouTube profile extraction
 */
function extractYouTubeProfile(result: EnrichmentSearchResult) {
  // Title format: "Channel Name - YouTube"
  const titleParts = result.title.replace(/\s*[-·]\s*YouTube.*$/i, '').split(' - ');
  const name = titleParts[0]?.trim() || null;

  // Extract subscriber count
  let followers: number | undefined;
  const subsMatch = result.snippet?.match(/(\d+(?:\.\d+)?[KkMm]?)\s*subscribers?/i);
  if (subsMatch) {
    const count = subsMatch[1];
    if (count.toLowerCase().endsWith('k')) {
      followers = parseFloat(count) * 1000;
    } else if (count.toLowerCase().endsWith('m')) {
      followers = parseFloat(count) * 1000000;
    } else {
      followers = parseInt(count, 10);
    }
  }

  // Extract video count
  let publicRepos: number | undefined;
  const videosMatch = result.snippet?.match(/(\d+)\s*videos?/i);
  if (videosMatch) {
    publicRepos = parseInt(videosMatch[1], 10);
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
 * Crunchbase profile extraction
 */
function extractCrunchbaseProfile(result: EnrichmentSearchResult) {
  // Title format: "Name - Crunchbase Person Profile"
  const titleParts = result.title.replace(/\s*[-·]\s*Crunchbase.*$/i, '').split(' - ');
  const name = titleParts[0]?.trim() || null;

  // Extract company
  let company: string | null = null;
  const companyMatch = result.snippet?.match(/(?:Founder|CEO|CTO|COO|CFO|President|VP|Director)\s+(?:at|of)\s+([A-Z][A-Za-z0-9\s&]+)/i);
  if (companyMatch) {
    company = companyMatch[1].trim();
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
    company,
    location,
    followers: undefined,
    reputation: undefined,
    publicRepos: undefined,
    publications: undefined,
  };
}

/**
 * SEC EDGAR profile extraction
 */
function extractSECProfile(result: EnrichmentSearchResult) {
  // SEC results are filing-based
  const name = result.title?.split(' - ')[0]?.trim() || null;

  // Extract company from filing
  let company: string | null = null;
  const companyMatch = result.snippet?.match(/(?:officer|director)\s+(?:of|at)\s+([A-Z][A-Za-z0-9\s&,]+?)(?:\s*[·|,.]|$)/i);
  if (companyMatch) {
    company = companyMatch[1].trim();
  }

  return {
    name,
    bio: result.snippet || null,
    company,
    location: null,
    followers: undefined,
    reputation: undefined,
    publicRepos: undefined,
    publications: undefined,
  };
}

/**
 * Medium enrichment source
 *
 * Medium uses @username handles but discovery is often name/content-based.
 * Uses both HANDLE_MODE and NAME_MODE for maximum recall.
 */
export class MediumSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'medium';
  readonly displayName = 'Medium';
  readonly supportedRoles: RoleType[] = ['founder', 'general'];
  readonly baseWeight = 0.15;
  readonly queryPattern = 'site:medium.com "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractMediumProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 2);

    // HANDLE_MODE: Try linkedinId variants as handle hypothesis
    // Many people's Medium handle ≠ LinkedIn slug, so this is low-confidence
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;
      candidates.push({
        query: `site:medium.com/@${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'linkedinId' ? 'handle:clean' : 'handle:collapsed',
      });
    }

    // NAME_MODE: This is the dominant discovery path for Medium
    // Content authors are found by name, not handle
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:medium.com "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    // NAME + COMPANY: Better precision for common names
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:medium.com "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

/**
 * Dev.to enrichment source
 */
export class DevtoSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'devto';
  readonly displayName = 'Dev.to';
  readonly supportedRoles: RoleType[] = ['engineer'];
  readonly baseWeight = 0.15;
  readonly queryPattern = 'site:dev.to "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractDevtoProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 2);

    // HANDLE_MODE: Dev.to URLs are handle-based: dev.to/username
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;
      candidates.push({
        query: `site:dev.to/${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'linkedinId' ? 'handle:clean' : 'handle:derived',
      });
    }

    // NAME_MODE: Name-based search
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:dev.to "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

/**
 * Twitter/X enrichment source
 * Note: Requires guard (bio_link_or_multi_platform) for confidence
 */
export class TwitterSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'twitter';
  readonly displayName = 'Twitter/X';
  readonly supportedRoles: RoleType[] = ['founder', 'general'];
  readonly baseWeight = 0.15;
  readonly queryPattern = 'site:twitter.com "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractTwitterProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];

    // NAME + COMPANY: Twitter search is noisy, be more specific
    if (hints.nameHint && hints.companyHint) {
      candidates.push({
        query: `site:twitter.com "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    // NAME + TITLE: Extract job title from headline
    if (hints.nameHint && hints.headlineHint && candidates.length < maxQueries) {
      const titleMatch = hints.headlineHint.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
      if (titleMatch) {
        candidates.push({
          query: `site:twitter.com "${hints.nameHint}" "${titleMatch[1]}"`,
          mode: 'name',
          variantId: 'name+headline_title',
        });
      }
    }

    // NAME_MODE: Fallback (less reliable)
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:twitter.com "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

/**
 * YouTube enrichment source
 */
export class YouTubeSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'youtube';
  readonly displayName = 'YouTube';
  readonly supportedRoles: RoleType[] = ['founder', 'researcher'];
  readonly baseWeight = 0.2;
  readonly queryPattern = 'site:youtube.com "{name}" talk';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractYouTubeProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];

    // NAME_MODE: Search for channel with @ handle pattern
    if (hints.nameHint) {
      candidates.push({
        query: `site:youtube.com/@ "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full_at_handle_guess',
      });
    }

    // NAME_MODE: Search for talks/interviews
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:youtube.com "${hints.nameHint}" talk interview`,
        mode: 'name',
        variantId: 'name:talks',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

/**
 * Substack enrichment source
 */
export class SubstackSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'substack';
  readonly displayName = 'Substack';
  readonly supportedRoles: RoleType[] = ['founder', 'general'];
  readonly baseWeight = 0.15;
  readonly queryPattern = 'site:substack.com "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    // Title format: "Newsletter Name | Substack"
    const titleParts = result.title.replace(/\s*[|·-]\s*Substack.*$/i, '').split(' | ');
    const name = titleParts[0]?.trim() || null;

    // Extract subscriber count
    let followers: number | undefined;
    const subsMatch = result.snippet?.match(/(\d+(?:,\d+)?)\s*subscribers?/i);
    if (subsMatch) {
      followers = parseInt(subsMatch[1].replace(/,/g, ''), 10);
    }

    return {
      name,
      bio: result.snippet || null,
      company: null,
      location: null,
      followers,
      reputation: undefined,
      publicRepos: undefined,
      publications: undefined,
    };
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];

    // NAME_MODE: Full name search
    if (hints.nameHint) {
      candidates.push({
        query: `site:substack.com "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    // NAME + COMPANY
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:substack.com "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

/**
 * Crunchbase enrichment source
 */
export class CrunchbaseSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'crunchbase';
  readonly displayName = 'Crunchbase';
  readonly supportedRoles: RoleType[] = ['founder'];
  readonly baseWeight = 0.3;
  readonly queryPattern = 'site:crunchbase.com/person "{name}"';

  protected getSiteDomain(): string {
    return 'crunchbase.com/person';
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractCrunchbaseProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];

    // NAME_MODE: Full name search on person profiles
    if (hints.nameHint) {
      candidates.push({
        query: `site:crunchbase.com/person "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    // NAME + COMPANY: Better precision for founders
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:crunchbase.com "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

/**
 * SEC EDGAR enrichment source (official filings)
 */
export class SECSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'sec';
  readonly displayName = 'SEC EDGAR';
  readonly supportedRoles: RoleType[] = ['founder'];
  readonly baseWeight = 0.5; // High weight - official government records
  readonly queryPattern = 'site:sec.gov "{name}" officer director';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractSECProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];

    // NAME + COMPANY: SEC search with company context
    if (hints.nameHint && hints.companyHint) {
      candidates.push({
        query: `site:sec.gov "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    // NAME_MODE: SEC search with just name
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:sec.gov "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

// Export singleton instances
export const mediumSource = new MediumSource();
export const devtoSource = new DevtoSource();
export const twitterSource = new TwitterSource();
export const youtubeSource = new YouTubeSource();
export const substackSource = new SubstackSource();
export const crunchbaseSource = new CrunchbaseSource();
export const secSource = new SECSource();

export default {
  mediumSource,
  devtoSource,
  twitterSource,
  youtubeSource,
  substackSource,
  crunchbaseSource,
  secSource,
};
