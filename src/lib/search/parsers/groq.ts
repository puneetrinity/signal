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

/**
 * Zod schema for structured output (same as Gemini)
 */
const SearchQuerySchema = z.object({
  count: z.number().min(1).max(50),
  role: z.string().nullable(),
  location: z.string().optional().nullable(),
  countryCode: z.string().length(2).optional().nullable(),
  keywords: z.array(z.string()),
  searchQuery: z.string(),
  roleType: z
    .enum(['engineer', 'data_scientist', 'researcher', 'founder', 'designer', 'general'])
    .optional()
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
 * Default Groq model for query parsing
 * Can be overridden via GROQ_MODEL env var
 */
const DEFAULT_GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

/**
 * Dynamically load and create Groq model
 * This keeps @ai-sdk/groq as a runtime-only dependency
 * Uses string-based import to bypass TypeScript's module resolution
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createGroqModel(apiKey: string): Promise<any> {
  try {
    // Use variable to prevent TypeScript from trying to resolve the module
    const moduleName = '@ai-sdk/groq';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groqSdk: any = await import(/* webpackIgnore: true */ moduleName);
    const groq = groqSdk.createGroq({ apiKey });
    const model = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
    return groq(model);
  } catch {
    throw new Error(
      'Groq parser requires @ai-sdk/groq package. Install with: npm install @ai-sdk/groq'
    );
  }
}

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
      const model = await createGroqModel(apiKey);

      const { object } = await generateObject({
        model,
        schema: SearchQuerySchema,
        prompt: `${SYSTEM_PROMPT}\n\nQuery: "${query}"`,
      });

      const latency = Date.now() - startTime;
      console.log(
        `[Groq Parser] Parsed in ${latency}ms: "${query}" -> role="${object.role}", count=${object.count}`
      );

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
      console.error('[Groq Parser] Error:', error);
      throw new Error(
        `Failed to parse query: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  },
};

export default groqParser;
