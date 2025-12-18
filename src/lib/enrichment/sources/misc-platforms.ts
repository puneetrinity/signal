/**
 * Miscellaneous Platform Sources
 *
 * Additional enrichment sources for:
 * - HackerEarth (competitive programming)
 * - Gist (GitHub Gists)
 * - OpenReview (ML/AI conference papers)
 * - University (academic profiles)
 * - CompanyTeam (company team pages)
 * - AngelList (startup profiles)
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, CandidateHints, QueryCandidate } from './types';
import { BaseEnrichmentSource } from './base-source';
import type { EnrichmentSearchResult } from './search-executor';
import { generateHandleVariants } from './handle-variants';

/**
 * HackerEarth Source
 * Competitive programming and hiring platform
 */
class HackerEarthSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'hackerearth';
  readonly displayName = 'HackerEarth';
  readonly supportedRoles: RoleType[] = ['engineer'];
  readonly baseWeight = 0.15;
  readonly queryPattern = 'site:hackerearth.com/@{name}';

  protected getSiteDomain(): string {
    return 'hackerearth.com';
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 2);

    // HANDLE_MODE: HackerEarth URLs are handle-based: hackerearth.com/@username
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;
      candidates.push({
        query: `site:hackerearth.com/@${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'linkedinId' ? 'handle:clean' : 'handle:derived',
      });
    }

    // NAME_MODE: Name search
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:hackerearth.com "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    // NAME + COMPANY
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:hackerearth.com "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    return candidates.slice(0, maxQueries);
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    // HackerEarth URLs: hackerearth.com/@username
    const titleParts = result.title.split(' | ');
    const name = titleParts[0]?.replace(' - HackerEarth', '').trim() || null;

    // Extract ranking/score from snippet
    let reputation: number | undefined;
    const rankMatch = result.snippet?.match(/rank[:\s]+(\d+)/i);
    if (rankMatch) {
      reputation = parseInt(rankMatch[1], 10);
    }

    return {
      name,
      bio: result.snippet || null,
      company: null,
      location: null,
      reputation,
    };
  }
}

/**
 * GitHub Gist Source
 * Public code snippets and notes
 */
class GistSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'gist';
  readonly displayName = 'GitHub Gist';
  readonly supportedRoles: RoleType[] = ['engineer', 'data_scientist'];
  readonly baseWeight = 0.1;
  readonly queryPattern = 'site:gist.github.com "{name}"';

  protected getSiteDomain(): string {
    return 'gist.github.com';
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 2);

    // HANDLE_MODE: Gist URLs are handle-based: gist.github.com/username
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;
      candidates.push({
        query: `site:gist.github.com/${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'linkedinId' ? 'handle:clean' : 'handle:derived',
      });
    }

    // NAME_MODE: Search for gists by name
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:gist.github.com "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    // NAME + COMPANY
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:gist.github.com "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    return candidates.slice(0, maxQueries);
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    // Gist URLs: gist.github.com/username/gistid or gist.github.com/username
    const urlParts = result.url.split('/');
    const usernameIndex = urlParts.indexOf('gist.github.com') + 1;
    const username = urlParts[usernameIndex] || null;

    // Extract name from title
    const name = result.title.split(' · ')[0]?.trim() || username;

    return {
      name,
      bio: result.snippet || null,
      company: null,
      location: null,
    };
  }
}

/**
 * OpenReview Source
 * ML/AI conference paper reviews (NeurIPS, ICLR, etc.)
 */
class OpenReviewSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'openreview';
  readonly displayName = 'OpenReview';
  readonly supportedRoles: RoleType[] = ['researcher', 'data_scientist'];
  readonly baseWeight = 0.3;
  readonly queryPattern = 'site:openreview.net "{name}"';

  protected getSiteDomain(): string {
    return 'openreview.net';
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];

    // NAME_MODE: Author profile search
    if (hints.nameHint) {
      candidates.push({
        query: `site:openreview.net/profile "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:profile',
      });
    }

    // NAME_MODE: Paper author search
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:openreview.net "${hints.nameHint}" author`,
        mode: 'name',
        variantId: 'name:author',
      });
    }

    // NAME + INSTITUTION
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:openreview.net "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    return candidates.slice(0, maxQueries);
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    // OpenReview URLs: openreview.net/profile?id=~Name_Surname1
    const titleParts = result.title.split(' | ');
    let name = titleParts[0]?.replace(' - OpenReview', '').trim() || null;

    // Extract publications count from snippet
    let publications: number | undefined;
    const pubMatch = result.snippet?.match(/(\d+)\s*(?:papers?|publications?)/i);
    if (pubMatch) {
      publications = parseInt(pubMatch[1], 10);
    }

    // Extract institution from snippet
    let company: string | null = null;
    const instMatch = result.snippet?.match(/(?:at|from|@)\s*([A-Z][A-Za-z\s&]+?)(?:[,.|]|$)/);
    if (instMatch) {
      company = instMatch[1].trim();
    }

    // Clean up profile ID in name
    if (name?.startsWith('~')) {
      name = name.substring(1).replace(/_/g, ' ').replace(/\d+$/, '').trim();
    }

    return {
      name,
      bio: result.snippet || null,
      company,
      location: null,
      publications,
    };
  }
}

/**
 * University Source
 * Academic faculty/researcher profiles
 */
class UniversitySource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'university';
  readonly displayName = 'University Profile';
  readonly supportedRoles: RoleType[] = ['researcher'];
  readonly baseWeight = 0.35;
  readonly queryPattern = '"{name}" site:edu OR site:ac.uk professor OR faculty OR researcher';

  protected getSiteDomain(): string {
    return 'edu'; // Not a real domain, used for query pattern
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];

    // NAME_MODE: Faculty search across .edu and .ac.uk domains
    if (hints.nameHint) {
      candidates.push({
        query: `"${hints.nameHint}" (site:edu OR site:ac.uk)`,
        mode: 'name',
        variantId: 'name:edu',
      });
    }

    // NAME + INSTITUTION
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `"${hints.nameHint}" (site:edu OR site:ac.uk) "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name:edu+company',
      });
    }

    // NAME + LOCATION
    if (hints.nameHint && hints.locationHint && candidates.length < maxQueries) {
      candidates.push({
        query: `"${hints.nameHint}" (site:edu OR site:ac.uk) "${hints.locationHint}"`,
        mode: 'name',
        variantId: 'name:edu+location',
      });
    }

    return candidates.slice(0, maxQueries);
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    // Extract name from title
    const titleParts = result.title.split(' - ');
    const name = titleParts[0]?.trim() || null;

    // Try to extract institution from URL
    let company: string | null = null;
    const eduMatch = result.url.match(/https?:\/\/(?:www\.)?([^.]+)\.(?:edu|ac\.uk)/);
    if (eduMatch) {
      // Capitalize first letter of institution name
      company = eduMatch[1].charAt(0).toUpperCase() + eduMatch[1].slice(1);
    }

    // Extract department/title from snippet
    let bio = result.snippet || null;
    const deptMatch = result.snippet?.match(/(?:department|dept\.?)\s+(?:of\s+)?([A-Za-z\s&]+)/i);
    if (deptMatch) {
      bio = `${deptMatch[0]} - ${result.snippet}`;
    }

    return {
      name,
      bio,
      company,
      location: null,
      publications: undefined,
    };
  }
}

/**
 * Company Team Page Source
 * Team/about pages on company websites
 */
class CompanyTeamSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'companyteam';
  readonly displayName = 'Company Team Page';
  readonly supportedRoles: RoleType[] = ['founder', 'general'];
  readonly baseWeight = 0.4;
  readonly queryPattern = '"{company}" /team OR /about "{name}"';

  protected getSiteDomain(): string {
    return ''; // No specific domain - searches company sites
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];

    // NAME + COMPANY: Team page search with company domain guess
    if (hints.nameHint && hints.companyHint) {
      const companyDomain = hints.companyHint
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .substring(0, 20);

      candidates.push({
        query: `"${hints.nameHint}" site:${companyDomain}.com (team OR about OR leadership)`,
        mode: 'name',
        variantId: 'name:company_domain_guess',
      });
    }

    // NAME + COMPANY: General team page search
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `"${hints.nameHint}" "${hints.companyHint}" (team page OR about us OR leadership)`,
        mode: 'name',
        variantId: 'name+company_team',
      });
    }

    // NAME + COMPANY (founder-specific): Executive search
    if (hints.nameHint && hints.companyHint && hints.roleType === 'founder' && candidates.length < maxQueries) {
      candidates.push({
        query: `"${hints.nameHint}" "${hints.companyHint}" (CEO OR CTO OR founder OR co-founder)`,
        mode: 'name',
        variantId: 'name+company_exec',
      });
    }

    return candidates.slice(0, maxQueries);
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    // Extract name from title (often "Name - Company" or "Name | Title at Company")
    const titleParts = result.title.split(/\s*[-|]\s*/);
    const name = titleParts[0]?.trim() || null;

    // Try to extract company from URL or title
    let company: string | null = null;
    const domainMatch = result.url.match(/https?:\/\/(?:www\.)?([^./]+)\./);
    if (domainMatch) {
      company = domainMatch[1].charAt(0).toUpperCase() + domainMatch[1].slice(1);
    }

    // Extract role/title from snippet
    let bio = result.snippet || null;
    const roleMatch = result.snippet?.match(/(CEO|CTO|founder|co-founder|VP|director|head of)[^.]*\./i);
    if (roleMatch) {
      bio = roleMatch[0];
    }

    return {
      name,
      bio,
      company,
      location: null,
    };
  }
}

/**
 * AngelList Source
 * Startup and investor profiles
 */
class AngelListSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'angellist';
  readonly displayName = 'AngelList';
  readonly supportedRoles: RoleType[] = ['founder'];
  readonly baseWeight = 0.3;
  readonly queryPattern = 'site:angel.co "{name}"';

  protected getSiteDomain(): string {
    return 'angel.co';
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 2);

    // HANDLE_MODE: AngelList is handle-heavy: angel.co/u/username
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;
      candidates.push({
        query: `site:angel.co/u/${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'linkedinId' ? 'handle:clean_user_path' : 'handle:derived',
      });
    }

    // NAME_MODE: Name-based search
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:angel.co "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    // NAME + COMPANY
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:angel.co "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    return candidates.slice(0, maxQueries);
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    // AngelList URLs: angel.co/u/username or angel.co/p/username
    const urlMatch = result.url.match(/angel\.co\/(?:u|p)\/([^/?]+)/);
    const username = urlMatch ? urlMatch[1] : null;

    // Extract name from title
    const titleParts = result.title.split(' - ');
    const name = titleParts[0]?.replace(' | AngelList', '').trim() || null;

    // Extract company from title or snippet
    let company: string | null = null;
    const companyMatch = result.title.match(/(?:at|@)\s+([A-Za-z0-9\s&]+)/);
    if (companyMatch) {
      company = companyMatch[1].trim();
    }

    // Extract role from snippet
    let bio = result.snippet || null;
    const roleMatch = result.snippet?.match(/(founder|ceo|cto|investor)[^.]*\./i);
    if (roleMatch) {
      bio = roleMatch[0];
    }

    // Extract followers if mentioned
    let followers: number | undefined;
    const followMatch = result.snippet?.match(/(\d+(?:,\d+)?)\s*followers?/i);
    if (followMatch) {
      followers = parseInt(followMatch[1].replace(/,/g, ''), 10);
    }

    return {
      name,
      bio,
      company,
      location: null,
      followers,
    };
  }
}

// Export source instances
export const hackerEarthSource = new HackerEarthSource();
export const gistSource = new GistSource();
export const openReviewSource = new OpenReviewSource();
export const universitySource = new UniversitySource();
export const companyTeamSource = new CompanyTeamSource();
export const angelListSource = new AngelListSource();
