/**
 * Base Enrichment Source Implementation
 *
 * Abstract base class for all search-based enrichment sources.
 * Provides common functionality for:
 * - Query building from patterns
 * - Search execution via Serper/Brave
 * - Identity scoring and evidence creation
 *
 * @see docs/ARCHITECTURE_V2.1.md Section 5
 */

import type { RoleType } from '@/types/linkedin';
import type {
  EnrichmentSource,
  EnrichmentPlatform,
  CandidateHints,
  DiscoveredIdentity,
  BridgeDiscoveryResult,
  DiscoveryOptions,
  SourceHealthCheck,
  ScoreBreakdown,
  EvidencePointer,
  PlatformDiagnostics,
  QueryCandidate,
} from './types';
import { inferQueryMode } from './types';
import {
  searchForPlatformWithMeta,
  buildQueryFromPattern,
  type EnrichmentSearchResult,
  getEnrichmentProviderConfig,
} from './search-executor';
import { checkProvidersHealth } from '@/lib/search/providers';
import { validateQuery, generateHandleVariants } from './handle-variants';
import {
  type BridgeSignal,
  createBridgeDetection,
} from '../bridge-types';

/** Maximum rejection reasons to store in diagnostics */
const MAX_REJECTION_REASONS = 10;

/**
 * Query normalization (Phase B3)
 * Best-effort recall boost for names with diacritics/punctuation.
 *
 * Controlled via ENRICHMENT_ENABLE_QUERY_NORMALIZATION (default: true).
 * Only applied to name-mode queries and only when the initial query returns 0 matched results.
 */
function isQueryNormalizationEnabled(): boolean {
  return process.env.ENRICHMENT_ENABLE_QUERY_NORMALIZATION !== 'false';
}

function shouldTryNormalizeQuery(query: string): boolean {
  // Any non-ASCII characters (e.g., Löf) or common curly punctuation.
  return /[^\u0000-\u007F]/.test(query) || /[“”‘’–—]/.test(query);
}

function foldDiacritics(text: string): string {
  // NFKD splits diacritics into combining marks; strip those marks.
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeQuotedPunctuation(text: string): string {
  // Only normalize within quoted phrases to avoid breaking URL/site: syntax.
  return text.replace(/"([^"]+)"/g, (_match, inner: string) => {
    const normalized = inner
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[-–—_.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return `"${normalized}"`;
  });
}

function normalizeNameModeQuery(query: string): string {
  return normalizeQuotedPunctuation(foldDiacritics(query));
}

/**
 * Default discovery options
 */
const DEFAULT_OPTIONS: Required<DiscoveryOptions> = {
  maxResults: 5,
  maxQueries: 3,
  timeout: 30000,
  minConfidence: parseFloat(process.env.ENRICHMENT_MIN_CONFIDENCE || '0.20'),
};

/**
 * Name matching utilities
 */
function normalizeString(str: string | null): string {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function calculateNameSimilarity(name1: string | null, name2: string | null): number {
  const n1 = normalizeString(name1);
  const n2 = normalizeString(name2);

  if (!n1 || !n2) return 0;
  if (n1 === n2) return 1.0;

  // Check if one contains the other
  if (n1.includes(n2) || n2.includes(n1)) return 0.8;

  // Token-based matching
  const tokens1 = new Set(n1.split(' '));
  const tokens2 = new Set(n2.split(' '));
  const intersection = [...tokens1].filter((t) => tokens2.has(t));
  const union = new Set([...tokens1, ...tokens2]);

  return intersection.length / union.size;
}

function calculateCompanyMatch(
  candidateHint: string | null,
  platformCompany: string | null
): number {
  if (!candidateHint || !platformCompany) return 0;

  const c1 = normalizeString(candidateHint);
  const c2 = normalizeString(platformCompany);

  if (!c1 || !c2) return 0;
  if (c1 === c2) return 1.0;
  if (c1.includes(c2) || c2.includes(c1)) return 0.7;

  return 0;
}

function calculateLocationMatch(
  candidateLocation: string | null,
  platformLocation: string | null
): number {
  if (!candidateLocation || !platformLocation) return 0;

  const l1 = normalizeString(candidateLocation);
  const l2 = normalizeString(platformLocation);

  if (!l1 || !l2) return 0;
  if (l1 === l2) return 1.0;

  // Partial match for cities/regions
  const tokens1 = l1.split(' ');
  const tokens2 = l2.split(' ');

  for (const t1 of tokens1) {
    for (const t2 of tokens2) {
      if (t1 === t2 && t1.length > 2) return 0.6;
    }
  }

  return 0;
}

/**
 * Generic handles that should NOT trigger cross_platform_handle signal
 * These are too common to be reliable identity bridges
 */
const GENERIC_HANDLES = new Set([
  'dev', 'developer', 'admin', 'root', 'user', 'test', 'demo', 'example',
  'alex', 'sam', 'john', 'jane', 'mike', 'david', 'chris', 'james', 'robert',
  'andrew', 'daniel', 'matt', 'matthew', 'mark', 'peter', 'tom', 'steve',
  'web', 'app', 'code', 'tech', 'data', 'info', 'main', 'home', 'default',
  'engineer', 'coder', 'hacker', 'ninja', 'guru', 'master', 'pro',
]);

/**
 * Check if a handle is too generic to be a reliable cross-platform signal
 */
function isGenericHandle(handle: string): boolean {
  const normalized = handle.toLowerCase().replace(/[-_\d]/g, '');
  return GENERIC_HANDLES.has(normalized) || normalized.length < 4;
}

/**
 * Extract all LinkedIn URLs from text and return them with their IDs
 */
function extractLinkedInUrls(text: string): { url: string; id: string }[] {
  const results: { url: string; id: string }[] = [];

  // Match regular LinkedIn URLs
  const regularPattern = /linkedin\.com\/in\/([a-zA-Z0-9_-]+)/gi;
  let match;
  while ((match = regularPattern.exec(text)) !== null) {
    results.push({ url: match[0], id: match[1].toLowerCase() });
  }

  // Match URL-encoded LinkedIn URLs (e.g., linkedin.com%2Fin%2F)
  const encodedPattern = /linkedin\.com%2Fin%2F([a-zA-Z0-9_-]+)/gi;
  while ((match = encodedPattern.exec(text)) !== null) {
    results.push({ url: decodeURIComponent(match[0]), id: match[1].toLowerCase() });
  }

  // Match double-encoded URLs (linkedin.com%252Fin%252F)
  const doubleEncodedPattern = /linkedin\.com%252Fin%252F([a-zA-Z0-9_-]+)/gi;
  while ((match = doubleEncodedPattern.exec(text)) !== null) {
    results.push({ url: decodeURIComponent(decodeURIComponent(match[0])), id: match[1].toLowerCase() });
  }

  return results;
}

/**
 * Abstract base class for search-based enrichment sources
 */
export abstract class BaseEnrichmentSource implements EnrichmentSource {
  abstract readonly platform: EnrichmentPlatform;
  abstract readonly displayName: string;
  abstract readonly supportedRoles: RoleType[];
  abstract readonly baseWeight: number;
  abstract readonly queryPattern: string;

  /**
   * Build query candidates with mode metadata (Phase B)
   * Override this in subclasses to provide typed candidates.
   * If not implemented, discover() will fall back to buildQueries() with mode inference.
   */
  buildQueryCandidates?(hints: CandidateHints, maxQueries?: number): QueryCandidate[];

  /**
   * Build search queries for this platform (legacy)
   * Can be overridden for platform-specific query construction
   */
  buildQueries(hints: CandidateHints, maxQueries: number = 3): string[] {
    const queries: string[] = [];

    // Primary query from pattern
    const primary = buildQueryFromPattern(this.queryPattern, hints);
    if (primary) {
      queries.push(primary);
    }

    // Name-only query
    if (hints.nameHint && queries.length < maxQueries) {
      const nameQuery = `site:${this.getSiteDomain()} "${hints.nameHint}"`;
      if (!queries.includes(nameQuery)) {
        queries.push(nameQuery);
      }
    }

    // Name + company variant
    if (hints.nameHint && hints.companyHint && queries.length < maxQueries) {
      const companyQuery = `site:${this.getSiteDomain()} "${hints.nameHint}" "${hints.companyHint}"`;
      if (!queries.includes(companyQuery)) {
        queries.push(companyQuery);
      }
    }

    return queries.slice(0, maxQueries);
  }

  /**
   * Get the site domain for search queries
   * Can be overridden for platforms with different domains
   */
  protected getSiteDomain(): string {
    const domainMap: Partial<Record<EnrichmentPlatform, string>> = {
      github: 'github.com',
      stackoverflow: 'stackoverflow.com/users',
      npm: 'npmjs.com',
      pypi: 'pypi.org',
      kaggle: 'kaggle.com',
      huggingface: 'huggingface.co',
      orcid: 'orcid.org',
      scholar: 'scholar.google.com',
      medium: 'medium.com',
      devto: 'dev.to',
      twitter: 'twitter.com',
      dribbble: 'dribbble.com',
      behance: 'behance.net',
      leetcode: 'leetcode.com',
      gitlab: 'gitlab.com',
      crunchbase: 'crunchbase.com/person',
      researchgate: 'researchgate.net/profile',
      semanticscholar: 'semanticscholar.org/author',
      arxiv: 'arxiv.org',
      patents: 'patents.google.com',
      youtube: 'youtube.com',
      substack: 'substack.com',
      codepen: 'codepen.io',
      dockerhub: 'hub.docker.com/u',
      angellist: 'angel.co/u',
      paperswithcode: 'paperswithcode.com',
      hackerearth: 'hackerearth.com',
      gist: 'gist.github.com',
      openreview: 'openreview.net',
      university: 'edu', // Special case - searches across .edu domains
      companyteam: '', // Special case - searches company domains
      sec: 'sec.gov',
    };
    return domainMap[this.platform] || `${this.platform}.com`;
  }

  /**
   * Extract profile information from search result snippet
   * Override in subclasses for platform-specific extraction
   */
  protected extractProfileInfo(result: EnrichmentSearchResult): {
    name: string | null;
    bio: string | null;
    company: string | null;
    location: string | null;
    followers?: number;
    reputation?: number;
    publicRepos?: number;
    publications?: number;
  } {
    // Default extraction from title and snippet
    const titleParts = result.title.split(' - ');
    const name = titleParts[0]?.trim() || null;

    return {
      name,
      bio: result.snippet || null,
      company: null,
      location: null,
    };
  }

  /**
   * Calculate confidence score for a discovered identity
   */
  protected calculateScore(
    hints: CandidateHints,
    result: EnrichmentSearchResult,
    profileInfo: ReturnType<typeof this.extractProfileInfo>,
    hasBridgeEvidence: boolean = false
  ): ScoreBreakdown {
    const nameMatch = calculateNameSimilarity(hints.nameHint, profileInfo.name);

    // Extract company from headline if not in hints
    let companyHint = hints.companyHint;
    if (!companyHint && hints.headlineHint) {
      const match = hints.headlineHint.match(/(?:at|@|,)\s*([A-Z][A-Za-z0-9\s&]+?)(?:\s*[-|·]|$)/);
      if (match) companyHint = match[1].trim();
    }

    const companyMatch = calculateCompanyMatch(companyHint, profileInfo.company);
    const locationMatch = calculateLocationMatch(hints.locationHint, profileInfo.location);

    // Handle match: compare platformId against linkedinId and variants
    // Strong signal for handle-based platforms (github, npm, pypi, gitlab, etc.)
    let handleMatch = 0;
    if (result.platformId && hints.linkedinId) {
      const platformIdLower = result.platformId.toLowerCase();
      const linkedinIdLower = hints.linkedinId.toLowerCase();

      // Exact match is strongest signal
      if (platformIdLower === linkedinIdLower) {
        handleMatch = 1.0;
      } else {
        // Check against generated handle variants
        const variants = generateHandleVariants(hints.linkedinId, hints.nameHint, 5);
        for (const variant of variants) {
          if (variant.handle === platformIdLower) {
            // Use variant confidence (0.4-0.9 range)
            handleMatch = variant.confidence;
            break;
          }
        }
      }

      // Reduce weight for non-profile URLs (repos, groups, orgs)
      // GitLab groups: gitlab.com/groups/xxx, repos: gitlab.com/user/repo
      const url = result.platformProfileUrl || result.url || '';
      if (
        url.includes('/groups/') ||
        url.includes('/projects/') ||
        (url.includes('/') && url.split('/').filter(Boolean).length > 4)
      ) {
        handleMatch *= 0.5; // Reduce for non-profile URLs
      }
    }

    // Profile completeness (0-1)
    const completenessFactors = [
      profileInfo.name ? 1 : 0,
      profileInfo.bio ? 1 : 0,
      profileInfo.company ? 1 : 0,
      profileInfo.location ? 1 : 0,
    ];
    const profileCompleteness =
      completenessFactors.reduce((a, b) => a + b, 0) / completenessFactors.length;

    // Activity score based on platform metrics
    let activityScore = 0;
    if (profileInfo.followers && profileInfo.followers > 10) activityScore += 0.3;
    if (profileInfo.reputation && profileInfo.reputation > 100) activityScore += 0.3;
    if (profileInfo.publicRepos && profileInfo.publicRepos > 5) activityScore += 0.3;
    if (profileInfo.publications && profileInfo.publications > 0) activityScore += 0.3;
    activityScore = Math.min(activityScore, 1);

    // Bridge weight (profile link to LinkedIn is strongest signal)
    const bridgeWeight = hasBridgeEvidence ? 0.4 : 0;

    // Calculate base score from signals
    // handleMatch provides strong signal for handle-based platforms when name matching fails
    // Exact handle match (0.35) reliably clears 0.35 threshold
    const baseScore =
      bridgeWeight +
      nameMatch * 0.25 +
      handleMatch * 0.35 +
      companyMatch * 0.10 +
      locationMatch * 0.05 +
      (profileCompleteness * 0.5 + activityScore * 0.5) * 0.05;

    // Platform weight is used as a small bonus for more reliable platforms, not a multiplier
    // This ensures name matches can still reach threshold regardless of platform
    const platformBonus = this.baseWeight * 0.1; // Max +0.05 for high-weight platforms

    const total = Math.min(1, baseScore + platformBonus);

    return {
      bridgeWeight,
      nameMatch,
      handleMatch,
      companyMatch,
      locationMatch,
      profileCompleteness,
      activityScore,
      total,
    };
  }

  /**
   * Create evidence pointers for a discovered identity
   */
  protected createEvidence(
    result: EnrichmentSearchResult,
    additionalEvidence?: EvidencePointer[]
  ): EvidencePointer[] {
    const evidence: EvidencePointer[] = [
      {
        type: 'profile_link',
        sourceUrl: result.platformProfileUrl || result.url,
        sourcePlatform: this.platform,
        description: `${this.displayName} profile discovered via search`,
        capturedAt: new Date().toISOString(),
        metadata: {
          searchTitle: result.title,
          searchSnippet: result.snippet,
        },
      },
    ];

    if (additionalEvidence) {
      evidence.push(...additionalEvidence);
    }

    return evidence;
  }

  /**
   * Detect contradictions between candidate hints and platform profile
   */
  protected detectContradictions(
    hints: CandidateHints,
    profileInfo: ReturnType<typeof this.extractProfileInfo>
  ): { hasContradiction: boolean; note: string | null } {
    const issues: string[] = [];

    // Check for name contradiction (completely different names)
    if (hints.nameHint && profileInfo.name) {
      const similarity = calculateNameSimilarity(hints.nameHint, profileInfo.name);
      if (similarity < 0.2) {
        issues.push(`Name mismatch: "${hints.nameHint}" vs "${profileInfo.name}"`);
      }
    }

    // Check for company contradiction
    if (hints.companyHint && profileInfo.company) {
      const companyMatch = calculateCompanyMatch(hints.companyHint, profileInfo.company);
      if (companyMatch === 0) {
        // Only flag if both are well-known companies (not just different)
        const known1 = hints.companyHint.length > 3;
        const known2 = profileInfo.company.length > 3;
        if (known1 && known2) {
          issues.push(`Company differs: "${hints.companyHint}" vs "${profileInfo.company}"`);
        }
      }
    }

    return {
      hasContradiction: issues.length > 0,
      note: issues.length > 0 ? issues.join('; ') : null,
    };
  }

  /**
   * Detect bridge signals from a search result
   * Override in subclasses for platform-specific detection
   *
   * IMPORTANT: Tier 1 signals (linkedin_url_in_bio, linkedin_url_in_page) require
   * an explicit linkedin.com/in/{id} URL that matches the candidate's LinkedIn ID.
   * This prevents false positives from handle-only matching.
   */
  protected detectBridgeSignals(
    hints: CandidateHints,
    result: EnrichmentSearchResult,
    profileInfo: ReturnType<typeof this.extractProfileInfo>
  ): BridgeSignal[] {
    const signals: BridgeSignal[] = [];
    const targetLinkedinId = hints.linkedinId.toLowerCase();

    // Check for LinkedIn URL in bio/description
    // TIER 1: Requires explicit linkedin.com/in/{id} URL match
    if (profileInfo.bio) {
      const linkedinUrls = extractLinkedInUrls(profileInfo.bio);
      const matchingUrl = linkedinUrls.find(u => u.id === targetLinkedinId);

      if (matchingUrl) {
        // Check for team page (multiple different LinkedIn URLs) -> Tier 2
        const uniqueIds = new Set(linkedinUrls.map(u => u.id));
        if (uniqueIds.size > 1) {
          // Multiple LinkedIn profiles found - likely a team page, Tier 2 (no auto-merge)
          console.log(`[BridgeSignal] Multiple LinkedIn URLs in bio (${uniqueIds.size}), using linkedin_url_in_team_page (Tier 2)`);
          signals.push('linkedin_url_in_team_page');
        } else {
          signals.push('linkedin_url_in_bio');
        }
      }
    }

    // Check for LinkedIn URL in snippet (found via search)
    // TIER 1: Requires explicit linkedin.com/in/{id} URL match
    if (result.snippet) {
      const linkedinUrls = extractLinkedInUrls(result.snippet);
      const matchingUrl = linkedinUrls.find(u => u.id === targetLinkedinId);

      if (matchingUrl) {
        // Check for team page (multiple different LinkedIn URLs) -> Tier 2
        const uniqueIds = new Set(linkedinUrls.map(u => u.id));
        if (uniqueIds.size > 1) {
          console.log(`[BridgeSignal] Multiple LinkedIn URLs in snippet (${uniqueIds.size}), using linkedin_url_in_team_page (Tier 2)`);
          // Team page signal - Tier 2, no auto-merge
          signals.push('linkedin_url_in_team_page');
        } else if (!signals.includes('linkedin_url_in_bio') && !signals.includes('linkedin_url_in_team_page')) {
          // Only add if not already found in bio
          signals.push('linkedin_url_in_page');
        }
      }
    }

    // Check for cross-platform handle match (e.g., same username)
    // TIER 2: Requires non-generic handle match
    if (result.platformId && hints.linkedinId) {
      const platformId = result.platformId.toLowerCase();
      const linkedinId = hints.linkedinId.toLowerCase();

      // Skip if handle is too generic (dev, alex, john, etc.)
      if (!isGenericHandle(platformId) && !isGenericHandle(linkedinId)) {
        // Normalize for comparison (remove hyphens, underscores, trailing numbers)
        const normalizedPlatformId = platformId.replace(/[-_]/g, '');
        const normalizedLinkedinId = linkedinId.replace(/[-_]/g, '').replace(/\d+$/, '');

        if (normalizedPlatformId === normalizedLinkedinId) {
          signals.push('cross_platform_handle');
        }
      }
    }

    // If no meaningful signals found, return 'none'
    if (signals.length === 0) {
      signals.push('none');
    }

    return signals;
  }

  /**
   * Classify confidence into buckets
   */
  protected classifyConfidence(
    confidence: number
  ): 'auto_merge' | 'suggest' | 'low' | 'rejected' {
    if (confidence >= 0.9) return 'auto_merge';
    if (confidence >= 0.7) return 'suggest';
    if (confidence >= 0.35) return 'low';
    return 'rejected';
  }

  /**
   * Generate human-readable persist reason from bridge and score
   */
  protected formatPersistReason(
    bridge: ReturnType<typeof createBridgeDetection>,
    score: ScoreBreakdown
  ): string {
    const signalDescriptions: Record<BridgeSignal, string> = {
      'linkedin_url_in_bio': 'LinkedIn URL in bio',
      'linkedin_url_in_blog': 'LinkedIn URL in website',
      'linkedin_url_in_page': 'LinkedIn URL on page',
      'linkedin_url_in_team_page': 'LinkedIn URL on team page',
      'reverse_link_hint_match': 'Reverse-link page corroborates company/location',
      'commit_email_domain': 'Commit email matches domain',
      'cross_platform_handle': 'Same username',
      'mutual_reference': 'Mutual reference',
      'verified_domain': 'Verified domain',
      'email_in_public_page': 'Email on page',
      'conference_speaker': 'Conference speaker',
      'none': 'Search match',
    };

    const signals = bridge.signals.filter(s => s !== 'none');
    const signalText = signals.length > 0
      ? signals.map(s => signalDescriptions[s] || s).join(', ')
      : this.formatScoreReason(score);

    if (bridge.tier === 1) {
      const autoMerge = score.total >= 0.90;
      return autoMerge
        ? `Tier 1, auto-merge eligible (${(score.total * 100).toFixed(0)}% >= 90%): ${signalText}`
        : `Tier 1 bridge detected (${(score.total * 100).toFixed(0)}% < 90% auto-merge): ${signalText}`;
    }
    if (bridge.tier === 2) {
      return `Tier 2 (review): ${signalText}`;
    }
    return `Tier 3 (${(score.total * 100).toFixed(0)}%): ${signalText}`;
  }

  /**
   * Generate reason from score breakdown when no bridge signals
   */
  private formatScoreReason(score: ScoreBreakdown): string {
    const parts: string[] = [];

    if ((score.handleMatch ?? 0) > 0.3) {
      parts.push(`handle ${((score.handleMatch ?? 0) * 100).toFixed(0)}%`);
    }
    if (score.nameMatch > 0.1) {
      parts.push(`name ${(score.nameMatch * 100 / 0.30).toFixed(0)}%`);
    }
    if (score.companyMatch > 0) {
      parts.push('company match');
    }
    if (score.locationMatch > 0) {
      parts.push('location match');
    }

    return parts.length > 0 ? parts.join(', ') : 'search result';
  }

  /**
   * Main discovery method - discovers identities from search results
   * Phase B: Now uses QueryCandidate with validation gate
   */
  async discover(
    hints: CandidateHints,
    options?: DiscoveryOptions
  ): Promise<BridgeDiscoveryResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startTime = Date.now();
    const identities: DiscoveredIdentity[] = [];
    const searchQueries: string[] = [];
    let queriesExecuted = 0;

    // Diagnostics tracking
    const config = getEnrichmentProviderConfig();
    let totalRawResults = 0;
    let totalMatchedResults = 0;
    let wasRateLimited = false;
    let identitiesAboveThreshold = 0;
    let queriesRejected = 0;
    const rejectionReasons: string[] = [];
    const variantsExecuted: string[] = [];
    const variantsRejected: string[] = [];
    const unmatchedSampleUrls: string[] = [];
    const unmatchedSeen = new Set<string>();
    let lastProvider: string = config.primary;

    // Get query candidates - use new interface if available, else convert legacy
    const candidates: QueryCandidate[] = this.buildQueryCandidates
      ? this.buildQueryCandidates(hints, opts.maxQueries)
      : this.buildQueries(hints, opts.maxQueries).map(query => ({
          query,
          mode: inferQueryMode(query),
          variantId: 'legacy',
        }));

    if (candidates.length === 0) {
      console.log(`[${this.displayName}] No queries to execute for ${hints.linkedinId}`);
      return {
        platform: this.platform,
        identities: [],
        queriesExecuted: 0,
        searchQueries: [],
        durationMs: Date.now() - startTime,
        error: 'no_queries',
        diagnostics: {
          queriesAttempted: 0,
          queriesRejected: 0,
          rejectionReasons: [],
          variantsExecuted: [],
          variantsRejected: [],
          rawResultCount: 0,
          matchedResultCount: 0,
          unmatchedSampleUrls: [],
          identitiesAboveThreshold: 0,
          rateLimited: false,
          provider: config.primary,
        },
      };
    }

    const seenIds = new Set<string>();

    // Execute validated queries
    for (const candidate of candidates) {
      // Enforce max query budget per platform (normalization may add an extra query)
      if (queriesExecuted >= opts.maxQueries) {
        console.log(
          `[${this.displayName}] Budget reached (${opts.maxQueries} queries), stopping for ${hints.linkedinId}`
        );
        break;
      }

      // Validation gate - reject bad queries before wasting budget
      const validation = validateQuery(this.platform, candidate.query, hints, candidate.mode);
      if (!validation.valid) {
        queriesRejected++;
        if (rejectionReasons.length < MAX_REJECTION_REASONS) {
          const reason = `${candidate.mode}:${validation.reason || 'unknown'}`;
          rejectionReasons.push(reason);
        }
        // Track rejected variant for canonical aggregation
        if (candidate.variantId) {
          variantsRejected.push(candidate.variantId);
        }
        console.log(
          `[${this.displayName}] Query rejected (${candidate.mode}): "${candidate.query}" - ${validation.reason}`
        );
        continue;
      }

      try {
        const runSearch = async (
          query: string,
          variantId: string | undefined,
          mode: typeof candidate.mode
        ) => {
          queriesExecuted++;
          searchQueries.push(query);
          if (variantId) variantsExecuted.push(variantId);

          console.log(
            `[${this.displayName}] Query ${queriesExecuted}/${opts.maxQueries}: "${query}" [${mode}]${variantId ? ` (${variantId})` : ''}`
          );

          const searchResult = await searchForPlatformWithMeta(this.platform, query, opts.maxResults);
          totalRawResults += searchResult.rawResultCount;
          totalMatchedResults += searchResult.matchedResultCount;
          lastProvider = searchResult.provider;
          if (searchResult.rateLimited) wasRateLimited = true;
          if (searchResult.unmatchedSampleUrls?.length) {
            for (const url of searchResult.unmatchedSampleUrls) {
              if (unmatchedSampleUrls.length >= 3) break;
              if (unmatchedSeen.has(url)) continue;
              unmatchedSeen.add(url);
              unmatchedSampleUrls.push(url);
            }
          }

          return searchResult;
        };

        // Execute primary query
        let searchResult = await runSearch(candidate.query, candidate.variantId, candidate.mode);

        // Phase B3: If name-mode query returns 0 matched results and looks non-ASCII/punctuated,
        // try a normalized variant (diacritics folded + punctuation normalized in quoted phrases).
        if (
          isQueryNormalizationEnabled() &&
          candidate.mode === 'name' &&
          searchResult.matchedResultCount === 0 &&
          shouldTryNormalizeQuery(candidate.query) &&
          queriesExecuted < opts.maxQueries
        ) {
          const normalizedQuery = normalizeNameModeQuery(candidate.query);
          if (normalizedQuery !== candidate.query) {
            const normalizedVariantId = candidate.variantId
              ? `${candidate.variantId}_folded`
              : 'name:full_folded';
            const normalizedResult = await runSearch(normalizedQuery, normalizedVariantId, candidate.mode);

            // Prefer the result set that produces more platform-matched URLs.
            if (
              normalizedResult.matchedResultCount > searchResult.matchedResultCount ||
              (normalizedResult.matchedResultCount === searchResult.matchedResultCount &&
                normalizedResult.rawResultCount > searchResult.rawResultCount)
            ) {
              searchResult = normalizedResult;
            }
          }
        }

        for (const result of searchResult.results) {
          if (!result.platformId) continue;

          // Skip duplicates
          if (seenIds.has(result.platformId.toLowerCase())) continue;
          seenIds.add(result.platformId.toLowerCase());

          // Extract profile info
          const profileInfo = this.extractProfileInfo(result);

          // Calculate score
          const scoreBreakdown = this.calculateScore(hints, result, profileInfo);

          // Detect bridge signals BEFORE applying minConfidence filter
          // Tier-1/Tier-2 signals can override the confidence threshold
          const bridgeSignals = this.detectBridgeSignals(hints, result, profileInfo);
          const bridge = createBridgeDetection(bridgeSignals, result.url);

          // Skip if below threshold UNLESS we have strong bridge signals (Tier 1 or 2)
          const hasStrongBridgeSignals = bridge.tier === 1 || bridge.tier === 2;
          if (scoreBreakdown.total < opts.minConfidence && !hasStrongBridgeSignals) {
            console.log(
              `[${this.displayName}] Skipping ${result.platformId} (confidence: ${scoreBreakdown.total.toFixed(2)} < ${opts.minConfidence}, no strong bridge signals)`
            );
            continue;
          }

          // Log if we're keeping a low-confidence match due to bridge signals
          if (scoreBreakdown.total < opts.minConfidence && hasStrongBridgeSignals) {
            console.log(
              `[${this.displayName}] Keeping ${result.platformId} despite low confidence (${scoreBreakdown.total.toFixed(2)}) due to Tier-${bridge.tier} bridge signals: ${bridge.signals.join(', ')}`
            );
          }

          identitiesAboveThreshold++;

          // Detect contradictions
          const contradictions = this.detectContradictions(hints, profileInfo);

          // Generate human-readable persist reason
          const persistReason = this.formatPersistReason(bridge, scoreBreakdown);

          // Create identity
          const identity: DiscoveredIdentity = {
            platform: this.platform,
            platformId: result.platformId,
            profileUrl: result.platformProfileUrl || result.url,
            displayName: profileInfo.name,
            confidence: scoreBreakdown.total,
            confidenceBucket: this.classifyConfidence(scoreBreakdown.total),
            scoreBreakdown,
            evidence: this.createEvidence(result),
            hasContradiction: contradictions.hasContradiction,
            contradictionNote: contradictions.note,
            platformProfile: profileInfo,
            bridgeTier: bridge.tier,
            bridgeSignals: bridge.signals,
            persistReason,
            serpPosition: result.position,
          };

          identities.push(identity);

          console.log(
            `[${this.displayName}] Found: ${result.platformId} (confidence: ${scoreBreakdown.total.toFixed(2)}, tier: ${bridge.tier}, bucket: ${identity.confidenceBucket})`
          );

          // Early stop on high confidence match
          if (scoreBreakdown.total >= 0.9) {
            console.log(`[${this.displayName}] Early stop: high confidence match found`);
            break;
          }
        }

        // Early stop if we found high confidence match
        if (identities.some((i) => i.confidence >= 0.9)) {
          break;
        }
      } catch (error) {
        console.error(
          `[${this.displayName}] Query failed: "${candidate.query}"`,
          error instanceof Error ? error.message : error
        );
        // Check for rate limiting in error
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (/rate.?limit|429|too many requests/i.test(errorMsg)) {
          wasRateLimited = true;
        }
      }
    }

    // Sort by confidence, then SERP position tiebreaker (0.01 epsilon)
    identities.sort((a, b) => {
      const confDiff = b.confidence - a.confidence;
      if (Math.abs(confDiff) > 0.01) return confDiff;
      return (a.serpPosition ?? Infinity) - (b.serpPosition ?? Infinity);
    });

    // Build diagnostics with accurate rejection tracking and variant info
    const diagnostics: PlatformDiagnostics = {
      queriesAttempted: candidates.length,
      queriesRejected,
      rejectionReasons,
      variantsExecuted,
      variantsRejected,
      rawResultCount: totalRawResults,
      matchedResultCount: totalMatchedResults,
      unmatchedSampleUrls,
      identitiesAboveThreshold,
      rateLimited: wasRateLimited,
      provider: lastProvider,
    };

    const result: BridgeDiscoveryResult = {
      platform: this.platform,
      identities,
      queriesExecuted,
      searchQueries,
      durationMs: Date.now() - startTime,
      diagnostics,
    };

    console.log(
      `[${this.displayName}] Completed for ${hints.linkedinId}: ${identities.length} identities, ${queriesExecuted} queries (${queriesRejected} rejected), ${result.durationMs}ms (raw: ${totalRawResults}, matched: ${totalMatchedResults})`
    );

    return result;
  }

  /**
   * Health check using search provider health
   */
  async healthCheck(): Promise<SourceHealthCheck> {
    try {
      const health = await checkProvidersHealth();
      return {
        healthy: health.primary.healthy || (health.fallback?.healthy ?? false),
        error: health.primary.error || health.fallback?.error,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

export default BaseEnrichmentSource;
