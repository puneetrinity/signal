/**
 * npm and PyPI Enrichment Sources
 *
 * Discovers package maintainer profiles for JavaScript/TypeScript and Python engineers.
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, CandidateHints } from './types';
import { BaseEnrichmentSource } from './base-source';
import type { EnrichmentSearchResult } from './search-executor';

/**
 * npm profile extraction
 */
function extractNpmProfile(result: EnrichmentSearchResult) {
  // Title format: "~username - npm" or "package-name - npm"
  const titleParts = result.title.replace(/ - npm$/i, '').split(' - ');
  let name = titleParts[0]?.trim() || null;

  // Remove ~ prefix if present
  if (name?.startsWith('~')) {
    name = name.slice(1);
  }

  // Extract package count from snippet
  let publicRepos: number | undefined;
  const packagesMatch = result.snippet?.match(/(\d+)\s*packages?/i);
  if (packagesMatch) {
    publicRepos = parseInt(packagesMatch[1], 10);
  }

  return {
    name,
    bio: result.snippet || null,
    company: null,
    location: null,
    followers: undefined,
    reputation: undefined,
    publicRepos,
    publications: undefined,
  };
}

/**
 * PyPI profile extraction
 */
function extractPyPIProfile(result: EnrichmentSearchResult) {
  // Title format: "username · PyPI" or "package-name · PyPI"
  const titleParts = result.title.replace(/\s*[·-]\s*PyPI$/i, '').split(' · ');
  const name = titleParts[0]?.trim() || null;

  // Extract maintainer info from snippet
  let publicRepos: number | undefined;
  const packagesMatch = result.snippet?.match(/(\d+)\s*(?:packages?|projects?)/i);
  if (packagesMatch) {
    publicRepos = parseInt(packagesMatch[1], 10);
  }

  return {
    name,
    bio: result.snippet || null,
    company: null,
    location: null,
    followers: undefined,
    reputation: undefined,
    publicRepos,
    publications: undefined,
  };
}

/**
 * npm enrichment source
 */
export class NpmSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'npm';
  readonly displayName = 'npm';
  readonly supportedRoles: RoleType[] = ['engineer'];
  readonly baseWeight = 0.2;
  readonly queryPattern = 'site:npmjs.com "~{name}" author';

  protected getSiteDomain(): string {
    return 'npmjs.com/~';
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractNpmProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    const queries: string[] = [];

    // Primary: Author profile search
    if (hints.nameHint) {
      queries.push(`site:npmjs.com/~ "${hints.nameHint}"`);
    }

    // Secondary: Package author search
    if (hints.nameHint && queries.length < maxQueries) {
      queries.push(`site:npmjs.com "${hints.nameHint}" author maintainer`);
    }

    return queries.slice(0, maxQueries);
  }
}

/**
 * PyPI enrichment source
 */
export class PyPISource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'pypi';
  readonly displayName = 'PyPI';
  readonly supportedRoles: RoleType[] = ['engineer', 'data_scientist'];
  readonly baseWeight = 0.2;
  readonly queryPattern = 'site:pypi.org "{name}" maintainer';

  protected getSiteDomain(): string {
    return 'pypi.org/user';
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractPyPIProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    const queries: string[] = [];

    // Primary: User profile search
    if (hints.nameHint) {
      queries.push(`site:pypi.org/user "${hints.nameHint}"`);
    }

    // Secondary: Package maintainer search
    if (hints.nameHint && queries.length < maxQueries) {
      queries.push(`site:pypi.org "${hints.nameHint}" maintainer author`);
    }

    return queries.slice(0, maxQueries);
  }
}

// Export singleton instances
export const npmSource = new NpmSource();
export const pypiSource = new PyPISource();
export default { npmSource, pypiSource };
