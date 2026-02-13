/**
 * Bridge Discovery for Identity Resolution
 *
 * Discovers potential platform identities for LinkedIn candidates using
 * bridge signals like:
 * - Name + Company/Location matching
 * - GitHub profile links to LinkedIn
 * - Commit email patterns
 * - Multi-platform search discovery
 * - URL-anchored reverse link searches (bridge-first)
 *
 * Returns IdentityCandidate entries with evidence pointers (NOT PII).
 *
 * NOTE: Bridge tiering + auto-merge logic is protected by offline eval harness.
 * Changes require fixture updates + CI gate review.
 * @see eval/TODO.md for invariants and metrics.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import {
  getGitHubClient,
  type GitHubUserProfile,
  type CommitEmailEvidence,
} from './github';
import {
  calculateConfidenceScore,
  computeShadowScore,
  classifyConfidence,
  detectContradictions,
  createBridgeFromScoring,
  shouldPersistWithBridge,
  type ScoreBreakdown,
  type ShadowScoreComparison,
  type BridgeDetection,
  type BridgeTier,
} from './scoring';
import {
  STATIC_SCORER_VERSION,
  DYNAMIC_SCORER_VERSION,
} from './scoring-metadata';
import { searchRawMergedProviders } from './sources/search-executor';
import {
  discoverAcrossSources,
  type CandidateHints as SourceCandidateHints,
  type DiscoveredIdentity as SourceDiscoveredIdentity,
  type MultiSourceDiscoveryResult,
} from './sources';
import type { RoleType } from '@/types/linkedin';
import {
  type TrackedQuery,
  type QueryType,
  type BridgeSignal,
  type EnrichmentMetrics,
  type EnrichedHints,
  type Tier1ShadowDiagnostics,
  type Tier1ShadowSample,
  type Tier1BlockReason,
  type Tier1SignalSource,
  createEmptyMetrics,
  createEmptyTier1Shadow,
  TIER_1_SIGNALS,
} from './bridge-types';
import {
  extractAllHints,
  extractAllHintsWithConfidence,
  mergeHintsFromSerpMeta,
} from './hint-extraction';
import { getEnrichmentMinConfidenceThreshold } from './config';
import { createLogger } from '@/lib/logger';

const log = createLogger('BridgeDiscovery');
const urlLog = createLogger('UrlAnchoredDiscovery');

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
  companyHint?: string | null;
  serpTitle?: string;
  serpSnippet?: string;
  serpMeta?: Record<string, unknown>;
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
  /** Bridge detection info (v2.1) */
  bridge?: BridgeDetection;
  /** Bridge tier classification */
  bridgeTier?: BridgeTier;
  /** Reason for persistence decision */
  persistReason?: string;
  /** SERP position for tiebreaker sorting */
  serpPosition?: number;
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
  /** Metrics for this discovery run (v2.1) */
  metrics?: EnrichmentMetrics;
  /** Whether any Tier 1 bridge was found */
  hasTier1Bridge?: boolean;
  /** Tier-1 shadow evaluation diagnostics */
  tier1Shadow?: Tier1ShadowDiagnostics;
}

/**
 * Bridge discovery options
 */
export interface BridgeDiscoveryOptions {
  maxGitHubResults?: number;
  confidenceThreshold?: number;
  includeCommitEvidence?: boolean;
  maxCommitRepos?: number;
  /** Session ID for deterministic Tier-1 shadow sampling */
  sessionId?: string;
}

/**
 * Commit email extraction is disabled by default for compliance.
 * Set ENABLE_COMMIT_EMAIL_EVIDENCE=true to enable gathering commit email pointers.
 * Note: This only gathers evidence pointers (URLs), not the actual emails.
 * Actual email extraction requires explicit confirmation flow.
 */
const ENABLE_COMMIT_EMAIL_EVIDENCE = process.env.ENABLE_COMMIT_EMAIL_EVIDENCE === 'true';

// Tier-1 shadow telemetry flags
const TIER1_SHADOW = process.env.ENRICHMENT_TIER1_SHADOW !== 'false';
const TIER1_ENFORCE = process.env.ENRICHMENT_TIER1_ENFORCE === 'true';
const TIER1_SAMPLE_RATE = (() => {
  const raw = parseFloat(process.env.ENRICHMENT_TIER1_SAMPLE_RATE ?? '');
  if (!Number.isFinite(raw) || raw < 0) return 1;
  return Math.min(raw, 1);
})();

/**
 * Deterministic sampler: hash(sessionId + platformId) → 0..99
 * Reproducible across reruns for the same identity.
 */
function deterministicSample(sessionId: string, platformId: string): number {
  const key = `${sessionId}:${platformId}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100;
}

function getBridgeQueryBudget(): number {
  const raw = process.env.ENRICHMENT_BRIDGE_QUERY_BUDGET;
  if (!raw) return 8;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  log.warn({ rawValue: raw, default: 8 }, 'Invalid ENRICHMENT_BRIDGE_QUERY_BUDGET, using default 8');
  return 8;
}

const DEFAULT_OPTIONS: Required<BridgeDiscoveryOptions> = {
  maxGitHubResults: 5,
  confidenceThreshold: getEnrichmentMinConfidenceThreshold('BridgeDiscovery'),
  includeCommitEvidence: ENABLE_COMMIT_EMAIL_EVIDENCE,
  maxCommitRepos: 3,
  sessionId: '',
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
 * Confidence thresholds for query building
 */
const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.7,    // Use for exact match queries
  MEDIUM: 0.5,  // Use for amplified queries
  LOW: 0.3,     // Use for fuzzy fallbacks
};

/**
 * Build search queries for a candidate with confidence gating
 * Uses hints from search snippets (NOT scraped data)
 *
 * Query strategy (GitHub-native):
 * 1. High-confidence name: exact match queries
 * 2. Medium-confidence: amplified with company/location
 * 3. Low-confidence or missing: slug-based fallback
 */
function buildSearchQueries(
  hints: CandidateHints,
  enrichedHints?: EnrichedHints
): TrackedQuery[] {
  const queries: TrackedQuery[] = [];
  const seen = new Set<string>();

  const addQuery = (query: string, type: QueryType, variantId: string) => {
    const normalized = query.toLowerCase().trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      queries.push({ query, type, variantId });
    }
  };

  // Get confidence levels (use enrichedHints if provided, otherwise assume high confidence)
  const nameConfidence = enrichedHints?.nameHint?.confidence ?? 0.8;
  const companyConfidence = enrichedHints?.companyHint?.confidence ?? 0.5;
  const locationConfidence = enrichedHints?.locationHint?.confidence ?? 0.5;

  // === Phase 1: Name-based queries (confidence-gated) ===
  if (hints.nameHint && nameConfidence >= CONFIDENCE_THRESHOLDS.LOW) {
    // High confidence: use exact match
    if (nameConfidence >= CONFIDENCE_THRESHOLDS.HIGH) {
      addQuery(`"${hints.nameHint}"`, 'name_only', 'name_exact');
    }
    // Medium confidence: use unquoted for fuzzy match
    addQuery(hints.nameHint, 'name_only', 'name');

    // Name + Company (prefer explicit company hint)
    let companyHint = hints.companyHint || null;
    if (!companyHint && hints.headlineHint) {
      const companyMatch = hints.headlineHint.match(
        /(?:at|@|,)\s*([\p{L}\p{N}][\p{L}\p{N}\s&.,'-]+?)(?:\s*[-|·]|$)/u
      );
      if (companyMatch) {
        companyHint = companyMatch[1].trim();
      }
    }

    // Only use company if confidence is adequate
    if (companyHint && companyConfidence >= CONFIDENCE_THRESHOLDS.MEDIUM) {
      addQuery(`"${hints.nameHint}" "${companyHint}"`, 'name_company', 'name+company');
      // Company-amplified variants (only for high-confidence names)
      if (nameConfidence >= CONFIDENCE_THRESHOLDS.HIGH) {
        addQuery(`"${hints.nameHint}" "${companyHint}" github`, 'company_amplified', 'name+company+github');
        addQuery(`"${hints.nameHint}" "${companyHint}" linkedin`, 'company_amplified', 'name+company+linkedin');
      }
    }

    // Name + Location (only if both have adequate confidence)
    if (hints.locationHint && hints.locationHint.length < 30 &&
        locationConfidence >= CONFIDENCE_THRESHOLDS.MEDIUM) {
      addQuery(`"${hints.nameHint}" ${hints.locationHint}`, 'name_location', 'name+location');
    }

    // Name + Headline keywords (for tech talent — only technical roles)
    if (hints.headlineHint && (hints.roleType === 'engineer' || hints.roleType === 'data_scientist' || hints.roleType === 'researcher')) {
      const techKeywords = extractTechKeywords(hints.headlineHint);
      if (techKeywords.length > 0) {
        addQuery(`"${hints.nameHint}" ${techKeywords.slice(0, 2).join(' ')}`, 'company_amplified', 'name+tech');
      }
    }
  }

  // === Phase 1.5: Company/Location-centric queries (when name is weak) ===
  {
    let companyHint = hints.companyHint || null;
    if (!companyHint && hints.headlineHint) {
      const companyMatch = hints.headlineHint.match(
        /(?:at|@|,)\s*([\p{L}\p{N}][\p{L}\p{N}\s&.,'-]+?)(?:\s*[-|·]|$)/u
      );
      if (companyMatch) {
        companyHint = companyMatch[1].trim();
      }
    }
    if (companyHint && companyConfidence >= 0.85 && nameConfidence < CONFIDENCE_THRESHOLDS.MEDIUM) {
      addQuery(`"${companyHint}" linkedin`, 'company_only', 'company_only');
      if (hints.locationHint && locationConfidence >= CONFIDENCE_THRESHOLDS.MEDIUM) {
        addQuery(`"${companyHint}" ${hints.locationHint}`, 'company_location', 'company+location');
      }
    }
  }

  // === Phase 2: Slug-based fallback queries ===
  // Use when no name hint OR name confidence is too low
  if (queries.length === 0 || !hints.nameHint || nameConfidence < CONFIDENCE_THRESHOLDS.LOW) {
    const fallbacks = buildFallbackQueries(hints);
    for (const q of fallbacks) {
      addQuery(q.query, q.type, q.variantId);
    }
  }

  // Enforce query budget
  const maxQueries = getBridgeQueryBudget();
  return queries.slice(0, maxQueries);
}

/**
 * Build URL-anchored reverse link queries
 * These search for pages that link TO the LinkedIn profile (strongest bridge signal)
 */
function buildUrlAnchoredQueries(hints: CandidateHints): TrackedQuery[] {
  const queries: TrackedQuery[] = [];
  const linkedinUrl = getCanonicalLinkedInUrl(hints);

  if (!linkedinUrl) return queries;

  // Exact URL search (quoted)
  queries.push({
    query: `"${linkedinUrl}"`,
    type: 'url_reverse',
    variantId: 'url_exact',
  });

  // URL + GitHub context
  queries.push({
    query: `"${linkedinUrl}" site:github.com`,
    type: 'url_reverse',
    variantId: 'url_github',
  });

  // URL + personal site context
  queries.push({
    query: `"${linkedinUrl}" (github OR "personal site" OR portfolio OR about)`,
    type: 'url_reverse',
    variantId: 'url_personal',
  });

  // URL + conference context (tech talent often listed as speakers)
  if (hints.roleType === 'engineer' || hints.roleType === 'researcher') {
    queries.push({
      query: `"${linkedinUrl}" (conference OR speaker OR talk OR meetup OR sessionize)`,
      type: 'url_reverse',
      variantId: 'url_conference',
    });
  }

  return queries;
}

/**
 * Canonicalize LinkedIn URL for reverse-link matching and queries.
 */
function getCanonicalLinkedInUrl(hints: CandidateHints): string | null {
  if (hints.linkedinId) {
    return `https://www.linkedin.com/in/${hints.linkedinId}`;
  }

  if (!hints.linkedinUrl) return null;

  try {
    const parsed = new URL(hints.linkedinUrl);
    if (!parsed.hostname.includes('linkedin.com')) return null;

    const host = parsed.hostname.replace(/^www\./, '');
    const pathname = parsed.pathname.replace(/\/$/, '');
    return `https://www.${host}${pathname}`;
  } catch {
    return null;
  }
}

/**
 * Build fallback queries when name hints are missing.
 * Uses LinkedIn slug with numeric suffix handling.
 */
function buildFallbackQueries(hints: CandidateHints): TrackedQuery[] {
  const queries: TrackedQuery[] = [];
  const handle = hints.linkedinId?.trim();

  if (!handle) return queries;

  // Strip numeric suffix for name-guess queries
  // "john-smith-12345" -> "john-smith" for name queries
  // but keep "john-smith-12345" for exact handle search
  const withoutNumericSuffix = handle
    .replace(/-[a-f0-9]{6,}$/i, '')  // Remove hex suffix
    .replace(/-\d{3,}$/, '');        // Remove numeric suffix

  // Exact handle (might find matching handles on other platforms)
  queries.push({
    query: handle,
    type: 'handle_based',
    variantId: 'handle_exact',
  });

  // Handle without numeric suffix (if different)
  if (withoutNumericSuffix && withoutNumericSuffix !== handle) {
    queries.push({
      query: withoutNumericSuffix,
      type: 'handle_based',
      variantId: 'handle_clean',
    });
  }

  // Convert hyphens to spaces for name-like search
  // "john-smith" -> "john smith"
  if (withoutNumericSuffix.includes('-')) {
    const spaced = withoutNumericSuffix.replace(/-/g, ' ').trim();
    if (spaced && spaced !== handle) {
      queries.push({
        query: spaced,
        type: 'slug_based',
        variantId: 'slug_spaced',
      });

      // Add quoted version for exact phrase
      queries.push({
        query: `"${spaced}"`,
        type: 'slug_based',
        variantId: 'slug_quoted',
      });
    }
  }

  return queries;
}

/**
 * Extract tech keywords from headline for query amplification
 */
function extractTechKeywords(headline: string): string[] {
  const techTerms = [
    'python', 'javascript', 'typescript', 'java', 'go', 'rust', 'c++',
    'react', 'angular', 'vue', 'node', 'django', 'flask', 'rails',
    'aws', 'gcp', 'azure', 'kubernetes', 'docker', 'terraform',
    'ml', 'ai', 'machine learning', 'data science', 'deep learning',
    'backend', 'frontend', 'fullstack', 'devops', 'sre',
  ];

  const lower = headline.toLowerCase();
  return techTerms.filter(term => lower.includes(term));
}

/**
 * Result from URL-anchored web search
 */
export interface UrlAnchoredResult {
  /** URL of the page that mentions the LinkedIn profile */
  sourceUrl: string;
  /** Title of the page */
  title: string;
  /** Snippet containing the LinkedIn URL mention */
  snippet: string;
  /** Platform detected from the URL (github, medium, etc.) */
  platform: string | null;
  /** Platform ID extracted if possible */
  platformId: string | null;
  /** Bridge signal type */
  signal: BridgeSignal;
  /** Optional extra signals derived from corroborating hints */
  extraSignals?: BridgeSignal[];
  /** SERP position from the search result */
  serpPosition?: number;
}

/**
 * Execute URL-anchored reverse link discovery via web search
 *
 * This searches for pages that link TO the LinkedIn profile using
 * general web search providers (Serper + Brave), not GitHub search.
 *
 * Returns pages that contain the LinkedIn URL, which can then be
 * parsed to extract platform identities (GitHub profiles, personal sites, etc.)
 */
export async function discoverUrlAnchoredBridges(
  hints: CandidateHints,
  metrics: EnrichmentMetrics
): Promise<{ results: UrlAnchoredResult[]; queriesExecuted: number }> {
  const results: UrlAnchoredResult[] = [];
  const linkedinUrl = getCanonicalLinkedInUrl(hints);

  if (!linkedinUrl) return { results, queriesExecuted: 0 };

  // Boundary pattern: end of string, whitespace, or common URL terminators
  // Includes: space, newline, ), ], }, ", ', ,, ., ;, :, and end-of-string
  const boundaryPattern = `(?:[/?#\\s)\\]}"',\\.;:]|$)`;

  // LinkedIn ID pattern - matches linkedin.com/in/{id} with various prefixes
  // Handles: https://www.linkedin.com, https://linkedin.com, http://, m.linkedin.com
  const linkedinIdPattern = hints.linkedinId
    ? new RegExp(
        `(?:https?://)?(?:www\\.|m\\.)?linkedin\\.com/in/${escapeRegExp(hints.linkedinId)}${boundaryPattern}`,
        'i'
      )
    : null;

  // Full URL pattern
  const linkedinUrlPattern = new RegExp(escapeRegExp(linkedinUrl), 'i');

  // Encoded URL patterns (for URLs embedded in other URLs or JSON)
  const encodedLinkedinUrl = encodeURIComponent(linkedinUrl);
  const encodedLinkedinUrlAlt = hints.linkedinId
    ? encodeURIComponent(`https://linkedin.com/in/${hints.linkedinId}`)
    : null;
  const encodedUrlPattern = new RegExp(escapeRegExp(encodedLinkedinUrl), 'i');
  const encodedUrlAltPattern = encodedLinkedinUrlAlt
    ? new RegExp(escapeRegExp(encodedLinkedinUrlAlt), 'i')
    : null;

  // Build URL-anchored queries for web search
  const queries = buildUrlAnchoredQueries(hints);

  // Update metrics
  for (const q of queries) {
    metrics.queriesByType[q.type] = (metrics.queriesByType[q.type] || 0) + 1;
    metrics.totalQueries++;
  }

  urlLog.info({ queryCount: queries.length, linkedinId: hints.linkedinId }, 'Executing URL-anchored queries');

  for (const trackedQuery of queries) {
    try {
      // Use merged Serper + Brave results for URL-anchored search (recall > cost)
      const searchResults = await searchRawMergedProviders(trackedQuery.query, 10);

      for (const result of searchResults) {
        // Skip LinkedIn results (we're looking for external pages)
        if (result.url.includes('linkedin.com')) continue;

        // Build haystack from title, snippet, and URL
        const rawHaystack = `${result.title} ${result.snippet} ${result.url}`;

        // Iterative decode (max 3 passes) to handle encoded URLs
        const haystacks = [rawHaystack];
        let decoded = rawHaystack;
        for (let i = 0; i < 3; i++) {
          try {
            // Decode common URL encodings
            const next = decoded
              .replace(/%2F/gi, '/')
              .replace(/%3A/gi, ':')
              .replace(/%3D/gi, '=')
              .replace(/%26/gi, '&')
              .replace(/%3F/gi, '?')
              .replace(/\+/g, ' ');
            // Also try full decodeURIComponent
            const fullDecoded = decodeURIComponent(next);
            if (fullDecoded === decoded) break; // No change, stop
            decoded = fullDecoded;
            haystacks.push(decoded);
          } catch {
            break; // Invalid encoding, stop
          }
        }

        // Check all haystack variants for LinkedIn mention
        const mentionsLinkedIn = haystacks.some(haystack =>
          linkedinUrlPattern.test(haystack) ||
          encodedUrlPattern.test(haystack) ||
          (encodedUrlAltPattern ? encodedUrlAltPattern.test(haystack) : false) ||
          (linkedinIdPattern ? linkedinIdPattern.test(haystack) : false)
        );

        if (!mentionsLinkedIn) continue;

        // Detect platform from URL
        const { platform, platformId } = detectPlatformFromUrl(result.url);

        // Assign appropriate bridge signal
        const signal: BridgeSignal = platform === 'companyteam'
          ? 'linkedin_url_in_team_page'
          : 'linkedin_url_in_page';

        // Corroborate company/location hints from reverse-link title/snippet
        const pageHints = extractAllHints(hints.linkedinId, result.title || '', result.snippet || '');
        const normalizeHint = (value: string | null | undefined) =>
          value ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
        const hintMatches = (a: string | null | undefined, b: string | null | undefined) => {
          const na = normalizeHint(a);
          const nb = normalizeHint(b);
          return Boolean(na && nb && (na.includes(nb) || nb.includes(na)));
        };

        const matchesCompany = hintMatches(hints.companyHint, pageHints.companyHint);
        const matchesLocation = hintMatches(hints.locationHint, pageHints.locationHint);
        const extraSignals: BridgeSignal[] = [];
        if (matchesCompany || matchesLocation) {
          extraSignals.push('reverse_link_hint_match');
        }

        // Skip LinkedIn-adjacent domains (lead-gen tools, not real bridges)
        try {
          const host = new URL(result.url).hostname.toLowerCase();
          if (/linkedin-?leads|linkedhelper|phantombuster|dripify|expandi/i.test(host)) continue;
        } catch { /* invalid URL, keep result */ }

        results.push({
          sourceUrl: result.url,
          title: result.title,
          snippet: result.snippet || '',
          platform,
          platformId,
          signal,
          extraSignals: extraSignals.length > 0 ? extraSignals : undefined,
          serpPosition: result.position,
        });
        metrics.candidatesFound += 1;

        urlLog.info({ url: result.url, signal, platform: platform || 'unknown' }, 'Found bridge');
      }
    } catch (error) {
      urlLog.error(
        { query: trackedQuery.query, error: error instanceof Error ? error.message : error },
        'Query failed'
      );
    }
  }

  urlLog.info({ bridgeCount: results.length }, 'Found URL-anchored bridges');
  return { results, queriesExecuted: queries.length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect platform and extract ID from a URL
 */
function detectPlatformFromUrl(url: string): { platform: string | null; platformId: string | null } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname;
    const segments = path.split('/').filter(Boolean);

    // GitHub
    if (host === 'github.com' || host === 'www.github.com') {
      if (segments.length === 1) {
        const handle = segments[0];
        if (!['about', 'features', 'pricing', 'enterprise', 'topics', 'collections', 'trending', 'events', 'sponsors', 'settings', 'marketplace', 'explore', 'notifications', 'issues', 'pulls', 'discussions', 'codespaces', 'orgs'].includes(handle)) {
          return { platform: 'github', platformId: handle };
        }
      }
    }

    // Twitter/X
    if (host === 'twitter.com' || host === 'x.com' || host === 'www.twitter.com') {
      const match = path.match(/^\/([^/]+)/);
      if (match && !['home', 'explore', 'notifications', 'messages', 'settings', 'i', 'search'].includes(match[1])) {
        return { platform: 'twitter', platformId: match[1] };
      }
    }

    // Medium
    if (host === 'medium.com' || host.endsWith('.medium.com')) {
      const match = path.match(/^\/@([^/]+)/);
      if (match) {
        return { platform: 'medium', platformId: match[1] };
      }
    }

    // Substack
    if (host.endsWith('.substack.com')) {
      const subdomain = host.replace('.substack.com', '');
      return { platform: 'substack', platformId: subdomain };
    }

    // Personal sites / portfolios (common patterns)
    if (path.includes('/about') || path.includes('/team') || path.includes('/people')) {
      return { platform: 'companyteam', platformId: null };
    }

    return { platform: null, platformId: null };
  } catch {
    return { platform: null, platformId: null };
  }
}

/**
 * Update metrics with query breakdown
 */
function updateQueryMetrics(metrics: EnrichmentMetrics, queries: TrackedQuery[]): void {
  for (const q of queries) {
    metrics.queriesByType[q.type] = (metrics.queriesByType[q.type] || 0) + 1;
    metrics.totalQueries++;
  }
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
  let hasTier1Bridge = false;

  // Initialize metrics
  const metrics = createEmptyMetrics();
  metrics.scoringVersion = STATIC_SCORER_VERSION;
  metrics.dynamicScoringVersion = DYNAMIC_SCORER_VERSION;

  // Initialize Tier-1 shadow diagnostics
  const tier1Shadow = TIER1_SHADOW
    ? createEmptyTier1Shadow(true, TIER1_ENFORCE, TIER1_SAMPLE_RATE)
    : undefined;
  const shadowSessionId = opts.sessionId || candidateId;

  // Track Tier-2 identity count (global cap, not per-platform)
  let tier2Count = 0;

  // Build enriched hints with confidence scoring
  // Use real SERP title/snippet when available, fall back to parsed hints
  const baseHints = extractAllHintsWithConfidence(
    hints.linkedinId,
    hints.linkedinUrl,
    hints.serpTitle || hints.nameHint || '',
    hints.serpSnippet || hints.headlineHint || '',
    hints.roleType
  );

  // Upgrade hints from KG/answerBox when available (higher confidence)
  const enrichedHints = mergeHintsFromSerpMeta(baseHints, hints.serpMeta);

  // Log hint confidence for debugging
  log.info({
    linkedinId: hints.linkedinId,
    nameConfidence: enrichedHints.nameHint.confidence,
    companyConfidence: enrichedHints.companyHint.confidence,
    locationConfidence: enrichedHints.locationHint.confidence,
  }, 'Hint confidence');

  // Run URL-anchored reverse link discovery via web search
  const { results: urlBridges, queriesExecuted: urlQueriesExecuted } =
    await discoverUrlAnchoredBridges(hints, metrics);
  queriesExecuted += urlQueriesExecuted;

  // Build GitHub-native search queries with confidence gating
  const queries = buildSearchQueries(hints, enrichedHints);
  updateQueryMetrics(metrics, queries);

  if (queries.length === 0 && urlBridges.length === 0) {
    log.warn({ linkedinId: hints.linkedinId }, 'No search queries for candidate (no name hint)');
    return {
      candidateId,
      linkedinId: hints.linkedinId,
      identitiesFound: [],
      queriesExecuted,
      earlyStopReason: 'no_search_queries',
      metrics,
      hasTier1Bridge: false,
    };
  }

  // Track seen profiles to avoid duplicates
  const seenProfiles = new Set<string>();

  // Shadow scoring: collect dynamic vs static comparisons for logging
  const shadowScores: Array<{ login: string; boostedTotal?: number } & ShadowScoreComparison> = [];

  const reverseBridgeMap = new Map<string, {
    bridgeUrl: string | null;
    signals: BridgeSignal[];
    title?: string;
    snippet?: string;
    serpPosition?: number;
  }>();
  for (const bridge of urlBridges) {
    if (bridge.platform !== 'github' || !bridge.platformId) continue;
    const loginKey = bridge.platformId.toLowerCase();
    const existing = reverseBridgeMap.get(loginKey);
    const allSignals = [bridge.signal, ...(bridge.extraSignals || [])];
    if (existing) {
      const mergedSignals = new Set([...existing.signals, ...allSignals]);
      reverseBridgeMap.set(loginKey, {
        bridgeUrl: existing.bridgeUrl || bridge.sourceUrl,
        signals: Array.from(mergedSignals),
        title: existing.title || bridge.title,
        snippet: existing.snippet || bridge.snippet,
        serpPosition: existing.serpPosition ?? bridge.serpPosition,
      });
    } else {
      reverseBridgeMap.set(loginKey, {
        bridgeUrl: bridge.sourceUrl,
        signals: allSignals,
        title: bridge.title,
        snippet: bridge.snippet,
        serpPosition: bridge.serpPosition,
      });
    }
  }

  const processLogin = async (
    login: string,
    extraSignals: BridgeSignal[] = [],
    bridgeUrl: string | null = null,
    serpPosition?: number
  ) => {
    const loginKey = login.toLowerCase();
    if (seenProfiles.has(loginKey)) return;
    seenProfiles.add(loginKey);

    try {
      const profile = await github.getUser(login);

      const linkedInId = extractLinkedInFromProfile(profile);
      const hasProfileLink =
        linkedInId?.toLowerCase() === hints.linkedinId.toLowerCase();

      let commitEvidence: CommitEmailEvidence[] = [];
      if (opts.includeCommitEvidence) {
        commitEvidence = await github.getCommitEvidence(
          login,
          opts.maxCommitRepos
        );
      } else if (queriesExecuted === 0) {
        log.info('Commit email evidence disabled (set ENABLE_COMMIT_EMAIL_EVIDENCE=true to enable)');
      }

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
        // Hint confidence for dynamic scoring (shadow mode)
        nameHintConfidence: enrichedHints.nameHint.confidence,
        companyHintConfidence: enrichedHints.companyHint.confidence,
        locationHintConfidence: enrichedHints.locationHint.confidence,
      };

      const resolvedBridgeUrl = bridgeUrl || (hasProfileLink ? profile.html_url : null);
      const bridge = createBridgeFromScoring(scoreInput, resolvedBridgeUrl, extraSignals);
      const baseScore = calculateConfidenceScore(scoreInput);

      // Shadow scoring: compute dynamic score for comparison logging (no production impact)
      const shadowComparison = computeShadowScore(scoreInput);
      shadowScores.push({
        login,
        ...shadowComparison,
      });

      // Apply Tier-1 boost when strict Tier-1 evidence exists (not team-page, no contradictions)
      const { hasContradiction } = detectContradictions(scoreInput);
      const isStrictTier1 = bridge.tier === 1 &&
        !bridge.signals.includes('linkedin_url_in_team_page') &&
        !hasContradiction;
      const TIER_1_BOOST = 0.08;
      const boostedTotal = isStrictTier1
        ? Math.min(1.0, baseScore.total + TIER_1_BOOST)
        : baseScore.total;

      // Record boosted total on shadow entry for diagnostics
      const shadowEntry = shadowScores.find(s => s.login === login);
      if (shadowEntry && boostedTotal !== baseScore.total) {
        shadowEntry.boostedTotal = boostedTotal;
      }

      // scoreBreakdown should only contain numeric fields for scoring
      // Bridge info is stored separately on the identity (bridgeTier, bridge.signals, etc.)
      const scoreBreakdown: ScoreBreakdown = {
        ...baseScore,
        total: boostedTotal,
      };
      const confidence = boostedTotal;
      const confidenceBucket = classifyConfidence(confidence);

      // Track bridge signals in metrics (including 'none' when no meaningful signals)
      if (bridge.hadNoSignals) {
        metrics.bridgesBySignal.none = (metrics.bridgesBySignal.none || 0) + 1;
      } else {
        for (const signal of bridge.signals) {
          metrics.bridgesBySignal[signal] = (metrics.bridgesBySignal[signal] || 0) + 1;
        }
      }
      if (bridge.signals.length > 0) {
        metrics.totalBridges++;
      }

      // Get contradiction note (hasContradiction already computed above for Tier-1 boost)
      const { note: contradictionNote } = detectContradictions(scoreInput);

      // Tier-1 shadow evaluation (log-only, no behavior change)
      if (tier1Shadow && deterministicSample(shadowSessionId, login) < TIER1_SAMPLE_RATE * 100) {
        const tier1Signals = bridge.signals.filter(
          (s): s is Tier1SignalSource => (TIER_1_SIGNALS as string[]).includes(s)
        );
        const nameMismatch =
          !!scoreInput.candidateName &&
          !!scoreInput.platformName &&
          baseScore.nameMatch < 0.1;
        const hasTeamPageSignal = bridge.signals.includes('linkedin_url_in_team_page');
        const hasIdMismatch =
          !!hints.linkedinId &&
          !!linkedInId &&
          linkedInId.toLowerCase() !== hints.linkedinId.toLowerCase();

        const blockReasons: Tier1BlockReason[] = [];
        if (tier1Signals.length === 0) blockReasons.push('no_bridge_signal');
        if (confidence < 0.85) blockReasons.push('low_confidence');
        if (hasContradiction) blockReasons.push('contradiction');
        if (nameMismatch) blockReasons.push('name_mismatch');
        if (hasTeamPageSignal) blockReasons.push('team_page');
        if (hasIdMismatch) blockReasons.push('id_mismatch');

        const wouldAutoMerge = tier1Signals.length > 0 &&
          confidence >= 0.85 &&
          !hasContradiction &&
          !nameMismatch &&
          !hasTeamPageSignal &&
          !hasIdMismatch;

        const sample: Tier1ShadowSample = {
          platform: 'github',
          platformId: login,
          signals: tier1Signals,
          blockReasons,
          confidenceScore: confidence,
          wouldAutoMerge,
          actuallyPromoted: false, // Always false - this PR is log-only
          bridgeTier: bridge.tier,
        };

        tier1Shadow.totalEvaluated++;
        if (wouldAutoMerge) tier1Shadow.wouldAutoMerge++;
        if (!wouldAutoMerge) {
          tier1Shadow.blocked++;
          for (const reason of blockReasons) {
            tier1Shadow.blockReasonCounts[reason]++;
          }
        }
        if (tier1Shadow.samples.length < 20) {
          tier1Shadow.samples.push(sample);
        }
      }

      const persistResult = shouldPersistWithBridge(
        scoreBreakdown,
        bridge,
        tier2Count
      );

      metrics.identitiesByTier[persistResult.tier] =
        (metrics.identitiesByTier[persistResult.tier] || 0) + 1;

      if (persistResult.shouldPersist) {
        if (bridge.tier === 2) {
          tier2Count += 1;
        }

        if (bridge.tier === 1) {
          hasTier1Bridge = true;
          metrics.hasTier1Bridge = true;
        }

        identitiesFound.push({
          platform: 'github',
          platformId: login,
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
          bridge,
          bridgeTier: bridge.tier,
          persistReason: persistResult.reason,
          serpPosition,
        });

        log.info({
          login,
          confidence,
          tier: bridge.tier,
          reason: persistResult.reason,
        }, 'Found match');

        if (bridge.tier === 1) {
          earlyStopReason = 'tier1_bridge_found';
        }
      } else {
        log.info({
          login,
          tier: bridge.tier,
          reason: persistResult.reason,
        }, 'Skipped');
      }
    } catch (error) {
      log.warn({
        login,
        error: error instanceof Error ? error.message : error,
      }, 'Failed to process');
    }
  };

  for (const [login, bridgeInfo] of reverseBridgeMap.entries()) {
    await processLogin(login, bridgeInfo.signals, bridgeInfo.bridgeUrl, bridgeInfo.serpPosition);
    if (earlyStopReason) break;
  }

  if (!earlyStopReason) {
    for (const trackedQuery of queries) {
      try {
        queriesExecuted++;

        log.info({
          query: trackedQuery.query,
          type: trackedQuery.type,
          linkedinId: hints.linkedinId,
        }, 'Searching GitHub');

        const searchResults = await github.searchUsers(trackedQuery.query, opts.maxGitHubResults);
        metrics.candidatesFound += searchResults.length;

        for (const result of searchResults) {
          await processLogin(result.login);
          if (earlyStopReason) break;
        }

        if (earlyStopReason) break;
      } catch (error) {
        log.error({
          query: trackedQuery.query,
          error: error instanceof Error ? error.message : error,
        }, 'Query failed');
      }
    }
  }

  // Sort by bridge tier (lower is better), then confidence, then SERP position tiebreaker
  identitiesFound.sort((a, b) => {
    const tierDiff = (a.bridgeTier || 3) - (b.bridgeTier || 3);
    if (tierDiff !== 0) return tierDiff;
    const confDiff = b.confidence - a.confidence;
    if (Math.abs(confDiff) > 0.01) return confDiff;
    return (a.serpPosition ?? Infinity) - (b.serpPosition ?? Infinity);
  });

  log.info({
    linkedinId: hints.linkedinId,
    identitiesFound: identitiesFound.length,
    queriesExecuted,
    hasTier1Bridge,
  }, 'Completed');

  // Log metrics summary
  log.info({
    queriesByType: metrics.queriesByType,
    totalBridges: metrics.totalBridges,
    identitiesByTier: metrics.identitiesByTier,
  }, 'Metrics');

  // Shadow scoring: log dynamic vs static comparison (no production impact)
  if (shadowScores.length > 0) {
    const bucketChanges = shadowScores.filter(s => s.bucketChanged);
    const avgDelta = shadowScores.reduce((sum, s) => sum + s.delta, 0) / shadowScores.length;
    log.info({
      linkedinId: hints.linkedinId,
      profilesScored: shadowScores.length,
      avgDelta,
      bucketChanges: bucketChanges.length,
    }, 'Shadow scoring');
    if (bucketChanges.length > 0) {
      for (const change of bucketChanges) {
        log.info({
          login: change.login,
          staticBucket: change.staticBucket,
          dynamicBucket: change.dynamicBucket,
          staticScore: change.staticScore.total,
          dynamicScore: change.dynamicScore.total,
        }, 'Shadow bucket change');
      }
    }
    // Attach shadow scores to metrics for runTrace persistence
    metrics.shadowScoring = {
      profilesScored: shadowScores.length,
      avgDelta,
      bucketChanges: bucketChanges.length,
      staticScoringVersion: STATIC_SCORER_VERSION,
      dynamicScoringVersion: DYNAMIC_SCORER_VERSION,
      details: shadowScores.map(s => ({
        login: s.login,
        staticTotal: s.staticScore.total,
        ...(s.boostedTotal !== undefined ? { boostedTotal: s.boostedTotal } : {}),
        dynamicTotal: s.dynamicScore.total,
        delta: s.delta,
        staticBucket: s.staticBucket,
        dynamicBucket: s.dynamicBucket,
        bucketChanged: s.bucketChanged,
      })),
    };
  }

  // Log Tier-1 shadow summary
  if (tier1Shadow && tier1Shadow.totalEvaluated > 0) {
    log.info({
      linkedinId: hints.linkedinId,
      totalEvaluated: tier1Shadow.totalEvaluated,
      wouldAutoMerge: tier1Shadow.wouldAutoMerge,
      blocked: tier1Shadow.blocked,
      blockReasonCounts: tier1Shadow.blockReasonCounts,
    }, 'Tier-1 shadow');
  }

  return {
    candidateId,
    linkedinId: hints.linkedinId,
    identitiesFound,
    queriesExecuted,
    earlyStopReason,
    metrics,
    hasTier1Bridge,
    tier1Shadow,
  };
}

/**
 * Check if a platform is supported for bridge discovery
 * Only returns true for implemented sources
 */
export function isSupportedPlatform(platform: string): boolean {
  const supported = [
    // Code & Engineering
    'github',       // Direct API
    'stackoverflow',
    'npm',
    'pypi',
    'leetcode',
    'hackerearth',
    'gitlab',
    'dockerhub',
    'codepen',
    'gist',
    'devto',
    // Data Science & ML
    'kaggle',
    'huggingface',
    'paperswithcode',
    'openreview',
    // Academic
    'orcid',
    'scholar',
    'semanticscholar',
    'researchgate',
    'arxiv',
    'patents',
    'university',
    // Founder
    'sec',
    'crunchbase',
    'angellist',
    'companyteam',
    // Content
    'medium',
    'substack',
    'youtube',
    'twitter',
    // Design
    'dribbble',
    'behance',
  ];
  return supported.includes(platform.toLowerCase());
}

/**
 * Get supported platforms for a role type
 * Uses the v2.1 matrix priorities - only includes implemented sources
 */
export function getPlatformsForRoleType(roleType: string | null): string[] {
  switch (roleType) {
    case 'engineer':
      return ['github', 'stackoverflow', 'npm', 'pypi', 'leetcode', 'hackerearth', 'gitlab', 'dockerhub', 'codepen', 'gist', 'devto'];
    case 'data_scientist':
      return ['github', 'kaggle', 'huggingface', 'paperswithcode', 'openreview', 'scholar', 'gist', 'stackoverflow'];
    case 'researcher':
      return ['orcid', 'scholar', 'semanticscholar', 'openreview', 'researchgate', 'arxiv', 'patents', 'university', 'github'];
    case 'founder':
      return ['sec', 'crunchbase', 'angellist', 'companyteam', 'github', 'twitter', 'medium', 'youtube', 'substack'];
    case 'designer':
      return ['dribbble', 'behance', 'github', 'codepen', 'twitter', 'medium'];
    default:
      return ['github', 'stackoverflow', 'twitter', 'medium', 'companyteam'];
  }
}

/**
 * Convert local CandidateHints to source-compatible format
 */
function toSourceHints(hints: CandidateHints): SourceCandidateHints {
  // Extract company from headline if not provided
  let companyHint = hints.companyHint || null;
  if (!companyHint && hints.headlineHint) {
    const match = hints.headlineHint.match(/(?:at|@|,)\s*([A-Z][A-Za-z0-9\s&]+?)(?:\s*[-|·]|$)/);
    if (match) {
      companyHint = match[1].trim();
    }
  }

  return {
    linkedinId: hints.linkedinId,
    linkedinUrl: hints.linkedinUrl,
    nameHint: hints.nameHint,
    headlineHint: hints.headlineHint,
    locationHint: hints.locationHint,
    companyHint,
    roleType: (hints.roleType as RoleType) || null,
  };
}

/**
 * Convert source DiscoveredIdentity to local format
 */
function fromSourceIdentity(identity: SourceDiscoveredIdentity): DiscoveredIdentity {
  return {
    platform: identity.platform,
    platformId: identity.platformId,
    profileUrl: identity.profileUrl,
    confidence: identity.confidence,
    confidenceBucket: identity.confidenceBucket,
    scoreBreakdown: identity.scoreBreakdown,
    evidence: null, // Search-based discovery doesn't have commit evidence
    hasContradiction: identity.hasContradiction,
    contradictionNote: identity.contradictionNote,
    platformProfile: {
      name: identity.platformProfile.name,
      company: identity.platformProfile.company,
      location: identity.platformProfile.location,
      bio: identity.platformProfile.bio,
      followers: identity.platformProfile.followers || 0,
      publicRepos: identity.platformProfile.publicRepos || 0,
    },
  };
}

/**
 * Discover identities across all relevant platforms for a candidate
 * Uses both GitHub API (for commit evidence) and search-based discovery
 */
export async function discoverAllPlatformIdentities(
  candidateId: string,
  hints: CandidateHints,
  options: BridgeDiscoveryOptions & {
    maxSources?: number;
    includeSearchSources?: boolean;
  } = {}
): Promise<{
  githubResult: BridgeDiscoveryResult;
  searchResult: MultiSourceDiscoveryResult | null;
  allIdentities: DiscoveredIdentity[];
  totalQueriesExecuted: number;
}> {
  const includeSearch = options.includeSearchSources !== false;
  const roleType = (hints.roleType as RoleType) || 'general';

  // Start GitHub discovery (uses direct API for commit evidence)
  const githubResult = await discoverGitHubIdentities(candidateId, hints, options);

  // Start search-based discovery for other platforms
  let searchResult: MultiSourceDiscoveryResult | null = null;
  if (includeSearch) {
    try {
      searchResult = await discoverAcrossSources(toSourceHints(hints), roleType, {
        maxResults: options.maxGitHubResults || 5,
        maxQueries: 3,
        minConfidence:
          options.confidenceThreshold ?? getEnrichmentMinConfidenceThreshold('BridgeDiscovery'),
        maxSources: options.maxSources || 5,
        parallelism: 3,
      });
    } catch (error) {
      log.error({
        error: error instanceof Error ? error.message : error,
      }, 'Search-based discovery failed');
    }
  }

  // Combine all identities
  const allIdentities: DiscoveredIdentity[] = [...githubResult.identitiesFound];

  if (searchResult) {
    for (const identity of searchResult.allIdentities) {
      // Skip GitHub results from search (we have better data from API)
      if (identity.platform === 'github') continue;

      allIdentities.push(fromSourceIdentity(identity));
    }
  }

  // Sort by confidence
  allIdentities.sort((a, b) => b.confidence - a.confidence);

  const totalQueriesExecuted =
    githubResult.queriesExecuted + (searchResult?.totalQueriesExecuted || 0);

  log.info({
    identities: allIdentities.length,
    platforms: 1 + (searchResult?.sourcesQueried.length || 0),
    queries: totalQueriesExecuted,
  }, 'Total');

  return {
    githubResult,
    searchResult,
    allIdentities,
    totalQueriesExecuted,
  };
}

export default {
  discoverGitHubIdentities,
  discoverAllPlatformIdentities,
  isSupportedPlatform,
  getPlatformsForRoleType,
};
