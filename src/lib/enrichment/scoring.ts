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
 * - low: >= 0.3 (possible match, needs review)
 * - rejected: < 0.3 (unlikely match)
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

/**
 * Score breakdown for transparency
 */
export interface ScoreBreakdown {
  bridgeWeight: number; // 0-0.4 based on evidence type
  nameMatch: number; // 0-0.25 based on name similarity
  companyMatch: number; // 0-0.15 based on company match
  locationMatch: number; // 0-0.1 based on location match
  profileCompleteness: number; // 0-0.1 based on profile data
  total: number; // Sum of all weights
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
  hasProfileLink: boolean; // LinkedIn link in GitHub bio

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
    .replace(/[^a-z0-9\s]/g, '') // Remove special chars
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
 * Weights:
 * - Bridge evidence: 40% (strongest signal)
 * - Name match: 25%
 * - Company match: 15%
 * - Location match: 10%
 * - Profile completeness: 10%
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

  // Name match weight (0-0.25)
  const nameSimilarity = calculateNameSimilarity(
    input.candidateName,
    input.platformName
  );
  const nameMatch = nameSimilarity * 0.25;

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

  // Profile completeness weight (0-0.1)
  const completenessRaw = calculateProfileCompleteness(input);
  const profileCompleteness = completenessRaw * 0.1;

  // Total score
  const total =
    bridgeWeight + nameMatch + companyMatch + locationMatch + profileCompleteness;

  return {
    bridgeWeight,
    nameMatch,
    companyMatch,
    locationMatch,
    profileCompleteness,
    total: Math.min(1, total),
  };
}

/**
 * Classify confidence score into bucket
 */
export function classifyConfidence(score: number): ConfidenceBucket {
  if (score >= 0.9) return 'auto_merge';
  if (score >= 0.7) return 'suggest';
  if (score >= 0.3) return 'low';
  return 'rejected';
}

/**
 * Check if score meets threshold for storing
 * We don't store rejected matches to avoid noise
 * Threshold lowered to 0.3 to allow name-based matches without bridge evidence
 */
export function meetsStorageThreshold(score: number): boolean {
  return score >= 0.3;
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

export default {
  calculateConfidenceScore,
  classifyConfidence,
  meetsStorageThreshold,
  detectContradictions,
};
