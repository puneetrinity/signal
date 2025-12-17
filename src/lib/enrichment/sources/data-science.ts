/**
 * Data Science & ML Enrichment Sources
 *
 * Discovers profiles for data scientists and ML engineers:
 * - Kaggle: Competition and notebook profiles
 * - Hugging Face: Model and dataset profiles
 * - Papers With Code: ML research author profiles
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, CandidateHints } from './types';
import { BaseEnrichmentSource } from './base-source';
import type { EnrichmentSearchResult } from './search-executor';

/**
 * Kaggle profile extraction
 */
function extractKaggleProfile(result: EnrichmentSearchResult) {
  // Title format: "Username | Kaggle" or "Name - Kaggle"
  const titleParts = result.title.replace(/\s*[|·-]\s*Kaggle.*$/i, '').split(' | ');
  const name = titleParts[0]?.trim() || null;

  // Extract tier/rank
  let reputation: number | undefined;
  const tierMatch = result.snippet?.match(/(Grandmaster|Master|Expert|Contributor|Novice)/i);
  if (tierMatch) {
    const tierScores: Record<string, number> = {
      grandmaster: 5000,
      master: 3000,
      expert: 1500,
      contributor: 500,
      novice: 100,
    };
    reputation = tierScores[tierMatch[1].toLowerCase()] || 0;
  }

  // Extract competition medals/rankings
  const medalsMatch = result.snippet?.match(/(\d+)\s*(?:gold|silver|bronze)\s*medals?/gi);
  if (medalsMatch && !reputation) {
    reputation = medalsMatch.length * 500;
  }

  // Extract notebooks/datasets count
  let publicRepos: number | undefined;
  const notebooksMatch = result.snippet?.match(/(\d+)\s*(?:notebooks?|datasets?|kernels?)/i);
  if (notebooksMatch) {
    publicRepos = parseInt(notebooksMatch[1], 10);
  }

  // Extract bio/occupation
  const bio = result.snippet || null;

  // Extract organization
  let company: string | null = null;
  const orgMatch = result.snippet?.match(/(?:at|works at|from)\s+([A-Z][A-Za-z\s&]+?)(?:\s*[·|,.]|$)/i);
  if (orgMatch) {
    company = orgMatch[1].trim();
  }

  return {
    name,
    bio,
    company,
    location: null,
    followers: undefined,
    reputation,
    publicRepos,
    publications: undefined,
  };
}

/**
 * Hugging Face profile extraction
 */
function extractHuggingFaceProfile(result: EnrichmentSearchResult) {
  // Title format: "username - Hugging Face" or "Name's Profile | Hugging Face"
  const titleParts = result.title.replace(/\s*[|·-]\s*Hugging Face.*$/i, '').split(' - ');
  let name = titleParts[0]?.trim() || null;

  // Remove "'s Profile" suffix
  if (name) {
    name = name.replace(/'s Profile$/i, '').trim();
  }

  // Extract model/dataset counts
  let publicRepos: number | undefined;
  const modelsMatch = result.snippet?.match(/(\d+)\s*(?:models?|spaces?|datasets?)/i);
  if (modelsMatch) {
    publicRepos = parseInt(modelsMatch[1], 10);
  }

  // Extract followers/likes
  let followers: number | undefined;
  const followersMatch = result.snippet?.match(/(\d+(?:,\d+)?)\s*(?:followers?|likes?)/i);
  if (followersMatch) {
    followers = parseInt(followersMatch[1].replace(/,/g, ''), 10);
  }

  // Extract organization
  let company: string | null = null;
  const orgMatch = result.snippet?.match(/(?:Organization|Org|Team):\s*([A-Za-z0-9_-]+)/i);
  if (orgMatch) {
    company = orgMatch[1];
  }

  return {
    name,
    bio: result.snippet || null,
    company,
    location: null,
    followers,
    reputation: undefined,
    publicRepos,
    publications: undefined,
  };
}

/**
 * Papers With Code profile extraction
 */
function extractPapersWithCodeProfile(result: EnrichmentSearchResult) {
  // Title format: "Author Name | Papers With Code"
  const titleParts = result.title.replace(/\s*[|·-]\s*Papers With Code.*$/i, '').split(' | ');
  const name = titleParts[0]?.trim() || null;

  // Extract paper count
  let publications: number | undefined;
  const papersMatch = result.snippet?.match(/(\d+)\s*(?:papers?|publications?)/i);
  if (papersMatch) {
    publications = parseInt(papersMatch[1], 10);
  }

  // Extract implementation count
  let publicRepos: number | undefined;
  const implMatch = result.snippet?.match(/(\d+)\s*(?:implementations?|repos?|code)/i);
  if (implMatch) {
    publicRepos = parseInt(implMatch[1], 10);
  }

  // Extract affiliation
  let company: string | null = null;
  const affMatch = result.snippet?.match(/(?:at|affiliated with)\s+([A-Z][A-Za-z\s]+)/i);
  if (affMatch) {
    company = affMatch[1].trim();
  }

  return {
    name,
    bio: result.snippet || null,
    company,
    location: null,
    followers: undefined,
    reputation: undefined,
    publicRepos,
    publications,
  };
}

/**
 * Kaggle enrichment source
 */
export class KaggleSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'kaggle';
  readonly displayName = 'Kaggle';
  readonly supportedRoles: RoleType[] = ['data_scientist'];
  readonly baseWeight = 0.25;
  readonly queryPattern = 'site:kaggle.com "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractKaggleProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    const queries: string[] = [];

    // Primary: Profile search
    if (hints.nameHint) {
      queries.push(`site:kaggle.com "${hints.nameHint}"`);
    }

    // Secondary: With company/org
    if (hints.nameHint && hints.companyHint && queries.length < maxQueries) {
      queries.push(`site:kaggle.com "${hints.nameHint}" "${hints.companyHint}"`);
    }

    return queries.slice(0, maxQueries);
  }
}

/**
 * Hugging Face enrichment source
 */
export class HuggingFaceSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'huggingface';
  readonly displayName = 'Hugging Face';
  readonly supportedRoles: RoleType[] = ['data_scientist', 'researcher'];
  readonly baseWeight = 0.25;
  readonly queryPattern = 'site:huggingface.co "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractHuggingFaceProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    const queries: string[] = [];

    // Primary: User profile search
    if (hints.nameHint) {
      queries.push(`site:huggingface.co "${hints.nameHint}"`);
    }

    // Secondary: Organization search
    if (hints.companyHint && queries.length < maxQueries) {
      queries.push(`site:huggingface.co "${hints.companyHint}"`);
    }

    return queries.slice(0, maxQueries);
  }
}

/**
 * Papers With Code enrichment source (highest weight for ML researchers)
 */
export class PapersWithCodeSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'paperswithcode';
  readonly displayName = 'Papers With Code';
  readonly supportedRoles: RoleType[] = ['data_scientist', 'researcher'];
  readonly baseWeight = 0.45; // High weight - vetted research
  readonly queryPattern = 'site:paperswithcode.com/author "{name}"';

  protected getSiteDomain(): string {
    return 'paperswithcode.com/author';
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractPapersWithCodeProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    const queries: string[] = [];

    // Primary: Author profile search
    if (hints.nameHint) {
      queries.push(`site:paperswithcode.com/author "${hints.nameHint}"`);
    }

    // Secondary: Paper search with name
    if (hints.nameHint && queries.length < maxQueries) {
      queries.push(`site:paperswithcode.com "${hints.nameHint}"`);
    }

    return queries.slice(0, maxQueries);
  }
}

// Export singleton instances
export const kaggleSource = new KaggleSource();
export const huggingFaceSource = new HuggingFaceSource();
export const papersWithCodeSource = new PapersWithCodeSource();

export default {
  kaggleSource,
  huggingFaceSource,
  papersWithCodeSource,
};
