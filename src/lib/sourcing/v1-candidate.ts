export type V1CandidateSourceType = 'memory' | 'discovered' | 'fallback';

export type IdentitySignalStatus = 'verified' | 'unverified' | 'rejected';

export interface IdentitySignal {
  type: 'linkedin_url' | 'github_url' | 'email' | 'phone' | 'other';
  value: string;
  status: IdentitySignalStatus;
  source: string;
  confidence?: number | null;
}

export interface V1CandidateMemory {
  timesSurfaced?: number;
  lastSurfacedAt?: string | null;
  lastContactedAt?: string | null;
  lastOutcome?: string | null;
  fatigueUntil?: string | null;
}

export interface V1Candidate {
  id: string;
  sourceType: V1CandidateSourceType;
  linkedinUrl: string;
  linkedinId: string;
  name: string | null;
  headline: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  location: string | null;
  primaryRoleFamily: string | null;
  secondaryRoleFamilies: string[];
  skillsNormalized: string[];
  functionalTags: string[];
  summary: string | null;
  identitySignals: IdentitySignal[];
  memory?: V1CandidateMemory;
  emailAvailable?: boolean;
  activeSeeker?: boolean;
  outreachReady?: boolean;
  providerMeta?: Record<string, unknown>;
}

export interface V1RetrievalRequest {
  tenantId: string;
  primaryRoleFamily: string | null;
  secondaryRoleFamilies: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  functionalTags: string[];
  location: string | null;
  seniorityBand: string | null;
  memoryLimit: number;
  discoveryLimit: number;
  minMemoryInOutput: number;
  minDiscoveredInOutput: number;
}
