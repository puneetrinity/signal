/**
 * People Data Labs (PDL) enrichment client
 */

export interface PdlCandidateInput {
  linkedinUrl?: string | null;
  name?: string | null;
  company?: string | null;
  location?: string | null;
}

export interface PdlContactInfoItem {
  value: string;
  type?: string;
}

export interface PdlContactInfo {
  source: 'pdl';
  emails: PdlContactInfoItem[];
  phones: PdlContactInfoItem[];
  likelihood?: number;
}

export interface PdlEnrichmentResult {
  data: Record<string, unknown>;
  summaryData: Record<string, unknown>;
  contactInfo: PdlContactInfo | null;
  likelihood?: number;
  matchedBy: 'profile' | 'name_company' | 'name_location' | 'name_only';
}

const DEFAULT_PDL_URL = 'https://api.peopledatalabs.com/v5/person/enrich';

function normalizeLinkedInProfile(url: string): string {
  const trimmed = url.trim();
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  return withoutProtocol.replace(/\/$/, '');
}

function splitName(name: string): { firstName?: string; lastName?: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

function buildPdlQuery(input: PdlCandidateInput): { params: Record<string, unknown>; matchedBy: PdlEnrichmentResult['matchedBy'] } {
  if (input.linkedinUrl) {
    return {
      params: {
        profile: [normalizeLinkedInProfile(input.linkedinUrl)],
      },
      matchedBy: 'profile',
    };
  }

  const name = input.name?.trim();
  const company = input.company?.trim();
  const location = input.location?.trim();

  if (name && company) {
    return {
      params: {
        name,
        company,
      },
      matchedBy: 'name_company',
    };
  }

  if (name && location) {
    return {
      params: {
        name,
        location,
      },
      matchedBy: 'name_location',
    };
  }

  if (name) {
    const { firstName, lastName } = splitName(name);
    return {
      params: {
        name,
        ...(firstName ? { first_name: firstName } : {}),
        ...(lastName ? { last_name: lastName } : {}),
      },
      matchedBy: 'name_only',
    };
  }

  throw new Error('PDL enrichment requires linkedinUrl or name hints');
}

function toStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : null))
      .filter((item): item is string => !!item);
  }
  if (typeof value === 'string') return [value];
  return [];
}

function extractEmails(data: Record<string, unknown>): string[] {
  const emails: string[] = [];
  const add = (val: unknown) => {
    if (typeof val === 'string' && val.includes('@')) emails.push(val);
  };

  add(data.email);
  add(data.work_email);

  toStringArray(data.personal_emails).forEach(add);

  if (Array.isArray(data.emails)) {
    for (const item of data.emails) {
      if (typeof item === 'string') {
        add(item);
      } else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        add(record.address);
        add(record.email);
      }
    }
  }

  return Array.from(new Set(emails));
}

function extractPhones(data: Record<string, unknown>): string[] {
  const phones: string[] = [];
  const add = (val: unknown) => {
    if (typeof val === 'string' && val.trim()) phones.push(val);
  };

  add(data.mobile_phone);
  add(data.phone);

  if (Array.isArray(data.phone_numbers)) {
    for (const item of data.phone_numbers) {
      if (typeof item === 'string') {
        add(item);
      } else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        add(record.number);
        add(record.phone);
      }
    }
  }

  return Array.from(new Set(phones));
}

function compactPdlProfile(data: Record<string, unknown>): Record<string, unknown> {
  const pick = <T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null) {
        out[key] = obj[key];
      }
    }
    return out;
  };

  const experience = Array.isArray(data.experience)
    ? data.experience.slice(0, 5)
    : undefined;
  const education = Array.isArray(data.education)
    ? data.education.slice(0, 5)
    : undefined;
  const profiles = Array.isArray(data.profiles)
    ? data.profiles.slice(0, 5)
    : undefined;
  const skills = Array.isArray(data.skills)
    ? data.skills.slice(0, 25)
    : data.skills;

  return {
    ...pick(data, [
      'full_name',
      'first_name',
      'last_name',
      'name',
      'job_title',
      'job_company_name',
      'job_company',
      'job_company_website',
      'job_company_industry',
      'job_company_size',
      'location_name',
      'location',
      'city',
      'region',
      'country',
      'summary',
      'headline',
      'linkedin_url',
      'github_url',
      'twitter_url',
      'website',
    ]),
    skills,
    experience,
    education,
    profiles,
  };
}

export async function enrichWithPdl(
  input: PdlCandidateInput,
  options?: { timeoutMs?: number }
): Promise<PdlEnrichmentResult> {
  const apiKey = process.env.PDL_API_KEY;
  if (!apiKey) {
    throw new Error('PDL_API_KEY is required for PDL enrichment');
  }

  const baseUrl = process.env.PDL_BASE_URL || DEFAULT_PDL_URL;
  const timeoutMs = options?.timeoutMs ?? parseInt(process.env.PDL_TIMEOUT || '12000', 10);

  const { params, matchedBy } = buildPdlQuery(input);

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `PDL API error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const payloadStatus = typeof payload.status === 'number' ? payload.status : null;

  if (payloadStatus && payloadStatus >= 400) {
    throw new Error(`PDL error: ${payload.error || payload.message || payloadStatus}`);
  }

  const data = (payload.data && typeof payload.data === 'object')
    ? (payload.data as Record<string, unknown>)
    : payload;

  const likelihood = typeof payload.likelihood === 'number'
    ? payload.likelihood
    : typeof data.likelihood === 'number'
      ? data.likelihood
      : undefined;

  const emails = extractEmails(data).map((value) => ({ value }));
  const phones = extractPhones(data).map((value) => ({ value }));

  const contactInfo = emails.length > 0 || phones.length > 0
    ? {
        source: 'pdl' as const,
        emails,
        phones,
        likelihood,
      }
    : null;

  return {
    data,
    summaryData: compactPdlProfile(data),
    contactInfo,
    likelihood,
    matchedBy,
  };
}
