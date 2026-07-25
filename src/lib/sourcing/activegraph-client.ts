import { JobRequirements } from './jd-digest';
import type { CandidateForRanking } from './ranking-new';
import type { CrustdataProfileResponse } from './crustdata-client';
import { signActiveGraphJWT } from './activegraph-auth';
import {
  toActiveGraphPublicMarket,
  type PublicMarket,
} from './public-memory';
import { resolveLocationDeterministic } from '@/lib/taxonomy/location-service';
import type { RoleFamily } from '@/lib/taxonomy/role-service';
import { createLogger } from '@/lib/logger';
import { normalizeGlobalCandidateId } from './global-candidate-id';
import {
  projectPublicCrustdataProfile,
  redactPublicContactText,
} from './public-profile-redaction';

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
const IDENTITY_LOOKUP_TIMEOUT_MS = parseInt(
  process.env.ACTIVEGRAPH_IDENTITY_TIMEOUT_MS || '2000',
  10,
);

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, timeoutMs),
  );
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
  /** Tenant-private verified skills. Public-v1 rows deliberately return null. */
  skills_normalized: string[] | null;
  /** Public-profile skills are retrieval/display evidence, never verified skills. */
  public_skills_normalized?: string[] | null;
  location_city: string | null;
  location_country_code: string | null;
  similarity: number;
  crustdata_profile: CrustdataProfileResponse | null;
  tenant_candidate_id: string | null;
  signal_candidate_id: string | null;
  evidence_surface?: 'legacy' | 'public' | 'tenant_private';
}

export type GlobalPoolSurface = 'legacy_v0' | 'public_v1';

export interface GlobalPoolSearchResponse {
  surface: GlobalPoolSurface;
  results: GlobalPoolSearchResult[];
  count: number;
  appliedLimit: number;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function containsRestrictedEvidence(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) =>
      containsRestrictedEvidence(entry, seen),
    );
  }
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      normalizedKey.includes('email') ||
      normalizedKey.includes('phone') ||
      normalizedKey === 'contact' ||
      normalizedKey === 'contacts' ||
      normalizedKey.includes('resume') ||
      normalizedKey.includes('application') ||
      normalizedKey.includes('shortlist') ||
      normalizedKey.includes('campaign') ||
      normalizedKey.includes('outreach') ||
      normalizedKey === 'note' ||
      normalizedKey === 'notes' ||
      normalizedKey.includes('privateprovenance') ||
      normalizedKey === 'candidateprovenance'
    ) {
      return true;
    }
    if (containsRestrictedEvidence(nested, seen)) return true;
  }
  return false;
}

function isPublicGlobalPoolSearchResult(
  value: unknown,
): value is GlobalPoolSearchResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'id',
    'name',
    'headline',
    'linkedin_url',
    'linkedin_id',
    'role_family',
    'seniority_band',
    'skills_normalized',
    'public_skills_normalized',
    'location_city',
    'location_country_code',
    'similarity',
    'crustdata_profile',
    'tenant_candidate_id',
    'signal_candidate_id',
    'evidence_surface',
  ]);
  return (
    Object.keys(row).every((key) => allowedKeys.has(key)) &&
    normalizeGlobalCandidateId(row.id) !== null &&
    row.evidence_surface === 'public' &&
    row.skills_normalized === null &&
    row.tenant_candidate_id === null &&
    row.signal_candidate_id === null &&
    isNullableString(row.name) &&
    isNullableString(row.headline) &&
    isNullableString(row.linkedin_url) &&
    isNullableString(row.linkedin_id) &&
    isNullableString(row.role_family) &&
    isNullableString(row.seniority_band) &&
    isNullableString(row.location_city) &&
    isNullableString(row.location_country_code) &&
    typeof row.similarity === 'number' &&
    Number.isFinite(row.similarity) &&
    (row.public_skills_normalized === null ||
      (Array.isArray(row.public_skills_normalized) &&
        row.public_skills_normalized.every(
          (skill) => typeof skill === 'string',
        ))) &&
    (row.crustdata_profile === null ||
      (typeof row.crustdata_profile === 'object' &&
        !Array.isArray(row.crustdata_profile) &&
        !containsRestrictedEvidence(row.crustdata_profile)))
  );
}

export interface PublicMarketExclusionResponse {
  surface: 'public_v1';
  coarseMarketKey: string;
  crustdataPersonIds: number[];
  total: number;
  totalMatched: number;
  classifiedMatched: number;
  unclassifiedMatched: number;
  unclassifiedReturned: number;
  truncated: boolean;
  appliedLimit: number;
}

export interface PublicIdentityResult {
  linkedinUrl: string;
  normalizedLinkedinUrl: string;
  globalCandidateId: string;
}

export interface PublicIdentityLookupResponse {
  surface: 'public_v1';
  results: PublicIdentityResult[];
}

export interface TenantPrivateSearchResult {
  candidateId: string;
  globalCandidateId: string | null;
  displayName: string | null;
  linkedinUrl: string | null;
  linkedinId: string | null;
  headline: string | null;
  locationRaw: string | null;
  skills: string[];
  seniorityLevel: string | null;
  keywordScore: number;
  skillOverlapCount: number;
  evidenceSurface: 'tenant_private_v1';
}

export interface TenantPrivateSearchResponse {
  surface: 'tenant_private_v1';
  results: TenantPrivateSearchResult[];
  total: number;
  totalAvailable: number;
  truncated: boolean;
  appliedLimit: number;
}

export function chunkPublicIdentityUrls(
  linkedinUrls: string[],
  chunkSize = 200,
): string[][] {
  const uniqueUrls = Array.from(
    new Set(linkedinUrls.map((url) => url.trim()).filter(Boolean)),
  );
  const chunks: string[][] = [];
  const safeChunkSize = Math.max(1, chunkSize);
  for (let index = 0; index < uniqueUrls.length; index += safeChunkSize) {
    chunks.push(uniqueUrls.slice(index, index + safeChunkSize));
  }
  return chunks;
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
async function searchGlobalPoolResponseForSurface(
  requirements: JobRequirements,
  tenantId: string,
  limit: number,
  requestId: string | undefined,
  surface: GlobalPoolSurface,
): Promise<GlobalPoolSearchResponse | null> {
  const queryText = buildPoolQueryText(requirements);
  if (!queryText.trim()) {
    return { surface, results: [], count: 0, appliedLimit: limit };
  }

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
        surface,
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

  const data = await response.json().catch(() => null) as {
    surface?: unknown;
    results?: unknown;
    count?: unknown;
    applied_limit?: unknown;
  } | null;
  const returnedSurface =
    data?.surface ??
    // Backward compatibility while Memory rolls out the discriminator:
    // an absent marker can only mean the historical legacy response.
    (surface === 'legacy_v0' ? 'legacy_v0' : null);
  if (
    !data ||
    returnedSurface !== surface ||
    !Array.isArray(data.results) ||
    typeof data.applied_limit !== 'number'
  ) {
    log.error(
      { requestId, requestedSurface: surface },
      'Global pool vector search returned an invalid surface contract',
    );
    return null;
  }
  if (
    surface === 'public_v1' &&
    !data.results.every(isPublicGlobalPoolSearchResult)
  ) {
    log.error(
      { requestId, requestedSurface: surface },
      'Public pool search returned private or malformed candidate evidence',
    );
    return null;
  }
  if (typeof data.applied_limit === 'number' && data.applied_limit < limit) {
    // No silent caps: the server clamped our request — candidates beyond
    // applied_limit never entered the vector set.
    log.warn(
      { requestId, requested: limit, appliedLimit: data.applied_limit },
      'Global pool vector search truncated by server cap'
    );
  }
  const results =
    surface === 'public_v1'
      ? (data.results as GlobalPoolSearchResult[]).map((row) => ({
          ...row,
          id: normalizeGlobalCandidateId(row.id)!,
        }))
      : (data.results as GlobalPoolSearchResult[]);
  return {
    surface,
    results,
    count: typeof data.count === 'number' ? data.count : data.results.length,
    appliedLimit: data.applied_limit,
  };
}

/**
 * Full typed legacy response. Existing scripts and orchestrator callers use
 * searchGlobalPool below, which retains its historical results-only contract.
 */
export async function searchGlobalPoolResponse(
  requirements: JobRequirements,
  tenantId: string,
  limit: number = HOME_POOL_LIMIT,
  requestId?: string,
): Promise<GlobalPoolSearchResponse | null> {
  return searchGlobalPoolResponseForSurface(
    requirements,
    tenantId,
    limit,
    requestId,
    'legacy_v0',
  );
}

/**
 * Explicit public-v1 vector surface. The separate method prevents a rollout
 * flag from silently changing legacy tenant-private retrieval semantics.
 */
export async function searchPublicGlobalPool(
  requirements: JobRequirements,
  tenantId: string,
  limit: number = HOME_POOL_LIMIT,
  requestId?: string,
): Promise<GlobalPoolSearchResponse | null> {
  return searchGlobalPoolResponseForSurface(
    requirements,
    tenantId,
    limit,
    requestId,
    'public_v1',
  );
}

export async function searchTenantPrivateCandidates(
  requirements: JobRequirements,
  tenantId: string,
  limit: number = HOME_POOL_LIMIT,
  requestId?: string,
): Promise<TenantPrivateSearchResponse | null> {
  const token = await signActiveGraphJWT(tenantId, 'kg:read', requestId);
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${ACTIVEGRAPH_URL}/candidates/search/private`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query_text: buildPoolQueryText(requirements),
          skills_any: requirements.topSkills ?? [],
          limit,
        }),
      },
    );
  } catch (error) {
    log.warn(
      { requestId, err: String(error) },
      'Tenant-private Memory search unreachable',
    );
    return null;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log.warn(
      { requestId, status: response.status, body: body.slice(0, 200) },
      'Tenant-private Memory search unavailable',
    );
    return null;
  }

  const data = (await response.json().catch(() => null)) as {
    surface?: unknown;
    results?: unknown;
    total?: unknown;
    total_available?: unknown;
    truncated?: unknown;
    applied_limit?: unknown;
  } | null;
  if (
    !data ||
    data.surface !== 'tenant_private_v1' ||
    !Array.isArray(data.results) ||
    typeof data.total !== 'number' ||
    typeof data.total_available !== 'number' ||
    typeof data.applied_limit !== 'number'
  ) {
    log.error(
      { requestId },
      'Tenant-private Memory search returned an invalid contract',
    );
    return null;
  }

  const allowedKeys = new Set([
    'candidate_id',
    'global_candidate_id',
    'display_name',
    'linkedin_url',
    'linkedin_id',
    'headline',
    'location_raw',
    'skills',
    'seniority_level',
    'keyword_score',
    'skill_overlap_count',
    'evidence_surface',
  ]);
  const results: TenantPrivateSearchResult[] = [];
  for (const raw of data.results) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some((key) => !allowedKeys.has(key))) {
      log.error(
        { requestId },
        'Tenant-private Memory row contained a non-allowlisted field',
      );
      return null;
    }
    const globalCandidateId =
      row.global_candidate_id == null
        ? null
        : normalizeGlobalCandidateId(row.global_candidate_id);
    if (
      typeof row.candidate_id !== 'string' ||
      !row.candidate_id ||
      (row.global_candidate_id != null && !globalCandidateId) ||
      !isNullableString(row.display_name) ||
      !isNullableString(row.linkedin_url) ||
      !isNullableString(row.linkedin_id) ||
      !isNullableString(row.headline) ||
      !isNullableString(row.location_raw) ||
      !isNullableString(row.seniority_level) ||
      !Array.isArray(row.skills) ||
      !row.skills.every((skill) => typeof skill === 'string') ||
      typeof row.keyword_score !== 'number' ||
      !Number.isFinite(row.keyword_score) ||
      typeof row.skill_overlap_count !== 'number' ||
      !Number.isSafeInteger(row.skill_overlap_count) ||
      row.evidence_surface !== 'tenant_private_v1'
    ) {
      log.error(
        { requestId },
        'Tenant-private Memory row was malformed',
      );
      return null;
    }
    results.push({
      candidateId: row.candidate_id,
      globalCandidateId,
      displayName: row.display_name,
      linkedinUrl: row.linkedin_url,
      linkedinId: row.linkedin_id,
      headline: row.headline,
      locationRaw: row.location_raw,
      skills: Array.from(new Set(row.skills.map((skill) => skill.trim().toLowerCase()).filter(Boolean))),
      seniorityLevel: row.seniority_level,
      keywordScore: row.keyword_score,
      skillOverlapCount: row.skill_overlap_count,
      evidenceSurface: 'tenant_private_v1',
    });
  }
  return {
    surface: 'tenant_private_v1',
    results,
    total: data.total,
    totalAvailable: data.total_available,
    truncated: data.truncated === true,
    appliedLimit: data.applied_limit,
  };
}

export async function searchGlobalPool(
  requirements: JobRequirements,
  tenantId: string,
  limit: number = HOME_POOL_LIMIT,
  requestId?: string,
): Promise<GlobalPoolSearchResult[] | null> {
  const response = await searchGlobalPoolResponse(
    requirements,
    tenantId,
    limit,
    requestId,
  );
  return response?.results ?? null;
}

/**
 * Public Crustdata identities that are fresh and safely retrievable for a
 * coarse market. A null result means Memory was unavailable; an empty ID list
 * means Memory answered and knows no eligible public identities.
 */
export async function getPublicMarketExclusions(
  tenantId: string,
  market: PublicMarket,
  freshDays: number,
  limit: number,
  requestId?: string,
): Promise<PublicMarketExclusionResponse | null> {
  const token = await signActiveGraphJWT(tenantId, 'kg:read', requestId);
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${ACTIVEGRAPH_URL}/public-candidates/exclusions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          coarse_market_key: market.coarseMarketKey,
          fresh_days: freshDays,
          limit,
        }),
      },
    );
  } catch (err) {
    log.warn(
      { requestId, err: String(err) },
      'Public Memory exclusion lookup unreachable',
    );
    return null;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log.warn(
      { requestId, status: response.status, body: body.slice(0, 200) },
      'Public Memory exclusion lookup unavailable',
    );
    return null;
  }

  const data = await response.json().catch(() => null) as {
    surface?: unknown;
    coarse_market_key?: unknown;
    crustdata_person_ids?: unknown;
    total?: unknown;
    total_matched?: unknown;
    classified_matched?: unknown;
    unclassified_matched?: unknown;
    unclassified_returned?: unknown;
    truncated?: unknown;
    applied_limit?: unknown;
  } | null;
  if (
    !data ||
    data.surface !== 'public_v1' ||
    data.coarse_market_key !== market.coarseMarketKey ||
    !Array.isArray(data.crustdata_person_ids) ||
    typeof data.classified_matched !== 'number' ||
    !Number.isSafeInteger(data.classified_matched) ||
    data.classified_matched < 0 ||
    typeof data.unclassified_matched !== 'number' ||
    !Number.isSafeInteger(data.unclassified_matched) ||
    data.unclassified_matched < 0 ||
    typeof data.unclassified_returned !== 'number' ||
    !Number.isSafeInteger(data.unclassified_returned) ||
    data.unclassified_returned < 0
  ) {
    log.error(
      { requestId, coarseMarketKey: market.coarseMarketKey },
      'Public Memory exclusion lookup returned an invalid contract',
    );
    return null;
  }

  const ids = data.crustdata_person_ids.filter(
    (value): value is number => Number.isSafeInteger(value) && value > 0,
  );
  return {
    surface: 'public_v1',
    coarseMarketKey: market.coarseMarketKey,
    crustdataPersonIds: ids,
    total: typeof data.total === 'number' ? data.total : ids.length,
    totalMatched:
      typeof data.total_matched === 'number'
        ? data.total_matched
        : ids.length,
    classifiedMatched: data.classified_matched,
    unclassifiedMatched: data.unclassified_matched,
    unclassifiedReturned: data.unclassified_returned,
    truncated: data.truncated === true,
    appliedLimit:
      typeof data.applied_limit === 'number' ? data.applied_limit : limit,
  };
}

/**
 * Resolve public LinkedIn anchors to canonical Memory IDs without retrieving
 * profile or private tenant evidence.
 */
export async function resolvePublicIdentities(
  tenantId: string,
  linkedinUrls: string[],
  requestId?: string,
): Promise<PublicIdentityLookupResponse | null> {
  const urlChunks = chunkPublicIdentityUrls(linkedinUrls);
  if (urlChunks.length === 0) {
    return { surface: 'public_v1', results: [] };
  }

  const token = await signActiveGraphJWT(tenantId, 'kg:read', requestId);
  const chunkResults = await Promise.all(urlChunks.map(async (urls) => {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${ACTIVEGRAPH_URL}/global-candidates/public-identities`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ linkedin_urls: urls }),
        },
        IDENTITY_LOOKUP_TIMEOUT_MS,
      );
    } catch (err) {
      log.warn(
        { requestId, err: String(err) },
        'Public Memory identity lookup unreachable',
      );
      return null;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.warn(
        { requestId, status: response.status, body: body.slice(0, 200) },
        'Public Memory identity lookup unavailable',
      );
      return null;
    }

    const data = (await response.json().catch(() => null)) as {
      surface?: unknown;
      results?: unknown;
    } | null;
    if (
      !data ||
      data.surface !== 'public_v1' ||
      !Array.isArray(data.results)
    ) {
      log.error(
        { requestId },
        'Public Memory identity lookup returned an invalid contract',
      );
      return null;
    }

    const results: PublicIdentityResult[] = [];
    for (const raw of data.results) {
      if (!raw || typeof raw !== 'object') {
        log.error({ requestId }, 'Public identity row is malformed');
        return null;
      }
      const row = raw as Record<string, unknown>;
      const globalCandidateId = normalizeGlobalCandidateId(
        row.global_candidate_id,
      );
      if (
        typeof row.linkedin_url !== 'string' ||
        typeof row.normalized_linkedin_url !== 'string' ||
        !globalCandidateId
      ) {
        log.error({ requestId }, 'Public identity row is malformed');
        return null;
      }
      results.push({
        linkedinUrl: row.linkedin_url,
        normalizedLinkedinUrl: row.normalized_linkedin_url,
        globalCandidateId,
      });
    }
    return results;
  }));
  if (chunkResults.some((result) => result === null)) return null;
  return {
    surface: 'public_v1',
    results: chunkResults.flatMap((result) => result ?? []),
  };
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
export interface CandidateIngestOptions {
  publicMarket?: PublicMarket | null;
  publicCandidateRoleFamily?: RoleFamily | null;
}

export interface CandidateIngestResult {
  success: boolean;
  signalCandidateId: string;
  memoryCandidateId: string | null;
  globalCandidateId: string | null;
  resolutionStatus: string | null;
  errorCode?: string | null;
}

type IngestableCandidate = CandidateForRanking & {
  linkedinUrl?: string;
  name?: string;
};

export async function ingestCandidateWithResult(
  tenantId: string,
  candidate: IngestableCandidate,
  tags: string[],
  requestId?: string,
  options: CandidateIngestOptions = {},
): Promise<CandidateIngestResult> {
  // Extract standard identifier format from ID (which is the LinkedIn URL)
  let linkedinUrl = candidate.linkedinUrl || candidate.id;
  if (!linkedinUrl.startsWith('http')) {
    linkedinUrl = `https://www.linkedin.com/in/${linkedinUrl}`;
  }

  const sourceMetadata = {
    public_memory_surface: 'public_v1',
    ...(options.publicCandidateRoleFamily
      ? {
          public_candidate_role_family:
            options.publicCandidateRoleFamily,
        }
      : {}),
    ...(options.publicMarket
      ? { public_market: toActiveGraphPublicMarket(options.publicMarket) }
      : {}),
  };
  const payload = {
    signal_candidate_id: candidate.id,
    source_record_type: 'sourced_candidate',
    linkedinUrl,
    display_name:
      typeof candidate.name === 'string'
        ? redactPublicContactText(candidate.name)
        : candidate.name,
    headline:
      typeof candidate.headlineHint === 'string'
        ? redactPublicContactText(candidate.headlineHint)
        : candidate.headlineHint,
    request_id: requestId,
    tags,
    tenant_id: tenantId,
    crustdata: projectPublicCrustdataProfile(candidate.crustdata),
    source_metadata: sourceMetadata,
  };

  const token = await signActiveGraphJWT(tenantId, 'kg:write', requestId);
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${ACTIVEGRAPH_URL}/candidates/resolve/signal/candidate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      },
    );
  } catch (err) {
    log.error(
      { requestId, candidateId: candidate.id, err: String(err) },
      'ActiveGraph candidate ingest unreachable',
    );
    return {
      success: false,
      signalCandidateId: candidate.id,
      memoryCandidateId: null,
      globalCandidateId: null,
      resolutionStatus: null,
      errorCode: 'transport',
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log.error(
      {
        requestId,
        tenantId,
        candidateId: candidate.id,
        status: response.status,
        body: body.slice(0, 300),
      },
      'ActiveGraph candidate ingest failed',
    );
    return {
      success: false,
      signalCandidateId: candidate.id,
      memoryCandidateId: null,
      globalCandidateId: null,
      resolutionStatus: null,
      errorCode: `http_${response.status}`,
    };
  }

  const data = await response.json().catch(() => null) as {
    candidate_id?: unknown;
    global_candidate_id?: unknown;
    resolution_status?: unknown;
  } | null;
  if (!data || typeof data.resolution_status !== 'string') {
    log.error(
      { requestId, candidateId: candidate.id },
      'ActiveGraph candidate ingest returned an invalid contract',
    );
    return {
      success: false,
      signalCandidateId: candidate.id,
      memoryCandidateId: null,
      globalCandidateId: null,
      resolutionStatus: null,
      errorCode: 'invalid_contract',
    };
  }
  const success =
    data.resolution_status === 'created' ||
    data.resolution_status === 'matched';
  const globalCandidateId = normalizeGlobalCandidateId(
    data.global_candidate_id,
  );
  if (success && !globalCandidateId) {
    log.error(
      { requestId, candidateId: candidate.id },
      'ActiveGraph candidate ingest returned an invalid canonical ID',
    );
    return {
      success: false,
      signalCandidateId: candidate.id,
      memoryCandidateId: null,
      globalCandidateId: null,
      resolutionStatus: data.resolution_status,
      errorCode: 'invalid_contract',
    };
  }

  return {
    success,
    signalCandidateId: candidate.id,
    memoryCandidateId:
      typeof data.candidate_id === 'string' ? data.candidate_id : null,
    globalCandidateId,
    resolutionStatus: data.resolution_status,
    errorCode: null,
  };
}

/**
 * Backward-compatible boolean wrapper used by the current async ingest path.
 */
export async function ingestCandidate(
  tenantId: string,
  candidate: IngestableCandidate,
  tags: string[],
  requestId?: string,
  options: CandidateIngestOptions = {},
): Promise<boolean> {
  const result = await ingestCandidateWithResult(
    tenantId,
    candidate,
    tags,
    requestId,
    options,
  );
  return result.success;
}

export async function ingestCandidateBatchWithResults(
  tenantId: string,
  candidates: IngestableCandidate[],
  requestId?: string,
  chunkSize = 10,
  optionsForCandidate?: (
    candidate: IngestableCandidate,
  ) => CandidateIngestOptions,
): Promise<CandidateIngestResult[]> {
  const allResults: CandidateIngestResult[] = [];
  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    const results = await Promise.all(
      chunk.map(async (candidate): Promise<CandidateIngestResult> => {
        try {
          const tags = generateTagsFromCandidate(candidate);
          return await ingestCandidateWithResult(
            tenantId,
            candidate,
            tags,
            requestId,
            optionsForCandidate?.(candidate),
          );
        } catch (err) {
          log.error(
            { requestId, candidateId: candidate.id, err: String(err) },
            'ingest threw',
          );
          return {
            success: false,
            signalCandidateId: candidate.id,
            memoryCandidateId: null,
            globalCandidateId: null,
            resolutionStatus: null,
            errorCode: 'unexpected',
          };
        }
      }),
    );
    allResults.push(...results);
  }
  return allResults;
}

/**
 * Ingest a batch of candidates with bounded concurrency (chunks of 10).
 * Individual failures are logged by ingestCandidateWithResult; returns the
 * historical success-count contract.
 */
export async function ingestCandidateBatch(
  tenantId: string,
  candidates: IngestableCandidate[],
  requestId?: string,
  chunkSize = 10,
  optionsForCandidate?: (
    candidate: IngestableCandidate,
  ) => CandidateIngestOptions,
): Promise<number> {
  const results = await ingestCandidateBatchWithResults(
    tenantId,
    candidates,
    requestId,
    chunkSize,
    optionsForCandidate,
  );
  return results.filter((result) => result.success).length;
}
