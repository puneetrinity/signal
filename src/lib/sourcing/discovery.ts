import { generateText } from 'ai';
import { z } from 'zod';
import { createGroqModel } from '@/lib/ai/groq';
import { searchLinkedInProfilesWithMeta, type SearchGeoContext } from '@/lib/search/providers';
import type { ProfileSummary } from '@/types/linkedin';
import { upsertDiscoveredCandidates } from './upsert-candidates';
import type { JobRequirements } from './jd-digest';
import { getDiscoverySkillBuckets } from './jd-digest';
import type { SourcingConfig } from './config';
import type { JobTrack } from './types';
import { createLogger } from '@/lib/logger';

const log = createLogger('SourcingDiscovery');

export interface DiscoveredCandidate {
  candidateId: string;
  linkedinId: string;
  queryIndex: number;
}

export interface DiscoveryRunResult {
  candidates: DiscoveredCandidate[];
  queriesExecuted: number;
  queriesBuilt: number;
  telemetry: DiscoveryTelemetry;
}

export interface DiscoveryQueryRunTelemetry {
  queryIndex: number;
  phase: 'strict' | 'fallback';
  query: string;
  providerUsed: string;
  usedFallbackProvider: boolean;
  resultCount: number;
  acceptedCount: number;
  cumulativeDiscovered: number;
  latencyMs: number;
}

export interface DiscoveryTelemetry {
  mode: 'deterministic' | 'hybrid';
  strictQueriesBuilt: number;
  fallbackQueriesBuilt: number;
  strictQueriesExecuted: number;
  fallbackQueriesExecuted: number;
  strictYield: number;
  fallbackYield: number;
  providerUsage: Record<string, number>;
  stoppedReason:
    | 'target_reached'
    | 'strict_low_yield_shifted'
    | 'fallback_low_yield_stopped'
    | 'budget_exhausted'
    | 'no_queries'
    | 'completed_queries';
  groq: {
    enabled: boolean;
    used: boolean;
    retries: number;
    modelName: string | null;
    latencyMs: number | null;
    error: string | null;
    parseStage: 'none' | 'labeled_sections' | 'inline_buckets' | 'json' | 'repair' | null;
    rawPreview: string | null;
    repaired: boolean;
  };
  queryRuns: DiscoveryQueryRunTelemetry[];
}

interface QueryPlan {
  strict: string[];
  fallback: string[];
}

const QueryPlanSchema = z.object({
  strictQueries: z.array(z.string().min(1)).max(12).default([]),
  fallbackQueries: z.array(z.string().min(1)).max(12).default([]),
});

type QueryPlanSchemaOutput = z.infer<typeof QueryPlanSchema>;
type QueryPlanParseStage = DiscoveryTelemetry['groq']['parseStage'];

const COUNTRY_CODE_BY_LOCATION_TOKEN: Record<string, string> = {
  india: 'IN',
  indonesia: 'ID',
  usa: 'US',
  'u s a': 'US',
  us: 'US',
  'united states': 'US',
  'united states of america': 'US',
  uk: 'GB',
  'u k': 'GB',
  'united kingdom': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  ireland: 'IE',
  germany: 'DE',
  france: 'FR',
  spain: 'ES',
  italy: 'IT',
  netherlands: 'NL',
  singapore: 'SG',
  uae: 'AE',
  'united arab emirates': 'AE',
  australia: 'AU',
  newzealand: 'NZ',
  'new zealand': 'NZ',
  canada: 'CA',
  brazil: 'BR',
  mexico: 'MX',
  japan: 'JP',
};

const LINKEDIN_SITE_SUBDOMAIN_BY_COUNTRY: Record<string, string> = {
  AE: 'ae',
  AU: 'au',
  BR: 'br',
  CA: 'ca',
  DE: 'de',
  ES: 'es',
  FR: 'fr',
  GB: 'uk',
  ID: 'id',
  IE: 'ie',
  IN: 'in',
  IT: 'it',
  JP: 'jp',
  MX: 'mx',
  NL: 'nl',
  SG: 'sg',
};

const DEFAULT_STRICT_SERPER_TBS = 'qdr:y2';

function isTechLikeQueryTrack(track: JobTrack | null | undefined, requirements: JobRequirements): boolean {
  if (track === 'tech' || track === 'blended') return true;
  const roleFamily = (requirements.roleFamily ?? '').toLowerCase();
  return ['backend', 'frontend', 'fullstack', 'devops', 'sre', 'data', 'ml'].includes(roleFamily);
}

function buildStructuredQueryPrompt(
  requirements: JobRequirements,
  maxQueries: number,
  track?: JobTrack | null,
): string {
  const example = isTechLikeQueryTrack(track, requirements)
    ? [
        'Example:',
        'STRICT:',
        '- site:linkedin.com/in "staff platform engineer" "Hyderabad, India" kubernetes aws go',
        '- site:linkedin.com/in "platform engineer" "Hyderabad, India" distributed systems microservices',
        'FALLBACK:',
        '- site:linkedin.com/in "staff platform engineer" kubernetes aws go',
        '- site:linkedin.com/in "platform engineer" distributed systems microservices',
      ].join('\n')
    : [
        'Example:',
        'STRICT:',
        '- site:linkedin.com/in "account executive" "Mumbai, India" salesforce outbound quota',
        '- site:linkedin.com/in "enterprise account executive" "Mumbai, India" pipeline closing',
        'FALLBACK:',
        '- site:linkedin.com/in "account executive" salesforce outbound quota',
        '- site:linkedin.com/in "enterprise account executive" pipeline closing',
      ].join('\n');

  return [
    'Generate LinkedIn profile search queries for candidate sourcing.',
    'Return exactly this format and nothing else:',
    'STRICT:',
    '- <query>',
    '- <query>',
    'FALLBACK:',
    '- <query>',
    '- <query>',
    '',
    'Rules:',
    '- Always target public LinkedIn profiles using site:linkedin.com/in',
    '- STRICT queries must prioritize requested location when one exists',
    '- FALLBACK queries should broaden while preserving role and core skills',
    '- Keep queries concise and search-engine friendly',
    '- No prose, no commentary, no markdown fences',
    `- Maximum ${maxQueries} STRICT queries and ${maxQueries} FALLBACK queries`,
    '',
    `Track: ${track ?? 'unknown'}`,
    `Title: ${requirements.title ?? ''}`,
    `Role family: ${requirements.roleFamily ?? ''}`,
    `Seniority: ${requirements.seniorityLevel ?? ''}`,
    `Domain: ${requirements.domain ?? ''}`,
    `Location: ${requirements.location ?? ''}`,
    `Top skills: ${requirements.topSkills.slice(0, 8).join(', ')}`,
    '',
    example,
  ].join('\n');
}

function buildRepairPrompt(rawOutput: string, maxQueries: number): string {
  return [
    'Reformat the text below into this exact structure and nothing else:',
    'STRICT:',
    '- <query>',
    'FALLBACK:',
    '- <query>',
    '',
    `Maximum ${maxQueries} STRICT queries and ${maxQueries} FALLBACK queries.`,
    '',
    'Text to reformat:',
    rawOutput.trim().slice(0, 1200),
  ].join('\n');
}
const DEFAULT_FALLBACK_SERPER_TBS = '';

function normalizeLocationToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[.]/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveCountryCodeFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;

  const segments = location
    .split(',')
    .map((segment) => normalizeLocationToken(segment))
    .filter(Boolean);

  const normalizedLocation = normalizeLocationToken(location);
  const candidates = [
    segments[segments.length - 1],
    segments.length > 1 ? segments.slice(-2).join(' ') : null,
    normalizedLocation,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const code = COUNTRY_CODE_BY_LOCATION_TOKEN[candidate];
    if (code) return code;
  }

  return null;
}

function getStrictSerperTbs(): string | null {
  const configured = (process.env.SOURCING_STRICT_SERPER_TBS ?? DEFAULT_STRICT_SERPER_TBS).trim();
  if (!configured) return null;
  return /^qdr:[dwmy]\d*$/i.test(configured) ? configured.toLowerCase() : null;
}

function getFallbackSerperTbs(strictTbs: string | null): string | null {
  const configured = (process.env.SOURCING_FALLBACK_SERPER_TBS ?? DEFAULT_FALLBACK_SERPER_TBS).trim();
  if (!configured) return strictTbs;
  return /^qdr:[dwmy]\d*$/i.test(configured) ? configured.toLowerCase() : null;
}

function hasLinkedInSiteConstraint(query: string): boolean {
  return /\bsite:(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\b\/?/i.test(query);
}

function normalizeLinkedInSiteToken(raw: string): string {
  return raw.toLowerCase().replace(/\/+$/, '');
}

function stripLinkedInSiteConstraints(query: string): string {
  return query
    .replace(/\bsite:(?:[a-z0-9-]+\.)?linkedin\.com\/in\/?\b\/?/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function enforceSingleLinkedInSiteConstraint(query: string, preferredSite: string): string {
  const withoutLinkedInSite = stripLinkedInSiteConstraints(query);
  const normalizedSite = normalizeLinkedInSiteToken(preferredSite);
  return `${normalizedSite} ${withoutLinkedInSite}`.trim();
}

function toLinkedInCountrySubdomain(countryCode: string | null | undefined): string | null {
  if (!countryCode) return null;
  return LINKEDIN_SITE_SUBDOMAIN_BY_COUNTRY[countryCode.toUpperCase()] ?? null;
}

function applyCountryLinkedInSiteConstraint(
  query: string,
  countryCode: string | null | undefined,
): string {
  const subdomain = toLinkedInCountrySubdomain(countryCode);
  if (!subdomain) return query;
  const targetSite = `site:${subdomain}.linkedin.com/in`;
  return enforceSingleLinkedInSiteConstraint(query, targetSite);
}

function normalizeQuery(query: string): string | null {
  const compact = query.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  const existingSite = compact.match(/\bsite:(?:[a-z0-9-]+\.)?linkedin\.com\/in\/?\b\/?/i)?.[0] ?? null;
  const siteScoped = hasLinkedInSiteConstraint(compact)
    ? enforceSingleLinkedInSiteConstraint(compact, existingSite ?? 'site:linkedin.com/in')
    : `site:linkedin.com/in ${compact}`;
  return siteScoped.slice(0, 240);
}

export function formatQueryTerm(term: string, kind: 'exact' | 'concept' = 'exact'): string {
  const trimmed = term.trim();
  if (!trimmed) return '';
  if (kind === 'concept') {
    return trimmed.replace(/^"(.*)"$/, '$1');
  }
  if (/\s/.test(trimmed) && !/^".*"$/.test(trimmed)) {
    return `"${trimmed}"`;
  }
  return trimmed;
}

function dedupeQueries(queries: string[], maxQueries: number, exclude?: Set<string>): string[] {
  const seen = new Set<string>(exclude ?? []);
  const out: string[] = [];
  for (const raw of queries) {
    const normalized = normalizeQuery(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxQueries) break;
  }
  return out;
}

function coerceQueryArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/\n|;|,/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Raw JSON response
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  // Fenced code block response
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  // Best-effort object extraction
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1).trim();
  }

  return null;
}

function coerceQueryPlanFromUnknown(raw: unknown): QueryPlanSchemaOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const strictQueries = coerceQueryArray(obj.strictQueries ?? obj.strict);
  const fallbackQueries = coerceQueryArray(obj.fallbackQueries ?? obj.fallback);

  const parsed = QueryPlanSchema.safeParse({ strictQueries, fallbackQueries });
  return parsed.success ? parsed.data : null;
}

function normalizeQueryLine(value: string): string | null {
  const cleaned = value
    .replace(/^[-*•]\s*/, '')
    .replace(/^\d+[\].)\-:]\s*/, '')
    .trim();
  return cleaned || null;
}

/**
 * Validate that a parsed query looks like a real search query.
 * Rejects LLM commentary that leaked through the parser.
 */
const LINKEDIN_SITE_SCOPE_RE = /\bsite:(?:[a-z]{2}\.)?linkedin\.com\/in\b/i;

const COMMENTARY_PATTERNS = [
  /\bnote that\b/i,
  /\bthere were only\b/i,
  /\bprovided\b/i,
  /\breformat/i,
  /\bquery limit\b/i,
  /\bbelow the\b/i,
  /\bmaximum\b/i,
  /\bno .* query to/i,
];

function isValidSearchQuery(query: string): boolean {
  if (!LINKEDIN_SITE_SCOPE_RE.test(query)) return false;
  for (const pattern of COMMENTARY_PATTERNS) {
    if (pattern.test(query)) return false;
  }
  return true;
}

function parseLabeledQueryPlan(text: string): QueryPlanSchemaOutput | null {
  const stripped = text
    .replace(/```(?:json|text)?/gi, '')
    .replace(/```/g, '')
    .trim();
  if (!stripped) return null;

  const strictQueries: string[] = [];
  const fallbackQueries: string[] = [];
  let currentBucket: 'strict' | 'fallback' | null = null;

  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const headerMatch = line.match(/^(strict|fallback)\s*:\s*(.*)$/i);
    if (headerMatch) {
      currentBucket = headerMatch[1].toLowerCase() as 'strict' | 'fallback';
      const inlineValue = normalizeQueryLine(headerMatch[2] ?? '');
      if (inlineValue && isValidSearchQuery(inlineValue)) {
        (currentBucket === 'strict' ? strictQueries : fallbackQueries).push(inlineValue);
      }
      continue;
    }

    const inlineBucketMatch = line.match(/^(strict|fallback)\s*[-:]\s*(.+)$/i);
    if (inlineBucketMatch) {
      const bucket = inlineBucketMatch[1].toLowerCase() as 'strict' | 'fallback';
      const value = normalizeQueryLine(inlineBucketMatch[2]);
      if (value && isValidSearchQuery(value)) {
        (bucket === 'strict' ? strictQueries : fallbackQueries).push(value);
      }
      continue;
    }

    if (!currentBucket) continue;
    const value = normalizeQueryLine(line);
    if (!value) continue;
    if (!isValidSearchQuery(value)) continue;
    (currentBucket === 'strict' ? strictQueries : fallbackQueries).push(value);
  }

  const parsed = QueryPlanSchema.safeParse({ strictQueries, fallbackQueries });
  if (!parsed.success) return null;
  if (parsed.data.strictQueries.length === 0 && parsed.data.fallbackQueries.length === 0) return null;
  return parsed.data;
}

export function parseQueryPlanFromText(text: string): { plan: QueryPlanSchemaOutput | null; parseStage: QueryPlanParseStage } {
  let plan: QueryPlanSchemaOutput | null = null;
  let parseStage: QueryPlanParseStage = 'none';

  const labeled = parseLabeledQueryPlan(text);
  if (labeled) {
    const nonEmptyInlineBucket = /^(strict|fallback)[ \t]*[-:][ \t]+\S.+$/im.test(text);
    plan = labeled;
    parseStage = nonEmptyInlineBucket ? 'inline_buckets' : 'labeled_sections';
  } else {
    const jsonCandidate = extractJsonCandidate(text);
    if (jsonCandidate) {
      try {
        const parsed = JSON.parse(jsonCandidate) as unknown;
        plan = coerceQueryPlanFromUnknown(parsed);
        parseStage = 'json';
      } catch {
        return { plan: null, parseStage: 'json' };
      }
    }
  }

  // Post-filter: remove any queries that fail validation (LLM commentary, missing site scope)
  if (plan) {
    const filteredPlan = {
      strictQueries: plan.strictQueries.filter(isValidSearchQuery),
      fallbackQueries: plan.fallbackQueries.filter(isValidSearchQuery),
    };
    if (filteredPlan.strictQueries.length === 0 && filteredPlan.fallbackQueries.length === 0) {
      return { plan: null, parseStage: 'none' };
    }
    return { plan: filteredPlan, parseStage };
  }

  return { plan: null, parseStage };
}

function buildGroqRawPreview(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Groq query generation timeout after ${ms}ms`)), ms),
    ),
  ]);
}

const NON_TECH_TITLE_VARIANTS: Record<string, string[]> = {
  'account_executive': ['account executive', 'enterprise sales', 'sales executive', 'regional sales manager'],
  'customer_success': ['customer success manager', 'client success manager', 'customer success lead'],
  'technical_account_manager': ['technical account manager', 'technical customer success'],
  'sales_engineer': ['sales engineer', 'solutions engineer', 'pre-sales engineer'],
  'business_development': ['business development representative', 'sales development representative'],
  'account_manager': ['account manager', 'key account manager', 'client manager'],
};

export function buildDeterministicQueries(
  requirements: JobRequirements,
  maxQueries: number,
  track?: JobTrack,
): QueryPlan {
  const roleFamily = requirements.roleFamily || '';
  const title = requirements.title?.trim() || '';
  const location = requirements.location || '';
  const skillBuckets = getDiscoverySkillBuckets(requirements.topSkills.slice(0, 8), 4, 2);
  const exactSkills = skillBuckets.exactTerms
    .map((term) => formatQueryTerm(term, 'exact'))
    .filter(Boolean);
  const conceptSkills = skillBuckets.conceptTerms
    .map((term) => formatQueryTerm(term, 'concept'))
    .filter(Boolean);
  const strictSkills = [...exactSkills, ...conceptSkills.slice(0, 1)].slice(0, 4);
  const fallbackSkills = [...exactSkills, ...conceptSkills].slice(0, 6);
  const narrowSkills = exactSkills.slice(0, 2).length > 0
    ? exactSkills.slice(0, 2)
    : conceptSkills.slice(0, 2);
  const strict: string[] = [];
  const fallback: string[] = [];

  // Strict pass: location-targeted queries
  if (location && strictSkills.length > 0) {
    if (roleFamily) {
      strict.push(`site:linkedin.com/in "${roleFamily}" "${location}" ${strictSkills.join(' ')}`);
    } else {
      strict.push(`site:linkedin.com/in "${location}" ${strictSkills.join(' ')}`);
    }
    if (strictSkills.length > 2) {
      if (roleFamily) {
        strict.push(`site:linkedin.com/in "${roleFamily}" "${location}" ${narrowSkills.join(' ')}`);
      } else {
        strict.push(`site:linkedin.com/in "${location}" ${narrowSkills.join(' ')}`);
      }
    }
  }
  if (location && title) {
    strict.push(`site:linkedin.com/in "${title}" "${location}"`);
  }
  if (location && roleFamily && exactSkills.length === 0 && conceptSkills.length === 0) {
    strict.push(`site:linkedin.com/in "${roleFamily}" "${location}"`);
  }

  // Non-tech title variant expansion: add strict queries for each title variant
  if (track === 'non_tech' && roleFamily && location) {
    const variants = NON_TECH_TITLE_VARIANTS[roleFamily];
    if (variants) {
      for (const variant of variants) {
        strict.push(`site:linkedin.com/in "${variant}" "${location}"`);
      }
    }
  }

  // Fallback pass: without location (broader reach)
  if (roleFamily && fallbackSkills.length > 0) {
    fallback.push(`site:linkedin.com/in "${roleFamily}" ${fallbackSkills.join(' ')}`);
  }
  if (title) {
    fallback.push(`site:linkedin.com/in "${title}"`);
    if (fallbackSkills.length > 0) {
      fallback.push(`site:linkedin.com/in "${title}" ${fallbackSkills.join(' ')}`);
    }
  }
  if (fallbackSkills.length > 0) {
    fallback.push(`site:linkedin.com/in ${fallbackSkills.join(' ')}`);
  }
  if (fallbackSkills.length > 2 && roleFamily) {
    fallback.push(`site:linkedin.com/in "${roleFamily}" ${narrowSkills.join(' ')}`);
  }
  if (roleFamily && fallbackSkills.length === 0) {
    fallback.push(`site:linkedin.com/in "${roleFamily}"`);
  }
  if (!roleFamily && !title && location && fallbackSkills.length === 0) {
    fallback.push(`site:linkedin.com/in "${location}"`);
  }

  // Non-tech fallback variant expansion (without location)
  if (track === 'non_tech' && roleFamily) {
    const variants = NON_TECH_TITLE_VARIANTS[roleFamily];
    if (variants) {
      for (const variant of variants) {
        fallback.push(`site:linkedin.com/in "${variant}"`);
      }
    }
  }

  const strictDeduped = dedupeQueries(strict, maxQueries);
  const strictSet = new Set(strictDeduped);
  const fallbackDeduped = dedupeQueries(fallback, maxQueries, strictSet);

  return { strict: strictDeduped, fallback: fallbackDeduped };
}

async function buildHybridQueries(
  requirements: JobRequirements,
  maxQueries: number,
  config: SourcingConfig,
  track?: JobTrack | null,
): Promise<{
  plan: QueryPlan;
  groq: DiscoveryTelemetry['groq'];
}> {
  const deterministic = buildDeterministicQueries(requirements, maxQueries, track ?? undefined);
  const groqMeta: DiscoveryTelemetry['groq'] = {
    enabled: config.queryGenMode === 'hybrid',
    used: false,
    retries: 0,
    modelName: null,
    latencyMs: null,
    error: null,
    parseStage: null,
    rawPreview: null,
    repaired: false,
  };

  if (config.queryGenMode !== 'hybrid') {
    return { plan: deterministic, groq: groqMeta };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    groqMeta.error = 'GROQ_API_KEY not configured';
    return { plan: deterministic, groq: groqMeta };
  }

  const attempts = 1 + config.queryGroqMaxRetries;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      groqMeta.retries = attempt - 1;
      const startedAt = Date.now();
      const { model, modelName } = await createGroqModel(apiKey);
      groqMeta.modelName = modelName;

      const prompt = buildStructuredQueryPrompt(requirements, maxQueries, track);
      const textGenerated = await withTimeout(
        generateText({
          model,
          prompt,
        }),
        config.queryGroqTimeoutMs,
      );
      const parsed = parseQueryPlanFromText(textGenerated.text);
      const { parseStage } = parsed;
      let object = parsed.plan;
      groqMeta.parseStage = parseStage;
      groqMeta.rawPreview = buildGroqRawPreview(textGenerated.text);

      if (!object) {
        const repairedText = await withTimeout(
          generateText({
            model,
            prompt: buildRepairPrompt(textGenerated.text, maxQueries),
          }),
          config.queryGroqTimeoutMs,
        );
        const repaired = parseQueryPlanFromText(repairedText.text);
        groqMeta.rawPreview = buildGroqRawPreview(repairedText.text);
        groqMeta.parseStage = repaired.plan ? 'repair' : (repaired.parseStage ?? 'repair');
        groqMeta.repaired = repaired.plan !== null;
        object = repaired.plan;
      }

      if (!object) {
        throw new Error('Groq query plan parse_failed');
      }

      groqMeta.latencyMs = Date.now() - startedAt;

      const llmStrict = dedupeQueries(object.strictQueries, maxQueries);
      const strictSet = new Set(llmStrict);
      const llmFallback = dedupeQueries(object.fallbackQueries, maxQueries, strictSet);
      const mergedStrict = dedupeQueries([...llmStrict, ...deterministic.strict], maxQueries);
      const mergedStrictSet = new Set(mergedStrict);
      const mergedFallback = dedupeQueries(
        [...llmFallback, ...deterministic.fallback],
        maxQueries,
        mergedStrictSet,
      );

      groqMeta.used = llmStrict.length > 0 || llmFallback.length > 0;

      return {
        plan: {
          strict: mergedStrict,
          fallback: mergedFallback,
        },
        groq: groqMeta,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      groqMeta.error = message;
      const isParseFailure = typeof message === 'string' && message.includes('parse_failed');
      if (attempt >= attempts || isParseFailure) {
        log.warn({ maxAttempts: attempts, error: message }, 'Hybrid query generation fallback to deterministic');
      }
      if (attempt >= attempts || isParseFailure) break;
    }
  }

  return { plan: deterministic, groq: groqMeta };
}

export async function discoverCandidates(
  tenantId: string,
  requirements: JobRequirements,
  targetCount: number,
  existingLinkedinIds: Set<string>,
  maxQueries: number = 3,
  options?: {
    config?: SourcingConfig;
    track?: JobTrack | null;
  },
): Promise<DiscoveryRunResult> {
  const config = options?.config;
  const deterministicPlan = buildDeterministicQueries(requirements, maxQueries, options?.track ?? undefined);
  const hybridPlan = config
    ? await buildHybridQueries(requirements, maxQueries, config, options?.track)
    : null;
  const plan = hybridPlan?.plan ?? deterministicPlan;
  let strict = plan.strict;
  const fallback = plan.fallback;
  const locationText = requirements.location?.trim() || null;
  const derivedCountryCode = deriveCountryCodeFromLocation(locationText);
  const strictSerperTbs = getStrictSerperTbs();
  const fallbackSerperTbs = getFallbackSerperTbs(strictSerperTbs);
  if (strict.length > 0 && derivedCountryCode) {
    const rewrittenStrict = strict.map((query) =>
      applyCountryLinkedInSiteConstraint(query, derivedCountryCode),
    );
    strict = dedupeQueries(rewrittenStrict, maxQueries);
  }
  const strictGeo: SearchGeoContext | undefined = (locationText || derivedCountryCode)
    ? {
      countryCode: derivedCountryCode,
      locationText,
      tbs: strictSerperTbs,
    }
    : undefined;
  const fallbackGeo: SearchGeoContext | undefined = (derivedCountryCode || fallbackSerperTbs)
    ? {
      ...(derivedCountryCode ? { countryCode: derivedCountryCode } : {}),
      ...(fallbackSerperTbs ? { tbs: fallbackSerperTbs } : {}),
    }
    : undefined;
  const discovered: DiscoveredCandidate[] = [];
  const seenLinkedinIds = new Set(existingLinkedinIds);
  let queriesExecuted = 0;
  let queryIndex = 0;
  let strictQueriesExecuted = 0;
  let fallbackQueriesExecuted = 0;
  let strictAccepted = 0;
  let fallbackAccepted = 0;
  const queryRuns: DiscoveryQueryRunTelemetry[] = [];
  const providerUsage: Record<string, number> = {};
  let stoppedReason: DiscoveryTelemetry['stoppedReason'] = 'completed_queries';

  const runQuery = async (
    query: string,
    phase: 'strict' | 'fallback',
    geo?: SearchGeoContext,
  ): Promise<{ acceptedCount: number }> => {
    queriesExecuted++;
    const qi = queryIndex++;
    const startedAt = Date.now();
    log.info({ query, queryIndex: qi, phase }, 'Running discovery query');

    try {
      const searchResult = await searchLinkedInProfilesWithMeta(
        query,
        20,
        geo?.countryCode ?? null,
        geo,
      );
      const profiles = searchResult.results;
      providerUsage[searchResult.providerUsed] = (providerUsage[searchResult.providerUsed] || 0) + 1;
      const newProfiles = profiles.filter((p) => {
        const id = extractLinkedInIdFromUrl(p.linkedinUrl);
        if (!id || seenLinkedinIds.has(id)) return false;
        if (!isLikelyPersonProfile(p)) return false;
        return true;
      });

      if (newProfiles.length === 0) {
        queryRuns.push({
          queryIndex: qi,
          phase,
          query,
          providerUsed: searchResult.providerUsed,
          usedFallbackProvider: searchResult.usedFallback,
          resultCount: profiles.length,
          acceptedCount: 0,
          cumulativeDiscovered: discovered.length,
          latencyMs: Date.now() - startedAt,
        });
        return { acceptedCount: 0 };
      }

      const candidateMap = await upsertDiscoveredCandidates(
        tenantId,
        newProfiles,
        query,
        searchResult.providerUsed,
      );
      let acceptedCount = 0;

      for (const profile of newProfiles) {
        const linkedinId = extractLinkedInIdFromUrl(profile.linkedinUrl);
        if (!linkedinId) continue;
        const candidateId = candidateMap.get(linkedinId);
        if (!candidateId) continue;
        if (seenLinkedinIds.has(linkedinId)) continue;

        seenLinkedinIds.add(linkedinId);
        discovered.push({ candidateId, linkedinId, queryIndex: qi });
        acceptedCount++;

        if (discovered.length >= targetCount) break;
      }

      queryRuns.push({
        queryIndex: qi,
        phase,
        query,
        providerUsed: searchResult.providerUsed,
        usedFallbackProvider: searchResult.usedFallback,
        resultCount: profiles.length,
        acceptedCount,
        cumulativeDiscovered: discovered.length,
        latencyMs: Date.now() - startedAt,
      });

      log.info(
        { queryIndex: qi, phase, provider: searchResult.providerUsed, acceptedCount, totalDiscovered: discovered.length },
        'Discovery query complete',
      );
      return { acceptedCount };
    } catch (err) {
      log.error({ query, error: err instanceof Error ? err.message : err }, 'Discovery query failed');
      queryRuns.push({
        queryIndex: qi,
        phase,
        query,
        providerUsed: 'unknown',
        usedFallbackProvider: false,
        resultCount: 0,
        acceptedCount: 0,
        cumulativeDiscovered: discovered.length,
        latencyMs: Date.now() - startedAt,
      });
      return { acceptedCount: 0 };
    }
  };

  // Pass 1: Strict (location-targeted) queries
  for (const query of strict) {
    if (discovered.length >= targetCount) {
      stoppedReason = 'target_reached';
      break;
    }
    if (queriesExecuted >= maxQueries) {
      stoppedReason = 'budget_exhausted';
      break;
    }
    strictQueriesExecuted++;
    const { acceptedCount } = await runQuery(query, 'strict', strictGeo);
    strictAccepted += acceptedCount;

    if (discovered.length >= targetCount) {
      stoppedReason = 'target_reached';
      break;
    }

    if (
      config &&
      strictQueriesExecuted >= config.adaptiveMinStrictAttempts &&
      strictAccepted / strictQueriesExecuted < config.adaptiveStrictMinYield &&
      fallback.length > 0
    ) {
      stoppedReason = 'strict_low_yield_shifted';
      break;
    }
  }

  // Pass 2: Fallback (non-location) queries if strict under-delivers
  if (discovered.length < targetCount && queriesExecuted < maxQueries) {
    log.info(
      { strictDiscovered: discovered.length, targetCount, fallbackQueriesAvailable: fallback.length },
      'Strict discovery under-delivered, running fallback queries',
    );
    for (const query of fallback) {
      if (discovered.length >= targetCount) {
        stoppedReason = 'target_reached';
        break;
      }
      if (queriesExecuted >= maxQueries) {
        stoppedReason = 'budget_exhausted';
        break;
      }
      fallbackQueriesExecuted++;
      const { acceptedCount } = await runQuery(query, 'fallback', fallbackGeo);
      fallbackAccepted += acceptedCount;

      if (discovered.length >= targetCount) {
        stoppedReason = 'target_reached';
        break;
      }

      if (
        config &&
        fallbackQueriesExecuted >= config.adaptiveMinFallbackAttempts &&
        fallbackAccepted / fallbackQueriesExecuted < config.adaptiveFallbackMinYield
      ) {
        stoppedReason = 'fallback_low_yield_stopped';
        break;
      }
    }
  }

  if (queriesExecuted === 0) {
    stoppedReason = 'no_queries';
  } else if (stoppedReason === 'completed_queries' && queriesExecuted >= maxQueries) {
    stoppedReason = 'budget_exhausted';
  }

  if (discovered.length === 0 && (strict.length + fallback.length) > 0) {
    log.warn({
      tenantId,
      queriesAttempted: strict.length + fallback.length,
      roleFamily: requirements.roleFamily,
      targetCount,
    }, 'All discovery queries returned zero new candidates');
  }

  const telemetry: DiscoveryTelemetry = {
    mode: config?.queryGenMode ?? 'deterministic',
    strictQueriesBuilt: strict.length,
    fallbackQueriesBuilt: fallback.length,
    strictQueriesExecuted,
    fallbackQueriesExecuted,
    strictYield: strictQueriesExecuted > 0
      ? Number((strictAccepted / strictQueriesExecuted).toFixed(4))
      : 0,
    fallbackYield: fallbackQueriesExecuted > 0
      ? Number((fallbackAccepted / fallbackQueriesExecuted).toFixed(4))
      : 0,
    providerUsage,
    stoppedReason,
    groq: hybridPlan?.groq ?? {
      enabled: false,
      used: false,
      retries: 0,
      modelName: null,
      latencyMs: null,
      error: null,
      parseStage: null,
      rawPreview: null,
      repaired: false,
    },
    queryRuns,
  };

  return {
    candidates: discovered,
    queriesExecuted,
    queriesBuilt: strict.length + fallback.length,
    telemetry,
  };
}

/**
 * Reject SERP results that are clearly not person profiles.
 * Checks URL pattern, title, and snippet for spam signals.
 */
const SPAM_PATTERNS = [
  /\b(seo|backlink|link.?build|reputation repair)\b/i,
  /\b(assignment help|homework|course bro)\b/i,
  /\b(buy followers|get followers)\b/i,
  /\b(web systems|web agency)\b/i,
];

export function isLikelyPersonProfile(profile: ProfileSummary): boolean {
  const url = profile.linkedinUrl.toLowerCase();
  if (!url.includes('/in/')) return false;

  const title = (profile.title ?? '').toLowerCase();
  const snippet = (profile.snippet ?? '').toLowerCase();
  const combined = `${title} ${snippet}`;

  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(combined)) return false;
  }

  return true;
}

function extractLinkedInIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/in\/([^/]+)/);
    if (match) return match[1].split(/[?#]/)[0].replace(/\/$/, '');
    return null;
  } catch {
    return null;
  }
}
