/**
 * Additional Code Platform Enrichment Sources
 *
 * Discovers profiles for engineers on:
 * - LeetCode: Competitive programming
 * - GitLab: Alternative to GitHub
 * - DockerHub: Container maintainers
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, CandidateHints, QueryCandidate } from './types';
import { BaseEnrichmentSource } from './base-source';
import type { EnrichmentSearchResult } from './search-executor';
import { generateHandleVariants } from './handle-variants';

/**
 * LeetCode profile extraction
 */
function extractLeetCodeProfile(result: EnrichmentSearchResult) {
  // Title format: "username - LeetCode Profile"
  const titleParts = result.title.replace(/\s*[-·]\s*LeetCode.*$/i, '').split(' - ');
  const name = titleParts[0]?.trim() || null;

  // Extract ranking/rating
  let reputation: number | undefined;
  const ratingMatch = result.snippet?.match(/(?:rating|rank)[:\s]*(\d+)/i);
  if (ratingMatch) {
    reputation = parseInt(ratingMatch[1], 10);
  }

  // Extract problems solved
  let publicRepos: number | undefined;
  const solvedMatch = result.snippet?.match(/(\d+)\s*(?:problems?\s*solved|solved)/i);
  if (solvedMatch) {
    publicRepos = parseInt(solvedMatch[1], 10);
  }

  return {
    name,
    bio: result.snippet || null,
    company: null,
    location: null,
    followers: undefined,
    reputation,
    publicRepos,
    publications: undefined,
  };
}

/**
 * GitLab profile extraction
 */
function extractGitLabProfile(result: EnrichmentSearchResult) {
  // Title format: "Name (@username) · GitLab"
  let name: string | null = null;
  const nameMatch = result.title.match(/^([^(@]+?)(?:\s*\(@|\s*·)/);
  if (nameMatch) {
    name = nameMatch[1].trim();
  }

  // Extract project count
  let publicRepos: number | undefined;
  const projectsMatch = result.snippet?.match(/(\d+)\s*(?:projects?|repositories)/i);
  if (projectsMatch) {
    publicRepos = parseInt(projectsMatch[1], 10);
  }

  // Extract location
  let location: string | null = null;
  const locationMatch = result.snippet?.match(/(?:located in|from|based in)\s+([^.·]+)/i);
  if (locationMatch) {
    location = locationMatch[1].trim();
  }

  // Extract company/organization
  let company: string | null = null;
  const orgMatch = result.snippet?.match(/(?:works at|@)\s+([A-Z][A-Za-z0-9\s&]+)/i);
  if (orgMatch) {
    company = orgMatch[1].trim();
  }

  return {
    name,
    bio: result.snippet || null,
    company,
    location,
    followers: undefined,
    reputation: undefined,
    publicRepos,
    publications: undefined,
  };
}

/**
 * DockerHub profile extraction
 */
function extractDockerHubProfile(result: EnrichmentSearchResult) {
  // Title format: "username's Profile | Docker Hub"
  const titleParts = result.title.replace(/\s*[|·-]\s*Docker Hub.*$/i, '').split(' | ');
  let name = titleParts[0]?.trim() || null;

  // Remove "'s Profile" suffix
  if (name) {
    name = name.replace(/'s Profile$/i, '').trim();
  }

  // Extract image count
  let publicRepos: number | undefined;
  const imagesMatch = result.snippet?.match(/(\d+)\s*(?:images?|repositories)/i);
  if (imagesMatch) {
    publicRepos = parseInt(imagesMatch[1], 10);
  }

  // Extract pull count as reputation proxy
  let reputation: number | undefined;
  const pullsMatch = result.snippet?.match(/(\d+(?:,\d+)?[KkMm]?)\s*pulls?/i);
  if (pullsMatch) {
    const count = pullsMatch[1].replace(/,/g, '');
    if (count.toLowerCase().endsWith('k')) {
      reputation = parseFloat(count) * 1000;
    } else if (count.toLowerCase().endsWith('m')) {
      reputation = parseFloat(count) * 1000000;
    } else {
      reputation = parseInt(count, 10);
    }
  }

  return {
    name,
    bio: result.snippet || null,
    company: null,
    location: null,
    followers: undefined,
    reputation,
    publicRepos,
    publications: undefined,
  };
}

/**
 * LeetCode enrichment source
 */
export class LeetCodeSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'leetcode';
  readonly displayName = 'LeetCode';
  readonly supportedRoles: RoleType[] = ['engineer'];
  readonly baseWeight = 0.15;
  readonly queryPattern = 'site:leetcode.com "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractLeetCodeProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 3);

    // HANDLE_MODE: LeetCode URLs are handle-based: leetcode.com/u/username
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;

      // Map variant source to variantId
      let variantId = 'handle:clean';
      if (variant.source === 'derived') {
        if (!variant.handle.includes('-') && !variant.handle.includes('_')) {
          variantId = 'handle:collapsed';
        } else if (variant.handle.includes('_')) {
          variantId = 'handle:underscore';
        }
      }

      candidates.push({
        query: `site:leetcode.com/u/${variant.handle}`,
        mode: 'handle',
        variantId,
      });
    }

    // NAME_MODE: General search (lower recall for LeetCode)
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:leetcode.com "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

/**
 * GitLab enrichment source
 * Note: Has guard condition (handle_overlap_or_bio_link) - lower weight if no overlap with other platforms
 */
export class GitLabSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'gitlab';
  readonly displayName = 'GitLab';
  readonly supportedRoles: RoleType[] = ['engineer'];
  readonly baseWeight = 0.2;
  readonly queryPattern = 'site:gitlab.com/users "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractGitLabProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 3);

    // HANDLE_MODE: GitLab supports both direct path and /users/ path
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;

      // Direct path: gitlab.com/username
      candidates.push({
        query: `site:gitlab.com/${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'derived' ? 'handle:collapsed_direct' : 'handle:clean_direct',
      });

      // Users path: gitlab.com/users/username
      if (candidates.length < maxQueries) {
        candidates.push({
          query: `site:gitlab.com/users/${variant.handle}`,
          mode: 'handle',
          variantId: variant.source === 'derived' ? 'handle:collapsed_users' : 'handle:clean_users',
        });
      }
    }

    // NAME_MODE: Fallback to name search
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:gitlab.com "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    // NAME + COMPANY: Better precision
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:gitlab.com "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

/**
 * DockerHub enrichment source
 */
export class DockerHubSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'dockerhub';
  readonly displayName = 'Docker Hub';
  readonly supportedRoles: RoleType[] = ['engineer'];
  readonly baseWeight = 0.15;
  readonly queryPattern = 'site:hub.docker.com/u "{name}"';

  protected getSiteDomain(): string {
    return 'hub.docker.com/u';
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractDockerHubProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 2);

    // HANDLE_MODE: DockerHub URLs are handle-based: hub.docker.com/u/username
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;
      candidates.push({
        query: `site:hub.docker.com/u/${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'linkedinId' ? 'handle:clean' : 'handle:derived',
      });
    }

    // NAME_MODE: Name search scoped to user path
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:hub.docker.com/u "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full_scoped',
      });
    }

    // NAME_MODE: General Docker Hub search with name
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:hub.docker.com "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

// Export singleton instances
export const leetcodeSource = new LeetCodeSource();
export const gitlabSource = new GitLabSource();
export const dockerhubSource = new DockerHubSource();

export default {
  leetcodeSource,
  gitlabSource,
  dockerhubSource,
};
