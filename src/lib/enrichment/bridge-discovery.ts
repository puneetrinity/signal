/**
 * Bridge Discovery for Identity Resolution
 *
 * Discovers potential platform identities for LinkedIn candidates using
 * bridge signals like:
 * - Name + Company/Location matching
 * - GitHub profile links to LinkedIn
 * - Commit email patterns
 *
 * Returns IdentityCandidate entries with evidence pointers (NOT PII).
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import {
  GitHubClient,
  getGitHubClient,
  type GitHubUserProfile,
  type CommitEmailEvidence,
} from './github';
import {
  calculateConfidenceScore,
  classifyConfidence,
  meetsStorageThreshold,
  detectContradictions,
  type ScoreBreakdown,
} from './scoring';

/**
 * Candidate hints from search results (NOT scraped data)
 */
export interface CandidateHints {
  linkedinId: string;
  linkedinUrl: string;
  nameHint: string | null;
  headlineHint: string | null;
  locationHint: string | null;
  roleType: string | null;
}

/**
 * Discovered identity candidate (ready for DB insertion)
 */
export interface DiscoveredIdentity {
  platform: string;
  platformId: string;
  profileUrl: string;
  confidence: number;
  confidenceBucket: string;
  scoreBreakdown: ScoreBreakdown;
  evidence: CommitEmailEvidence[] | null;
  hasContradiction: boolean;
  contradictionNote: string | null;
  platformProfile: {
    name: string | null;
    company: string | null;
    location: string | null;
    bio: string | null;
    followers: number;
    publicRepos: number;
  };
}

/**
 * Bridge discovery result
 */
export interface BridgeDiscoveryResult {
  candidateId: string;
  linkedinId: string;
  identitiesFound: DiscoveredIdentity[];
  queriesExecuted: number;
  earlyStopReason: string | null;
}

/**
 * Bridge discovery options
 */
export interface BridgeDiscoveryOptions {
  maxGitHubResults?: number;
  confidenceThreshold?: number;
  includeCommitEvidence?: boolean;
  maxCommitRepos?: number;
}

const DEFAULT_OPTIONS: Required<BridgeDiscoveryOptions> = {
  maxGitHubResults: 5,
  confidenceThreshold: 0.4,
  includeCommitEvidence: true,
  maxCommitRepos: 3,
};

/**
 * Check if GitHub profile links to LinkedIn
 */
function extractLinkedInFromProfile(profile: GitHubUserProfile): string | null {
  // Check blog field
  if (profile.blog) {
    const blogLower = profile.blog.toLowerCase();
    if (blogLower.includes('linkedin.com/in/')) {
      const match = profile.blog.match(/linkedin\.com\/in\/([^/?\s]+)/i);
      if (match) return match[1];
    }
  }

  // Check bio
  if (profile.bio) {
    const match = profile.bio.match(/linkedin\.com\/in\/([^/?\s]+)/i);
    if (match) return match[1];
  }

  return null;
}

/**
 * Build search queries for a candidate
 * Uses hints from search snippets (NOT scraped data)
 */
function buildSearchQueries(hints: CandidateHints): string[] {
  const queries: string[] = [];

  // Query 1: Full name
  if (hints.nameHint) {
    queries.push(hints.nameHint);
  }

  // Query 2: Name + Company (extracted from headline)
  if (hints.nameHint && hints.headlineHint) {
    // Try to extract company from headline
    // Common patterns: "Title at Company", "Title @ Company", "Title, Company"
    const companyMatch = hints.headlineHint.match(
      /(?:at|@|,)\s*([A-Z][A-Za-z0-9\s&]+?)(?:\s*[-|·]|$)/
    );
    if (companyMatch) {
      queries.push(`${hints.nameHint} ${companyMatch[1].trim()}`);
    }
  }

  // Query 3: Name + Location
  if (hints.nameHint && hints.locationHint) {
    // Only add if location is specific (not just country)
    if (hints.locationHint.length < 30) {
      queries.push(`${hints.nameHint} ${hints.locationHint}`);
    }
  }

  return queries;
}

/**
 * Discover GitHub identities for a LinkedIn candidate
 */
export async function discoverGitHubIdentities(
  candidateId: string,
  hints: CandidateHints,
  options: BridgeDiscoveryOptions = {}
): Promise<BridgeDiscoveryResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const github = getGitHubClient();

  const identitiesFound: DiscoveredIdentity[] = [];
  let queriesExecuted = 0;
  let earlyStopReason: string | null = null;

  // Build search queries
  const queries = buildSearchQueries(hints);

  if (queries.length === 0) {
    console.warn(
      `[BridgeDiscovery] No search queries for candidate ${hints.linkedinId} (no name hint)`
    );
    return {
      candidateId,
      linkedinId: hints.linkedinId,
      identitiesFound: [],
      queriesExecuted: 0,
      earlyStopReason: 'no_search_queries',
    };
  }

  // Track seen profiles to avoid duplicates
  const seenProfiles = new Set<string>();

  // Execute queries
  for (const query of queries) {
    try {
      queriesExecuted++;

      console.log(
        `[BridgeDiscovery] Searching GitHub for: "${query}" (candidate: ${hints.linkedinId})`
      );

      const searchResults = await github.searchUsers(query, opts.maxGitHubResults);

      for (const result of searchResults) {
        // Skip if already processed
        if (seenProfiles.has(result.login.toLowerCase())) {
          continue;
        }
        seenProfiles.add(result.login.toLowerCase());

        try {
          // Get full profile
          const profile = await github.getUser(result.login);

          // Check for LinkedIn bridge (strongest signal)
          const linkedInId = extractLinkedInFromProfile(profile);
          const hasProfileLink =
            linkedInId?.toLowerCase() === hints.linkedinId.toLowerCase();

          // Get commit evidence if enabled
          let commitEvidence: CommitEmailEvidence[] = [];
          if (opts.includeCommitEvidence) {
            commitEvidence = await github.getCommitEvidence(
              result.login,
              opts.maxCommitRepos
            );
          }

          // Calculate confidence score
          const scoreInput = {
            hasCommitEvidence: commitEvidence.length > 0,
            commitCount: commitEvidence.length,
            hasProfileLink,
            candidateName: hints.nameHint,
            platformName: profile.name,
            candidateHeadline: hints.headlineHint,
            platformCompany: profile.company,
            candidateLocation: hints.locationHint,
            platformLocation: profile.location,
            platformFollowers: profile.followers,
            platformRepos: profile.public_repos,
            platformBio: profile.bio,
          };

          const scoreBreakdown = calculateConfidenceScore(scoreInput);
          const confidence = scoreBreakdown.total;
          const confidenceBucket = classifyConfidence(confidence);

          // Check for contradictions
          const { hasContradiction, note: contradictionNote } =
            detectContradictions(scoreInput);

          // Only store if meets threshold
          if (meetsStorageThreshold(confidence)) {
            identitiesFound.push({
              platform: 'github',
              platformId: result.login,
              profileUrl: profile.html_url,
              confidence,
              confidenceBucket,
              scoreBreakdown,
              evidence: commitEvidence.length > 0 ? commitEvidence : null,
              hasContradiction,
              contradictionNote: contradictionNote || null,
              platformProfile: {
                name: profile.name,
                company: profile.company,
                location: profile.location,
                bio: profile.bio,
                followers: profile.followers,
                publicRepos: profile.public_repos,
              },
            });

            console.log(
              `[BridgeDiscovery] Found match: ${result.login} (confidence: ${confidence.toFixed(2)}, bucket: ${confidenceBucket})`
            );

            // Early stop if we found a high-confidence match
            if (confidence >= 0.9) {
              earlyStopReason = 'confidence_threshold';
              console.log(
                `[BridgeDiscovery] Early stop: found high-confidence match`
              );
              break;
            }
          }
        } catch (error) {
          console.warn(
            `[BridgeDiscovery] Failed to process ${result.login}:`,
            error instanceof Error ? error.message : error
          );
        }
      }

      // Break outer loop if early stop
      if (earlyStopReason) break;
    } catch (error) {
      console.error(
        `[BridgeDiscovery] Query failed: "${query}"`,
        error instanceof Error ? error.message : error
      );
    }
  }

  // Sort by confidence (highest first)
  identitiesFound.sort((a, b) => b.confidence - a.confidence);

  console.log(
    `[BridgeDiscovery] Completed for ${hints.linkedinId}: ${identitiesFound.length} identities found, ${queriesExecuted} queries executed`
  );

  return {
    candidateId,
    linkedinId: hints.linkedinId,
    identitiesFound,
    queriesExecuted,
    earlyStopReason,
  };
}

/**
 * Check if a platform is supported for bridge discovery
 */
export function isSupportedPlatform(platform: string): boolean {
  return ['github'].includes(platform.toLowerCase());
}

/**
 * Get supported platforms for a role type
 * Engineers -> GitHub, StackOverflow
 * Researchers -> GitHub, ORCID, Google Scholar
 * Data Scientists -> GitHub, Kaggle
 */
export function getPlatformsForRoleType(roleType: string | null): string[] {
  switch (roleType) {
    case 'engineer':
      return ['github']; // TODO: Add stackoverflow
    case 'data_scientist':
      return ['github']; // TODO: Add kaggle
    case 'researcher':
      return ['github']; // TODO: Add orcid, scholar
    case 'founder':
      return ['github']; // TODO: Add twitter, crunchbase
    case 'designer':
      return []; // TODO: Add dribbble, behance
    default:
      return ['github'];
  }
}

export default {
  discoverGitHubIdentities,
  isSupportedPlatform,
  getPlatformsForRoleType,
};
