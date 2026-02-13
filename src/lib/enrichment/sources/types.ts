/**
 * Enrichment Source Types - v2.1 Matrix Support
 *
 * Common types for all enrichment sources to enable multi-platform
 * identity discovery with consistent scoring and evidence tracking.
 */

import type { RoleType } from '@/types/linkedin';
import type { BridgeSignal, BridgeTier, ShadowScoringSummary, Tier1ShadowDiagnostics } from '../bridge-types';
import type { ScoringMode } from '../scoring-metadata';

/**
 * Supported enrichment platforms
 */
export type EnrichmentPlatform =
  // Code & Engineering
  | 'github'
  | 'stackoverflow'
  | 'npm'
  | 'pypi'
  | 'dockerhub'
  | 'leetcode'
  | 'hackerearth'
  | 'codepen'
  | 'gitlab'
  | 'gist'
  | 'devto'
  // Data Science & ML
  | 'kaggle'
  | 'huggingface'
  | 'paperswithcode'
  | 'openreview'
  // Academic & Authority
  | 'orcid'
  | 'scholar'
  | 'semanticscholar'
  | 'researchgate'
  | 'arxiv'
  | 'patents'
  | 'university'
  // Business & Founder
  | 'sec'
  | 'companyteam'
  | 'angellist'
  | 'crunchbase'
  // Content & Thought Leadership
  | 'medium'
  | 'substack'
  | 'youtube'
  | 'twitter'
  // Design
  | 'dribbble'
  | 'behance';

/**
 * Hints extracted from search snippets for identity matching
 */
export interface CandidateHints {
  linkedinId: string;
  linkedinUrl: string;
  nameHint: string | null;
  headlineHint: string | null;
  locationHint: string | null;
  companyHint: string | null;
  roleType: RoleType | null;
}

/**
 * Evidence pointer - reference to verifiable data (NOT storing PII)
 */
export interface EvidencePointer {
  type: 'commit_email' | 'profile_link' | 'publication' | 'patent' | 'package' | 'post' | 'project';
  sourceUrl: string;
  sourcePlatform: EnrichmentPlatform;
  description: string;
  capturedAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * Score breakdown for transparency (all fields are numeric for UI rendering)
 */
export interface ScoreBreakdown {
  bridgeWeight: number;
  nameMatch: number;
  /** Handle/ID match weight (linkedinId vs platformId) - strong signal for handle platforms */
  handleMatch: number;
  companyMatch: number;
  locationMatch: number;
  profileCompleteness: number;
  activityScore: number;
  total: number;
  scoringVersion?: string;
  scoringMode?: ScoringMode;
}

/**
 * Discovered identity from a platform
 */
export interface DiscoveredIdentity {
  platform: EnrichmentPlatform;
  platformId: string;
  profileUrl: string;
  displayName: string | null;
  confidence: number;
  confidenceBucket: 'auto_merge' | 'suggest' | 'low' | 'rejected';
  scoreBreakdown: ScoreBreakdown;
  evidence: EvidencePointer[];
  hasContradiction: boolean;
  contradictionNote: string | null;
  platformProfile: {
    name: string | null;
    bio: string | null;
    company: string | null;
    location: string | null;
    followers?: number;
    reputation?: number;
    publicRepos?: number;
    publications?: number;
  };
  /** Bridge tier classification (v2.1) */
  bridgeTier?: 1 | 2 | 3;
  /** Bridge signals detected */
  bridgeSignals?: string[];
  /** Reason for persistence decision */
  persistReason?: string;
  /** SERP position for tiebreaker sorting */
  serpPosition?: number;
}

/**
 * Per-platform diagnostics for debugging enrichment runs
 */
export interface PlatformDiagnostics {
  /** Queries attempted (before validation) */
  queriesAttempted: number;
  /** Queries rejected by quality gate */
  queriesRejected: number;
  /** Rejection reasons */
  rejectionReasons: string[];
  /** Raw variantIds of executed queries (for canonical aggregation) */
  variantsExecuted: string[];
  /** Raw variantIds of rejected queries (for canonical aggregation) */
  variantsRejected: string[];
  /** Raw results from search (before URL filtering) */
  rawResultCount: number;
  /** Results after URL pattern matching */
  matchedResultCount: number;
  /** Sample unmatched URLs (diagnostics only, max 3) */
  unmatchedSampleUrls?: string[];
  /** Identities that passed scoring threshold */
  identitiesAboveThreshold: number;
  /** Was rate limited or blocked? */
  rateLimited: boolean;
  /** Provider used */
  provider: string;
  /** Shadow scoring diagnostics (dynamic vs static comparison) */
  shadowScoring?: ShadowScoringSummary;
  /** Primary scorer version used for persisted/static scores */
  scoringVersion?: string;
  /** Dynamic scorer version when shadow scoring is enabled */
  dynamicScoringVersion?: string;
  /** Scoring mode for this platform run */
  scoringMode?: ScoringMode;
  /** Tier-1 shadow evaluation diagnostics */
  tier1Shadow?: Tier1ShadowDiagnostics;
}

/**
 * Result from bridge discovery
 */
export interface BridgeDiscoveryResult {
  platform: EnrichmentPlatform;
  identities: DiscoveredIdentity[];
  queriesExecuted: number;
  searchQueries: string[];
  durationMs: number;
  error?: string;
  /** Per-platform diagnostics for observability */
  diagnostics?: PlatformDiagnostics;
}

/**
 * Options for enrichment source discovery
 */
export interface DiscoveryOptions {
  maxResults?: number;
  maxQueries?: number;
  timeout?: number;
  minConfidence?: number;
}

/**
 * Health check result for a source
 */
export interface SourceHealthCheck {
  healthy: boolean;
  authenticated?: boolean;
  rateLimit?: {
    remaining: number;
    limit: number;
    resetAt?: string;
  };
  error?: string;
}

/**
 * Query mode for validation and execution
 * - 'handle': Query targets a handle-based URL pattern (e.g., site:leetcode.com/u/johndoe)
 * - 'name': Query targets name-based search (e.g., site:medium.com "John Doe")
 */
export type QueryMode = 'handle' | 'name';

/**
 * Query candidate with mode metadata for validation
 * Produced by platform sources, validated by executor
 */
export interface QueryCandidate {
  /** The search query string */
  query: string;
  /** Query mode for validation rules */
  mode: QueryMode;
  /** Optional variant identifier for debugging (e.g., 'collapsed', 'underscore', 'name+company') */
  variantId?: string;
}

/**
 * Infer query mode from query string pattern
 * Used for backward compatibility with legacy buildQueries() that return string[]
 */
export function inferQueryMode(query: string): QueryMode {
  // Handle-pattern indicators in URLs
  const handlePatterns = [
    '/u/',      // leetcode.com/u/, hub.docker.com/u/
    '/~',       // npmjs.com/~
    '/@',       // medium.com/@, hackerearth.com/@
    '/users/',  // gitlab.com/users/, pypi.org/user/
  ];

  for (const pattern of handlePatterns) {
    if (query.includes(pattern)) {
      return 'handle';
    }
  }

  // Also check for direct handle patterns like site:gitlab.com/username (no /users/)
  // These are handle-mode if they're site: + domain + single path segment
  const directHandleMatch = query.match(/site:([a-z.]+)\/([a-z0-9_-]+)$/i);
  if (directHandleMatch) {
    return 'handle';
  }

  return 'name';
}

/**
 * Abstract enrichment source interface
 */
export interface EnrichmentSource {
  /** Platform identifier */
  readonly platform: EnrichmentPlatform;

  /** Human-readable name */
  readonly displayName: string;

  /** Supported role types for this source */
  readonly supportedRoles: RoleType[];

  /** Base confidence weight for this source */
  readonly baseWeight: number;

  /** Query pattern template */
  readonly queryPattern: string;

  /**
   * Discover identities matching the candidate hints
   */
  discover(hints: CandidateHints, options?: DiscoveryOptions): Promise<BridgeDiscoveryResult>;

  /**
   * Check if the source is healthy and available
   */
  healthCheck(): Promise<SourceHealthCheck>;

  /**
   * Build search queries for this platform (legacy interface)
   * @deprecated Use buildQueryCandidates() for new implementations
   */
  buildQueries(hints: CandidateHints, maxQueries?: number): string[];

  /**
   * Build query candidates with mode metadata for validation
   * Optional - if not implemented, buildQueries() is used with inferred modes
   */
  buildQueryCandidates?(hints: CandidateHints, maxQueries?: number): QueryCandidate[];
}

/**
 * Role-based source priority configuration
 * Only includes sources that are actually implemented in the registry
 *
 * Note: GitHub is handled via direct API, not search-based discovery.
 * It's listed here for priority ordering but actual GitHub discovery
 * happens in bridge-discovery.ts before search-based sources.
 */
export const ROLE_SOURCE_PRIORITY: Record<RoleType, EnrichmentPlatform[]> = {
  engineer: [
    'github',        // Direct API (bridge-discovery.ts)
    'stackoverflow', // Implemented
    'npm',           // Implemented
    'pypi',          // Implemented
    'leetcode',      // Implemented
    'hackerearth',   // Implemented
    'gitlab',        // Implemented
    'dockerhub',     // Implemented
    'codepen',       // Implemented
    'gist',          // Implemented
    'devto',         // Implemented
  ],
  data_scientist: [
    'github',          // Direct API
    'kaggle',          // Implemented
    'huggingface',     // Implemented
    'paperswithcode',  // Implemented
    'openreview',      // Implemented
    'scholar',         // Implemented
    'gist',            // Implemented
    'stackoverflow',   // Implemented
  ],
  researcher: [
    'orcid',           // Implemented
    'scholar',         // Implemented
    'semanticscholar', // Implemented
    'openreview',      // Implemented
    'researchgate',    // Implemented
    'arxiv',           // Implemented
    'patents',         // Implemented
    'university',      // Implemented
    'github',          // Direct API
  ],
  designer: [
    'dribbble',  // Implemented
    'behance',   // Implemented
    'github',    // Direct API
    'codepen',   // Implemented
    'twitter',   // Implemented
    'medium',    // Implemented
  ],
  founder: [
    'sec',          // Implemented
    'crunchbase',   // Implemented
    'angellist',    // Implemented
    'companyteam',  // Implemented
    'github',       // Direct API
    'twitter',      // Implemented
    'medium',       // Implemented
    'youtube',      // Implemented
    'substack',     // Implemented
  ],
  general: [
    'github',        // Direct API
    'stackoverflow', // Implemented
    'twitter',       // Implemented
    'medium',        // Implemented
    'companyteam',   // Implemented
  ],
};

/**
 * Source configuration with weights and guards
 */
export interface SourceConfig {
  platform: EnrichmentPlatform;
  displayName: string;
  weight: number;
  guard?: {
    condition: string;
    fallbackWeight: number;
  };
  queryPattern: string;
  supportedRoles: RoleType[];
}

/**
 * Full source matrix configuration from v2.1 architecture
 */
export const SOURCE_MATRIX: SourceConfig[] = [
  // Code & Engineering
  {
    platform: 'github',
    displayName: 'GitHub',
    weight: 0.6,
    queryPattern: 'site:github.com "{name}" "{company}"',
    supportedRoles: ['engineer', 'data_scientist', 'researcher', 'founder', 'general'],
  },
  {
    platform: 'stackoverflow',
    displayName: 'Stack Overflow',
    weight: 0.15,
    queryPattern: 'site:stackoverflow.com/users "{name}"',
    supportedRoles: ['engineer', 'data_scientist', 'general'],
  },
  {
    platform: 'npm',
    displayName: 'npm',
    weight: 0.2,
    queryPattern: 'site:npmjs.com "{name}" author',
    guard: { condition: 'email_domain_match', fallbackWeight: 0.1 },
    supportedRoles: ['engineer'],
  },
  {
    platform: 'pypi',
    displayName: 'PyPI',
    weight: 0.2,
    queryPattern: 'site:pypi.org "{name}" maintainer',
    guard: { condition: 'email_domain_match', fallbackWeight: 0.1 },
    supportedRoles: ['engineer', 'data_scientist'],
  },
  {
    platform: 'leetcode',
    displayName: 'LeetCode',
    weight: 0.15,
    queryPattern: 'site:leetcode.com "{name}"',
    supportedRoles: ['engineer'],
  },
  {
    platform: 'gitlab',
    displayName: 'GitLab',
    weight: 0.2,
    queryPattern: 'site:gitlab.com/users "{name}"',
    guard: { condition: 'handle_overlap_or_bio_link', fallbackWeight: 0 },
    supportedRoles: ['engineer'],
  },
  {
    platform: 'hackerearth',
    displayName: 'HackerEarth',
    weight: 0.15,
    queryPattern: 'site:hackerearth.com/@{name}',
    supportedRoles: ['engineer'],
  },
  {
    platform: 'gist',
    displayName: 'GitHub Gist',
    weight: 0.1,
    queryPattern: 'site:gist.github.com "{name}"',
    supportedRoles: ['engineer', 'data_scientist'],
  },
  // Data Science & ML
  {
    platform: 'kaggle',
    displayName: 'Kaggle',
    weight: 0.25,
    queryPattern: 'site:kaggle.com "{name}"',
    supportedRoles: ['data_scientist'],
  },
  {
    platform: 'huggingface',
    displayName: 'Hugging Face',
    weight: 0.25,
    queryPattern: 'site:huggingface.co "{name}"',
    supportedRoles: ['data_scientist', 'researcher'],
  },
  {
    platform: 'paperswithcode',
    displayName: 'Papers With Code',
    weight: 0.45,
    queryPattern: 'site:paperswithcode.com "{name}"',
    supportedRoles: ['data_scientist', 'researcher'],
  },
  {
    platform: 'openreview',
    displayName: 'OpenReview',
    weight: 0.3,
    queryPattern: 'site:openreview.net "{name}"',
    supportedRoles: ['data_scientist', 'researcher'],
  },
  // Academic & Authority
  {
    platform: 'orcid',
    displayName: 'ORCID',
    weight: 0.5,
    queryPattern: 'site:orcid.org "{name}"',
    supportedRoles: ['researcher'],
  },
  {
    platform: 'scholar',
    displayName: 'Google Scholar',
    weight: 0.25,
    queryPattern: 'site:scholar.google.com "{name}"',
    supportedRoles: ['researcher', 'data_scientist'],
  },
  {
    platform: 'semanticscholar',
    displayName: 'Semantic Scholar',
    weight: 0.2,
    queryPattern: 'site:semanticscholar.org "{name}"',
    supportedRoles: ['researcher'],
  },
  {
    platform: 'arxiv',
    displayName: 'arXiv',
    weight: 0.2,
    queryPattern: 'site:arxiv.org "{name}"',
    supportedRoles: ['researcher', 'data_scientist'],
  },
  {
    platform: 'patents',
    displayName: 'Google Patents',
    weight: 0.4,
    queryPattern: 'site:patents.google.com "{name}" inventor',
    supportedRoles: ['researcher', 'engineer', 'founder'],
  },
  {
    platform: 'university',
    displayName: 'University Profile',
    weight: 0.35,
    queryPattern: '"{name}" (site:edu OR site:ac.uk) (professor OR faculty OR researcher)',
    supportedRoles: ['researcher'],
  },
  // Business & Founder
  {
    platform: 'sec',
    displayName: 'SEC EDGAR',
    weight: 0.5,
    queryPattern: 'site:sec.gov "{name}" officer director',
    supportedRoles: ['founder'],
  },
  {
    platform: 'companyteam',
    displayName: 'Company Team Page',
    weight: 0.4,
    queryPattern: '"{company}" /team "{name}"',
    supportedRoles: ['founder', 'general'],
  },
  {
    platform: 'angellist',
    displayName: 'AngelList',
    weight: 0.3,
    queryPattern: 'site:angel.co "{name}"',
    supportedRoles: ['founder'],
  },
  {
    platform: 'crunchbase',
    displayName: 'Crunchbase',
    weight: 0.35,
    queryPattern: 'site:crunchbase.com/person "{name}"',
    supportedRoles: ['founder'],
  },
  // Content & Thought Leadership
  {
    platform: 'medium',
    displayName: 'Medium',
    weight: 0.15,
    queryPattern: 'site:medium.com "@{name}"',
    supportedRoles: ['founder', 'general'],
  },
  {
    platform: 'devto',
    displayName: 'Dev.to',
    weight: 0.15,
    queryPattern: 'site:dev.to "{name}"',
    supportedRoles: ['engineer'],
  },
  {
    platform: 'twitter',
    displayName: 'Twitter/X',
    weight: 0.15,
    queryPattern: 'site:twitter.com "{name}"',
    guard: { condition: 'bio_link_or_multi_platform', fallbackWeight: 0 },
    supportedRoles: ['founder', 'general'],
  },
  {
    platform: 'youtube',
    displayName: 'YouTube',
    weight: 0.2,
    queryPattern: 'site:youtube.com "{name}" talk',
    supportedRoles: ['founder', 'researcher'],
  },
  // Design
  {
    platform: 'dribbble',
    displayName: 'Dribbble',
    weight: 0.15,
    queryPattern: 'site:dribbble.com "{name}"',
    supportedRoles: ['designer'],
  },
  {
    platform: 'behance',
    displayName: 'Behance',
    weight: 0.15,
    queryPattern: 'site:behance.net "{name}"',
    supportedRoles: ['designer'],
  },
];

/**
 * Get sources for a role type in priority order
 */
export function getSourcesForRole(roleType: RoleType): SourceConfig[] {
  const priorityOrder = ROLE_SOURCE_PRIORITY[roleType] || ROLE_SOURCE_PRIORITY.general;
  return priorityOrder
    .map((platform) => SOURCE_MATRIX.find((s) => s.platform === platform))
    .filter((s): s is SourceConfig => s !== undefined);
}

/**
 * Get source config by platform
 */
export function getSourceConfig(platform: EnrichmentPlatform): SourceConfig | undefined {
  return SOURCE_MATRIX.find((s) => s.platform === platform);
}
