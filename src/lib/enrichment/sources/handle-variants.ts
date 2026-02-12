/**
 * Handle Variant Generator
 *
 * Generates probable handle variants from LinkedIn ID and name hints.
 * LinkedIn slugs often differ from handles on other platforms.
 *
 * Example: linkedinId "john-doe-12345" generates:
 * - john-doe-12345 (raw)
 * - john-doe (stripped digits)
 * - johndoe (collapsed)
 * - john_doe (underscore variant)
 * - john.doe (dot variant)
 * - jdoe (first initial + last, if name available)
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import type { CandidateHints, EnrichmentPlatform, QueryMode } from './types';

/**
 * Generated handle variants with confidence ranking
 */
export interface HandleVariant {
  handle: string;
  source: 'linkedinId' | 'name' | 'derived';
  confidence: number; // 0-1, higher = more likely to match
}

/**
 * Generate handle variants from linkedinId
 */
export function generateHandleVariants(
  linkedinId: string,
  nameHint: string | null,
  maxVariants: number = 5
): HandleVariant[] {
  const variants: HandleVariant[] = [];
  const seen = new Set<string>();

  const addVariant = (handle: string, source: HandleVariant['source'], confidence: number) => {
    const normalized = handle.toLowerCase().trim();
    if (normalized && normalized.length >= 2 && !seen.has(normalized)) {
      seen.add(normalized);
      variants.push({ handle: normalized, source, confidence });
    }
  };

  // 1. Raw linkedinId (highest confidence if it's clean)
  const hasTrailingDigits = /\d+$/.test(linkedinId);
  addVariant(linkedinId, 'linkedinId', hasTrailingDigits ? 0.6 : 0.9);

  // 2. Strip trailing digits (common LinkedIn pattern: john-doe-12345)
  if (hasTrailingDigits) {
    const stripped = linkedinId.replace(/-?\d+$/, '');
    if (stripped && stripped !== linkedinId) {
      addVariant(stripped, 'derived', 0.85);
    }
  }

  // 3. Collapse separators (john-doe -> johndoe)
  const collapsed = linkedinId.replace(/[-_.\d]+/g, '');
  if (collapsed && collapsed !== linkedinId) {
    addVariant(collapsed, 'derived', 0.7);
  }

  // 4. Swap separators (john-doe -> john_doe, john.doe)
  const baseName = linkedinId.replace(/-?\d+$/, ''); // strip trailing digits first
  if (baseName.includes('-')) {
    addVariant(baseName.replace(/-/g, '_'), 'derived', 0.65);
    addVariant(baseName.replace(/-/g, '.'), 'derived', 0.6);
  }

  // 5. First initial + last name (from nameHint)
  if (nameHint) {
    const nameParts = nameHint.trim().split(/\s+/);
    if (nameParts.length >= 2) {
      const firstName = nameParts[0];
      const lastName = nameParts[nameParts.length - 1];

      // jdoe pattern
      const initialLast = `${firstName[0]}${lastName}`.toLowerCase();
      addVariant(initialLast, 'name', 0.5);

      // firstname.lastname pattern
      const dotName = `${firstName}.${lastName}`.toLowerCase();
      addVariant(dotName, 'name', 0.45);

      // firstnamelastname pattern
      const concatName = `${firstName}${lastName}`.toLowerCase();
      addVariant(concatName, 'name', 0.4);
    }
  }

  // Sort by confidence descending and limit
  return variants
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxVariants);
}

/**
 * Platform query support - what query modes a platform accepts
 * Different from QueryMode (individual query type) - this describes platform capability
 */
export type PlatformQuerySupport = 'handle' | 'name' | 'both';

/**
 * Determine what query modes a platform supports
 */
export function getQueryModeForPlatform(platform: string): PlatformQuerySupport {
  // Handle-based platforms (profile URL is /username)
  const handlePlatforms = [
    'github', 'gitlab', 'leetcode', 'hackerearth', 'dockerhub',
    'npm', 'pypi', 'kaggle', 'huggingface', 'dribbble', 'behance',
    'codepen', 'devto', 'twitter', 'medium', 'gist'
  ];

  // Name-based platforms (search by full name)
  const namePlatforms = [
    'stackoverflow', 'scholar', 'semanticscholar', 'openreview',
    'arxiv', 'patents', 'university', 'companyteam', 'crunchbase',
    'angellist', 'sec', 'orcid', 'researchgate'
  ];

  if (handlePlatforms.includes(platform)) {
    return 'both'; // Use both handle and name queries
  }
  if (namePlatforms.includes(platform)) {
    return 'name';
  }
  return 'both'; // Default to both for unknown platforms
}

/**
 * Query quality gate - reject low-quality queries
 *
 * IMPORTANT: Gate on semantic completeness, not raw length.
 * A handle query like "site:leetcode.com/u/abc" is always complete
 * even if the handle is short.
 */
export interface QueryQualityResult {
  valid: boolean;
  reason?: string;
}

/**
 * Platform-specific handle URL patterns
 * Used to determine if a query is a complete handle-pattern query
 *
 * IMPORTANT: Use [a-z0-9_.-]+ (not \w+) to match handles with dashes/dots
 * e.g., "john-doe" or "john.doe" are valid handles on most platforms
 */
const HANDLE_CHAR_CLASS = '[a-z0-9_.-]+';
const PLATFORM_HANDLE_PATTERNS: Record<string, RegExp[]> = {
  leetcode: [new RegExp(`site:leetcode\\.com/u/${HANDLE_CHAR_CLASS}`, 'i')],
  npm: [new RegExp(`site:npmjs\\.com/~${HANDLE_CHAR_CLASS}`, 'i')],
  medium: [new RegExp(`site:medium\\.com/@${HANDLE_CHAR_CLASS}`, 'i')],
  hackerearth: [
    new RegExp(`site:hackerearth\\.com/@${HANDLE_CHAR_CLASS}`, 'i'),
    new RegExp(`site:hackerearth\\.com/users/${HANDLE_CHAR_CLASS}`, 'i'),
    new RegExp(`site:hackerearth\\.com/people/${HANDLE_CHAR_CLASS}`, 'i'),
  ],
  gitlab: [
    new RegExp(`site:gitlab\\.com/${HANDLE_CHAR_CLASS}$`, 'i'),
    new RegExp(`site:gitlab\\.com/users/${HANDLE_CHAR_CLASS}`, 'i'),
  ],
  pypi: [new RegExp(`site:pypi\\.org/user/${HANDLE_CHAR_CLASS}`, 'i')],
  dockerhub: [new RegExp(`site:hub\\.docker\\.com/[ur]/${HANDLE_CHAR_CLASS}`, 'i')],
  gist: [new RegExp(`site:gist\\.github\\.com/${HANDLE_CHAR_CLASS}`, 'i')],
  github: [new RegExp(`site:github\\.com/${HANDLE_CHAR_CLASS}`, 'i')],
  kaggle: [new RegExp(`site:kaggle\\.com/${HANDLE_CHAR_CLASS}`, 'i')],
  huggingface: [new RegExp(`site:huggingface\\.co/${HANDLE_CHAR_CLASS}`, 'i')],
  dribbble: [new RegExp(`site:dribbble\\.com/${HANDLE_CHAR_CLASS}`, 'i')],
  behance: [new RegExp(`site:behance\\.net/${HANDLE_CHAR_CLASS}`, 'i')],
  codepen: [new RegExp(`site:codepen\\.io/${HANDLE_CHAR_CLASS}`, 'i')],
  devto: [new RegExp(`site:dev\\.to/${HANDLE_CHAR_CLASS}`, 'i')],
  twitter: [new RegExp(`site:(?:twitter|x)\\.com/${HANDLE_CHAR_CLASS}`, 'i')],
  angellist: [new RegExp(`site:angel\\.co/u/${HANDLE_CHAR_CLASS}`, 'i')],
};

/**
 * Generic handle patterns (fallback for platforms not in the specific map)
 * Uses [a-z0-9_.-]+ to match handles with dashes/dots
 */
const GENERIC_HANDLE_PATTERNS = [
  /site:\S+\/u\/[a-z0-9_.-]+/i,           // /u/handle pattern
  /site:\S+\/~[a-z0-9_.-]+/i,             // /~handle pattern
  /site:\S+\/@[a-z0-9_.-]+/i,             // /@handle pattern
  /site:\S+\/users?\/[a-z0-9_.-]+/i,      // /users/handle pattern
];

/**
 * Check if query is a complete handle-pattern query for a specific platform
 * e.g., site:npmjs.com/~jjpickering is valid even though handle is short
 */
function isCompleteHandleQuery(query: string, platform?: EnrichmentPlatform): boolean {
  // Try platform-specific patterns first
  if (platform && PLATFORM_HANDLE_PATTERNS[platform]) {
    for (const pattern of PLATFORM_HANDLE_PATTERNS[platform]) {
      if (pattern.test(query)) {
        return true;
      }
    }
  }

  // Fall back to generic patterns
  return GENERIC_HANDLE_PATTERNS.some(pattern => pattern.test(query));
}

/**
 * Validate a query for semantic completeness
 * @param platform - The target platform (for platform-specific rules)
 * @param query - The search query string
 * @param hints - Candidate hints for context
 * @param mode - Query mode ('handle' or 'name')
 */
export function validateQuery(
  platform: EnrichmentPlatform,
  query: string,
  hints: CandidateHints,
  mode: QueryMode
): QueryQualityResult {
  const trimmed = query.trim();

  // Handle-pattern queries are always semantically complete
  // Don't reject short handles like "site:npmjs.com/~abc"
  if (isCompleteHandleQuery(trimmed, platform)) {
    return { valid: true };
  }

  // For non-handle queries, check semantic completeness
  const queryContent = trimmed
    .replace(/site:\S+\s*/g, '')  // Remove site: prefix
    .replace(/"/g, '')            // Remove quotes
    .replace(/\s+(author|maintainer|profile)\s*/gi, '') // Remove common keywords
    .trim();

  // Empty or trivially short content (not a handle query)
  if (queryContent.length < 3) {
    return { valid: false, reason: 'Query content too short' };
  }

  // Handle-mode query but using full name (the old bug)
  if (mode === 'handle') {
    const nameWords = hints.nameHint?.split(/\s+/) || [];
    const hasFullName = nameWords.length >= 2 && nameWords.every(w =>
      queryContent.toLowerCase().includes(w.toLowerCase())
    );
    if (hasFullName && !queryContent.includes(hints.linkedinId)) {
      return { valid: false, reason: 'Handle query contains full name instead of handle' };
    }
  }

  // First-name-only query (high false positive risk)
  if (hints.nameHint) {
    const firstName = hints.nameHint.split(/\s+/)[0];
    if (queryContent.toLowerCase() === firstName.toLowerCase()) {
      return { valid: false, reason: 'Query contains only first name' };
    }
  }

  // Missing both linkedinId and fullName
  if (!hints.linkedinId && !hints.nameHint) {
    return { valid: false, reason: 'Query lacks both linkedinId and name' };
  }

  return { valid: true };
}

/**
 * Build queries for a handle-based platform with proper mode handling
 * Note: Validation is performed in BaseEnrichmentSource.discover(), not here.
 */
export function buildHandlePlatformQueries(
  hints: CandidateHints,
  sitePatterns: string[], // e.g., ['site:github.com/', 'site:github.com/users/']
  maxQueries: number = 3
): string[] {
  const queries: string[] = [];
  const handleVariants = generateHandleVariants(hints.linkedinId, hints.nameHint, 3);

  // HANDLE_MODE: Use handle variants with site patterns
  for (const pattern of sitePatterns) {
    for (const variant of handleVariants) {
      if (queries.length >= maxQueries) break;
      const query = `${pattern}${variant.handle}`;
      queries.push(query);
    }
    if (queries.length >= maxQueries) break;
  }

  // NAME_MODE: Fallback to name-based search if we have room
  if (queries.length < maxQueries && hints.nameHint) {
    const siteBase = sitePatterns[0].replace(/\/+$/, ''); // e.g., 'site:github.com'
    const nameQuery = `${siteBase} "${hints.nameHint}"`;
    queries.push(nameQuery);
  }

  // NAME + COMPANY: Additional disambiguation
  if (queries.length < maxQueries && hints.nameHint && hints.companyHint) {
    const siteBase = sitePatterns[0].replace(/\/+$/, '');
    const companyQuery = `${siteBase} "${hints.nameHint}" "${hints.companyHint}"`;
    queries.push(companyQuery);
  }

  return queries.slice(0, maxQueries);
}

/**
 * Build queries for a name-based platform
 * Note: Validation is performed in BaseEnrichmentSource.discover(), not here.
 */
export function buildNamePlatformQueries(
  hints: CandidateHints,
  sitePattern: string, // e.g., 'site:stackoverflow.com/users'
  maxQueries: number = 3
): string[] {
  const queries: string[] = [];

  // Primary: Full name
  if (hints.nameHint) {
    const query = `${sitePattern} "${hints.nameHint}"`;
    queries.push(query);
  }

  // Secondary: Name + company
  if (queries.length < maxQueries && hints.nameHint && hints.companyHint) {
    const query = `${sitePattern} "${hints.nameHint}" "${hints.companyHint}"`;
    queries.push(query);
  }

  // Tertiary: Name + location (for researchers/academics)
  if (queries.length < maxQueries && hints.nameHint && hints.locationHint) {
    const query = `${sitePattern} "${hints.nameHint}" "${hints.locationHint}"`;
    queries.push(query);
  }

  return queries.slice(0, maxQueries);
}
