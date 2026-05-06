import type { JobRequirements } from './jd-digest';
import { getSourcingConfig } from './config';
import type { V1RetrievalRequest } from './v1-candidate';
import { resolveLocationDeterministic } from '@/lib/taxonomy/location-service';

function splitSkills(skills: string[]): { requiredSkills: string[]; preferredSkills: string[] } {
  const normalized = Array.from(
    new Set(
      skills
        .map((skill) => skill.trim())
        .filter(Boolean),
    ),
  );
  return {
    requiredSkills: normalized.slice(0, 8),
    preferredSkills: normalized.slice(8, 16),
  };
}

export function buildV1RetrievalRequest(
  tenantId: string,
  requirements: JobRequirements,
): V1RetrievalRequest {
  const config = getSourcingConfig();
  const { requiredSkills, preferredSkills } = splitSkills(requirements.topSkills);
  const resolvedLocation = requirements.location
    ? resolveLocationDeterministic(requirements.location)
    : null;
  const normalizedLocation = resolvedLocation
    ? [resolvedLocation.city, resolvedLocation.state, resolvedLocation.country]
        .filter(Boolean)
        .join(', ') || requirements.location
    : requirements.location ?? null;
  const title = requirements.title?.trim() ?? '';
  const seniorityBand = requirements.seniorityLevel ?? null;
  const isNicheRole = requiredSkills.length >= 6 || title.split(/\s+/).length >= 4;
  const discoveryLimit = Math.max(
    config.targetCount * (isNicheRole ? 3 : 2),
    200,
  );

  return {
    tenantId,
    primaryRoleFamily: requirements.roleFamily ?? null,
    secondaryRoleFamilies: [],
    requiredSkills,
    preferredSkills,
    functionalTags: [],
    location: normalizedLocation,
    seniorityBand,
    memoryLimit: Math.max(config.targetCount, 100),
    discoveryLimit,
    minMemoryInOutput: Math.max(10, Math.floor(config.targetCount * 0.2)),
    minDiscoveredInOutput: Math.max(config.minDiscoveredInOutput, Math.floor(config.targetCount * 0.3)),
  };
}
