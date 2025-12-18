/**
 * npm and PyPI Enrichment Sources
 *
 * Discovers package maintainer profiles for JavaScript/TypeScript and Python engineers.
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, CandidateHints, QueryCandidate } from './types';
import { BaseEnrichmentSource } from './base-source';
import type { EnrichmentSearchResult } from './search-executor';
import { generateHandleVariants } from './handle-variants';

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
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 2);

    // HANDLE_MODE: npm profile URLs are npmjs.com/~username
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;
      candidates.push({
        query: `site:npmjs.com/~${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'linkedinId' ? 'handle:clean' : 'handle:derived',
      });
    }

    // NAME_MODE: Package page search (surfaces packages by author)
    if (hints.linkedinId && candidates.length < maxQueries) {
      const cleanHandle = hints.linkedinId.replace(/-?\d+$/, '');
      candidates.push({
        query: `site:npmjs.com "${cleanHandle}"`,
        mode: 'name',
        variantId: 'handle:package_search',
      });
    }

    // NAME_MODE: Author search by name
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:npmjs.com "${hints.nameHint}" author`,
        mode: 'name',
        variantId: 'name:full_author',
      });
    }

    // NAME + COMPANY: Better precision
    if (hints.nameHint && hints.companyHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:npmjs.com "${hints.nameHint}" "${hints.companyHint}"`,
        mode: 'name',
        variantId: 'name+company',
      });
    }

    return candidates.slice(0, maxQueries);
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
    return this.buildQueryCandidates(hints, maxQueries).map(c => c.query);
  }

  buildQueryCandidates(hints: CandidateHints, maxQueries: number = 3): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 2);

    // HANDLE_MODE: PyPI profile URLs are handle-based: pypi.org/user/username
    for (const variant of variants) {
      if (candidates.length >= maxQueries) break;
      candidates.push({
        query: `site:pypi.org/user/${variant.handle}`,
        mode: 'handle',
        variantId: variant.source === 'linkedinId' ? 'handle:clean' : 'handle:derived',
      });
    }

    // NAME_MODE: User profile search by name
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:pypi.org/user "${hints.nameHint}"`,
        mode: 'name',
        variantId: 'name:full_user_search',
      });
    }

    // NAME_MODE: Package maintainer search
    if (hints.nameHint && candidates.length < maxQueries) {
      candidates.push({
        query: `site:pypi.org "${hints.nameHint}" maintainer author`,
        mode: 'name',
        variantId: 'name:full_maintainer',
      });
    }

    return candidates.slice(0, maxQueries);
  }
}

// Export singleton instances
export const npmSource = new NpmSource();
export const pypiSource = new PyPISource();
export default { npmSource, pypiSource };
