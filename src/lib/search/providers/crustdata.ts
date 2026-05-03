import type { ProfileSummary } from '@/types/linkedin';
import type {
  RawSearchResult,
  SearchGeoContext,
  SearchProvider,
  StructuredJobSearchSpec,
} from './types';

function searchUrl(): string {
  return process.env.CRUSTDATA_SEARCH_URL || 'https://api.crustdata.com/person/search';
}
function apiVersion(): string {
  return process.env.CRUSTDATA_API_VERSION || '2025-11-01';
}
const CRUSTDATA_TIMEOUT_MS = 30_000;
// Cap on Retry-After we'll honor before falling through to Serper. Beyond this,
// the SERP fallback path is faster than waiting on Crustdata to recover.
const CRUSTDATA_MAX_RETRY_AFTER_MS = 2_000;
// Brief sleep before the single retry on 5xx / timeout / network errors.
const CRUSTDATA_RETRY_BASE_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CrustdataFetchError extends Error {
  status?: number;
  retryable: boolean;
}

async function fetchCrustdataOnce(body: unknown, apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CRUSTDATA_TIMEOUT_MS);
  try {
    return await fetch(searchUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'x-api-version': apiVersion(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * POST to Crustdata with one retry on transient failures (5xx, 429 with short
 * Retry-After, timeout, network error). 4xx other than 429 throws immediately —
 * those are permanent (bad request, auth) and the caller should fall through
 * to the SERP path.
 */
async function fetchCrustdata(body: unknown): Promise<unknown> {
  const apiKey = process.env.CRUSTDATA_API_KEY;
  if (!apiKey) {
    throw new Error('CRUSTDATA_API_KEY is not configured');
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await fetchCrustdataOnce(body, apiKey);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      lastError = new Error(
        isAbort
          ? `Crustdata request timed out after ${CRUSTDATA_TIMEOUT_MS}ms`
          : `Crustdata network error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt === 1) {
        await sleep(CRUSTDATA_RETRY_BASE_DELAY_MS);
        continue;
      }
      throw lastError;
    }

    if (res.ok) {
      return await res.json();
    }

    const bodyText = await res.text().catch(() => '');
    const snippet = bodyText.slice(0, 200);
    const errMessage = `Crustdata search failed: ${res.status} ${snippet}`;

    // 4xx (except 429) — permanent. Throw, caller falls back to Serper.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw Object.assign(new Error(errMessage), { status: res.status, retryable: false } satisfies Partial<CrustdataFetchError>);
    }

    // 429 — honor Retry-After if short; otherwise give up so caller falls back.
    if (res.status === 429 && attempt === 1) {
      const retryAfterRaw = res.headers.get('retry-after');
      const retryAfterSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : NaN;
      const retryAfterMs = Number.isFinite(retryAfterSec)
        ? retryAfterSec * 1_000
        : CRUSTDATA_RETRY_BASE_DELAY_MS;
      if (retryAfterMs <= CRUSTDATA_MAX_RETRY_AFTER_MS) {
        await sleep(retryAfterMs);
        lastError = new Error(errMessage);
        continue;
      }
      // Retry-After too long — abandon to Serper now.
      throw new Error(errMessage);
    }

    // 5xx — retry once after a short delay.
    if (res.status >= 500 && attempt === 1) {
      await sleep(CRUSTDATA_RETRY_BASE_DELAY_MS);
      lastError = new Error(errMessage);
      continue;
    }

    throw new Error(errMessage);
  }

  throw lastError ?? new Error('Crustdata request failed');
}

interface CrustdataExperienceCurrent {
  title?: string | null;
  name?: string | null;
}

interface CrustdataPerson {
  basic_profile?: {
    name?: string | null;
    headline?: string | null;
    current_title?: string | null;
    location?: {
      city?: string | null;
      state?: string | null;
      country?: string | null;
      raw?: string | null;
    } | null;
  } | null;
  social_handles?: {
    professional_network_identifier?: {
      profile_url?: string | null;
      public_identifier?: string | null;
    } | null;
  } | null;
  experience?: {
    employment_details?: {
      current?: CrustdataExperienceCurrent[] | null;
    } | null;
  } | null;
}

interface CrustdataSearchResponse {
  profiles?: CrustdataPerson[];
  total_count?: number;
  next_cursor?: string | null;
}

type CrustdataCondition =
  | { field: string; type: string; value: string | number | boolean }
  | { op: 'and' | 'or'; conditions: CrustdataCondition[] };

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'in', 'at', 'of', 'for', 'to', 'with', 'on', 'by',
  'site', 'linkedin', 'com', 'www', 'https', 'http', 'inurl',
]);

const HEX_RE = /^[a-f0-9]{16,}$/i;

function parseSerpQuery(query: string): {
  phrases: string[];
  keywords: string[];
} {
  const phrases: string[] = [];
  const keywords: string[] = [];

  let working = query;
  const quoteRe = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = quoteRe.exec(query)) !== null) {
    const phrase = match[1].trim();
    if (phrase.length > 0) phrases.push(phrase);
  }
  working = working.replace(quoteRe, ' ');
  working = working.replace(/\b(site|inurl|intitle|filetype):\S+/gi, ' ');

  const tokens = working
    .toLowerCase()
    .split(/[\s,/]+/)
    .map((t) => t.replace(/[^\p{L}\p{N}+#-]/gu, ''))
    .filter(Boolean);

  for (const tok of tokens) {
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    if (HEX_RE.test(tok)) continue;
    keywords.push(tok);
  }

  return { phrases, keywords };
}

function buildFilters(
  query: string,
  geo?: SearchGeoContext
): { filters: CrustdataCondition; debug: { phrases: string[]; keywords: string[] } } {
  const { phrases, keywords } = parseSerpQuery(query);
  const conditions: CrustdataCondition[] = [];

  // Parse geo.locationText to extract city (first segment before comma)
  const locationText = geo?.locationText?.trim() || '';
  const geoCity = locationText.split(',')[0]?.trim() || '';
  const cityPhrase = phrases.find(
    (p) => geoCity && p.toLowerCase().includes(geoCity.toLowerCase())
  );
  const titlePhrase = phrases.find((p) => p !== cityPhrase);

  // Title: only use if we have a quoted phrase. Bare keywords are skills, not title.
  if (titlePhrase) {
    conditions.push({
      field: 'experience.employment_details.current.title',
      type: '(.)',
      value: titlePhrase,
    });
  }

  // Location: prefer city extracted from geo.locationText, then quoted phrase
  const cityFromPhrase = cityPhrase?.split(',')[0]?.trim();
  const cityValue = geoCity || cityFromPhrase;

  if (cityValue) {
    conditions.push({
      field: 'basic_profile.location.city',
      type: '(.)',
      value: cityValue,
    });
  } else if (geo?.countryCode) {
    conditions.push({
      field: 'basic_profile.location.country',
      type: '(.)',
      value: geo.countryCode,
    });
  }

  // Skills: all bare keywords go into an OR group across skills + headline.
  // This widens the net so Crustdata returns matches even when one signal is missing.
  if (keywords.length > 0) {
    const skillConditions: CrustdataCondition[] = [];
    for (const kw of keywords.slice(0, 8)) {
      skillConditions.push({
        field: 'skills.professional_network_skills',
        type: '(.)',
        value: kw,
      });
      skillConditions.push({
        field: 'basic_profile.headline',
        type: '(.)',
        value: kw,
      });
    }
    if (skillConditions.length === 1) {
      conditions.push(skillConditions[0]);
    } else {
      conditions.push({ op: 'or', conditions: skillConditions });
    }
  }

  return {
    filters:
      conditions.length === 1
        ? conditions[0]
        : { op: 'and', conditions },
    debug: { phrases, keywords },
  };
}

async function searchPeople(
  query: string,
  maxResults: number,
  geo?: SearchGeoContext
): Promise<CrustdataPerson[]> {
  const { filters } = buildFilters(query, geo);

  const json = (await fetchCrustdata({
    filters,
    limit: Math.min(Math.max(maxResults, 1), 100),
  })) as CrustdataSearchResponse;
  return json.profiles ?? [];
}

function normalizeLinkedInId(url: string, fallback?: string | null): string {
  if (fallback?.trim()) return fallback.trim();
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match?.[1]?.trim() ?? url;
}

function extractCurrentTitle(person: CrustdataPerson): string | null {
  const direct = person.basic_profile?.current_title?.trim();
  if (direct) return direct;
  const fromExperience = person.experience?.employment_details?.current?.[0]?.title?.trim();
  return fromExperience || null;
}

/**
 * Crustdata's title filter does substring (contains) matching, so a query like
 * "Senior Hadoop Developer" requires that exact phrase in the candidate's
 * current_title. Real-world titles are usually "Senior Apache Hadoop Developer"
 * or "Senior Big Data with Hadoop Developer" — they don't contain "Senior Hadoop
 * Developer" verbatim. Stripping the seniority adjective broadens the match
 * to the role itself ("Hadoop Developer") without losing precision because
 * skills + city already narrow the result set.
 */
const SENIORITY_PREFIX_RE = /\b(senior|sr\.?|junior|jr\.?|lead|principal|staff|chief|head|director|manager|associate|entry-level|entry|trainee|intern)\b/gi;

function stripSeniorityFromTitle(title: string): string {
  const stripped = title.replace(SENIORITY_PREFIX_RE, '').replace(/\s+/g, ' ').trim();
  // If stripping removed everything (title was just "Senior"), keep the original.
  return stripped.length >= 3 ? stripped : title;
}

/**
 * Crustdata stores country as full name ("India", "United States") not ISO code.
 * Map common ISO codes back to country names for filter matching.
 */
const COUNTRY_CODE_TO_NAME: Record<string, string> = {
  IN: 'India',
  US: 'United States',
  GB: 'United Kingdom',
  UK: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  IT: 'Italy',
  NL: 'Netherlands',
  SG: 'Singapore',
  AE: 'United Arab Emirates',
  IE: 'Ireland',
};

function expandCountryToName(countryRaw: string): string {
  const trimmed = countryRaw.trim();
  if (trimmed.length <= 3) {
    const upper = trimmed.toUpperCase();
    return COUNTRY_CODE_TO_NAME[upper] ?? trimmed;
  }
  return trimmed;
}

/**
 * Build a Crustdata filter directly from a structured job spec.
 *
 * Filter shape (proven against the live API to return matching candidates):
 *   AND(
 *     experience.employment_details.current.title contains <title>,
 *     basic_profile.location.city = <city>           [or .country contains if no city],
 *     OR(skills.professional_network_skills contains <skill_i> for each skill)
 *   )
 */
function buildJobSpecFilters(spec: StructuredJobSearchSpec): CrustdataCondition {
  const conditions: CrustdataCondition[] = [];

  const title = spec.title?.trim();
  if (title) {
    conditions.push({
      field: 'experience.employment_details.current.title',
      type: '(.)',
      value: stripSeniorityFromTitle(title),
    });
  }

  const city = spec.city?.trim();
  const country = spec.country?.trim();
  if (city) {
    // Exact city match — proven to give clean results
    conditions.push({
      field: 'basic_profile.location.city',
      type: '=',
      value: city,
    });
  } else if (country) {
    conditions.push({
      field: 'basic_profile.location.country',
      type: '(.)',
      value: expandCountryToName(country),
    });
  }

  const skills = (spec.skills ?? [])
    .map((s) => s?.trim().toLowerCase())
    .filter((s): s is string => Boolean(s));
  if (skills.length > 0) {
    const skillConditions: CrustdataCondition[] = skills.slice(0, 8).map((skill) => ({
      field: 'skills.professional_network_skills',
      type: '(.)',
      value: skill,
    }));
    if (skillConditions.length === 1) {
      conditions.push(skillConditions[0]);
    } else {
      conditions.push({ op: 'or', conditions: skillConditions });
    }
  }

  if (conditions.length === 1) return conditions[0];
  return { op: 'and', conditions };
}

async function searchByFilters(
  filters: CrustdataCondition,
  maxResults: number,
): Promise<CrustdataPerson[]> {
  const json = (await fetchCrustdata({
    filters,
    limit: Math.min(Math.max(maxResults, 1), 100),
  })) as CrustdataSearchResponse;
  return json.profiles ?? [];
}

function personToProfileSummary(person: CrustdataPerson): ProfileSummary | null {
  const profileUrl = person.social_handles?.professional_network_identifier?.profile_url?.trim();
  if (!profileUrl) return null;

  const linkedinId = normalizeLinkedInId(
    profileUrl,
    person.social_handles?.professional_network_identifier?.public_identifier,
  );

  const headline = person.basic_profile?.headline?.trim() || null;
  const city = person.basic_profile?.location?.city?.trim() || null;
  const country = person.basic_profile?.location?.country?.trim() || null;
  const title = extractCurrentTitle(person);
  const currentCompany = person.experience?.employment_details?.current?.[0]?.name?.trim() || null;

  return {
    linkedinUrl: profileUrl,
    linkedinId,
    title: headline || title || person.basic_profile?.name?.trim() || profileUrl,
    snippet: headline || title || '',
    name: person.basic_profile?.name?.trim() || undefined,
    headline: headline || undefined,
    location: [city, country].filter(Boolean).join(', ') || undefined,
    providerMeta: {
      provider: 'crustdata',
      city,
      country,
      currentTitle: title,
      currentCompany,
    },
  };
}

export const crustdataProvider: SearchProvider = {
  name: 'crustdata',

  async searchLinkedInProfiles(
    query: string,
    maxResults: number = 10,
    _countryCode?: string | null,
    geo?: SearchGeoContext
  ): Promise<ProfileSummary[]> {
    const people = await searchPeople(query, maxResults, geo);
    return people
      .map(personToProfileSummary)
      .filter((row): row is ProfileSummary => Boolean(row));
  },

  async searchByJobSpec(
    spec: StructuredJobSearchSpec,
    maxResults: number = 100,
    _geo?: SearchGeoContext,
  ): Promise<ProfileSummary[]> {
    const filters = buildJobSpecFilters(spec);
    const people = await searchByFilters(filters, maxResults);
    return people
      .map(personToProfileSummary)
      .filter((row): row is ProfileSummary => Boolean(row));
  },

  async searchRaw(query: string, maxResults: number = 20, geo?: SearchGeoContext): Promise<RawSearchResult[]> {
    const people = await searchPeople(query, maxResults, geo);
    return people
      .map((person, index): RawSearchResult | null => {
        const profileUrl = person.social_handles?.professional_network_identifier?.profile_url?.trim();
        if (!profileUrl) return null;
        const headline = person.basic_profile?.headline?.trim() || '';
        const title = extractCurrentTitle(person);
        return {
          url: profileUrl,
          title: person.basic_profile?.name?.trim() || profileUrl,
          snippet: headline || title || '',
          position: index + 1,
          providerMeta: {
            provider: 'crustdata',
          },
        };
      })
      .filter((row): row is RawSearchResult => Boolean(row));
  },

  async healthCheck() {
    if (!process.env.CRUSTDATA_API_KEY) {
      return { healthy: false, error: 'CRUSTDATA_API_KEY is not configured' };
    }
    return { healthy: true };
  },
};

export default crustdataProvider;
