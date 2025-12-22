/**
 * Hint Extraction Utilities
 *
 * Extracts name, company, location, and headline hints from LinkedIn
 * SERP data (URL slug, title, snippet). No scraping - only uses public
 * search engine results.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

/**
 * Extracted hints from LinkedIn SERP data
 */
export interface ExtractedHints {
  nameHint: string | null;
  headlineHint: string | null;
  locationHint: string | null;
  companyHint: string | null;
  nameSource: 'title' | 'slug' | null;
}

/**
 * Common LinkedIn title patterns (from SERP results):
 *
 * 1. "Name - Headline | LinkedIn"
 * 2. "Name | LinkedIn"
 * 3. "Name - Title at Company | LinkedIn"
 * 4. "Name, Title at Company | LinkedIn"
 * 5. "Name - Title - Company | LinkedIn"
 * 6. "Name | Title at Company | LinkedIn"
 * 7. "(1) Name - Headline | LinkedIn" (notification badge)
 * 8. "Name - LinkedIn" (minimal)
 * 9. "Name · Title · Company" (some regions)
 */

/**
 * Extract name from LinkedIn URL slug
 *
 * LinkedIn slugs follow patterns:
 * - /in/firstname-lastname (most common)
 * - /in/firstname-lastname-123abc (with suffix)
 * - /in/firstnamelastname (no hyphen)
 * - /in/john-smith-phd (with suffix like phd, md, etc)
 *
 * @example
 * extractNameFromSlug('jane-doe-12345') => 'Jane Doe'
 * extractNameFromSlug('john-smith') => 'John Smith'
 * extractNameFromSlug('johnsmith') => null (can't reliably parse)
 */
export function extractNameFromSlug(linkedinId: string): string | null {
  if (!linkedinId) return null;

  // Remove common suffixes (random IDs, credentials)
  const cleaned = linkedinId
    // Remove trailing random ID (e.g., -12345, -a1b2c3)
    .replace(/-[a-f0-9]{6,}$/i, '')
    .replace(/-\d{3,}$/, '')
    // Remove common credential suffixes
    .replace(/-(phd|md|mba|cpa|cfa|pmp|pe|esq|jr|sr|ii|iii|iv)$/i, '');

  // Must have at least one hyphen to be a parseable name
  if (!cleaned.includes('-')) {
    return null;
  }

  // Split by hyphens
  const parts = cleaned.split('-').filter(Boolean);

  // Need at least 2 parts (first name, last name)
  if (parts.length < 2) {
    return null;
  }

  // Take first 2-3 parts as name (handles middle names)
  const nameParts = parts.slice(0, Math.min(3, parts.length));

  // Capitalize each part
  const name = nameParts
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');

  // Sanity check: name should be reasonable length
  if (name.length < 3 || name.length > 50) {
    return null;
  }

  return name;
}

/**
 * Extract name from SERP title
 *
 * Handles multiple title formats from different search engines
 */
export function extractNameFromTitle(title: string): string | null {
  if (!title) return null;

  // Clean up notification badges
  let cleaned = title.replace(/^\(\d+\)\s*/, '');

  // Remove " | LinkedIn" or " - LinkedIn" suffix
  cleaned = cleaned
    .replace(/\s*[|·-]\s*LinkedIn\s*$/i, '')
    .trim();

  // If nothing left, bail
  if (!cleaned) return null;

  // Strategy 1: Split by common delimiters and take first part
  // Title formats: "Name - Headline", "Name | Role", "Name, Title"
  const delimiters = [' - ', ' | ', ' · ', ', '];

  for (const delim of delimiters) {
    if (cleaned.includes(delim)) {
      const parts = cleaned.split(delim);
      const candidate = parts[0].trim();

      // Validate it looks like a name (not a title/role)
      if (isLikelyName(candidate)) {
        return candidate;
      }
    }
  }

  // Strategy 2: If no delimiter, check if entire string is a name
  if (isLikelyName(cleaned)) {
    return cleaned;
  }

  return null;
}

/**
 * Extract headline from SERP title
 */
export function extractHeadlineFromTitle(title: string): string | null {
  if (!title) return null;

  // Clean up
  const cleaned = title
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*[|·-]\s*LinkedIn\s*$/i, '')
    .trim();

  // Find first delimiter and take everything after
  const delimiters = [' - ', ' | ', ' · '];

  for (const delim of delimiters) {
    const idx = cleaned.indexOf(delim);
    if (idx !== -1) {
      const headline = cleaned.slice(idx + delim.length).trim();
      if (headline.length > 0) {
        return headline;
      }
    }
  }

  return null;
}

/**
 * Extract company from headline or title
 *
 * Common patterns:
 * - "Title at Company"
 * - "Title @ Company"
 * - "Title, Company"
 * - "Title | Company"
 * - "Title - Company"
 * - "Company · Title" (reversed)
 */
export function extractCompanyFromHeadline(headline: string | null): string | null {
  if (!headline) return null;

  // Pattern 1: "at Company" or "@ Company"
  const atMatch = headline.match(/(?:\bat\b|@)\s+([A-Z][A-Za-z0-9\s&.,'-]+?)(?:\s*[|·\-]|$)/i);
  if (atMatch) {
    return cleanCompanyName(atMatch[1]);
  }

  // Pattern 2: Check for known company indicators after comma/pipe
  const segments = headline.split(/\s*[|·,]\s*/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i].trim();
    if (isLikelyCompany(seg)) {
      return cleanCompanyName(seg);
    }
  }

  // Pattern 3: "Title - Company" (when Company starts with capital)
  const dashMatch = headline.match(/\s-\s([A-Z][A-Za-z0-9\s&]+?)$/);
  if (dashMatch && isLikelyCompany(dashMatch[1])) {
    return cleanCompanyName(dashMatch[1]);
  }

  return null;
}

/**
 * Extract location from SERP snippet
 *
 * LinkedIn snippets often contain:
 * - "Location: City, Country"
 * - "City, Country · Connections"
 * - Geographic info in first/last segment
 */
export function extractLocationFromSnippet(snippet: string): string | null {
  if (!snippet) return null;

  // Pattern 1: Explicit "Location: X"
  const locationMatch = snippet.match(/Location:\s*([^·\n]+)/i);
  if (locationMatch) {
    return locationMatch[1].trim();
  }

  // Pattern 2: City/Country pattern with common separators
  // "San Francisco, California · 500+ connections"
  const cityMatch = snippet.match(/^([A-Z][A-Za-z\s]+(?:,\s*[A-Z][A-Za-z\s]+)?)\s*·/);
  if (cityMatch && isLikelyLocation(cityMatch[1])) {
    return cityMatch[1].trim();
  }

  // Pattern 3: Split by middot and check segments
  const segments = snippet.split(' · ');
  for (const seg of segments) {
    const cleaned = seg.trim();
    if (cleaned.length <= 50 && isLikelyLocation(cleaned)) {
      return cleaned;
    }
  }

  // Pattern 4: Common geographic patterns
  const geoMatch = snippet.match(/(?:based in|located in|from)\s+([A-Z][A-Za-z\s,]+?)(?:\.|,|\s*·)/i);
  if (geoMatch) {
    return geoMatch[1].trim();
  }

  return null;
}

/**
 * Extract all hints from LinkedIn SERP data
 */
export function extractAllHints(
  linkedinId: string,
  title: string,
  snippet: string
): ExtractedHints {
  // Try title-based name first (more reliable)
  let nameHint = extractNameFromTitle(title);
  let nameSource: 'title' | 'slug' | null = nameHint ? 'title' : null;

  // Fallback to slug-based name
  if (!nameHint) {
    nameHint = extractNameFromSlug(linkedinId);
    nameSource = nameHint ? 'slug' : null;
  }

  // Extract headline
  const headlineHint = extractHeadlineFromTitle(title);

  // Extract company (try headline first, then title)
  let companyHint = extractCompanyFromHeadline(headlineHint);
  if (!companyHint) {
    // Try extracting from full title (after name)
    const titleParts = title.split(' - ');
    if (titleParts.length > 1) {
      companyHint = extractCompanyFromHeadline(titleParts.slice(1).join(' - '));
    }
  }

  // Extract location
  const locationHint = extractLocationFromSnippet(snippet);

  return {
    nameHint,
    headlineHint,
    locationHint,
    companyHint,
    nameSource,
  };
}

// ============================================
// Helper Functions
// ============================================

/**
 * Check if a string looks like a person's name
 */
function isLikelyName(str: string): boolean {
  if (!str || str.length < 2 || str.length > 50) return false;

  // Names typically:
  // - Start with capital letter
  // - Have 2-4 words
  // - Don't contain job keywords
  const words = str.split(/\s+/);
  if (words.length < 1 || words.length > 5) return false;

  // Check for job title keywords (not a name)
  const jobKeywords = [
    'engineer', 'developer', 'manager', 'director', 'president',
    'ceo', 'cto', 'cfo', 'vp', 'head', 'lead', 'senior', 'junior',
    'analyst', 'consultant', 'specialist', 'coordinator', 'founder',
    'software', 'product', 'data', 'marketing', 'sales', 'hr',
    'seeking', 'looking', 'hiring', 'open', 'available',
  ];

  const lower = str.toLowerCase();
  for (const keyword of jobKeywords) {
    if (lower.includes(keyword)) return false;
  }

  // First word should start with capital
  if (!/^[A-Z]/.test(words[0])) return false;

  return true;
}

/**
 * Check if a string looks like a company name
 */
function isLikelyCompany(str: string): boolean {
  if (!str || str.length < 2 || str.length > 80) return false;

  const lower = str.toLowerCase();

  // Company indicators
  const companyIndicators = [
    'inc', 'llc', 'ltd', 'corp', 'co', 'company', 'group',
    'technologies', 'solutions', 'services', 'systems', 'labs',
    'capital', 'ventures', 'partners', 'consulting', 'studios',
  ];

  for (const indicator of companyIndicators) {
    if (lower.includes(indicator)) return true;
  }

  // Known major companies (quick check)
  const majorCompanies = [
    'google', 'meta', 'facebook', 'amazon', 'microsoft', 'apple',
    'netflix', 'uber', 'airbnb', 'stripe', 'coinbase', 'twitter',
    'linkedin', 'salesforce', 'oracle', 'ibm', 'intel', 'nvidia',
    'tesla', 'spacex', 'openai', 'anthropic', 'databricks',
  ];

  for (const company of majorCompanies) {
    if (lower.includes(company)) return true;
  }

  // Starts with capital, reasonable length, no obvious job keywords
  if (/^[A-Z]/.test(str) && str.length >= 2 && str.length <= 40) {
    const jobKeywords = ['engineer', 'developer', 'manager', 'analyst', 'seeking', 'open to'];
    for (const kw of jobKeywords) {
      if (lower.includes(kw)) return false;
    }
    return true;
  }

  return false;
}

/**
 * Check if a string looks like a location
 */
function isLikelyLocation(str: string): boolean {
  if (!str || str.length < 2 || str.length > 60) return false;

  const lower = str.toLowerCase();

  // Location indicators
  const locationIndicators = [
    'area', 'region', 'metropolitan', 'greater', 'bay',
    'city', 'county', 'state', 'province',
  ];

  for (const indicator of locationIndicators) {
    if (lower.includes(indicator)) return true;
  }

  // US states
  const usStates = [
    'california', 'new york', 'texas', 'florida', 'washington',
    'massachusetts', 'illinois', 'georgia', 'colorado', 'virginia',
    'ca', 'ny', 'tx', 'fl', 'wa', 'ma', 'il', 'ga', 'co', 'va',
  ];

  for (const state of usStates) {
    if (lower.includes(state)) return true;
  }

  // Common cities
  const cities = [
    'san francisco', 'new york', 'los angeles', 'seattle', 'austin',
    'boston', 'chicago', 'denver', 'atlanta', 'miami', 'portland',
    'london', 'berlin', 'paris', 'amsterdam', 'dublin', 'singapore',
    'toronto', 'vancouver', 'sydney', 'melbourne', 'bangalore', 'mumbai',
  ];

  for (const city of cities) {
    if (lower.includes(city)) return true;
  }

  // Pattern: "City, State/Country"
  if (/^[A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s*[A-Z]/.test(str)) {
    return true;
  }

  return false;
}

/**
 * Clean up company name
 */
function cleanCompanyName(name: string): string {
  return name
    .replace(/\s+/g, ' ')
    .replace(/[|·\-]\s*$/, '')
    .trim();
}

export default {
  extractNameFromSlug,
  extractNameFromTitle,
  extractHeadlineFromTitle,
  extractCompanyFromHeadline,
  extractLocationFromSnippet,
  extractAllHints,
};
