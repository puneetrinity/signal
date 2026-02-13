/**
 * Provider Health Check API
 *
 * GET /api/health/providers
 *
 * Returns health status of all configured search and parser providers.
 * Useful for monitoring and debugging provider configuration.
 */

import { NextResponse } from 'next/server';
import {
  checkProvidersHealth,
  getProviderConfig,
} from '@/lib/search/providers';
import { getParserConfig } from '@/lib/search/parsers';

export async function GET() {
  try {
    const [searchHealth, searchConfig, parserConfig] = await Promise.all([
      checkProvidersHealth(),
      Promise.resolve(getProviderConfig()),
      Promise.resolve(getParserConfig()),
    ]);

    return NextResponse.json({
      success: true,
      timestamp: Date.now(),
      search: {
        config: searchConfig,
        health: searchHealth,
      },
      parser: {
        config: parserConfig,
      },
      environment: {
        SEARCH_PROVIDER: process.env.SEARCH_PROVIDER || 'serper (default)',
        SEARCH_FALLBACK_PROVIDER: process.env.SEARCH_FALLBACK_PROVIDER || 'none',
        PARSER_PROVIDER: process.env.PARSER_PROVIDER || 'gemini (default)',
        USE_NEW_DISCOVERY: process.env.USE_NEW_DISCOVERY || 'false',
        // Show which APIs are configured (not the actual keys)
        BRIGHTDATA_API_TOKEN: process.env.BRIGHTDATA_API_TOKEN ? 'configured' : 'not set',
        SEARXNG_URL: process.env.SEARXNG_URL || 'default',
        BRAVE_API_KEY: process.env.BRAVE_API_KEY ? 'configured' : 'not set',
        GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY
          ? 'configured'
          : 'not set',
        GROQ_API_KEY: process.env.GROQ_API_KEY ? 'configured' : 'not set',
      },
    });
  } catch (error) {
    console.error('[Health Check] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Health check failed',
      },
      { status: 500 }
    );
  }
}
