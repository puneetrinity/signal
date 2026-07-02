import { SignJWT, importPKCS8 } from 'jose';
import { JobRequirements } from './jd-digest';
import type { CandidateForRanking } from './ranking-new';
import type { CrustdataProfileResponse } from './crustdata-client';

const ACTIVEGRAPH_URL = process.env.ACTIVEGRAPH_URL || process.env.ACTIVEKG_BASE_URL || 'http://localhost:8000';

let cachedKey: CryptoKey | null = null;

async function getPrivateKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  const pem = process.env.SIGNAL_JWT_PRIVATE_KEY;
  if (!pem) throw new Error('SIGNAL_JWT_PRIVATE_KEY not configured');

  cachedKey = await importPKCS8(pem, 'RS256');
  return cachedKey;
}

async function signActiveGraphJwt(tenantId: string): Promise<string> {
  const privateKey = await getPrivateKey();

  return new SignJWT({
    tenant_id: tenantId,
    scopes: 'kg:write kg:read',
    actor_type: 'service',
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer('signal')
    .setAudience('activekg')
    .setSubject('signal-service')
    .setExpirationTime('5m')
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

async function authHeaders(tenantId: string): Promise<Record<string, string>> {
  const token = await signActiveGraphJwt(tenantId);
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
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
export async function searchHomePool(
  tags: string[],
  tenantId: string,
  limit = 100
): Promise<ActiveGraphSearchResult[]> {
  if (!tags.length) return [];

  const response = await fetch(`${ACTIVEGRAPH_URL}/candidates/search/by-tags`, {
    method: 'POST',
    headers: await authHeaders(tenantId),
    body: JSON.stringify({
      tags,
      tenant_id: tenantId,
      limit,
    }),
  });

  if (!response.ok) {
    console.error(`[activegraph-client] search failed: ${response.status} ${response.statusText}`);
    return [];
  }

  const data = await response.json();
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

  const response = await fetch(`${ACTIVEGRAPH_URL}/candidates/resolve/signal/candidate`, {
    method: 'POST',
    headers: await authHeaders(tenantId),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error(`[activegraph-client] ingest failed for ${candidate.id}: ${response.status} ${response.statusText}`);
    return false;
  }

  return true;
}
