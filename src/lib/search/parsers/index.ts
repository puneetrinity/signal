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
 * Parse a search query using the configured parser
 *
 * This is the main entry point for query parsing.
 * It uses the parser specified by PARSER_PROVIDER env var.
 *
 * @param query - Natural language query
 * @returns Structured search query
 */
export async function parseSearchQuery(query: string): Promise<ParsedSearchQuery> {
  const parserType = getParserType();
  const parser = getParser(parserType);

  console.log(`[Parsers] Using parser: ${parserType}`);

  return parser.parseSearchQuery(query);
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
