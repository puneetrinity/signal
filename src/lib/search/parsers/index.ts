/**
 * Parser Provider Factory
 *
 * Handles parser selection via environment variables.
 *
 * Environment Variables:
 * - PARSER_PROVIDER: 'gemini' | 'groq' (default: 'gemini')
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import type { ParserProvider, ParsedSearchQuery, ParserProviderType } from './types';
import { geminiParser } from './gemini';
import { groqParser } from './groq';

// Re-export types
export * from './types';

/**
 * Parser registry
 */
const parsers: Record<ParserProviderType, ParserProvider> = {
  gemini: geminiParser,
  groq: groqParser,
};

/**
 * Get the configured parser provider
 */
function getParserType(): ParserProviderType {
  const env = process.env.PARSER_PROVIDER?.toLowerCase();
  if (env && env in parsers) {
    return env as ParserProviderType;
  }
  return 'gemini'; // Default for backward compatibility
}

/**
 * Get a parser instance by type
 */
export function getParser(type: ParserProviderType): ParserProvider {
  const parser = parsers[type];
  if (!parser) {
    throw new Error(`Unknown parser provider: ${type}`);
  }
  return parser;
}

/**
 * Get the current parser instance
 */
export function getCurrentParser(): ParserProvider {
  return getParser(getParserType());
}

/**
 * Get the fallback parser type
 */
function getFallbackParserType(): ParserProviderType | null {
  const primary = getParserType();
  // If primary is Groq, fallback to Gemini; if primary is Gemini, no fallback
  return primary === 'groq' ? 'gemini' : null;
}

/**
 * Parse a search query using the configured parser with retry and fallback
 *
 * This is the main entry point for query parsing.
 * It uses the parser specified by PARSER_PROVIDER env var.
 *
 * Fallback strategy:
 * 1. Try primary parser
 * 2. If it fails, retry once
 * 3. If it still fails, try fallback parser (Groq → Gemini)
 *
 * @param query - Natural language query
 * @returns Structured search query
 */
export async function parseSearchQuery(query: string): Promise<ParsedSearchQuery> {
  const parserType = getParserType();
  const parser = getParser(parserType);
  const fallbackType = getFallbackParserType();

  console.log(`[Parsers] Using parser: ${parserType}${fallbackType ? `, fallback: ${fallbackType}` : ''}`);

  // Try primary parser
  try {
    return await parser.parseSearchQuery(query);
  } catch (primaryError) {
    console.warn(`[Parsers] Primary parser (${parserType}) failed:`, primaryError instanceof Error ? primaryError.message : primaryError);

    // Retry once with primary
    try {
      console.log(`[Parsers] Retrying primary parser (${parserType})...`);
      return await parser.parseSearchQuery(query);
    } catch (retryError) {
      console.warn(`[Parsers] Primary parser retry failed:`, retryError instanceof Error ? retryError.message : retryError);

      // Try fallback if available
      if (fallbackType) {
        try {
          console.log(`[Parsers] Trying fallback parser (${fallbackType})...`);
          const fallbackParser = getParser(fallbackType);
          return await fallbackParser.parseSearchQuery(query);
        } catch (fallbackError) {
          console.error(`[Parsers] Fallback parser (${fallbackType}) also failed:`, fallbackError instanceof Error ? fallbackError.message : fallbackError);
          // Throw the original error since all attempts failed
          throw primaryError;
        }
      }

      // No fallback available, throw original error
      throw primaryError;
    }
  }
}

/**
 * Get current parser configuration
 */
export function getParserConfig(): {
  current: ParserProviderType;
  available: ParserProviderType[];
} {
  return {
    current: getParserType(),
    available: Object.keys(parsers) as ParserProviderType[],
  };
}
