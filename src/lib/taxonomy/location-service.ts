/**
 * Canonical Location Service — single source of truth for location normalization.
 *
 * Phase 1: deterministic normalization/parsing.
 * Phase 2: Groq LLM fallback for unresolved/ambiguous locations (shadow-safe via caller).
 */

import { createLogger } from '@/lib/logger';
import { getSourcingConfig } from '@/lib/sourcing/config';
import { PLACEHOLDER_HINTS } from '@/lib/sourcing/hint-sanitizer';
import { groqClassifyLocation } from './location-groq';

const log = createLogger('LocationService');

export type LocationFallbackKind = 'unknown' | 'ambiguous';

export interface LocationResolution {
  normalizedInput: string;
  normalized: string;
  rawNormalized: string;
  city: string | null;
  rawCity: string | null;
  countryCode: string | null;
  confidence: number;
  source: 'deterministic' | 'groq';
  fallbackKind: LocationFallbackKind | null;
}

export interface LocationBatchEntry {
  key: string;
  location: string | null | undefined;
  context?: string;
}

export interface LocationResolutionMetrics {
  deterministicHitRate: number;
  cacheHitRate: number;
  llmCallCount: number;
  llmEligibleCount: number;
  skippedLlmCount: number;
  unknownCount: number;
  confidenceDistribution: {
    high: number;   // >= 0.8
    medium: number; // 0.5-0.8
    low: number;    // < 0.5
  };
}

export interface LocationBatchResult {
  resolutions: Map<string, LocationResolution>;
  metrics: LocationResolutionMetrics;
}

const LOCATION_ALIAS_REWRITES: Array<[RegExp, string]> = [
  [/\bbengaluru\b/gi, 'bangalore'],
  [/\bbombay\b/gi, 'mumbai'],
  [/\bnyc\b/gi, 'new york'],
  [/\bsf\b/gi, 'san francisco'],
  [/\bgurugram\b/gi, 'gurgaon'],
  [/\bmünchen\b/gi, 'munich'],
  [/\bm nchen\b/gi, 'munich'],
];

const LOCATION_PLACEHOLDERS = new Set([
  ...PLACEHOLDER_HINTS,
  '.',
  '..',
  'n a',
  'not specified',
]);

const COUNTRY_TOKENS = new Set([
  'india',
  'usa',
  'us',
  'united',
  'states',
  'uk',
  'kingdom',
  'canada',
  'australia',
  'germany',
  'france',
]);

const COUNTRY_CODE_ALIASES: Record<string, string[]> = {
  AE: ['uae', 'united arab emirates', 'dubai', 'abu dhabi'],
  AU: ['australia', 'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide'],
  BR: ['brazil', 'sao paulo', 'rio de janeiro'],
  CA: ['canada', 'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', 'edmonton', 'halifax', 'winnipeg'],
  DE: ['germany', 'deutschland', 'berlin', 'munich', 'frankfurt', 'hamburg'],
  ES: ['spain', 'madrid', 'barcelona'],
  FR: ['france', 'paris', 'lyon', 'marseille'],
  GB: ['uk', 'u k', 'united kingdom', 'england', 'scotland', 'wales', 'great britain', 'london', 'manchester', 'birmingham', 'edinburgh', 'glasgow', 'leeds', 'bristol'],
  ID: ['indonesia', 'jakarta'],
  IE: ['ireland', 'dublin'],
  IN: ['india', 'bangalore', 'bengaluru', 'mumbai', 'bombay', 'delhi', 'new delhi', 'hyderabad', 'chennai', 'pune', 'kolkata', 'noida', 'gurgaon', 'gurugram', 'ahmedabad', 'jaipur', 'lucknow', 'chandigarh', 'kochi', 'indore', 'coimbatore', 'thiruvananthapuram', 'nagpur', 'visakhapatnam'],
  IT: ['italy', 'rome', 'milan'],
  JP: ['japan', 'tokyo', 'osaka'],
  MX: ['mexico', 'mexico city', 'guadalajara', 'monterrey'],
  NL: ['netherlands', 'holland', 'amsterdam', 'rotterdam', 'the hague'],
  SG: ['singapore'],
  SE: ['sweden', 'stockholm', 'gothenburg', 'malmo'],
  US: ['us', 'u s', 'usa', 'u s a', 'united states', 'united states of america', 'america',
    'san francisco', 'new york', 'los angeles', 'seattle', 'austin', 'boston', 'chicago',
    'denver', 'atlanta', 'miami', 'portland', 'houston', 'dallas', 'phoenix', 'philadelphia',
    'san diego', 'san jose', 'washington dc', 'washington d c', 'raleigh', 'minneapolis', 'detroit',
    'salt lake city', 'charlotte', 'nashville', 'pittsburgh', 'columbus', 'indianapolis',
    'mountain view', 'palo alto', 'redmond', 'cupertino', 'menlo park',
    'san francisco bay area', 'bay area', 'silicon valley',
    'new york city', 'new york city metropolitan area', 'nyc metropolitan area',
    // US state names
    'california', 'texas', 'florida', 'washington', 'massachusetts',
    'illinois', 'georgia', 'colorado', 'virginia', 'oregon',
    'north carolina', 'new jersey', 'pennsylvania', 'ohio', 'michigan',
    'arizona', 'maryland', 'minnesota', 'tennessee', 'indiana', 'missouri', 'utah',
    'connecticut',
    // US state abbreviations (post-normalization form)
    'ca', 'tx', 'fl', 'wa', 'ma', 'il', 'ga', 'co', 'va', 'or',
    'nc', 'nj', 'pa', 'oh', 'mi', 'az', 'md', 'mn', 'tn', 'in', 'mo', 'ut', 'ct',
    'ny', 'dc'],
};

const LOCATION_LLM_BATCH_CONCURRENCY = 16;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workers = Math.max(1, concurrency);
  const results = new Array<R>(items.length);
  let index = 0;

  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        results[current] = await mapper(items[current]);
      }
    }),
  );

  return results;
}

function normalizeRawLocation(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9\s,]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function canonicalizeLocation(text: string): string {
  let normalized = text.toLowerCase().trim();
  for (const [pattern, replacement] of LOCATION_ALIAS_REWRITES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(/[^a-z0-9\s,]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isMeaningfulNormalizedLocation(normalized: string): boolean {
  if (!normalized) return false;
  if (LOCATION_PLACEHOLDERS.has(normalized)) return false;
  if (normalized.length <= 1) return false;
  const tokens = normalized.split(/[\s,]+/).map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.every((token) => token.length <= 1)) return false;
  return true;
}

export function isMeaningfulLocation(text: string | null | undefined): boolean {
  if (!text) return false;
  return isMeaningfulNormalizedLocation(canonicalizeLocation(text));
}

function locationTokens(text: string): string[] {
  return canonicalizeLocation(text)
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

export function extractPrimaryCity(normalizedLocation: string): string | null {
  const [firstSegmentRaw] = normalizedLocation.split(',');
  let firstSegment = firstSegmentRaw?.trim() ?? '';
  if (!firstSegment) return null;
  firstSegment = firstSegment
    .replace(/^greater\s+/i, '')
    .replace(/\s+(bay\s+area|area|metropolitan\s+area|metropolitan\s+region|metropolitan|region|urban|district)$/i, '')
    .replace(/\s+city$/i, '')
    .trim();
  if (!firstSegment) return null;
  const tokens = firstSegment.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.every((token) => COUNTRY_TOKENS.has(token))) return null;
  // Strip trailing country words (e.g. "hyderabad india" → "hyderabad")
  if (tokens.length > 1 && COUNTRY_TOKENS.has(tokens[tokens.length - 1])) {
    const cityTokens = tokens.slice(0, -1);
    if (cityTokens.length > 0) return cityTokens.join(' ');
  }
  return firstSegment;
}

export function hasCountryTokenOverlap(targetLocation: string, candidateLocation: string): boolean {
  const targetTokens = locationTokens(targetLocation).filter((token) => COUNTRY_TOKENS.has(token));
  if (targetTokens.length === 0) return false;
  const candidateTokens = new Set(locationTokens(candidateLocation));
  return targetTokens.some((token) => candidateTokens.has(token));
}

export function deriveCountryCodeFromLocationText(
  location: string | null | undefined,
): string | null {
  if (!location) return null;
  const normalized = canonicalizeLocation(location);
  if (!normalized) return null;

  const segments = normalized.split(',').map((segment) => segment.trim()).filter(Boolean);
  const wordTokens = segments.flatMap((seg) => seg.split(/\s+/).filter(Boolean));
  const derivedCity = extractPrimaryCity(normalized);

  const candidates = [
    // Last segment (e.g. "india" from "bangalore, india")
    segments[segments.length - 1],
    // Last two segments joined (e.g. "united states" from "new york, united states")
    segments.length > 1 ? segments.slice(-2).join(' ') : null,
    // Full normalized string
    normalized,
    // Each individual segment (e.g. "seattle" from "seattle, wa")
    ...segments,
    // Last word token (e.g. "india" from "hyderabad india")
    wordTokens[wordTokens.length - 1],
    // Last two word tokens joined (e.g. "united states")
    wordTokens.length > 1 ? wordTokens.slice(-2).join(' ') : null,
    // Derived city after stripping prefixes/suffixes (e.g. "bangalore" from "greater bangalore area")
    derivedCity,
  ].filter((value): value is string => Boolean(value));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    for (const [countryCode, aliases] of Object.entries(COUNTRY_CODE_ALIASES)) {
      if (aliases.includes(candidate)) return countryCode;
    }
  }

  return null;
}

export function resolveLocationDeterministic(
  location: string | null | undefined,
): LocationResolution {
  const normalizedInput = (location ?? '').trim();
  if (!normalizedInput) {
    return {
      normalizedInput: '',
      normalized: '',
      rawNormalized: '',
      city: null,
      rawCity: null,
      countryCode: null,
      confidence: 0,
      source: 'deterministic',
      fallbackKind: 'unknown',
    };
  }

  const rawNormalized = normalizeRawLocation(normalizedInput);
  const normalized = canonicalizeLocation(normalizedInput);
  if (!isMeaningfulNormalizedLocation(normalized)) {
    return {
      normalizedInput,
      normalized,
      rawNormalized,
      city: null,
      rawCity: null,
      countryCode: null,
      confidence: 0,
      source: 'deterministic',
      fallbackKind: 'unknown',
    };
  }

  const rawCity = extractPrimaryCity(rawNormalized);
  const city = extractPrimaryCity(normalized);
  const countryCode = deriveCountryCodeFromLocationText(normalized);
  const hasSignal = Boolean(city || countryCode);

  return {
    normalizedInput,
    normalized,
    rawNormalized,
    city,
    rawCity,
    countryCode,
    confidence: city && countryCode ? 0.95 : hasSignal ? 0.8 : 0.3,
    source: 'deterministic',
    fallbackKind: hasSignal ? null : 'ambiguous',
  };
}

function toResolutionFromGroq(
  location: string,
  groq: {
    city: string | null;
    countryCode: string | null;
    fallbackKind: LocationFallbackKind | null;
    confidence: number;
  },
): LocationResolution {
  const normalizedInput = location.trim();
  const normalized = canonicalizeLocation(
    [groq.city, groq.countryCode].filter(Boolean).join(', ') || location,
  );
  const rawNormalized = normalizeRawLocation(location);
  const rawCity = extractPrimaryCity(rawNormalized);
  const city = groq.city ? canonicalizeLocation(groq.city) : extractPrimaryCity(normalized);

  return {
    normalizedInput,
    normalized,
    rawNormalized,
    city,
    rawCity,
    countryCode: groq.countryCode,
    confidence: groq.confidence,
    source: 'groq',
    fallbackKind: groq.city || groq.countryCode ? null : (groq.fallbackKind ?? 'unknown'),
  };
}

export async function resolveLocation(
  location: string,
  context?: string,
): Promise<LocationResolution> {
  const det = resolveLocationDeterministic(location);
  if (det.city || det.countryCode) return det;
  if (!det.normalized || det.confidence === 0) return det;

  const config = getSourcingConfig();
  if (!config.locationGroqEnabled) return det;

  try {
    const groq = await groqClassifyLocation(location, context ?? null, config);
    if (!groq) return det;
    return toResolutionFromGroq(location, groq);
  } catch (err) {
    log.warn({ error: err, location }, 'Location Groq fallback failed, using deterministic');
    return det;
  }
}

export async function resolveLocationsBatch(
  entries: LocationBatchEntry[],
): Promise<LocationBatchResult> {
  const resolutions = new Map<string, LocationResolution>();
  const confDist = { high: 0, medium: 0, low: 0 };
  let deterministicResolved = 0;
  let cacheResolved = 0;
  let llmCalls = 0;
  let llmEligibleCount = 0;
  let skippedLlmCount = 0;
  let unknownCount = 0;

  const config = getSourcingConfig();
  const uniqueBySignature = new Map<string, { location: string; context?: string; resolution?: LocationResolution }>();

  for (const entry of entries) {
    const loc = (entry.location ?? '').trim();
    const ctx = entry.context?.trim() ?? '';
    const sig = loc.toLowerCase();
    if (!uniqueBySignature.has(sig)) {
      uniqueBySignature.set(sig, { location: loc, context: ctx || undefined });
    } else if (ctx) {
      const existing = uniqueBySignature.get(sig);
      if (existing && (!existing.context || ctx.length > existing.context.length)) {
        existing.context = ctx;
      }
    }
  }

  const llmCandidates: Array<{ signature: string; location: string; context?: string }> = [];
  for (const [, item] of uniqueBySignature) {
    const det = resolveLocationDeterministic(item.location);
    item.resolution = det;
    if (det.city || det.countryCode) {
      deterministicResolved++;
      continue;
    }
    if (!det.normalized || det.confidence === 0) {
      skippedLlmCount++;
      continue;
    }
    llmCandidates.push({
      signature: item.location.toLowerCase(),
      location: item.location,
      context: item.context,
    });
  }

  llmEligibleCount = llmCandidates.length;
  if (config.locationGroqEnabled && llmCandidates.length > 0) {
    const llmResults = await mapWithConcurrency(
      llmCandidates,
      LOCATION_LLM_BATCH_CONCURRENCY,
      async (entry) => {
        try {
          const groq = await groqClassifyLocation(entry.location, entry.context ?? null, config);
          if (!groq) return { signature: entry.signature, resolution: null, cached: false, llmCalled: false };
          return {
            signature: entry.signature,
            resolution: toResolutionFromGroq(entry.location, groq),
            cached: groq.cached,
            llmCalled: !groq.cached,
          };
        } catch (err) {
          log.warn({ error: err, location: entry.location }, 'Batch location Groq failed');
          return { signature: entry.signature, resolution: null, cached: false, llmCalled: false };
        }
      },
    );

    for (const result of llmResults) {
      if (!result.resolution) continue;
      if (result.cached) cacheResolved++;
      if (result.llmCalled) llmCalls++;
      const item = uniqueBySignature.get(result.signature);
      if (item) item.resolution = result.resolution;
    }
  }

  for (const entry of entries) {
    const loc = (entry.location ?? '').trim();
    const sig = loc.toLowerCase();
    const resolution = uniqueBySignature.get(sig)?.resolution ?? resolveLocationDeterministic(loc);
    resolutions.set(entry.key, resolution);
  }

  for (const [, resolution] of resolutions) {
    if (!resolution.city && !resolution.countryCode) unknownCount++;
    if (resolution.confidence >= 0.8) confDist.high++;
    else if (resolution.confidence >= 0.5) confDist.medium++;
    else confDist.low++;
  }

  const total = resolutions.size || 1;
  return {
    resolutions,
    metrics: {
      deterministicHitRate: Number((deterministicResolved / total).toFixed(4)),
      cacheHitRate: Number((cacheResolved / total).toFixed(4)),
      llmCallCount: llmCalls,
      llmEligibleCount,
      skippedLlmCount,
      unknownCount,
      confidenceDistribution: confDist,
    },
  };
}
