/**
 * Bridge Detection Types
 *
 * Defines bridge tiers, signals, and hint confidence for identity resolution.
 * A "bridge" is an explicit or inferred link between a LinkedIn candidate
 * and another platform identity.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

/**
 * Bridge signal types - how we detected the connection
 */
export type BridgeSignal =
  | 'linkedin_url_in_bio'       // Platform bio contains LinkedIn URL
  | 'linkedin_url_in_blog'      // Platform blog/website field contains LinkedIn URL
  | 'linkedin_url_in_page'      // External page links to LinkedIn URL (reverse search)
  | 'linkedin_url_in_team_page' // LinkedIn URL found on team/about page with multiple profiles (Tier 2)
  | 'reverse_link_hint_match'   // Reverse-link page hints corroborate candidate company/location
  | 'commit_email_domain'       // Commit email matches company domain
  | 'cross_platform_handle'     // Same handle on multiple platforms
  | 'mutual_reference'          // Both profiles reference each other
  | 'verified_domain'           // Platform-verified company domain
  | 'email_in_public_page'      // Email found in public page matching pattern
  | 'conference_speaker'        // Found as speaker at conference with LinkedIn
  | 'none';

/**
 * Bridge tier classification
 *
 * Tier 1: Explicit bidirectional/canonical link - auto-merge eligible
 * Tier 2: Strong unidirectional signals - human-in-loop, persist top-N
 * Tier 3: Weak/speculative - store as candidate, do not merge
 */
export type BridgeTier = 1 | 2 | 3;

/**
 * Bridge detection result
 */
export interface BridgeDetection {
  tier: BridgeTier;
  signals: BridgeSignal[];
  /** URL where bridge was found (if applicable) */
  bridgeUrl: string | null;
  /** Confidence floor based on bridge (Tier 1 = 0.85, Tier 2 = 0.5, Tier 3 = 0) */
  confidenceFloor: number;
  /** Whether this bridge supports auto-merge (Tier 1 only) */
  autoMergeEligible: boolean;
  /** True if no meaningful signals were found (for metrics tracking) */
  hadNoSignals: boolean;
}

/**
 * Hint source - where the hint came from
 */
export type HintSource =
  | 'serp_title'            // Parsed from SERP title
  | 'serp_snippet'          // Parsed from SERP snippet
  | 'serp_knowledge_graph'  // From Serper Knowledge Graph
  | 'serp_answer_box'       // From Serper answerBox
  | 'url_slug'              // Derived from LinkedIn URL slug
  | 'search_query'          // From original search query
  | 'headline_parse'        // Parsed from headline text
  | 'unknown';

/**
 * Hint with confidence and provenance
 */
export interface HintWithConfidence {
  value: string | null;
  confidence: number;  // 0.0 - 1.0
  source: HintSource;
}

/**
 * All hints with confidence tracking
 */
export interface EnrichedHints {
  nameHint: HintWithConfidence;
  headlineHint: HintWithConfidence;
  locationHint: HintWithConfidence;
  companyHint: HintWithConfidence;
  /** LinkedIn ID (always high confidence since it's from URL) */
  linkedinId: string;
  linkedinUrl: string;
  roleType: string | null;
}

/**
 * Query type classification for metrics
 */
export type QueryType =
  | 'name_only'           // Just name
  | 'name_company'        // Name + company
  | 'name_location'       // Name + location
  | 'company_only'        // Company-centric (when name is weak)
  | 'company_location'    // Company + location (when name is weak)
  | 'slug_based'          // Derived from URL slug
  | 'handle_based'        // Using platform handle patterns
  | 'url_reverse'         // Searching for pages linking TO LinkedIn URL
  | 'company_amplified';  // Query amplified with company context

/**
 * Query with metadata for tracking
 */
export interface TrackedQuery {
  query: string;
  type: QueryType;
  /** Variant ID for deduplication */
  variantId: string;
}

/**
 * Enrichment run metrics
 */
export interface EnrichmentMetrics {
  /** Query breakdown by type */
  queriesByType: Record<QueryType, number>;
  /** Total queries generated */
  totalQueries: number;
  /** Candidates found from searches */
  candidatesFound: number;
  /** Bridges detected by signal type */
  bridgesBySignal: Record<BridgeSignal, number>;
  /** Total bridges found */
  totalBridges: number;
  /** Identities by tier */
  identitiesByTier: Record<BridgeTier, number>;
  /** Whether any Tier 1 bridge was found */
  hasTier1Bridge: boolean;
  /** Shadow scoring diagnostics (dynamic vs static comparison) */
  shadowScoring?: ShadowScoringSummary;
  /** Primary scorer version used for persisted/static scores */
  scoringVersion?: string;
  /** Dynamic scorer version when shadow scoring is emitted */
  dynamicScoringVersion?: string;
}

/**
 * Shadow scoring summary for runTrace diagnostics
 */
export interface ShadowScoringSummary {
  profilesScored: number;
  avgDelta: number;
  bucketChanges: number;
  staticScoringVersion?: string;
  dynamicScoringVersion?: string;
  details: Array<{
    login: string;
    staticTotal: number;
    boostedTotal?: number;
    dynamicTotal: number;
    delta: number;
    staticBucket: 'auto_merge' | 'suggest' | 'low' | 'rejected';
    dynamicBucket: 'auto_merge' | 'suggest' | 'low' | 'rejected';
    bucketChanged: boolean;
  }>;
}

/**
 * Tier 1 signals - explicit bridges that support auto-merge
 */
export const TIER_1_SIGNALS: BridgeSignal[] = [
  'linkedin_url_in_bio',
  'linkedin_url_in_blog',
  'linkedin_url_in_page',
  'mutual_reference',
];

/**
 * Tier 2 signals - strong signals that need human review
 */
export const TIER_2_SIGNALS: BridgeSignal[] = [
  'linkedin_url_in_team_page',  // Team page with multiple LinkedIn profiles
  'reverse_link_hint_match',    // Reverse-link page corroborates company/location
  'commit_email_domain',
  'cross_platform_handle',
  'verified_domain',
  'email_in_public_page',
  'conference_speaker',
];

/**
 * Determine bridge tier from signals
 */
export function determineBridgeTier(signals: BridgeSignal[]): BridgeTier {
  if (signals.length === 0 || signals.every(s => s === 'none')) {
    return 3;
  }

  // Any Tier 1 signal = Tier 1
  if (signals.some(s => TIER_1_SIGNALS.includes(s))) {
    return 1;
  }

  // Any Tier 2 signal = Tier 2
  if (signals.some(s => TIER_2_SIGNALS.includes(s))) {
    return 2;
  }

  return 3;
}

/**
 * Get confidence floor for a tier
 */
export function getConfidenceFloor(tier: BridgeTier): number {
  switch (tier) {
    case 1: return 0.85;  // Tier 1 gets high confidence floor
    case 2: return 0.50;  // Tier 2 gets medium confidence floor
    case 3: return 0.00;  // Tier 3 has no floor
  }
}

/**
 * Create a bridge detection result
 */
export function createBridgeDetection(
  signals: BridgeSignal[],
  bridgeUrl: string | null = null
): BridgeDetection {
  const tier = determineBridgeTier(signals);
  const confidenceFloor = getConfidenceFloor(tier);
  // Track if no meaningful signals (only 'none' or empty)
  const hadNoSignals = signals.length === 0 || signals.every(s => s === 'none');

  return {
    tier,
    signals: signals.filter(s => s !== 'none'),
    bridgeUrl,
    confidenceFloor,
    autoMergeEligible: tier === 1,
    hadNoSignals,
  };
}

/**
 * Create empty metrics object
 */
export function createEmptyMetrics(): EnrichmentMetrics {
  return {
    queriesByType: {
      name_only: 0,
      name_company: 0,
      name_location: 0,
      company_only: 0,
      company_location: 0,
      slug_based: 0,
      handle_based: 0,
      url_reverse: 0,
      company_amplified: 0,
    },
    totalQueries: 0,
    candidatesFound: 0,
    bridgesBySignal: {
      linkedin_url_in_bio: 0,
      linkedin_url_in_blog: 0,
      linkedin_url_in_page: 0,
      linkedin_url_in_team_page: 0,
      reverse_link_hint_match: 0,
      commit_email_domain: 0,
      cross_platform_handle: 0,
      mutual_reference: 0,
      verified_domain: 0,
      email_in_public_page: 0,
      conference_speaker: 0,
      none: 0,
    },
    totalBridges: 0,
    identitiesByTier: { 1: 0, 2: 0, 3: 0 },
    hasTier1Bridge: false,
  };
}

/**
 * Tier 2 persistence cap (global)
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('BridgeTypes');

function getTier2Cap(defaultValue: number = 3): number {
  const raw = process.env.ENRICHMENT_TIER2_CAP;
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  log.warn({ raw, default: defaultValue }, 'Invalid ENRICHMENT_TIER2_CAP, using default');
  return defaultValue;
}

export const TIER_2_CAP = getTier2Cap(3);

export default {
  determineBridgeTier,
  getConfidenceFloor,
  createBridgeDetection,
  createEmptyMetrics,
  TIER_1_SIGNALS,
  TIER_2_SIGNALS,
  TIER_2_CAP,
};
