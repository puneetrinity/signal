import { searchLinkedInProfiles } from '@/lib/search/providers';
import { upsertDiscoveredCandidates } from './upsert-candidates';
import type { JobRequirements } from './jd-digest';
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
}

function buildQueries(requirements: JobRequirements, maxQueries: number): string[] {
  const roleFamily = requirements.roleFamily || '';
  const location = requirements.location || '';
  const skills = requirements.topSkills.slice(0, 3);
  const queries: string[] = [];

  // Role-guided queries
  if (roleFamily && skills.length > 0) {
    if (location) {
      queries.push(
        `site:linkedin.com/in "${roleFamily}" "${location}" ${skills.join(' ')}`,
      );
    }
    if (queries.length < maxQueries) {
      queries.push(
        `site:linkedin.com/in "${roleFamily}" ${skills.join(' ')}`,
      );
    }
  }

  // Skill-first fallback when role family is unavailable
  if (!roleFamily && location && skills.length > 0 && queries.length < maxQueries) {
    queries.push(`site:linkedin.com/in "${location}" ${skills.join(' ')}`);
  }
  if (!roleFamily && skills.length > 0 && queries.length < maxQueries) {
    queries.push(`site:linkedin.com/in ${skills.join(' ')}`);
  }

  // Narrow-skills variant (top 2 skills only)
  if (skills.length > 2 && queries.length < maxQueries) {
    const narrowSkills = skills.slice(0, 2);
    if (roleFamily && location) {
      queries.push(
        `site:linkedin.com/in "${roleFamily}" "${location}" ${narrowSkills.join(' ')}`,
      );
    } else if (roleFamily) {
      queries.push(
        `site:linkedin.com/in "${roleFamily}" ${narrowSkills.join(' ')}`,
      );
    }
  }

  // Dedupe identical queries
  const seen = new Set<string>();
  return queries.filter((q) => {
    if (seen.has(q)) return false;
    seen.add(q);
    return true;
  }).slice(0, maxQueries);
}

export async function discoverCandidates(
  tenantId: string,
  requirements: JobRequirements,
  targetCount: number,
  existingLinkedinIds: Set<string>,
  maxQueries: number = 3,
): Promise<DiscoveryRunResult> {
  const queries = buildQueries(requirements, maxQueries);
  const discovered: DiscoveredCandidate[] = [];
  const seenLinkedinIds = new Set(existingLinkedinIds);
  let queriesExecuted = 0;

  for (let qi = 0; qi < queries.length; qi++) {
    if (discovered.length >= targetCount) break;

    const query = queries[qi];
    queriesExecuted++;
    log.info({ query, queryIndex: qi }, 'Running discovery query');

    try {
      const profiles = await searchLinkedInProfiles(query, 20);
      // Filter out already-known candidates
      const newProfiles = profiles.filter((p) => {
        const id = extractLinkedInIdFromUrl(p.linkedinUrl);
        return id && !seenLinkedinIds.has(id);
      });

      if (newProfiles.length === 0) continue;

      const candidateMap = await upsertDiscoveredCandidates(tenantId, newProfiles, query);

      for (const profile of newProfiles) {
        const linkedinId = extractLinkedInIdFromUrl(profile.linkedinUrl);
        if (!linkedinId) continue;
        const candidateId = candidateMap.get(linkedinId);
        if (!candidateId) continue;
        if (seenLinkedinIds.has(linkedinId)) continue;

        seenLinkedinIds.add(linkedinId);
        discovered.push({ candidateId, linkedinId, queryIndex: qi });

        if (discovered.length >= targetCount) break;
      }

      log.info({ queryIndex: qi, newCount: newProfiles.length, totalDiscovered: discovered.length }, 'Discovery query complete');
    } catch (err) {
      log.error({ query, error: err instanceof Error ? err.message : err }, 'Discovery query failed');
    }
  }

  if (discovered.length === 0 && queries.length > 0) {
    log.warn({
      tenantId,
      queriesAttempted: queries.length,
      roleFamily: requirements.roleFamily,
      targetCount,
    }, 'All discovery queries returned zero new candidates — query refinement needed (Phase 4 LLM)');
  }

  return {
    candidates: discovered,
    queriesExecuted,
    queriesBuilt: queries.length,
  };
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
