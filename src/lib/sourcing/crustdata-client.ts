import { createLogger } from '@/lib/logger';
import { type JobRequirements } from './jd-digest';

const log = createLogger('CrustdataClient');

const CRUSTDATA_API_KEY = process.env.CRUSTDATA_API_KEY;
const API_URL = 'https://api.crustdata.com/person/search';

// ─── Response Types (matching actual Crustdata API response) ─────────────────

export interface CrustdataProfileResponse {
  // ── Nested schema (official /person/search endpoint) ────────────────────────
  crustdata_person_id?: number;
  metadata?: {
    updated_at?: string;
  };
  basic_profile?: {
    name?: string;
    first_name?: string;
    last_name?: string;
    headline?: string;
    current_title?: string;
    summary?: string;
    languages?: string[];
    location?: {
      city?: string;
      state?: string;
      country?: string;
      continent?: string;
      full_location?: string;
      raw?: string;
    };
  };
  professional_network?: {
    connections?: number;
    followers?: number;
    open_to_cards?: string[];
    profile_picture_permalink?: string;
    location?: {
      raw?: string;
    };
    metadata?: {
      last_scraped_source?: string;
    };
  };
  skills?: {
    professional_network_skills?: string[];
  };
  recently_changed_jobs?: boolean;
  years_of_experience_raw?: number;
  experience?: {
    employment_details?: {
      current?: {
        company_name?: string;
        title?: string;
        seniority_level?: string;
        function_category?: string;
        start_date?: string;
        end_date?: string;
        description?: string;
        name?: string;
        years_at_company_raw?: number;
        company_headquarters_country?: string;
        business_email_verified?: boolean;
        company_industries?: string[];
        company_professional_network_industry?: string;
        company_type?: string;
        company_headcount_range?: string;
      }[];
      past?: {
        company_name?: string;
        title?: string;
        seniority_level?: string;
        function_category?: string;
        start_date?: string;
        end_date?: string;
        description?: string;
        name?: string;
        years_at_company_raw?: number;
        company_headquarters_country?: string;
        business_email_verified?: boolean;
        company_industries?: string[];
        company_professional_network_industry?: string;
        company_type?: string;
        company_headcount_range?: string;
      }[];
    };
  };
  education?: {
    schools?: {
      school?: string;
      degree?: string;
      field_of_study?: string;
      start_year?: number;
      end_year?: number;
    }[];
  };
  certifications?: {
    name?: string;
    issuing_organization?: string;
    issue_date?: string;
    expiration_date?: string;
  }[];
  honors?: {
    title?: string;
    issuer?: string; // undocumented
    description?: string; // undocumented
  }[];
  contact?: {
    has_business_email?: boolean;
    has_personal_email?: boolean;
    has_phone_number?: boolean;
  };
  social_handles?: {
    professional_network_identifier?: { profile_url?: string };
    twitter_identifier?: { slug?: string };
    dev_platform_identifier?: { profile_url?: string | null };
    [key: string]: any;
  };
}

// ─── Filter Types (matching actual Crustdata API schema) ─────────────────────

// Leaf condition: bare object, NO op/conditions fields
interface CrustdataCondition {
  field: string;
  type: '=' | '!=' | '<' | '=<' | '>' | '=>' | 'in' | 'not_in' | '(.)' | '(!)' | '[.]' | 'geo_distance';
  value: string | number | string[] | number[] | object;
}

// Group: op + conditions array of leaf objects
interface CrustdataGroup {
  op: 'and' | 'or';
  conditions: (CrustdataCondition | CrustdataGroup)[];
}

// ─── Role-family → headline regex map ───────────────────────────────────────
//
// Crustdata `type: "(.)"` is a regex-contains match.
// Using role titles instead of skills prevents matching sales directors,
// VCs, or CEOs who merely mention a skill like "aws" in their headline.
// These patterns are OR-joined with pipes, which Crustdata handles natively.
//
// PRECISION over recall (#24): terms must be ROLE-SPECIFIC. Generic catch-alls like
// "software engineer"/"software developer" match ~everything — a live A/B showed the old
// backend pattern matched 113,362 Bengaluru profiles (0/30 actually backend in the fit-blind
// slice) vs 600 with backend-specific terms (30/30 backend). The scorer's roleScore taxonomy
// treats "software engineer" as non-backend, so those generics also scored 2-3/15 and crowded
// out true matches. Keep these tight; adaptive relaxation for sparse roles lives in #15.
//
const ROLE_FAMILY_HEADLINE_FILTERS: Record<string, string> = {
  devops: '(devops|sre|site reliability|platform engineer|infrastructure engineer|cloud engineer|devsecops)',
  sre: '(sre|site reliability|platform engineer|devops|infrastructure engineer)',
  backend: '(backend|back.?end|api engineer|server.?side|backend developer)',
  frontend: '(frontend|front.?end|ui engineer|react developer|angular developer|web developer)',
  fullstack: '(full.?stack|full stack developer|full stack engineer)',
  data: '(data engineer|data scientist|analytics engineer|bi engineer|data platform)',
  ml: '(machine learning|ml engineer|data scientist|ai engineer|deep learning)',
  mobile: '(ios developer|android developer|mobile engineer|react native|flutter)',
  security: '(security engineer|appsec|infosec|devsecops|cloud security|penetration)',
  qa: '(qa engineer|sdet|test engineer|quality engineer|automation engineer)',
  product: '(product manager|product lead|head of product|vp product|cpo|product owner)',
  design: '(ux designer|ui designer|product designer|ux lead|design lead)',
  sales: '(account executive|sales manager|sales director|business development|vp sales|revenue)',
  marketing: '(marketing manager|growth marketer|demand generation|content marketer|seo)',
  finance: '(finance manager|cfo|financial analyst|controller|fp&a|accounting)',
  hr: '(hr manager|recruiter|talent acquisition|people ops|hrbp|chief people)',
};

// Maps our extracted JD seniority to the Crustdata seniority_level vocabulary
// (observed values: "Entry Level", "Senior", "Entry Level Manager", "Manager",
// "Director", "VP", "CXO", "Owner / Partner"). Filtering on this removes the
// wrong-band noise — e.g. a "senior" role currently pulls ~52% Entry Level
// profiles — and naturally caps the upper end (excludes CXO/Owner/Partner).
// Kept generous (accept adjacent bands) to avoid over-restricting the pool.
const SENIORITY_TO_CRUSTDATA: Record<string, string[]> = {
  intern: ['Entry Level'],
  junior: ['Entry Level'],
  entry: ['Entry Level'],
  associate: ['Entry Level', 'Senior'],
  mid: ['Entry Level', 'Senior'],
  senior: ['Senior'],
  lead: ['Senior', 'Manager', 'Director'],
  staff: ['Senior', 'Director'],
  principal: ['Senior', 'Director'],
  manager: ['Entry Level Manager', 'Manager', 'Director'],
  director: ['Director', 'VP'],
  vp: ['VP', 'CXO'],
  head: ['Director', 'VP', 'CXO'],
  executive: ['CXO', 'Owner / Partner'],
  cxo: ['CXO', 'Owner / Partner'],
  chief: ['CXO', 'Owner / Partner'],
};

// Toggle so the seniority filter can be disabled without a deploy if it ever
// over-restricts a query.
const SENIORITY_FILTER_ENABLED =
  (process.env.SOURCE_CRUSTDATA_SENIORITY_FILTER || 'true').toLowerCase() === 'true';

/** Resolve the Crustdata seniority bands to accept for a JD seniority string. */
function resolveSeniorityBands(seniorityLevel: string | null): string[] {
  if (!seniorityLevel) return [];
  const key = seniorityLevel.toLowerCase().trim();
  if (SENIORITY_TO_CRUSTDATA[key]) return SENIORITY_TO_CRUSTDATA[key];
  // Substring fallback for compound labels like "senior software engineer".
  for (const [k, v] of Object.entries(SENIORITY_TO_CRUSTDATA)) {
    if (key.includes(k)) return v;
  }
  return [];
}

// ─── Search Function ──────────────────────────────────────────────────────────

/**
 * Search Crustdata for candidates.
 *
 * INTENTIONALLY RELAXED QUERY STRATEGY:
 * We fetch 300 candidates with a broad query (location + top 1-2 skills only).
 * Strict ranking against the full JD happens locally after retrieval.
 * This maximises Crustdata hit rate and avoids over-filtering at the API level.
 */
export async function searchPeople(
  requirements: JobRequirements,
  limit: number = 300,
  options?: {
    /**
     * Known crustdata_person_ids to exclude (Stage-2 dedup economics).
     * /person/search orders by lowest person_id — without exclusion every run
     * re-buys the same slice (~34% re-buy measured). Excluding fresh-known
     * people makes each run buy NEW people; stale-known people are deliberately
     * NOT excluded so they cycle back in and get their blobs refreshed.
     */
    excludePersonIds?: number[];
  },
): Promise<CrustdataProfileResponse[]> {
  if (!CRUSTDATA_API_KEY) {
    throw new Error('CRUSTDATA_API_KEY is not configured');
  }

  const conditions: (CrustdataCondition | CrustdataGroup)[] = [];

  const excludeIds = (options?.excludePersonIds ?? []).filter((n) => Number.isFinite(n));
  if (excludeIds.length > 0) {
    conditions.push({
      field: 'crustdata_person_id',
      type: 'not_in',
      value: excludeIds,
    });
  }

  // 1. Region filter — use full_location (can match country, city, state)
  if (requirements.location) {
    const location = requirements.location.split(',')[0].trim();
    conditions.push({
      field: 'basic_profile.location.full_location',
      type: '(.)',
      value: location,
    });
  }

  // 2. Title filter. Priority:
  //    a) digest titleSearchTerms — LLM-generated per-job LinkedIn title variants/synonyms
  //       (digest v2+). Handles tech variants AND non-tech synonym families per job.
  //    b) static role-family map — fallback for old digests / LLM failure.
  //    c) primary skill as title keyword — last resort.
  const digestTitleTerms = (requirements.titleSearchTerms ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3 && t.length <= 60)
    .slice(0, 6);
  const roleFamilyKey = (requirements.roleFamily ?? '').toLowerCase();
  const roleFamilyPattern = ROLE_FAMILY_HEADLINE_FILTERS[roleFamilyKey];
  const primarySkill = requirements.topSkills?.[0];

  const titleTerms = digestTitleTerms.length > 0
    ? digestTitleTerms
    : roleFamilyPattern
      ? roleFamilyPattern.replace(/[()]/g, '').split('|')
      : [];

  if (titleTerms.length > 0) {
    const orConditions = titleTerms.map(term => ({
      field: 'experience.employment_details.current.title',
      type: '(.)' as const,
      value: term,
    }));
    conditions.push({
      op: 'or',
      conditions: orConditions,
    });
  } else if (primarySkill) {
    // Fallback: no digest terms and no role family mapping — use top skill as title keyword
    conditions.push({
      field: 'experience.employment_details.current.title',
      type: '(.)',
      value: primarySkill,
    });
  }

  // 3. Seniority filter — accept the JD's band(s) in Crustdata's seniority
  //    vocabulary. Biggest single quality lever: strips the ~52% wrong-band
  //    (e.g. Entry Level) profiles a title-only query lets through, and caps
  //    the top (excludes CXO/Owner for a mid-senior role).
  const seniorityBands = SENIORITY_FILTER_ENABLED
    ? resolveSeniorityBands(requirements.seniorityLevel)
    : [];
  if (seniorityBands.length > 0) {
    conditions.push({
      op: 'or',
      conditions: seniorityBands.map((band) => ({
        field: 'experience.employment_details.current.seniority_level',
        type: '(.)' as const,
        value: band,
      })),
    });
  }
  const seniorityFilterUsed = seniorityBands.length > 0 ? seniorityBands.join('|') : 'none';

  const titleFilterUsed = digestTitleTerms.length > 0
    ? `digest:${digestTitleTerms.join('|')}`
    : roleFamilyPattern
      ? `role_family:${roleFamilyKey}`
      : primarySkill
        ? `skill:${primarySkill}`
        : 'none';

  const requestBody: {
    limit: number;
    fields?: string[];
    filters?: CrustdataCondition | CrustdataGroup;
  } = {
    limit,
    fields: [
      'crustdata_person_id', 'basic_profile', 'contact',
      'education', 'experience', 'fit', 'social_handles'
    ]
  };

  if (conditions.length === 1) {
    requestBody.filters = conditions[0];
  } else if (conditions.length > 1) {
    requestBody.filters = { op: 'and', conditions };
  }

  console.log('\n' + '='.repeat(60));
  console.log('📡 [CRUSTDATA] CONNECTED — OFFICIAL NESTED SCHEMA API');
  console.log(`🎯 [CRUSTDATA] TITLE FILTER: ${titleFilterUsed}`);
  console.log(`🎚️  [CRUSTDATA] SENIORITY FILTER: ${seniorityFilterUsed}`);
  console.log('📦 [CRUSTDATA] SENDING PAYLOAD (exclusion ids elided):');
  console.log(JSON.stringify(requestBody, (k, v) =>
    Array.isArray(v) && v.length > 20 && typeof v[0] === 'number' ? `[${v.length} ids]` : v, 2));
  console.log('⏳ [CRUSTDATA] WAITING FOR RESPONSE...');
  console.log('='.repeat(60) + '\n');

  log.info(
    { limit, titleFilterUsed, seniorityFilterUsed, excludedKnown: excludeIds.length },
    'Searching Crustdata (official person/search)'
  );

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CRUSTDATA_API_KEY}`,
      'x-api-version': '2025-11-01',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    log.error({ status: response.status, errText }, 'Crustdata API error');
    console.error('\n' + '!'.repeat(60));
    console.error(`❌ [CRUSTDATA] API ERROR! Status: ${response.status}`);
    console.error(`📝 [CRUSTDATA] DETAILS: ${errText}`);
    console.error('!'.repeat(60) + '\n');
    throw new Error(`Crustdata API error: ${response.status} - ${errText}`);
  }

  const data = await response.json();

  // Deduplicate by profile URL
  const allProfiles = (data.profiles || []) as CrustdataProfileResponse[];
  const seen = new Set<string>();
  const deduped = allProfiles.filter((p) => {
    const key = p.social_handles?.professional_network_identifier?.profile_url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log('\n' + '*'.repeat(60));
  console.log(`✅ [CRUSTDATA] SUCCESS!`);
  console.log(`📊 [CRUSTDATA] TOTAL IN DB: ${data.total_count}`);
  console.log(`🧑‍💻 [CRUSTDATA] RETRIEVED: ${deduped.length} unique candidates`);
  console.log(`🔄 [CRUSTDATA] NEXT STEP: local re-ranking against full JD...`);
  console.log('*'.repeat(60) + '\n');

  log.info({ count: deduped.length, total: data.total_count, requested: limit }, 'Crustdata results');
  return deduped;
}





/**
 * Enrich Crustdata for candidates by URL.
 * Takes up to 25 URLs per request as per Crustdata API limits.
 * Returns a Map from linkedinUrl -> person_data.
 */
// export async function batchEnrichPeople(
//   linkedinUrls: string[],
// ): Promise<Map<string, any>> {
//   if (!CRUSTDATA_API_KEY) {
//     throw new Error('CRUSTDATA_API_KEY is not configured');
//   }

//   const results = new Map<string, any>();
//   const ENRICH_API_URL = 'https://api.crustdata.com/person/enrich';

//   // Chunk array into max 25 items each
//   const chunkSize = 25;
//   for (let i = 0; i < linkedinUrls.length; i += chunkSize) {
//     const chunk = linkedinUrls.slice(i, i + chunkSize);

//     console.log('\n' + '='.repeat(60));
//     console.log(`📡 [CRUSTDATA ENRICH] BATCH ${Math.floor(i / chunkSize) + 1} (${chunk.length} URLs)`);
//     console.log('='.repeat(60) + '\n');

//     const requestBody = {
//       professional_network_profile_urls: chunk,
//       fields: [
//         'crustdata_person_id', 'metadata', 'basic_profile', 'professional_network',
//         'skills', 'experience', 'education', 'certifications', 'honors',
//         'contact', 'social_handles', 'recently_changed_jobs', 'years_of_experience_raw', 'fit'
//       ]
//     };

//     try {
//       const response = await fetch(ENRICH_API_URL, {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//           'Authorization': `Bearer ${CRUSTDATA_API_KEY}`,
//           'x-api-version': '2025-11-01',
//         },
//         body: JSON.stringify(requestBody),
//       });

//       if (!response.ok) {
//         const errText = await response.text();
//         console.error(`❌ [CRUSTDATA ENRICH] API ERROR! Status: ${response.status} - ${errText}`);
//         continue;
//       }

//       const data: any[] = await response.json();

//       for (const item of data) {
//         const url = item.matched_on;
//         const matches = item.matches || [];
//         if (matches.length > 0 && matches[0].person_data) {
//           results.set(url, matches[0].person_data);
//         } else {
//           results.set(url, null); // No match found
//         }
//       }
//     } catch (err) {
//       console.error('❌ [CRUSTDATA ENRICH] FETCH FAILED:', err instanceof Error ? err.message : err);
//     }
//   }

//   return results;
// }
