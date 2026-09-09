import { createHash } from 'node:crypto';
import type { CandidateForRanking } from './ranking-new';
import type { RoleFamily } from '@/lib/taxonomy/role-service';
import type { PublicMarket } from './public-memory';
import { toActiveGraphPublicMarket } from './public-memory';
import { projectPublicCrustdataProfile, redactPublicContactText } from './public-profile-redaction';
import { resolveLocationDeterministic } from '@/lib/taxonomy/location-service';

const PROVIDER_NAMESPACE = 'crustdata' as const;
const RECORD_TYPE = 'person' as const;
const ADAPTER_VERSION = 'crustdata_person_v1' as const;
const PROVIDER_ID = /^[1-9][0-9]{0,18}$/;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const EMAIL = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
const PHONE = /(?:\+\d[\d().\s-]{5,}\d|\b\d{9,15}\b)/;

export type AcquisitionSlot = 'exact' | 'spill';

export interface SourcedCandidateAdapterOptions {
  acquisitionReceiptId: string;
  acquisitionGeneration: number;
  acquisitionSlot: AcquisitionSlot;
  acquiredAt: Date;
  profileObservedAt: Date;
  expectedGlobalCandidateId?: string | null;
  publicMarket?: PublicMarket | null;
  publicCandidateRoleFamily?: RoleFamily | null;
}

export interface NeutralEmploymentEntry {
  company_name?: string;
  title?: string;
  seniority_level?: string;
  function_category?: string;
  start_date?: string;
  end_date?: string;
  description?: string;
  years_at_company?: number;
  company_headquarters_country?: string;
  company_industries?: string[];
  company_network_industry?: string;
  company_type?: string;
  company_headcount_range?: string;
}

export interface NeutralProfessionalProfile {
  display_name?: string;
  given_name?: string;
  family_name?: string;
  headline?: string;
  current_title?: string;
  public_picture_url?: string;
  professional_summary?: string;
  languages: string[];
  location?: {
    city?: string;
    state?: string;
    country?: string;
    country_code?: string;
    continent?: string;
    full_location?: string;
  };
  role_family?: string;
  seniority_band?: string;
  years_of_experience?: number;
  recently_changed_jobs?: boolean;
  skills: string[];
  current_employment: NeutralEmploymentEntry[];
  past_employment: NeutralEmploymentEntry[];
  education: Array<{
    school?: string;
    degree?: string;
    field_of_study?: string;
    start_year?: number;
    end_year?: number;
  }>;
  certifications: Array<{
    name: string;
    issuing_organization?: string;
    issue_date?: string;
    expiration_date?: string;
  }>;
  honors: Array<{
    title: string;
    issuer?: string;
    description?: string;
  }>;
  public_profiles: Array<{
    platform: 'linkedin' | 'github' | 'twitter';
    profile_url: string;
  }>;
}

export interface ApprovedProviderCandidateIngestRequest {
  schema_version: 1;
  provider_namespace: typeof PROVIDER_NAMESPACE;
  record_type: typeof RECORD_TYPE;
  adapter_version: typeof ADAPTER_VERSION;
  provider_record_id: string;
  linkedin_url: string;
  expected_global_candidate_id?: string;
  acquisition_receipt_id: string;
  acquisition_generation: number;
  acquisition_slot: AcquisitionSlot;
  acquired_at: string;
  provider_observed_at: string;
  idempotency_key: string;
  normalized_profile: NeutralProfessionalProfile;
  public_market?: ReturnType<typeof toActiveGraphPublicMarket>;
}

type IngestableCandidate = CandidateForRanking & {
  linkedinUrl?: string;
  name?: string;
};

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const redacted = redactPublicContactText(value).trim();
  if (!redacted) return undefined;
  if (redacted.length > max) throw new Error('sourced_candidate_profile_field_too_large');
  if (EMAIL.test(redacted) || PHONE.test(redacted)) {
    throw new Error('sourced_candidate_private_value_refused');
  }
  return redacted;
}

function boundedStrings(value: unknown, maxItems: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error('sourced_candidate_profile_list_invalid');
  }
  const values = value
    .map((item) => boundedString(item, 200))
    .filter((item): item is string => Boolean(item));
  return Array.from(new Set(values));
}

export function normalizeSourcedCandidateLinkedInUrl(value: string): string {
  const input = value.trim();
  const withScheme = input.includes('://') ? input : `https://${input}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('sourced_candidate_linkedin_invalid');
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    host !== 'linkedin.com' ||
    !['in', 'pub'].includes(parts[0] ?? '') ||
    !parts[1]
  ) {
    throw new Error('sourced_candidate_linkedin_invalid');
  }
  const handle = parts[1].toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(handle)) {
    throw new Error('sourced_candidate_linkedin_invalid');
  }
  return `https://linkedin.com/in/${handle}`;
}

function exactIso(value: Date, code: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(code);
  }
  return value.toISOString();
}

function httpsUrl(value: unknown): string | undefined {
  const text = boundedString(value, 2048);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function employmentRows(value: unknown, maxItems: number): NeutralEmploymentEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error('sourced_candidate_employment_invalid');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('sourced_candidate_employment_invalid');
    }
    const row = entry as Record<string, unknown>;
    return compact({
      company_name: boundedString(row.company_name, 300),
      title: boundedString(row.title, 300),
      seniority_level: boundedString(row.seniority_level, 100),
      function_category: boundedString(row.function_category, 100),
      start_date: boundedString(row.start_date, 32),
      end_date: boundedString(row.end_date, 32),
      description: boundedString(row.description, 4000),
      years_at_company:
        typeof row.years_at_company_raw === 'number' &&
        Number.isFinite(row.years_at_company_raw) &&
        row.years_at_company_raw >= 0 &&
        row.years_at_company_raw <= 100
          ? row.years_at_company_raw
          : undefined,
      company_headquarters_country: boundedString(row.company_headquarters_country, 160),
      company_industries: boundedStrings(row.company_industries, 32),
      company_network_industry: boundedString(row.company_professional_network_industry, 200),
      company_type: boundedString(row.company_type, 100),
      company_headcount_range: boundedString(row.company_headcount_range, 100),
    });
  });
}

function publicProfileReference(
  platform: 'linkedin' | 'github' | 'twitter',
  value: unknown,
): { platform: 'linkedin' | 'github' | 'twitter'; profile_url: string } | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url = value.trim();
  if (platform === 'twitter' && !url.includes('/')) {
    url = `https://twitter.com/${url.replace(/^@/, '')}`;
  }
  if (platform === 'linkedin') {
    try {
      return {
        platform,
        profile_url: normalizeSourcedCandidateLinkedInUrl(url),
      };
    } catch {
      return null;
    }
  }
  const normalized = httpsUrl(url);
  if (!normalized) return null;
  const host = new URL(normalized).hostname.toLowerCase().replace(/^www\./, '');
  if (
    (platform === 'github' && host !== 'github.com') ||
    (platform === 'twitter' && !['twitter.com', 'x.com'].includes(host))
  ) {
    return null;
  }
  return { platform, profile_url: normalized };
}

function buildProfile(
  candidate: IngestableCandidate,
  linkedinUrl: string,
  options: SourcedCandidateAdapterOptions,
): NeutralProfessionalProfile {
  const profile = projectPublicCrustdataProfile(candidate.crustdata);
  if (!profile) throw new Error('sourced_candidate_profile_missing');
  const basic = profile.basic_profile ?? {};
  const employment = profile.experience?.employment_details ?? {};
  const rawLocation = basic.location;
  const locationText =
    rawLocation?.full_location ??
    rawLocation?.raw ??
    [rawLocation?.city, rawLocation?.state, rawLocation?.country].filter(Boolean).join(', ');
  const resolvedLocation = resolveLocationDeterministic(locationText || null);
  const location = compact({
    city: boundedString(rawLocation?.city ?? resolvedLocation.city, 160),
    state: boundedString(rawLocation?.state, 160),
    country: boundedString(rawLocation?.country, 160),
    country_code:
      resolvedLocation.countryCode && /^[A-Z]{2}$/.test(resolvedLocation.countryCode)
        ? resolvedLocation.countryCode
        : undefined,
    continent: boundedString(rawLocation?.continent, 80),
    full_location: boundedString(locationText, 500),
  });
  const current = employmentRows(employment.current, 8);
  const past = employmentRows(employment.past, 64);
  const linkedinReference = {
    platform: 'linkedin' as const,
    profile_url: linkedinUrl,
  };
  const social = profile.social_handles;
  const otherProfiles = [
    publicProfileReference('github', social?.dev_platform_identifier?.profile_url),
    publicProfileReference('twitter', social?.twitter_identifier?.slug),
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const education = (profile.education?.schools ?? []).map((entry) =>
    compact({
      school: boundedString(entry.school, 300),
      degree: boundedString(entry.degree, 200),
      field_of_study: boundedString(entry.field_of_study, 200),
      start_year: validYear(entry.start_year),
      end_year: validYear(entry.end_year),
    }),
  );
  if (education.length > 32) throw new Error('sourced_candidate_education_invalid');
  const certifications = (profile.certifications ?? []).map((entry) => {
    const name = boundedString(entry.name, 300);
    if (!name) throw new Error('sourced_candidate_certification_invalid');
    return compact({
      name,
      issuing_organization: boundedString(entry.issuing_organization, 300),
      issue_date: boundedString(entry.issue_date, 32),
      expiration_date: boundedString(entry.expiration_date, 32),
    });
  });
  if (certifications.length > 64) throw new Error('sourced_candidate_certification_invalid');
  const honors = (profile.honors ?? []).map((entry) => {
    const title = boundedString(entry.title, 300);
    if (!title) throw new Error('sourced_candidate_honor_invalid');
    return compact({
      title,
      issuer: boundedString(entry.issuer, 300),
      description: boundedString(entry.description, 2000),
    });
  });
  if (honors.length > 64) throw new Error('sourced_candidate_honor_invalid');
  const picture = httpsUrl(
    basic.profile_picture_permalink ?? profile.professional_network?.profile_picture_permalink,
  );
  const seniority = boundedString(
    current[0]?.seniority_level ?? candidate.snapshot?.seniorityBand,
    100,
  );
  return compact({
    display_name: boundedString(basic.name, 300),
    given_name: boundedString(basic.first_name, 160),
    family_name: boundedString(basic.last_name, 160),
    headline: boundedString(basic.headline, 500),
    current_title: boundedString(basic.current_title, 300),
    public_picture_url: picture,
    professional_summary: boundedString(basic.summary, 8000),
    languages: boundedStrings(basic.languages, 32),
    location: Object.keys(location).length ? location : undefined,
    role_family: options.publicCandidateRoleFamily ?? undefined,
    seniority_band: seniority,
    years_of_experience:
      typeof profile.years_of_experience_raw === 'number' &&
      Number.isFinite(profile.years_of_experience_raw) &&
      profile.years_of_experience_raw >= 0 &&
      profile.years_of_experience_raw <= 100
        ? profile.years_of_experience_raw
        : undefined,
    recently_changed_jobs:
      typeof profile.recently_changed_jobs === 'boolean'
        ? profile.recently_changed_jobs
        : undefined,
    skills: boundedStrings(profile.skills?.professional_network_skills, 256),
    current_employment: current,
    past_employment: past,
    education,
    certifications,
    honors,
    public_profiles: [linkedinReference, ...otherProfiles],
  }) as NeutralProfessionalProfile;
}

function validYear(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1900 && value <= 2200
    ? value
    : undefined;
}

export function computeSourcedCandidateIdempotencyKey(input: {
  providerRecordId: string;
  acquisitionReceiptId: string;
  acquisitionGeneration: number;
  acquisitionSlot: AcquisitionSlot;
}): string {
  return createHash('sha256')
    .update(
      [
        'v1',
        PROVIDER_NAMESPACE,
        RECORD_TYPE,
        input.providerRecordId,
        input.acquisitionReceiptId,
        String(input.acquisitionGeneration),
        input.acquisitionSlot,
      ].join('\0'),
      'utf8',
    )
    .digest('hex');
}

export function adaptCrustdataCandidateForMemory(
  candidate: IngestableCandidate,
  options: SourcedCandidateAdapterOptions,
): ApprovedProviderCandidateIngestRequest {
  const profile = projectPublicCrustdataProfile(candidate.crustdata);
  const rawProviderId = profile?.crustdata_person_id;
  const providerRecordId =
    typeof rawProviderId === 'number' && Number.isSafeInteger(rawProviderId)
      ? String(rawProviderId)
      : '';
  if (!PROVIDER_ID.test(providerRecordId)) {
    throw new Error('sourced_candidate_provider_id_invalid');
  }
  if (!RECEIPT_ID.test(options.acquisitionReceiptId)) {
    throw new Error('sourced_candidate_receipt_invalid');
  }
  if (
    !Number.isSafeInteger(options.acquisitionGeneration) ||
    options.acquisitionGeneration <= 0 ||
    options.acquisitionGeneration > 2_147_483_647
  ) {
    throw new Error('sourced_candidate_generation_invalid');
  }
  const linkedinUrl = normalizeSourcedCandidateLinkedInUrl(candidate.linkedinUrl ?? candidate.id);
  const acquiredAt = exactIso(options.acquiredAt, 'sourced_candidate_acquired_at_invalid');
  const observedAt = exactIso(options.profileObservedAt, 'sourced_candidate_observed_at_invalid');
  const idempotencyKey = computeSourcedCandidateIdempotencyKey({
    providerRecordId,
    acquisitionReceiptId: options.acquisitionReceiptId,
    acquisitionGeneration: options.acquisitionGeneration,
    acquisitionSlot: options.acquisitionSlot,
  });
  return {
    schema_version: 1,
    provider_namespace: PROVIDER_NAMESPACE,
    record_type: RECORD_TYPE,
    adapter_version: ADAPTER_VERSION,
    provider_record_id: providerRecordId,
    linkedin_url: linkedinUrl,
    ...(options.expectedGlobalCandidateId
      ? { expected_global_candidate_id: options.expectedGlobalCandidateId }
      : {}),
    acquisition_receipt_id: options.acquisitionReceiptId,
    acquisition_generation: options.acquisitionGeneration,
    acquisition_slot: options.acquisitionSlot,
    acquired_at: acquiredAt,
    provider_observed_at: observedAt,
    idempotency_key: idempotencyKey,
    normalized_profile: buildProfile(candidate, linkedinUrl, options),
    ...(options.publicMarket
      ? { public_market: toActiveGraphPublicMarket(options.publicMarket) }
      : {}),
  };
}
