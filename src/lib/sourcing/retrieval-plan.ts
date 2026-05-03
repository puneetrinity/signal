import type { JobRequirements } from './jd-digest';
import { getSourcingConfig } from './config';
import type { V1RetrievalRequest } from './v1-candidate';

export function buildV1RetrievalRequest(
  tenantId: string,
  requirements: JobRequirements,
): V1RetrievalRequest {
  const config = getSourcingConfig();
  const requiredSkills = requirements.topSkills.slice(0, 12);
  const preferredSkills = requirements.topSkills.slice(12, 20);

  return {
    tenantId,
    primaryRoleFamily: requirements.roleFamily ?? null,
    secondaryRoleFamilies: [],
    requiredSkills,
    preferredSkills,
    functionalTags: [],
    location: requirements.location ?? null,
    seniorityBand: requirements.seniorityLevel ?? null,
    memoryLimit: Math.max(config.targetCount, 100),
    discoveryLimit: Math.max(config.targetCount * 2, 200),
    minMemoryInOutput: Math.max(10, Math.floor(config.targetCount * 0.2)),
    minDiscoveredInOutput: Math.max(config.minDiscoveredInOutput, Math.floor(config.targetCount * 0.3)),
  };
}
