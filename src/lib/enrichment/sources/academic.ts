/**
 * Academic Enrichment Sources
 *
 * Discovers academic profiles for researchers:
 * - ORCID: Persistent researcher identifiers
 * - Google Scholar: Publication and citation profiles
 * - Semantic Scholar: Academic search and author profiles
 * - ResearchGate: Research networking profiles
 * - arXiv: Preprint author search
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, CandidateHints } from './types';
import { BaseEnrichmentSource } from './base-source';
import type { EnrichmentSearchResult } from './search-executor';

/**
 * ORCID profile extraction
 */
function extractOrcidProfile(result: EnrichmentSearchResult) {
  // Title format: "Name - ORCID" or "0000-0000-0000-0000 - ORCID"
  const titleParts = result.title.replace(/\s*[-·]\s*ORCID.*$/i, '').split(' - ');
  let name = titleParts[0]?.trim() || null;

  // If title is just the ORCID ID, try to get name from snippet
  if (name?.match(/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/)) {
    const nameMatch = result.snippet?.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
    if (nameMatch) {
      name = nameMatch[1];
    }
  }

  // Extract affiliation/organization
  let company: string | null = null;
  const affMatch = result.snippet?.match(/(?:at|affiliated with|works at)\s+([^.·]+)/i);
  if (affMatch) {
    company = affMatch[1].trim();
  }

  // Extract publications count
  let publications: number | undefined;
  const pubMatch = result.snippet?.match(/(\d+)\s*(?:works?|publications?|papers?)/i);
  if (pubMatch) {
    publications = parseInt(pubMatch[1], 10);
  }

  return {
    name,
    bio: result.snippet || null,
    company,
    location: null,
    followers: undefined,
    reputation: undefined,
    publicRepos: undefined,
    publications,
  };
}

/**
 * Google Scholar profile extraction
 */
function extractScholarProfile(result: EnrichmentSearchResult) {
  // Title format: "Name - Google Scholar"
  const titleParts = result.title.replace(/\s*[-·]\s*Google Scholar.*$/i, '').split(' - ');
  const name = titleParts[0]?.trim() || null;

  // Extract affiliation
  let company: string | null = null;
  const affMatch = result.snippet?.match(/(?:Professor|Researcher|Scientist|Engineer)\s+(?:at|,)\s+([^.·]+)/i);
  if (affMatch) {
    company = affMatch[1].trim();
  }

  // Extract citation count
  let reputation: number | undefined;
  const citMatch = result.snippet?.match(/Cited by\s*(\d+(?:,\d+)?)/i);
  if (citMatch) {
    reputation = parseInt(citMatch[1].replace(/,/g, ''), 10);
  }

  // Extract publication count
  let publications: number | undefined;
  const pubMatch = result.snippet?.match(/(\d+)\s*(?:articles?|publications?|papers?)/i);
  if (pubMatch) {
    publications = parseInt(pubMatch[1], 10);
  }

  return {
    name,
    bio: result.snippet || null,
    company,
    location: null,
    followers: undefined,
    reputation,
    publicRepos: undefined,
    publications,
  };
}

/**
 * Semantic Scholar profile extraction
 */
function extractSemanticScholarProfile(result: EnrichmentSearchResult) {
  // Title format: "Name | Semantic Scholar"
  const titleParts = result.title.replace(/\s*[|·-]\s*Semantic Scholar.*$/i, '').split(' | ');
  const name = titleParts[0]?.trim() || null;

  // Extract paper count
  let publications: number | undefined;
  const pubMatch = result.snippet?.match(/(\d+)\s*(?:papers?|publications?)/i);
  if (pubMatch) {
    publications = parseInt(pubMatch[1], 10);
  }

  // Extract citation count
  let reputation: number | undefined;
  const citMatch = result.snippet?.match(/(\d+(?:,\d+)?)\s*citations?/i);
  if (citMatch) {
    reputation = parseInt(citMatch[1].replace(/,/g, ''), 10);
  }

  // Extract affiliation
  let company: string | null = null;
  const affMatch = result.snippet?.match(/(?:affiliated with|at)\s+([A-Z][^.·]+)/i);
  if (affMatch) {
    company = affMatch[1].trim();
  }

  return {
    name,
    bio: result.snippet || null,
    company,
    location: null,
    followers: undefined,
    reputation,
    publicRepos: undefined,
    publications,
  };
}

/**
 * ResearchGate profile extraction
 */
function extractResearchGateProfile(result: EnrichmentSearchResult) {
  // Title format: "Name | ResearchGate"
  const titleParts = result.title.replace(/\s*[|·-]\s*ResearchGate.*$/i, '').split(' | ');
  const name = titleParts[0]?.trim() || null;

  // Extract RG Score/reads
  let reputation: number | undefined;
  const scoreMatch = result.snippet?.match(/(\d+(?:\.\d+)?)\s*(?:RG Score|ResearchGate Score)/i);
  if (scoreMatch) {
    reputation = parseFloat(scoreMatch[1]) * 100; // Normalize to similar scale
  }

  // Extract reads
  const readsMatch = result.snippet?.match(/(\d+(?:,\d+)?)\s*reads?/i);
  if (readsMatch && !reputation) {
    reputation = parseInt(readsMatch[1].replace(/,/g, ''), 10) / 100;
  }

  // Extract publications
  let publications: number | undefined;
  const pubMatch = result.snippet?.match(/(\d+)\s*(?:publications?|papers?)/i);
  if (pubMatch) {
    publications = parseInt(pubMatch[1], 10);
  }

  // Extract affiliation
  let company: string | null = null;
  const affMatch = result.snippet?.match(/(?:at|·)\s+([A-Z][A-Za-z\s]+(?:University|Institute|College|Lab))/i);
  if (affMatch) {
    company = affMatch[1].trim();
  }

  return {
    name,
    bio: result.snippet || null,
    company,
    location: null,
    followers: undefined,
    reputation,
    publicRepos: undefined,
    publications,
  };
}

/**
 * ORCID enrichment source (strongest academic identifier)
 */
export class OrcidSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'orcid';
  readonly displayName = 'ORCID';
  readonly supportedRoles: RoleType[] = ['researcher'];
  readonly baseWeight = 0.5; // High weight - persistent identifier
  readonly queryPattern = 'site:orcid.org "{name}"';

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractOrcidProfile(result);
  }
}

/**
 * Google Scholar enrichment source
 */
export class ScholarSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'scholar';
  readonly displayName = 'Google Scholar';
  readonly supportedRoles: RoleType[] = ['researcher', 'data_scientist'];
  readonly baseWeight = 0.25;
  readonly queryPattern = 'site:scholar.google.com/citations "{name}"';

  protected getSiteDomain(): string {
    return 'scholar.google.com/citations';
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractScholarProfile(result);
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    const queries: string[] = [];

    // Primary: Citation profile search
    if (hints.nameHint) {
      queries.push(`site:scholar.google.com/citations "${hints.nameHint}"`);
    }

    // Secondary: With affiliation
    if (hints.nameHint && hints.companyHint && queries.length < maxQueries) {
      queries.push(`site:scholar.google.com "${hints.nameHint}" "${hints.companyHint}"`);
    }

    return queries.slice(0, maxQueries);
  }
}

/**
 * Semantic Scholar enrichment source
 */
export class SemanticScholarSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'semanticscholar';
  readonly displayName = 'Semantic Scholar';
  readonly supportedRoles: RoleType[] = ['researcher'];
  readonly baseWeight = 0.2;
  readonly queryPattern = 'site:semanticscholar.org/author "{name}"';

  protected getSiteDomain(): string {
    return 'semanticscholar.org/author';
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractSemanticScholarProfile(result);
  }
}

/**
 * ResearchGate enrichment source
 */
export class ResearchGateSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'researchgate';
  readonly displayName = 'ResearchGate';
  readonly supportedRoles: RoleType[] = ['researcher'];
  readonly baseWeight = 0.2;
  readonly queryPattern = 'site:researchgate.net/profile "{name}"';

  protected getSiteDomain(): string {
    return 'researchgate.net/profile';
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    return extractResearchGateProfile(result);
  }
}

/**
 * arXiv author search source
 */
export class ArxivSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'arxiv';
  readonly displayName = 'arXiv';
  readonly supportedRoles: RoleType[] = ['researcher', 'data_scientist'];
  readonly baseWeight = 0.2;
  readonly queryPattern = 'site:arxiv.org author:"{name}"';

  protected getSiteDomain(): string {
    return 'arxiv.org';
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    // arXiv doesn't have profiles per se, extract from search results
    const titleParts = result.title.split(' - ');
    const name = titleParts[0]?.trim() || null;

    return {
      name,
      bio: result.snippet || null,
      company: null,
      location: null,
      followers: undefined,
      reputation: undefined,
      publicRepos: undefined,
      publications: undefined,
    };
  }

  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    const queries: string[] = [];

    // Primary: Author search
    if (hints.nameHint) {
      queries.push(`site:arxiv.org "${hints.nameHint}" author`);
    }

    return queries.slice(0, maxQueries);
  }
}

/**
 * Google Patents source (for inventors)
 */
export class PatentsSource extends BaseEnrichmentSource {
  readonly platform: EnrichmentPlatform = 'patents';
  readonly displayName = 'Google Patents';
  readonly supportedRoles: RoleType[] = ['researcher', 'engineer', 'founder'];
  readonly baseWeight = 0.4; // High weight - official records
  readonly queryPattern = 'site:patents.google.com "{name}" inventor';

  protected getSiteDomain(): string {
    return 'patents.google.com';
  }

  protected extractProfileInfo(result: EnrichmentSearchResult) {
    const name = result.title?.split(' - ')[0]?.trim() || null;

    // Try to extract patent count
    let publications: number | undefined;
    const patMatch = result.snippet?.match(/(\d+)\s*(?:patents?|inventions?)/i);
    if (patMatch) {
      publications = parseInt(patMatch[1], 10);
    }

    return {
      name,
      bio: result.snippet || null,
      company: null,
      location: null,
      followers: undefined,
      reputation: undefined,
      publicRepos: undefined,
      publications,
    };
  }
}

// Export singleton instances
export const orcidSource = new OrcidSource();
export const scholarSource = new ScholarSource();
export const semanticScholarSource = new SemanticScholarSource();
export const researchGateSource = new ResearchGateSource();
export const arxivSource = new ArxivSource();
export const patentsSource = new PatentsSource();

export default {
  orcidSource,
  scholarSource,
  semanticScholarSource,
  researchGateSource,
  arxivSource,
  patentsSource,
};
