import { NextRequest, NextResponse } from 'next/server';
import { parseSearchQuery } from '@/lib/search/parser';
import { searchLinkedInProfiles } from '@/lib/brightdata/search';
import { cacheSearchResults, getCachedSearchResults } from '@/lib/redis/search-cache';
import { cacheProfileSummary } from '@/lib/redis/profile-cache';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    // Phase 5: When v2 discovery is enabled, proxy /api/search to the compliant v2 endpoint.
    // This lets existing UI clients keep calling /api/search while getting v2 behavior.
    if (process.env.USE_NEW_DISCOVERY === 'true') {
      // NOTE: On some platforms (e.g. Railway), request.nextUrl can resolve to an internal
      // origin like https://localhost:3000 which causes "ERR_SSL_PACKET_LENGTH_TOO_LONG".
      // Build the proxy origin from forwarded headers instead.
      const forwardedProto =
        request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
      const forwardedHost =
        request.headers.get('x-forwarded-host') ?? request.headers.get('host');

      if (!forwardedHost) {
        return NextResponse.json(
          { success: false, error: 'Missing Host header for v2 proxy' },
          { status: 500 },
        );
      }

      const url = new URL('/api/v2/search', `${forwardedProto}://${forwardedHost}`);

      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json().catch(() => null);
      return NextResponse.json(data, { status: response.status, headers: response.headers });
    }

    const { query } = body as { query?: unknown };

    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Query is required' },
        { status: 400 },
      );
    }

    if (query.length < 2 || query.length > 100) {
      return NextResponse.json(
        { success: false, error: 'Query must be 2-100 characters' },
        { status: 400 },
      );
    }

    console.log('[Search API] Query:', query);

    const cachedResults = await getCachedSearchResults(query);

    if (cachedResults) {
      console.log('[Search API] Returning cached search results');
      return NextResponse.json({
        success: true,
        count: cachedResults.count,
        results: cachedResults.results,
        parsedQuery: cachedResults.parsedQuery,
        cached: true,
        timestamp: cachedResults.timestamp,
      });
    }

    const parsedQuery = await parseSearchQuery(query);
    console.log('[Search API] Parsed query:', parsedQuery);

    const summaries = await searchLinkedInProfiles(
      parsedQuery.searchQuery,
      parsedQuery.count,
      parsedQuery.countryCode,
    );

    await cacheSearchResults(query, parsedQuery, summaries);

    await Promise.all(summaries.map((summary) => cacheProfileSummary(summary)));

    console.log('[Search API] Returning fresh search results:', summaries.length);

    return NextResponse.json({
      success: true,
      count: summaries.length,
      results: summaries,
      parsedQuery,
      cached: false,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[Search API] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Search failed',
      },
      { status: 500 },
    );
  }
}
