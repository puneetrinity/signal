/**
 * Shared hint sanitization utilities.
 *
 * Used by upsert-candidates, ranking location guard, and backfill scripts.
 */

export const PLACEHOLDER_HINTS = new Set(['na', 'n/a', 'unknown', 'none', 'null', '-', '...']);

export function normalizeHint(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

export function isNoisyHint(value: string): boolean {
  const lower = value.toLowerCase();
  if (PLACEHOLDER_HINTS.has(lower)) return true;
  if (/\.{3,}|…/.test(value)) return true;
  if (/\blinkedin\b|\bview\b.*\bprofile\b|https?:\/\/|www\./i.test(value)) return true;
  return false;
}

export function hintQualityScore(value: string | null): number {
  if (!value) return 0;
  if (isNoisyHint(value)) return 0;
  const words = value.split(/\s+/).filter(Boolean).length;
  return Math.min(4, Math.max(1, words));
}

export function shouldReplaceHint(existing: string | null, incoming: string | undefined): boolean {
  const normalizedIncoming = normalizeHint(incoming);
  if (!normalizedIncoming) return false;
  const incomingScore = hintQualityScore(normalizedIncoming);
  if (incomingScore === 0) return false;
  return incomingScore > hintQualityScore(existing);
}

// ---------------------------------------------------------------------------
// Location-specific validators
// ---------------------------------------------------------------------------

const BIO_REJECT_PATTERNS = [
  /\b(experience|years?)\b/i,
  /\b(education|university|college|degree|institute|school)\b/i,
  /\b(engineer|manager|developer|director|analyst|consultant|specialist|coordinator|architect)\b/i,
  /\b(seeking|hiring|looking|open to)\b/i,
  /\b(proficient|expertise|responsible)\b/i,
  /\bprofessional community\b|\bconnections?\b|\bfollowers?\b/i,
];

const KNOWN_CITIES = new Set([
  'san francisco', 'new york', 'los angeles', 'seattle', 'austin',
  'boston', 'chicago', 'denver', 'atlanta', 'miami', 'portland',
  'london', 'berlin', 'paris', 'amsterdam', 'dublin', 'singapore',
  'toronto', 'vancouver', 'sydney', 'melbourne', 'bangalore', 'mumbai',
  'delhi', 'new delhi', 'hyderabad', 'pune', 'chennai', 'kolkata',
  'noida', 'gurgaon', 'gurugram', 'ahmedabad', 'jaipur', 'lucknow',
  'chandigarh', 'kochi', 'indore',
]);

const KNOWN_COUNTRIES = new Set([
  'india', 'germany', 'france', 'canada', 'australia',
  'united kingdom', 'japan', 'brazil',
]);

const KNOWN_STATES_FULL = new Set([
  'california', 'new york', 'texas', 'florida', 'washington',
  'massachusetts', 'illinois', 'georgia', 'colorado', 'virginia',
]);

// Short state codes need word-boundary matching to avoid false positives
// (e.g. "ca" inside "vacation", "co" inside "company")
const SHORT_STATE_CODES = ['ca', 'ny', 'tx', 'fl', 'wa', 'ma', 'il', 'ga', 'co', 'va'];
const SHORT_STATE_RE = new RegExp(`\\b(${SHORT_STATE_CODES.join('|')})\\b`, 'i');

const LOCATION_INDICATOR_WORDS = [
  'area', 'region', 'metropolitan', 'greater', 'bay',
  'city', 'county', 'state', 'province',
];

function containsGeoToken(lower: string, original: string): boolean {
  for (const city of KNOWN_CITIES) {
    if (lower.includes(city)) return true;
  }
  for (const country of KNOWN_COUNTRIES) {
    if (lower.includes(country)) return true;
  }
  for (const state of KNOWN_STATES_FULL) {
    if (lower.includes(state)) return true;
  }
  if (SHORT_STATE_RE.test(original)) return true;
  for (const indicator of LOCATION_INDICATOR_WORDS) {
    if (lower.includes(indicator)) return true;
  }
  return false;
}

export function isLikelyLocationHint(value: string): boolean {
  if (!value || value.length < 2 || value.length > 60) return false;
  if (isNoisyHint(value)) return false;

  for (const pattern of BIO_REJECT_PATTERNS) {
    if (pattern.test(value)) return false;
  }

  const lower = value.toLowerCase();

  if (containsGeoToken(lower, value)) return true;

  // "City, XX" comma pattern
  if (/^\p{L}+(?:\s\p{L}+)*,\s*\p{L}/u.test(value)) return true;

  return false;
}

export function locationHintQualityScore(value: string | null): number {
  if (!value) return 0;
  if (isNoisyHint(value)) return 0;
  if (!isLikelyLocationHint(value)) return 0;

  const lower = value.toLowerCase();

  // Check for city + state/country (comma-separated) → 3
  if (/,/.test(value)) {
    const parts = value.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const hasCity = [...KNOWN_CITIES].some(c => parts[0].toLowerCase().includes(c));
      if (hasCity) return 3;
      // Even without known city, comma pattern with geo tokens is high quality
      return 2;
    }
  }

  // City or region alone → 2
  for (const city of KNOWN_CITIES) {
    if (lower.includes(city)) return 2;
  }
  for (const indicator of LOCATION_INDICATOR_WORDS) {
    if (lower.includes(indicator)) return 2;
  }

  // Country-only → 1
  for (const country of KNOWN_COUNTRIES) {
    if (lower.includes(country)) return 1;
  }

  return 1;
}

export function shouldReplaceLocationHint(existing: string | null, incoming: string | undefined): boolean {
  const normalizedIncoming = normalizeHint(incoming);
  if (!normalizedIncoming) return false;
  const incomingScore = locationHintQualityScore(normalizedIncoming);
  if (incomingScore === 0) return false;
  return incomingScore > locationHintQualityScore(existing);
}
