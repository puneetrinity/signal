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

function buildQueries(
  requirements: JobRequirements,
  maxQueries: number,
): { strict: string[]; fallback: string[] } {
  const roleFamily = requirements.roleFamily || '';
  const title = requirements.title?.trim() || '';
  const location = requirements.location || '';
  const skills = requirements.topSkills.slice(0, 3);
  const narrowSkills = skills.slice(0, 2);
  const strict: string[] = [];
  const fallback: string[] = [];

  // Strict pass: location-targeted queries
  if (location && skills.length > 0) {
    if (roleFamily) {
      strict.push(`site:linkedin.com/in "${roleFamily}" "${location}" ${skills.join(' ')}`);
    } else {
      strict.push(`site:linkedin.com/in "${location}" ${skills.join(' ')}`);
    }
    if (skills.length > 2) {
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
  if (location && roleFamily && skills.length === 0) {
    strict.push(`site:linkedin.com/in "${roleFamily}" "${location}"`);
  }

  // Fallback pass: without location (broader reach)
  if (roleFamily && skills.length > 0) {
    fallback.push(`site:linkedin.com/in "${roleFamily}" ${skills.join(' ')}`);
  }
  if (title) {
    fallback.push(`site:linkedin.com/in "${title}"`);
    if (skills.length > 0) {
      fallback.push(`site:linkedin.com/in "${title}" ${skills.join(' ')}`);
    }
  }
  if (skills.length > 0) {
    fallback.push(`site:linkedin.com/in ${skills.join(' ')}`);
  }
  if (skills.length > 2 && roleFamily) {
    fallback.push(`site:linkedin.com/in "${roleFamily}" ${narrowSkills.join(' ')}`);
  }
  if (roleFamily && skills.length === 0) {
    fallback.push(`site:linkedin.com/in "${roleFamily}"`);
  }
  if (!roleFamily && !title && location && skills.length === 0) {
    fallback.push(`site:linkedin.com/in "${location}"`);
  }

  const dedup = (qs: string[]) => {
    const seen = new Set<string>();
    return qs.filter((q) => {
      if (seen.has(q)) return false;
      seen.add(q);
      return true;
    });
  };

  const strictDeduped = dedup(strict).slice(0, maxQueries);
  const strictSet = new Set(strictDeduped);
  const fallbackDeduped = dedup(fallback)
    .filter((q) => !strictSet.has(q))
    .slice(0, maxQueries);

  return { strict: strictDeduped, fallback: fallbackDeduped };
}

export async function discoverCandidates(
  tenantId: string,
  requirements: JobRequirements,
  targetCount: number,
  existingLinkedinIds: Set<string>,
  maxQueries: number = 3,
): Promise<DiscoveryRunResult> {
  const { strict, fallback } = buildQueries(requirements, maxQueries);
  const discovered: DiscoveredCandidate[] = [];
  const seenLinkedinIds = new Set(existingLinkedinIds);
  let queriesExecuted = 0;
  let queryIndex = 0;

  const runQuery = async (query: string): Promise<void> => {
    queriesExecuted++;
    const qi = queryIndex++;
    log.info({ query, queryIndex: qi }, 'Running discovery query');

    try {
      const profiles = await searchLinkedInProfiles(query, 20);
      const newProfiles = profiles.filter((p) => {
        const id = extractLinkedInIdFromUrl(p.linkedinUrl);
        return id && !seenLinkedinIds.has(id);
      });

      if (newProfiles.length === 0) return;

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
  };

  // Pass 1: Strict (location-targeted) queries
  for (const query of strict) {
    if (discovered.length >= targetCount || queriesExecuted >= maxQueries) break;
    await runQuery(query);
  }

  // Pass 2: Fallback (non-location) queries if strict under-delivers
  if (discovered.length < targetCount) {
    log.info(
      { strictDiscovered: discovered.length, targetCount, fallbackQueriesAvailable: fallback.length },
      'Strict discovery under-delivered, running fallback queries',
    );
    for (const query of fallback) {
      if (discovered.length >= targetCount || queriesExecuted >= maxQueries) break;
      await runQuery(query);
    }
  }

  if (discovered.length === 0 && (strict.length + fallback.length) > 0) {
    log.warn({
      tenantId,
      queriesAttempted: strict.length + fallback.length,
      roleFamily: requirements.roleFamily,
      targetCount,
    }, 'All discovery queries returned zero new candidates');
  }

  return {
    candidates: discovered,
    queriesExecuted,
    queriesBuilt: strict.length + fallback.length,
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
