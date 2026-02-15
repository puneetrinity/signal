/**
 * Identity Confidence Scoring
 *
 * Calculates confidence scores for identity matches based on:
 * - Bridge evidence (commit URLs, profile links)
 * - Name matching
 * - Company matching
 * - Location matching
 * - Profile completeness
 *
 * Confidence buckets:
 * - auto_merge: >= 0.9 (very high confidence, could auto-confirm)
 * - suggest: >= 0.7 (high confidence, recommend to recruiter)
 * - low: >= 0.35 (possible match, needs review)
 * - rejected: < 0.35 (unlikely match)
 *
 * Bridge tiers (v2.1):
 * - Tier 1: Explicit bidirectional link - auto-merge eligible
 * - Tier 2: Strong unidirectional signals - human review
 * - Tier 3: Weak/speculative - store as candidate only
 *
 * NOTE: Bridge tiering + auto-merge logic is protected by offline eval harness.
 * Changes require fixture updates + CI gate review.
 * @see eval/TODO.md for invariants and metrics.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import {
  type BridgeTier,
  type BridgeSignal,
  type BridgeDetection,
  createBridgeDetection,
  TIER_2_CAP,
} from './bridge-types';
import {
  STATIC_SCORER_VERSION,
  DYNAMIC_SCORER_VERSION,
  type ScoringMode,
} from './scoring-metadata';
import { getEnrichmentMinConfidenceThreshold } from './config';

/**
 * Score breakdown for transparency
 *
 * Weight distribution (without bridge evidence, max = 0.60):
 * - Name match: 30% (increased from 25% to allow name-only matches)
 * - Company match: 15%
 * - Location match: 10%
 * - Profile completeness: 5% (reduced to compensate for name increase)
 */
export interface ScoreBreakdown {
  bridgeWeight: number; // 0-0.4 based on evidence type
  nameMatch: number; // 0-0.25 based on name similarity
  /** Handle/ID match weight (linkedinId vs platformId) - strong signal for handle platforms */
  handleMatch: number; // 0-0.30 based on handle match
  companyMatch: number; // 0-0.10 based on company match
  locationMatch: number; // 0-0.05 based on location match
  profileCompleteness: number; // 0-1 based on profile data completeness
  activityScore: number; // 0-1 based on platform activity metrics
  total: number; // Sum of all weights
  scoringVersion?: string;
  scoringMode?: ScoringMode;
}

/**
 * Confidence bucket classification
 */
export type ConfidenceBucket = 'auto_merge' | 'suggest' | 'low' | 'rejected';

/**
 * Scoring input data
 */
export interface ScoringInput {
  // Evidence
  hasCommitEvidence: boolean;
  commitCount: number;
  hasProfileLink: boolean; // LinkedIn link in GitHub bio/blog
  profileLinkSource?: 'bio' | 'blog';  // where the LinkedIn URL was found

  // Name comparison
  candidateName: string | null;
  platformName: string | null;

  // Company comparison
  candidateHeadline: string | null;
  platformCompany: string | null;

  // Location comparison
  candidateLocation: string | null;
  platformLocation: string | null;

  // Platform profile
  platformFollowers?: number;
  platformRepos?: number;
  platformBio?: string | null;

  // Hint confidence from EnrichedHints (optional, for dynamic scoring)
  nameHintConfidence?: number;
  companyHintConfidence?: number;
  locationHintConfidence?: number;
}

/**
 * Normalize string for comparison
 */
function normalize(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    // Keep all Unicode letters/numbers so non-Latin names are comparable.
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate name similarity score (0-1)
 * Uses token overlap for robustness to name variations
 */
function calculateNameSimilarity(name1: string | null, name2: string | null): number {
  const n1 = normalize(name1);
  const n2 = normalize(name2);

  if (!n1 || !n2) return 0;

  // Exact match
  if (n1 === n2) return 1;

  // Token-based matching
  const tokens1 = new Set(n1.split(/\s+/).filter((t) => t.length > 1));
  const tokens2 = new Set(n2.split(/\s+/).filter((t) => t.length > 1));

  if (tokens1.size === 0 || tokens2.size === 0) return 0;

  // Calculate Jaccard similarity
  const intersection = [...tokens1].filter((t) => tokens2.has(t)).length;
  const union = new Set([...tokens1, ...tokens2]).size;

  const jaccard = intersection / union;

  // Bonus for first/last name match
  const arr1 = [...tokens1];
  const arr2 = [...tokens2];
  const firstNameMatch = arr1[0] === arr2[0] ? 0.1 : 0;
  const lastNameMatch =
    arr1[arr1.length - 1] === arr2[arr2.length - 1] ? 0.1 : 0;

  return Math.min(1, jaccard + firstNameMatch + lastNameMatch);
}

/**
 * Check if company names match
 * Handles variations like "Google" vs "Google Inc" vs "Google LLC"
 */
function calculateCompanyMatch(
  headline: string | null,
  company: string | null
): number {
  const h = normalize(headline);
  const c = normalize(company);

  if (!h || !c) return 0;

  // Direct inclusion check
  if (h.includes(c) || c.includes(h)) return 1;

  // Token overlap
  const headlineTokens = new Set(h.split(/\s+/).filter((t) => t.length > 2));
  const companyTokens = c.split(/\s+/).filter((t) => t.length > 2);

  // Check if any company token appears in headline
  for (const token of companyTokens) {
    if (headlineTokens.has(token)) return 0.8;
  }

  return 0;
}

/**
 * Check if locations match
 * Handles variations like "San Francisco" vs "SF" vs "San Francisco, CA"
 */
function calculateLocationMatch(
  loc1: string | null,
  loc2: string | null
): number {
  const l1 = normalize(loc1);
  const l2 = normalize(loc2);

  if (!l1 || !l2) return 0;

  // Direct inclusion
  if (l1.includes(l2) || l2.includes(l1)) return 1;

  // Common city abbreviations
  const abbreviations: Record<string, string[]> = {
    'san francisco': ['sf', 'san fran'],
    'new york': ['ny', 'nyc', 'new york city'],
    'los angeles': ['la'],
    'washington': ['dc', 'washington dc'],
    'united states': ['us', 'usa'],
    israel: ['il', 'tel aviv', 'tlv'],
    'united kingdom': ['uk', 'london'],
  };

  for (const [full, abbrevs] of Object.entries(abbreviations)) {
    const matches1 = l1.includes(full) || abbrevs.some((a) => l1.includes(a));
    const matches2 = l2.includes(full) || abbrevs.some((a) => l2.includes(a));
    if (matches1 && matches2) return 0.8;
  }

  // Token overlap
  const tokens1 = new Set(l1.split(/\s+/).filter((t) => t.length > 2));
  const tokens2 = l2.split(/\s+/).filter((t) => t.length > 2);

  for (const token of tokens2) {
    if (tokens1.has(token)) return 0.5;
  }

  return 0;
}

/**
 * Calculate profile completeness score
 */
function calculateProfileCompleteness(input: ScoringInput): number {
  let score = 0;
  const maxScore = 1;

  // Has followers (indicates active account)
  if (input.platformFollowers && input.platformFollowers > 10) {
    score += 0.3;
  }

  // Has repos (for GitHub)
  if (input.platformRepos && input.platformRepos > 0) {
    score += 0.3;
  }

  // Has bio
  if (input.platformBio && input.platformBio.length > 10) {
    score += 0.2;
  }

  // Has company
  if (input.platformCompany) {
    score += 0.2;
  }

  return Math.min(score, maxScore);
}

/**
 * Calculate overall confidence score
 *
 * Weights (designed to allow name-only matches to pass threshold):
 * - Bridge evidence: 40% (strongest signal - LinkedIn link or commit evidence)
 * - Name match: 30% (increased to allow name-only matches to reach 0.35)
 * - Company match: 15%
 * - Location match: 10%
 * - Profile completeness: 5% (reduced to compensate)
 *
 * Without bridge evidence, perfect name match (0.30) + any secondary signal
 * can reach 0.35 threshold.
 */
export function calculateConfidenceScore(input: ScoringInput): ScoreBreakdown {
  // Bridge evidence weight (0-0.4)
  let bridgeWeight = 0;
  if (input.hasProfileLink) {
    // LinkedIn link in GitHub bio is very strong evidence
    bridgeWeight = 0.4;
  } else if (input.hasCommitEvidence) {
    // Commit evidence is good but not as strong
    bridgeWeight = Math.min(0.3, 0.15 + input.commitCount * 0.05);
  }

  // Name match weight (0-0.30)
  const nameSimilarity = calculateNameSimilarity(
    input.candidateName,
    input.platformName
  );
  const nameMatch = nameSimilarity * 0.30;

  // Company match weight (0-0.15)
  const companyMatchRaw = calculateCompanyMatch(
    input.candidateHeadline,
    input.platformCompany
  );
  const companyMatch = companyMatchRaw * 0.15;

  // Location match weight (0-0.1)
  const locationMatchRaw = calculateLocationMatch(
    input.candidateLocation,
    input.platformLocation
  );
  const locationMatch = locationMatchRaw * 0.1;

  // Profile completeness weight (0-0.05)
  const completenessRaw = calculateProfileCompleteness(input);
  const profileCompleteness = completenessRaw * 0.05;

  // handleMatch not used in GitHub API scoring (direct lookup, not search)
  const handleMatch = 0;

  // activityScore from profile completeness context
  const activityScore = completenessRaw;

  // Total score
  const total =
    bridgeWeight + nameMatch + companyMatch + locationMatch + profileCompleteness;

  return {
    bridgeWeight,
    nameMatch,
    handleMatch,
    companyMatch,
    locationMatch,
    profileCompleteness,
    activityScore,
    total: Math.min(1, total),
    scoringVersion: STATIC_SCORER_VERSION,
    scoringMode: 'static',
  };
}

/**
 * Shadow score comparison result
 */
export interface ShadowScoreComparison {
  staticScore: ScoreBreakdown;
  dynamicScore: ScoreBreakdown;
  delta: number; // dynamicScore.total - staticScore.total
  staticBucket: ConfidenceBucket;
  dynamicBucket: ConfidenceBucket;
  bucketChanged: boolean;
}

/**
 * Calculate dynamic confidence score (shadow mode)
 *
 * Unlike the static scorer, this modulates match weights based on hint
 * extraction confidence. Low-confidence hints get reduced weights, preventing
 * noisy hints from inflating scores.
 *
 * Production scoring is NOT affected — this runs alongside for comparison.
 */
export function calculateDynamicConfidenceScore(input: ScoringInput): ScoreBreakdown {
  // Bridge evidence weight (same as static — evidence is binary, not hint-dependent)
  let bridgeWeight = 0;
  if (input.hasProfileLink) {
    bridgeWeight = 0.4;
  } else if (input.hasCommitEvidence) {
    bridgeWeight = Math.min(0.3, 0.15 + input.commitCount * 0.05);
  }

  // Hint confidence modulation factors (default to 1.0 when not provided)
  const nameHintConf = input.nameHintConfidence ?? 1.0;
  const companyHintConf = input.companyHintConfidence ?? 1.0;
  const locationHintConf = input.locationHintConfidence ?? 1.0;

  // Name match weight (0-0.30), modulated by hint confidence
  // Low name hint confidence reduces the weight of the name comparison
  const nameSimilarity = calculateNameSimilarity(
    input.candidateName,
    input.platformName
  );
  const nameMatch = nameSimilarity * 0.30 * nameHintConf;

  // Company match weight (0-0.15), modulated by hint confidence
  const companyMatchRaw = calculateCompanyMatch(
    input.candidateHeadline,
    input.platformCompany
  );
  const companyMatch = companyMatchRaw * 0.15 * companyHintConf;

  // Location match weight (0-0.1), modulated by hint confidence
  const locationMatchRaw = calculateLocationMatch(
    input.candidateLocation,
    input.platformLocation
  );
  const locationMatch = locationMatchRaw * 0.1 * locationHintConf;

  // Profile completeness (unmodulated — platform data, not hint-dependent)
  const completenessRaw = calculateProfileCompleteness(input);
  const profileCompleteness = completenessRaw * 0.05;

  const handleMatch = 0;
  const activityScore = completenessRaw;

  const total =
    bridgeWeight + nameMatch + companyMatch + locationMatch + profileCompleteness;

  return {
    bridgeWeight,
    nameMatch,
    handleMatch,
    companyMatch,
    locationMatch,
    profileCompleteness,
    activityScore,
    total: Math.min(1, total),
    scoringVersion: DYNAMIC_SCORER_VERSION,
    scoringMode: 'shadow',
  };
}

/**
 * Compute shadow score comparison between static and dynamic scorers
 */
export function computeShadowScore(input: ScoringInput): ShadowScoreComparison {
  const staticScore = calculateConfidenceScore(input);
  const dynamicScore = calculateDynamicConfidenceScore(input);

  const staticBucket = classifyConfidence(staticScore.total);
  const dynamicBucket = classifyConfidence(dynamicScore.total);

  return {
    staticScore,
    dynamicScore,
    delta: dynamicScore.total - staticScore.total,
    staticBucket,
    dynamicBucket,
    bucketChanged: staticBucket !== dynamicBucket,
  };
}

/**
 * Classify confidence score into bucket
 */
export function classifyConfidence(score: number): ConfidenceBucket {
  if (score >= 0.9) return 'auto_merge';
  if (score >= 0.7) return 'suggest';
  if (score >= 0.35) return 'low';
  return 'rejected';
}

/**
 * Get the minimum confidence threshold for storing identities
 * Configurable via ENRICHMENT_MIN_CONFIDENCE env var (default: 0.25)
 */
function getStorageThreshold(): number {
  return getEnrichmentMinConfidenceThreshold('Scoring');
}

/**
 * Check if score meets threshold for storing
 * We don't store rejected matches to avoid noise
 */
export function meetsStorageThreshold(score: number): boolean {
  return score >= getStorageThreshold();
}

/**
 * Check if an identity should be persisted based on score breakdown
 * Requires: total >= threshold AND (bridge evidence OR name match + secondary OR handle match)
 * This prevents storing random matches without meaningful evidence
 */
export function shouldPersistIdentity(breakdown: ScoreBreakdown): boolean {
  const threshold = getStorageThreshold();

  // Must meet minimum threshold
  if (breakdown.total < threshold) {
    return false;
  }

  // If we have bridge evidence (LinkedIn link), always persist
  if (breakdown.bridgeWeight > 0) {
    return true;
  }

  // Handle match: strong signal for handle-based platforms (github, npm, pypi, etc.)
  // Exact match gives handleMatch=1.0, variant match gives 0.4-0.9
  // Allow persistence if handleMatch >= 0.20 (covers derived variants)
  const hasHandleMatch = (breakdown.handleMatch ?? 0) >= 0.20;
  if (hasHandleMatch) {
    return true;
  }

  // Otherwise, require meaningful name match (> 0.15 means at least partial match)
  // AND at least one secondary signal (company, location, or profile completeness)
  const hasNameMatch = breakdown.nameMatch >= 0.15;
  const hasSecondarySignal =
    breakdown.companyMatch > 0 ||
    breakdown.locationMatch > 0 ||
    breakdown.profileCompleteness >= 0.03; // At least has name + bio

  return hasNameMatch && hasSecondarySignal;
}

/**
 * Check for contradictions that should flag the match
 */
export function detectContradictions(input: ScoringInput): {
  hasContradiction: boolean;
  note?: string;
} {
  // Name completely different despite other matches
  const nameSimilarity = calculateNameSimilarity(
    input.candidateName,
    input.platformName
  );

  if (
    input.candidateName &&
    input.platformName &&
    nameSimilarity < 0.2 &&
    (input.hasCommitEvidence || input.hasProfileLink)
  ) {
    return {
      hasContradiction: true,
      note: `Name mismatch: "${input.candidateName}" vs "${input.platformName}" despite strong bridge evidence`,
    };
  }

  // Location completely different
  const locationMatchRaw = calculateLocationMatch(
    input.candidateLocation,
    input.platformLocation
  );

  if (
    input.candidateLocation &&
    input.platformLocation &&
    locationMatchRaw === 0
  ) {
    // Check for obvious contradictions (different countries)
    const loc1 = normalize(input.candidateLocation);
    const loc2 = normalize(input.platformLocation);

    const countries = [
      'united states',
      'israel',
      'united kingdom',
      'germany',
      'france',
      'canada',
      'india',
      'china',
      'japan',
    ];

    const country1 = countries.find((c) => loc1.includes(c));
    const country2 = countries.find((c) => loc2.includes(c));

    if (country1 && country2 && country1 !== country2) {
      return {
        hasContradiction: true,
        note: `Location mismatch: "${input.candidateLocation}" vs "${input.platformLocation}"`,
      };
    }
  }

  return { hasContradiction: false };
}

/**
 * Detect bridge signals from scoring input
 * Returns the signals detected for use in bridge tier classification
 */
export function detectBridgeSignals(input: ScoringInput): BridgeSignal[] {
  const signals: BridgeSignal[] = [];

  // Tier 1 signals (explicit links)
  if (input.hasProfileLink) {
    signals.push(
      input.profileLinkSource === 'blog' ? 'linkedin_url_in_blog' : 'linkedin_url_in_bio'
    );
  }

  // Tier 2 signals (strong unidirectional)
  if (input.hasCommitEvidence && input.commitCount > 0) {
    signals.push('commit_email_domain');
  }

  // If no signals found, return 'none'
  if (signals.length === 0) {
    signals.push('none');
  }

  return signals;
}

/**
 * Create bridge detection from scoring input
 * Integrates signal detection with tier classification
 */
export function createBridgeFromScoring(
  input: ScoringInput,
  bridgeUrl: string | null = null,
  extraSignals: BridgeSignal[] = []
): BridgeDetection {
  const signals = [...detectBridgeSignals(input), ...extraSignals];
  return createBridgeDetection(signals, bridgeUrl);
}

/**
 * Extended scoring result with bridge detection
 */
export interface ScoringResultWithBridge {
  score: ScoreBreakdown;
  bridge: BridgeDetection;
  adjustedConfidence: number;
  persistDecision: 'persist' | 'skip' | 'cap_exceeded';
}

/**
 * Calculate confidence score with bridge tier integration
 * Applies confidence floor based on bridge tier
 */
/**
 * Tier-1 score boost when explicit bridge evidence exists
 * This helps Tier-1 matches clear the auto-merge threshold (0.90)
 * Only applied when: Tier-1, no contradictions, not team-page downgrade
 */
const TIER_1_SCORE_BOOST = 0.08;

export function calculateConfidenceWithBridge(
  input: ScoringInput,
  bridgeUrl: string | null = null,
  tier2Count: number = 0,
  extraSignals: BridgeSignal[] = [],
  hasContradiction: boolean = false
): ScoringResultWithBridge {
  const score = calculateConfidenceScore(input);
  const bridge = createBridgeFromScoring(input, bridgeUrl, extraSignals);

  // Check if this is a "strict" Tier-1 (not downgraded from team page)
  const isStrictTier1 = bridge.tier === 1 &&
    !bridge.signals.includes('linkedin_url_in_team_page') &&
    !hasContradiction;

  // Apply Tier-1 boost when strict Tier-1 evidence exists
  // This helps Tier-1 matches clear the auto-merge threshold (0.90)
  let boostedScore = score.total;
  if (isStrictTier1) {
    boostedScore = Math.min(1.0, score.total + TIER_1_SCORE_BOOST);
  }

  // Apply confidence floor from bridge tier (use boosted score)
  const adjustedConfidence = Math.max(boostedScore, bridge.confidenceFloor);

  // Determine persist decision
  let persistDecision: 'persist' | 'skip' | 'cap_exceeded' = 'skip';

  if (bridge.tier === 1) {
    // Tier 1: Always persist (auto-merge eligible)
    persistDecision = 'persist';
  } else if (bridge.tier === 2) {
    // Tier 2: Persist up to global cap
    if (tier2Count < TIER_2_CAP) {
      persistDecision = 'persist';
    } else {
      persistDecision = 'cap_exceeded';
    }
  } else {
    // Tier 3: Only persist if meets traditional threshold with meaningful signals
    if (shouldPersistIdentity(score)) {
      persistDecision = 'persist';
    }
  }

  return {
    score,
    bridge,
    adjustedConfidence,
    persistDecision,
  };
}

/**
 * Generate human-readable reason string from bridge signals
 */
function formatBridgeReason(bridge: BridgeDetection, score: ScoreBreakdown): string {
  const signals = bridge.signals.filter(s => s !== 'none');

  if (signals.length === 0) {
    if (score.bridgeWeight > 0) {
      return 'Profile contains LinkedIn link';
    }
    if ((score.handleMatch ?? 0) > 0.5) {
      return `Username match (${(score.handleMatch! * 100).toFixed(0)}% confidence)`;
    }
    if (score.nameMatch > 0.2) {
      return `Name match: ${(score.nameMatch * 100 / 0.30).toFixed(0)}% similarity`;
    }
    return 'Search result match';
  }

  const signalDescriptions: Record<BridgeSignal, string> = {
    'linkedin_url_in_bio': 'LinkedIn URL found in profile bio',
    'linkedin_url_in_blog': 'LinkedIn URL found in website/blog field',
    'linkedin_url_in_page': 'LinkedIn URL found on external page',
    'linkedin_url_in_team_page': 'LinkedIn URL found on team page (multiple profiles)',
    'reverse_link_hint_match': 'Reverse-link page corroborates company/location',
    'commit_email_domain': 'Commit email matches company domain',
    'cross_platform_handle': 'Same username across platforms',
    'mutual_reference': 'Both profiles reference each other',
    'verified_domain': 'Platform-verified company domain',
    'email_in_public_page': 'Email found on public page',
    'conference_speaker': 'Listed as conference speaker with LinkedIn',
    'none': 'No bridge signal detected',
  };

  return signals.map(s => signalDescriptions[s] || s).join('; ');
}

/**
 * Check if identity should be persisted based on bridge tier and score
 * Updated to integrate bridge tier logic
 *
 * Returns human-readable reason strings for transparency
 */
export function shouldPersistWithBridge(
  score: ScoreBreakdown,
  bridge: BridgeDetection,
  tier2Count: number = 0,
  autoMergeThreshold: number = 0.90
): {
  shouldPersist: boolean;
  reason: string;
  tier: BridgeTier;
} {
  const bridgeReason = formatBridgeReason(bridge, score);

  // Tier 1: Always persist (explicit bidirectional link)
  if (bridge.tier === 1) {
    const autoMergeEligible = score.total >= autoMergeThreshold;
    const thresholdLabel = autoMergeThreshold.toFixed(2);
    return {
      shouldPersist: true,
      reason: autoMergeEligible
        ? `Tier-1 bridge, auto-merge eligible (${score.total.toFixed(2)} >= ${thresholdLabel}): ${bridgeReason}`
        : `Tier-1 bridge detected (${score.total.toFixed(2)} < ${thresholdLabel} auto-merge threshold): ${bridgeReason}`,
      tier: 1,
    };
  }

  // Tier 2: Check cap (strong unidirectional signal)
  if (bridge.tier === 2) {
    if (tier2Count < TIER_2_CAP) {
      return {
        shouldPersist: true,
        reason: `Strong signal (${tier2Count + 1}/${TIER_2_CAP}): ${bridgeReason}`,
        tier: 2,
      };
    }
    return {
      shouldPersist: false,
      reason: `Cap exceeded (${tier2Count}/${TIER_2_CAP}): ${bridgeReason}`,
      tier: 2,
    };
  }

  // Tier 3: Traditional threshold check (weak/speculative)
  if (shouldPersistIdentity(score)) {
    const confidence = (score.total * 100).toFixed(0);
    return {
      shouldPersist: true,
      reason: `Threshold match (${confidence}%): ${bridgeReason}`,
      tier: 3,
    };
  }

  return {
    shouldPersist: false,
    reason: `Below threshold (${(score.total * 100).toFixed(0)}%): ${bridgeReason}`,
    tier: 3,
  };
}

// Re-export bridge types for convenience
export type { BridgeTier, BridgeSignal, BridgeDetection };

export default {
  calculateConfidenceScore,
  calculateDynamicConfidenceScore,
  computeShadowScore,
  classifyConfidence,
  meetsStorageThreshold,
  shouldPersistIdentity,
  detectContradictions,
  detectBridgeSignals,
  createBridgeFromScoring,
  calculateConfidenceWithBridge,
  shouldPersistWithBridge,
};
