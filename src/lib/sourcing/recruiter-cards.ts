type LocationStatus =
  | 'verified'
  | 'partial'
  | 'unverified'
  | 'mismatch'
  | 'unknown';

type MatchStrength = 'strong' | 'good' | 'possible' | 'weak';

export interface RecruiterCardInput {
  id: string;
  name: string | null;
  linkedinUrl: string | null;
  headline: string | null;
  location: string | null;
  company: string | null;
  rank: number;
  fitScore: number | null;
  locationLabel: string | null;
  enrichmentStatus: string | null;
  skillsTopN: string[];
  summaryShort: string | null;
  emailAvailable?: boolean | null;
  activeSeeker?: boolean | null;
  outreachReady?: boolean | null;
  sourceType?: string | null;
}

export function hasEmailAvailability(summaryStructured: unknown): boolean | null {
  if (!summaryStructured || typeof summaryStructured !== 'object' || Array.isArray(summaryStructured)) {
    return null;
  }

  const obj = summaryStructured as Record<string, unknown>;
  const cardSignals = obj.cardSignals;
  if (cardSignals && typeof cardSignals === 'object' && !Array.isArray(cardSignals)) {
    const emailAvailable = (cardSignals as Record<string, unknown>).emailAvailable;
    if (typeof emailAvailable === 'boolean') {
      return emailAvailable;
    }
  }

  const contact = obj.contact;
  if (contact && typeof contact === 'object' && !Array.isArray(contact)) {
    const emails = (contact as Record<string, unknown>).emails;
    if (Array.isArray(emails)) {
      return emails.length > 0;
    }
  }

  if (obj.contactRestricted === true) {
    return true;
  }

  return null;
}

export function hasActiveSeeker(summaryStructured: unknown): boolean | null {
  if (!summaryStructured || typeof summaryStructured !== 'object' || Array.isArray(summaryStructured)) {
    return null;
  }

  const obj = summaryStructured as Record<string, unknown>;
  const cardSignals = obj.cardSignals;
  if (cardSignals && typeof cardSignals === 'object' && !Array.isArray(cardSignals)) {
    const activeSeeker = (cardSignals as Record<string, unknown>).activeSeeker;
    if (typeof activeSeeker === 'boolean') {
      return activeSeeker;
    }
  }

  return null;
}

export function hasOutreachReady(
  summaryStructured: unknown,
  enrichmentStatus: string | null | undefined,
): boolean | null {
  if (summaryStructured && typeof summaryStructured === 'object' && !Array.isArray(summaryStructured)) {
    const cardSignals = (summaryStructured as Record<string, unknown>).cardSignals;
    if (cardSignals && typeof cardSignals === 'object' && !Array.isArray(cardSignals)) {
      const outreachReady = (cardSignals as Record<string, unknown>).outreachReady;
      if (typeof outreachReady === 'boolean') {
        return outreachReady;
      }
    }
  }

  const emailAvailable = hasEmailAvailability(summaryStructured);
  if (emailAvailable === null) return null;
  return emailAvailable && enrichmentStatus === 'completed';
}

export function toMatchStrength(fitScore: number | null | undefined): MatchStrength {
  if (typeof fitScore !== 'number' || !Number.isFinite(fitScore)) return 'weak';
  if (fitScore >= 0.8) return 'strong';
  if (fitScore >= 0.65) return 'good';
  if (fitScore >= 0.5) return 'possible';
  return 'weak';
}

export function toLocationStatus(locationLabel: string | null | undefined): LocationStatus {
  switch (locationLabel) {
    case 'location_verified':
      return 'verified';
    case 'location_partial':
      return 'partial';
    case 'location_unverified':
    case 'location_unverified_promoted':
      return 'unverified';
    case 'location_mismatch':
      return 'mismatch';
    default:
      return 'unknown';
  }
}

function normalizeSkill(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function topSkills(
  snapshotSkills: unknown,
  summaryStructured: unknown,
  limit: number = 6,
): string[] {
  const collected: string[] = [];

  if (Array.isArray(snapshotSkills)) {
    for (const skill of snapshotSkills) {
      const normalized = normalizeSkill(skill);
      if (normalized) collected.push(normalized);
    }
  }

  if (summaryStructured && typeof summaryStructured === 'object' && !Array.isArray(summaryStructured)) {
    const maybeSkills = (summaryStructured as Record<string, unknown>).skills;
    if (Array.isArray(maybeSkills)) {
      for (const skill of maybeSkills) {
        const normalized = normalizeSkill(skill);
        if (normalized) collected.push(normalized);
      }
    }
  }

  return Array.from(new Set(collected)).slice(0, Math.max(1, limit));
}

export function shortenSummary(summary: string | null | undefined, maxLength: number = 220): string | null {
  if (!summary) return null;
  const compact = summary.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

export function toRecruiterCard(input: RecruiterCardInput) {
  return {
    id: input.id,
    name: input.name,
    linkedinUrl: input.linkedinUrl,
    headline: input.headline,
    location: input.location,
    company: input.company,
    rank: input.rank,
    matchStrength: toMatchStrength(input.fitScore),
    locationStatus: toLocationStatus(input.locationLabel),
    enrichmentStatus: input.enrichmentStatus,
    skillsTopN: input.skillsTopN,
    summaryShort: input.summaryShort,
    emailAvailable: input.emailAvailable ?? null,
    activeSeeker: input.activeSeeker ?? null,
    outreachReady: input.outreachReady ?? null,
    sourceType: input.sourceType ?? null,
  };
}
