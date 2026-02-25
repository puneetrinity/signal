/**
 * v2 Search API
 *
 * POST /api/v2/search
 *
 * Compliant LinkedIn discovery endpoint that:
 * - Uses provider abstraction (Serper/Brave)
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
import type { Prisma } from '@prisma/client';
import { extractAllHints, extractCompanyFromHeadline } from '@/lib/enrichment/hint-extraction';
import crypto from 'crypto';
import {
  withRateLimit,
  SEARCH_RATE_LIMIT,
  rateLimitHeaders,
} from '@/lib/rate-limit';
import { logSearch } from '@/lib/audit';
import { withAuth, requireTenantId } from '@/lib/auth';
import {
  normalizeHint,
  shouldReplaceHint,
  shouldReplaceLocationHint,
  shouldReplaceCompanyHint,
} from '@/lib/sourcing/hint-sanitizer';

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
 * Check DB cache for search results (tenant-scoped)
 */
async function getCachedResults(tenantId: string, queryHash: string) {
  try {
    const cached = await prisma.searchCacheV2.findUnique({
      where: { tenantId_queryHash: { tenantId, queryHash } },
    });

    if (cached && cached.expiresAt > new Date()) {
      return cached;
    }

    // Clean up expired cache entry
    if (cached) {
      await prisma.searchCacheV2.delete({
        where: { tenantId_queryHash: { tenantId, queryHash } },
      }).catch((error) => {
        console.warn('[v2/search] Failed to delete expired cache entry:', error);
      });
    }

    return null;
  } catch (error) {
    console.error('[v2/search] Cache read error:', error);
    return null;
  }
}

/**
 * Save search results to DB cache (tenant-scoped)
 */
async function cacheResults(
  tenantId: string,
  queryHash: string,
  queryText: string,
  parsedQuery: object,
  results: object[],
  provider: string
) {
  try {
    const expiresAt = new Date(Date.now() + CACHE_TTL_SECONDS * 1000);

    await prisma.searchCacheV2.upsert({
      where: { tenantId_queryHash: { tenantId, queryHash } },
      update: {
        parsedQuery,
        results,
        resultCount: results.length,
        provider,
        expiresAt,
      },
      create: {
        tenantId,
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
 * Create or update Candidate records from search results (tenant-scoped)
 * Returns a map of linkedinId -> candidateId for reliable joining
 */
async function upsertCandidates(
  tenantId: string,
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

    const extractedHints = extractAllHints(linkedinId, result.title, result.snippet);
    const nameHint = normalizeHint(result.name ?? extractedHints.nameHint ?? undefined) ?? undefined;
    const headlineHint = normalizeHint(result.headline ?? extractedHints.headlineHint ?? undefined) ?? undefined;
    const locationHint = normalizeHint(result.location ?? extractedHints.locationHint ?? undefined) ?? undefined;
    let companyHint = normalizeHint(extractedHints.companyHint ?? undefined) ?? undefined;
    if (!companyHint && headlineHint) {
      companyHint = normalizeHint(extractCompanyFromHeadline(headlineHint) ?? undefined) ?? undefined;
    }

    try {
      const existing = await prisma.candidate.findUnique({
        where: { tenantId_linkedinId: { tenantId, linkedinId } },
        select: {
          nameHint: true,
          headlineHint: true,
          locationHint: true,
          companyHint: true,
        },
      });

      const updateData: Prisma.CandidateUpdateInput = {
        searchTitle: result.title,
        searchSnippet: result.snippet,
        searchMeta: (result.providerMeta ?? undefined) as Prisma.InputJsonValue | undefined,
        searchProvider: provider,
        updatedAt: new Date(),
      };
      if (shouldReplaceHint(existing?.nameHint ?? null, nameHint)) updateData.nameHint = nameHint;
      if (shouldReplaceHint(existing?.headlineHint ?? null, headlineHint)) updateData.headlineHint = headlineHint;
      if (shouldReplaceLocationHint(existing?.locationHint ?? null, locationHint)) updateData.locationHint = locationHint;
      if (shouldReplaceCompanyHint(existing?.companyHint ?? null, companyHint)) updateData.companyHint = companyHint;

      const candidate = await prisma.candidate.upsert({
        where: { tenantId_linkedinId: { tenantId, linkedinId } },
        update: updateData,
        create: {
          tenantId,
          linkedinUrl: result.linkedinUrl,
          linkedinId,
          searchTitle: result.title,
          searchSnippet: result.snippet,
          searchMeta: (result.providerMeta ?? undefined) as Prisma.InputJsonValue | undefined,
          nameHint: shouldReplaceHint(null, nameHint) ? nameHint : undefined,
          headlineHint: shouldReplaceHint(null, headlineHint) ? headlineHint : undefined,
          locationHint: shouldReplaceLocationHint(null, locationHint) ? locationHint : undefined,
          companyHint: shouldReplaceCompanyHint(null, companyHint) ? companyHint : undefined,
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
  // Auth check - requires authenticated user with org
  const authResult = await withAuth('recruiter');
  if (!authResult.authorized) {
    return authResult.response;
  }
  const tenantId = requireTenantId(authResult.context);

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

    console.log(`[v2/search] Query: ${query} (tenant: ${tenantId})`);

    const queryHash = hashQuery(query);

    // Check cache first (tenant-scoped)
    const cached = await getCachedResults(tenantId, queryHash);
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
      parsedQuery.searchQuery,
      parsedQuery.count,
      parsedQuery.countryCode,
      {
        countryCode: parsedQuery.countryCode,
        locationText: parsedQuery.location,
      }
    );

    const { results: summaries, providerUsed, usedFallback } = searchResult;
    console.log(`[v2/search] Found ${summaries.length} results from ${providerUsed}${usedFallback ? ' (fallback)' : ''}`);

    // Save results as Candidate records (tenant-scoped) - returns map for reliable joining
    const candidateMap = await upsertCandidates(
      tenantId,
      summaries,
      query,
      parsedQuery.roleType || null,
      providerUsed
    );

    console.log(`[v2/search] Created/updated ${candidateMap.size} candidates`);

    // Join results with candidate IDs by linkedinId (not by index)
    const resultsWithIds = joinResultsWithCandidates(summaries, candidateMap);

    // Cache resultsWithIds (tenant-scoped) for consistent response shape
    await cacheResults(tenantId, queryHash, query, parsedQuery, resultsWithIds, providerUsed);

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
        error: 'Search failed',
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
