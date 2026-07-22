import { JobRequirements } from './jd-digest';
import type { CandidateForRanking } from './ranking-new';
import type { CrustdataProfileResponse } from './crustdata-client';
import { signActiveGraphJWT } from './activegraph-auth';
import { resolveLocationDeterministic } from '@/lib/taxonomy/location-service';
import { createLogger } from '@/lib/logger';

const log = createLogger('activegraph-client');

const ACTIVEGRAPH_URL = process.env.ACTIVEGRAPH_URL || 'http://localhost:8000';

/** How many home-pool candidates to request per sourcing run. The server
 * clamps to its own ceiling and reports truncation via total_matched. */
// Matches Memory's GLOBAL_SEARCH_LIMIT_MAX (500) — the server is the
// authoritative binding limit; searchGlobalPool logs when it truncates us.
export const HOME_POOL_LIMIT = parseInt(process.env.SOURCE_HOME_POOL_LIMIT || '500', 10);

/** Home-pool results are merged into ranking only when explicitly enabled:
 * Memory returns signal_candidate_id values (LinkedIn URLs) that Discover's
 * persistence layer cannot yet reconcile with its local candidate CUIDs.
 * Ingest (write path) is always on; the read path stays dark until the ID
 * reconciliation ships. */
export const HOME_POOL_ENABLED =
  (process.env.SOURCE_HOME_POOL_ENABLED || 'false').toLowerCase() === 'true';

const REQUEST_TIMEOUT_MS = parseInt(process.env.ACTIVEGRAPH_TIMEOUT_MS || '15000', 10);

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export interface ActiveGraphSearchResult {
  candidate_id: string;
  display_name: string | null;
  primary_email: string | null;
  signal_candidate_id: string;
  stored_tags: string[];
  matched_tags: string[];
  overlap_count: number;
  overlap_ratio: number;
  profile: CrustdataProfileResponse | null;
}

export interface GlobalPoolSearchResult {
  id: string; // global_candidate_id
  name: string | null;
  headline: string | null;
  linkedin_url: string | null;
  linkedin_id: string | null;
  role_family: string | null;
  seniority_band: string | null;
  skills_normalized: string[] | null;
  location_city: string | null;
  location_country_code: string | null;
  similarity: number;
  crustdata_profile: CrustdataProfileResponse | null;
  tenant_candidate_id: string | null;
  signal_candidate_id: string | null;
}

/**
 * Builds the query text for vector pool search. Mirrors Memory's
 * build_candidate_embedding_text shape (name/headline/role/seniority,
 * "skills: ...", location) so JD queries and candidate rows live in the
 * same vector space.
 */
export function buildPoolQueryText(req: JobRequirements): string {
  const parts: string[] = [];
  if (req.title) parts.push(req.title);
  if (req.roleFamily) parts.push(req.roleFamily);
  if (req.seniorityLevel) parts.push(req.seniorityLevel);
  if (req.topSkills?.length) parts.push('skills: ' + req.topSkills.slice(0, 30).join(', '));
  if (req.location) parts.push(req.location.split(',')[0].trim());
  return parts.join('. ');
}

/**
 * Vector search over Memory's platform pool (#29 slice 5 — hybrid retrieval).
 * Returns null when the endpoint is unavailable/disabled so the caller can
 * fall back to tag search.
 */
export async function searchGlobalPool(
  requirements: JobRequirements,
  tenantId: string,
  limit: number = HOME_POOL_LIMIT,
  requestId?: string
): Promise<GlobalPoolSearchResult[] | null> {
  const queryText = buildPoolQueryText(requirements);
  if (!queryText.trim()) return [];

  const rawCity = requirements.location ? requirements.location.split(',')[0].trim() : null;
  let cityAliases: string[] | null = null;
  if (rawCity) {
    const resolved = resolveLocationDeterministic(rawCity);
    cityAliases = Array.from(
      new Set(
        [rawCity, resolved.city, resolved.rawCity]
          .filter((c): c is string => !!c && !!c.trim())
          .map((c) => c.toLowerCase()),
      ),
    );
  }

  const token = await signActiveGraphJWT(tenantId, 'kg:read', requestId);
  let response: Response;
  try {
    response = await fetchWithTimeout(`${ACTIVEGRAPH_URL}/global-candidates/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query_text: queryText,
        limit,
        location_city: rawCity,
        // Alias expansion (e.g. bengaluru + bangalore): Memory's filter is
        // ILIKE ANY over these — 'Bangalore Urban' rows failed a plain
        // 'bengaluru' substring and were unreachable at ANY limit.
        location_cities: cityAliases,
      }),
    });
  } catch (err) {
    log.warn({ requestId, err: String(err) }, 'Global pool vector search unreachable');
    return null;
  }

  if (!response.ok) {
    // 503 = GLOBAL_MEMORY_ENABLED off server-side — expected until slice-1 flips it.
    const body = await response.text().catch(() => '');
    log.info(
      { requestId, status: response.status, body: body.slice(0, 200) },
      'Global pool vector search unavailable — falling back to tag search'
    );
    return null;
  }

  const data = await response.json().catch(() => null);
  if (!data || !Array.isArray(data.results)) return null;
  if (typeof data.applied_limit === 'number' && data.applied_limit < limit) {
    // No silent caps: the server clamped our request — candidates beyond
    // applied_limit never entered the vector set.
    log.warn(
      { requestId, requested: limit, appliedLimit: data.applied_limit },
      'Global pool vector search truncated by server cap'
    );
  }
  return data.results as GlobalPoolSearchResult[];
}

/**
 * Derives search tags from the JD requirements for querying ActiveGraph.
 */
export function generateTagsFromJD(req: JobRequirements): string[] {
  const tags = new Set<string>();
  
  if (req.roleFamily) tags.add(req.roleFamily.toLowerCase());
  if (req.seniorityLevel) tags.add(req.seniorityLevel.toLowerCase());
  if (req.location) {
    const locMatch = req.location.match(/^([^,]+)/);
    if (locMatch) tags.add(locMatch[1].toLowerCase().trim());
  }
  
  for (const skill of (req.topSkills || [])) {
    tags.add(skill.toLowerCase().trim());
  }
  
  return Array.from(tags).filter(Boolean);
}

/**
 * Derives tags from the candidate's actual profile data for ingestion.
 * We store candidate-attribute tags so they are reusable across JDs.
 */
export function generateTagsFromCandidate(c: CandidateForRanking): string[] {
  const tags = new Set<string>();

  // 1. Skills
  if (c.snapshot?.skillsNormalized) {
    for (const skill of c.snapshot.skillsNormalized) {
      tags.add(skill.toLowerCase().trim());
    }
  }

  // 2. Role
  if (c.snapshot?.roleType) {
    tags.add(c.snapshot.roleType.toLowerCase());
  } else if (c.crustdata?.experience?.employment_details?.current?.[0]?.title) {
    // Basic fallback if snapshot wasn't fully populated
    const title = c.crustdata.experience.employment_details.current[0].title;
    const words = title.toLowerCase().split(/[\s,|-]+/);
    for (const w of words) {
      if (w.length > 3) tags.add(w);
    }
  }

  // 3. Location
  if (c.snapshot?.location) {
    const locMatch = c.snapshot.location.match(/^([^,]+)/);
    if (locMatch) tags.add(locMatch[1].toLowerCase().trim());
  }

  // 4. Seniority
  if (c.snapshot?.seniorityBand) {
    tags.add(c.snapshot.seniorityBand.toLowerCase());
  } else if (c.crustdata?.experience?.employment_details?.current?.[0]?.seniority_level) {
    tags.add(c.crustdata.experience.employment_details.current[0].seniority_level.toLowerCase());
  }

  // 5. Industry
  const currentRole = c.crustdata?.experience?.employment_details?.current?.[0];
  if (currentRole?.company_industries) {
    for (const ind of currentRole.company_industries) {
      tags.add(ind.toLowerCase().trim());
    }
  }

  return Array.from(tags).filter(Boolean);
}

/**
 * Search the internal candidate library (ActiveGraph) using tags.
 */
/** Returns the matched candidates, or null when the home pool was UNAVAILABLE
 * (auth/network/server failure) — callers must distinguish "Memory had nothing"
 * from "we could not ask Memory". */
export async function searchHomePool(
  tags: string[],
  tenantId: string,
  limit: number = HOME_POOL_LIMIT,
  requestId?: string
): Promise<ActiveGraphSearchResult[] | null> {
  if (!tags.length) return [];

  const token = await signActiveGraphJWT(tenantId, 'kg:read', requestId);
  const response = await fetchWithTimeout(`${ACTIVEGRAPH_URL}/candidates/search/by-tags`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      tags,
      // Kept for JWT-disabled dev environments; with JWT enabled the server
      // derives the tenant from the token's tenant_id claim.
      tenant_id: tenantId,
      limit,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log.error(
      { requestId, tenantId, status: response.status, body: body.slice(0, 300) },
      'ActiveGraph home-pool search failed — continuing without home pool'
    );
    return null;
  }

  const data = await response.json();
  if (data.truncated) {
    log.warn(
      {
        requestId,
        tenantId,
        returned: data.total,
        totalMatched: data.total_matched,
        appliedLimit: data.applied_limit,
      },
      'ActiveGraph home-pool result truncated — candidates above the limit were dropped'
    );
  }
  return data.results || [];
}

/**
 * Write a candidate to the internal library (ActiveGraph).
 */
export async function ingestCandidate(
  tenantId: string,
  candidate: CandidateForRanking & { linkedinUrl?: string; name?: string },
  tags: string[],
  requestId?: string
): Promise<boolean> {
  // Extract standard identifier format from ID (which is the LinkedIn URL)
  let linkedinUrl = candidate.linkedinUrl || candidate.id;
  if (!linkedinUrl.startsWith('http')) {
      linkedinUrl = `https://www.linkedin.com/in/${linkedinUrl}`;
  }

  const payload = {
    signal_candidate_id: candidate.id,
    source_record_type: "sourced_candidate",
    linkedinUrl: linkedinUrl,
    display_name: candidate.name,
    headline: candidate.headlineHint,
    request_id: requestId,
    tags: tags,
    tenant_id: tenantId,
    crustdata: candidate.crustdata,
  };

  const token = await signActiveGraphJWT(tenantId, 'kg:write', requestId);
  const response = await fetchWithTimeout(`${ACTIVEGRAPH_URL}/candidates/resolve/signal/candidate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log.error(
      { requestId, tenantId, candidateId: candidate.id, status: response.status, body: body.slice(0, 300) },
      'ActiveGraph candidate ingest failed'
    );
    return false;
  }

  return true;
}

/**
 * Ingest a batch of candidates with bounded concurrency (chunks of 10).
 * Individual failures are logged by ingestCandidate; returns the success count.
 */
export async function ingestCandidateBatch(
  tenantId: string,
  candidates: (CandidateForRanking & { linkedinUrl?: string; name?: string })[],
  requestId?: string,
  chunkSize = 10
): Promise<number> {
  let success = 0;
  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    const results = await Promise.all(
      chunk.map(async (candidate) => {
        try {
          const tags = generateTagsFromCandidate(candidate);
          return await ingestCandidate(tenantId, candidate, tags, requestId);
        } catch (err) {
          log.error({ requestId, candidateId: candidate.id, err: String(err) }, 'ingest threw');
          return false;
        }
      })
    );
    success += results.filter(Boolean).length;
  }
  return success;
}
