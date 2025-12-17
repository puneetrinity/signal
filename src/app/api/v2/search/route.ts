/**
 * v2 Search API
 *
 * POST /api/v2/search
 *
 * Compliant LinkedIn discovery endpoint that:
 * - Uses provider abstraction (SearXNG/Brave/BrightData)
 * - Saves results as Candidate rows (not Person)
 * - Stores only URL + SERP snippets (no scraped profile data)
 * - Uses SearchCacheV2 for DB-based caching
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { parseSearchQuery } from '@/lib/search/parsers';
import { searchLinkedInProfilesWithMeta, getProviderConfig } from '@/lib/search/providers';
import type { ProfileSummary } from '@/types/linkedin';
import crypto from 'crypto';
import {
  withRateLimit,
  SEARCH_RATE_LIMIT,
  rateLimitHeaders,
} from '@/lib/rate-limit';
import { logSearch } from '@/lib/audit';

/**
 * Search result with candidate ID for API response
 */
interface SearchResultWithCandidateId extends ProfileSummary {
  candidateId: string | null;
}

// Cache TTL in seconds (1 hour)
const CACHE_TTL_SECONDS = 3600;

/**
 * Hash a query string for cache key
 */
function hashQuery(query: string): string {
  const normalized = query.trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * Extract LinkedIn ID from URL
 */
function extractLinkedInId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/in\/([^/]+)/);
    if (match) {
      return match[1].split(/[?#]/)[0].replace(/\/$/, '');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse name hint from search title
 * Title format: "Name - Headline | LinkedIn"
 */
function parseNameHint(title: string): string | undefined {
  const parts = title.split(' - ');
  const rawName = parts[0]?.replace(' | LinkedIn', '').trim();
  return rawName || undefined;
}

/**
 * Parse headline hint from search title
 */
function parseHeadlineHint(title: string): string | undefined {
  const parts = title.split(' - ');
  const headline = parts.slice(1).join(' - ').replace(' | LinkedIn', '').trim();
  return headline || undefined;
}

/**
 * Parse location hint from search snippet
 */
function parseLocationHint(snippet: string): string | undefined {
  // Try "Location: X" pattern
  const locationMatch = snippet.match(/Location:\s*([^·]+)/i);
  if (locationMatch?.[1]) {
    return locationMatch[1].trim();
  }

  // Try last segment after " · "
  const parts = snippet.split(' · ');
  if (parts.length > 1) {
    const candidate = parts[parts.length - 1].trim();
    if (candidate && candidate.length <= 80) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Check DB cache for search results
 */
async function getCachedResults(queryHash: string) {
  try {
    const cached = await prisma.searchCacheV2.findUnique({
      where: { queryHash },
    });

    if (cached && cached.expiresAt > new Date()) {
      return cached;
    }

    // Clean up expired cache entry
    if (cached) {
      await prisma.searchCacheV2.delete({ where: { queryHash } }).catch(() => {});
    }

    return null;
  } catch (error) {
    console.error('[v2/search] Cache read error:', error);
    return null;
  }
}

/**
 * Save search results to DB cache
 */
async function cacheResults(
  queryHash: string,
  queryText: string,
  parsedQuery: object,
  results: object[],
  provider: string
) {
  try {
    const expiresAt = new Date(Date.now() + CACHE_TTL_SECONDS * 1000);

    await prisma.searchCacheV2.upsert({
      where: { queryHash },
      update: {
        parsedQuery,
        results,
        resultCount: results.length,
        provider,
        expiresAt,
      },
      create: {
        queryHash,
        queryText,
        parsedQuery,
        results,
        resultCount: results.length,
        provider,
        expiresAt,
      },
    });
  } catch (error) {
    console.error('[v2/search] Cache write error:', error);
  }
}

/**
 * Create or update Candidate records from search results
 * Returns a map of linkedinId -> candidateId for reliable joining
 */
async function upsertCandidates(
  results: ProfileSummary[],
  searchQuery: string,
  roleType: string | null,
  provider: string
): Promise<Map<string, string>> {
  const candidateMap = new Map<string, string>();

  for (const result of results) {
    const linkedinId = extractLinkedInId(result.linkedinUrl);
    if (!linkedinId) {
      console.warn(`[v2/search] Skipping result with invalid LinkedIn URL: ${result.linkedinUrl}`);
      continue;
    }

    try {
      const candidate = await prisma.candidate.upsert({
        where: { linkedinId },
        update: {
          // Update search metadata if this is a new search
          searchTitle: result.title,
          searchSnippet: result.snippet,
          nameHint: result.name || parseNameHint(result.title),
          headlineHint: result.headline || parseHeadlineHint(result.title),
          locationHint: result.location || parseLocationHint(result.snippet),
          searchProvider: provider, // Track last provider that found this candidate
          // Don't overwrite roleType if already set
          updatedAt: new Date(),
        },
        create: {
          linkedinUrl: result.linkedinUrl,
          linkedinId,
          searchTitle: result.title,
          searchSnippet: result.snippet,
          nameHint: result.name || parseNameHint(result.title),
          headlineHint: result.headline || parseHeadlineHint(result.title),
          locationHint: result.location || parseLocationHint(result.snippet),
          roleType: roleType || undefined,
          captureSource: 'search',
          searchQuery,
          searchProvider: provider,
        },
      });

      candidateMap.set(linkedinId, candidate.id);
    } catch (error) {
      console.error(`[v2/search] Failed to upsert candidate ${linkedinId}:`, error);
    }
  }

  return candidateMap;
}

/**
 * Join search results with candidate IDs by linkedinId
 */
function joinResultsWithCandidates(
  results: ProfileSummary[],
  candidateMap: Map<string, string>
): SearchResultWithCandidateId[] {
  return results.map((result) => {
    const linkedinId = extractLinkedInId(result.linkedinUrl);
    const candidateId = linkedinId ? candidateMap.get(linkedinId) || null : null;
    return {
      ...result,
      candidateId,
    };
  });
}

/**
 * Log search action to audit log (uses centralized audit module)
 */
async function logSearchAction(
  query: string,
  resultCount: number,
  cached: boolean,
  provider: string
) {
  await logSearch(hashQuery(query), {
    query,
    resultCount,
    cached,
    provider,
  });
}

export async function POST(request: NextRequest) {
  // Rate limit check
  const rateLimitCheck = await withRateLimit(SEARCH_RATE_LIMIT);
  if (!rateLimitCheck.allowed) {
    return rateLimitCheck.response;
  }

  try {
    const body = await request.json();
    const { query } = body;

    // Validate input
    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Query is required' },
        { status: 400 }
      );
    }

    if (query.length < 2 || query.length > 200) {
      return NextResponse.json(
        { success: false, error: 'Query must be 2-200 characters' },
        { status: 400 }
      );
    }

    console.log('[v2/search] Query:', query);

    const queryHash = hashQuery(query);

    // Check cache first
    const cached = await getCachedResults(queryHash);
    if (cached) {
      console.log('[v2/search] Cache HIT');

      // Log cached search
      await logSearchAction(query, cached.resultCount, true, cached.provider || 'unknown');

      // Cache already contains resultsWithIds (consistent shape)
      return NextResponse.json(
        {
          success: true,
          version: 'v2',
          count: cached.resultCount,
          results: cached.results, // Already has candidateId from when it was cached
          parsedQuery: cached.parsedQuery,
          cached: true,
          provider: cached.provider,
          timestamp: cached.createdAt.getTime(),
        },
        { headers: rateLimitHeaders(rateLimitCheck.result) }
      );
    }

    console.log('[v2/search] Cache MISS, executing search');

    // Parse query using configured parser
    const parsedQuery = await parseSearchQuery(query);
    console.log('[v2/search] Parsed:', {
      role: parsedQuery.role,
      count: parsedQuery.count,
      location: parsedQuery.location,
    });

    // Execute search using provider abstraction with metadata
    const searchResult = await searchLinkedInProfilesWithMeta(
      parsedQuery.googleQuery,
      parsedQuery.count,
      parsedQuery.countryCode
    );

    const { results: summaries, providerUsed, usedFallback } = searchResult;
    console.log(`[v2/search] Found ${summaries.length} results from ${providerUsed}${usedFallback ? ' (fallback)' : ''}`);

    // Save results as Candidate records - returns map for reliable joining
    const candidateMap = await upsertCandidates(
      summaries,
      query,
      parsedQuery.roleType || null,
      providerUsed
    );

    console.log(`[v2/search] Created/updated ${candidateMap.size} candidates`);

    // Join results with candidate IDs by linkedinId (not by index)
    const resultsWithIds = joinResultsWithCandidates(summaries, candidateMap);

    // Cache resultsWithIds (not raw summaries) for consistent response shape
    await cacheResults(queryHash, query, parsedQuery, resultsWithIds, providerUsed);

    // Log search action with actual provider used
    await logSearchAction(query, summaries.length, false, providerUsed);

    return NextResponse.json(
      {
        success: true,
        version: 'v2',
        count: summaries.length,
        results: resultsWithIds,
        parsedQuery,
        cached: false,
        provider: providerUsed,
        usedFallback,
        timestamp: Date.now(),
      },
      { headers: rateLimitHeaders(rateLimitCheck.result) }
    );
  } catch (error) {
    console.error('[v2/search] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Search failed',
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/v2/search - Health check and config info
 */
export async function GET() {
  const providerConfig = getProviderConfig();

  return NextResponse.json({
    version: 'v2',
    status: 'ok',
    providers: providerConfig,
    features: {
      candidatePersistence: true,
      dbCaching: true,
      auditLogging: true,
    },
  });
}
