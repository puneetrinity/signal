/**
 * Groq Parser Provider (v2 Fast)
 *
 * Uses Groq's LLaMA models for ultra-fast query parsing.
 * ~5-10x faster than Gemini (~200ms vs ~1-2s).
 *
 * Latency: ~200ms
 * Cost: Free tier generous (30 req/min)
 *
 * NOTE: Requires @ai-sdk/groq package:
 *   npm install @ai-sdk/groq
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { z } from 'zod';
import { generateObject } from 'ai';
import type { ParserProvider, ParsedSearchQuery, ParserProviderType } from './types';
import { createGroqModel } from '@/lib/ai/groq';
import { createLogger } from '@/lib/logger';

const log = createLogger('GroqParser');

/**
 * Valid role types for enrichment source selection
 */
const VALID_ROLE_TYPES = ['engineer', 'data_scientist', 'researcher', 'founder', 'designer', 'general'] as const;

/**
 * Map common LLM-generated role types to valid enum values
 */
const ROLE_TYPE_ALIASES: Record<string, typeof VALID_ROLE_TYPES[number]> = {
  developer: 'engineer',
  'software engineer': 'engineer',
  'software developer': 'engineer',
  programmer: 'engineer',
  'ml engineer': 'engineer',
  'machine learning engineer': 'engineer',
  scientist: 'data_scientist',
  'data analyst': 'data_scientist',
  academic: 'researcher',
  professor: 'researcher',
  phd: 'researcher',
  ceo: 'founder',
  cto: 'founder',
  entrepreneur: 'founder',
  cofounder: 'founder',
  'co-founder': 'founder',
  'ui designer': 'designer',
  'ux designer': 'designer',
  'product designer': 'designer',
};

/**
 * Coerce roleType string to valid enum value
 * Falls back to 'general' for unknown types
 */
function coerceRoleType(value: string | undefined | null): typeof VALID_ROLE_TYPES[number] {
  if (!value) return 'general';
  const lower = value.toLowerCase().trim();
  if (VALID_ROLE_TYPES.includes(lower as typeof VALID_ROLE_TYPES[number])) {
    return lower as typeof VALID_ROLE_TYPES[number];
  }
  return ROLE_TYPE_ALIASES[lower] || 'general';
}

/**
 * Zod schema for structured output (same as Gemini)
 * Uses .transform() to coerce invalid roleType values to 'general'
 */
const SearchQuerySchema = z.object({
  count: z.number().min(1).max(50),
  role: z.string().nullable(),
  location: z.string().optional().nullable(),
  countryCode: z.string().length(2).optional().nullable(),
  keywords: z.array(z.string()),
  searchQuery: z.string(),
  roleType: z
    .string()
    .optional()
    .nullable()
    .transform(coerceRoleType)
    .describe('Classification of the role for enrichment source selection'),
});

/**
 * Optimized system prompt for Groq (more concise for speed)
 */
const SYSTEM_PROMPT = `Parse the search query into structured data for LinkedIn profile discovery.

RULES:
1. If query is a person's name: count=1, role=null, location=null, countryCode=null
2. If query is a job search: extract count (default 10), role, location, countryCode (geographic only)
3. searchQuery format: site:linkedin.com/in "{role or name}" "{location}" {keywords}
4. roleType: classify as engineer/data_scientist/researcher/founder/designer/general

EXAMPLES:
"5 AI Engineers in Israel" → count=5, role="AI Engineer", countryCode="IL", roleType="engineer"
"John Smith" → count=1, role=null, keywords=["John Smith"], roleType="general"
"ML researchers at Google" → count=10, role="ML Researcher", roleType="researcher"`;

/**
 * Groq Parser Provider Implementation
 */
export const groqParser: ParserProvider = {
  name: 'groq' as ParserProviderType,

  async parseSearchQuery(query: string): Promise<ParsedSearchQuery> {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not set in environment variables');
    }

    try {
      const startTime = Date.now();
      const { model } = await createGroqModel(apiKey);

      const { object } = await generateObject({
        model,
        schema: SearchQuerySchema,
        prompt: `${SYSTEM_PROMPT}\n\nQuery: "${query}"`,
      });

      const latency = Date.now() - startTime;
      log.info({ latency, query, role: object.role, count: object.count }, 'Parsed query');

      return {
        count: object.count,
        role: object.role,
        location: object.location,
        countryCode: object.countryCode,
        keywords: object.keywords,
        searchQuery: object.searchQuery,
        googleQuery: object.searchQuery, // deprecated
        roleType: object.roleType,
      };
    } catch (error) {
      log.error({ err: error }, 'Failed to parse query');
      throw new Error(
        `Failed to parse query: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  },
};

export default groqParser;
