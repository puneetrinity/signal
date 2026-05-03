export interface EnrichLayerProfileResponse {
  profile?: Record<string, unknown> | null;
  experiences?: unknown[];
  education?: unknown[];
  certifications?: unknown[];
  skills?: unknown[];
  personal_emails?: string[];
  personal_numbers?: string[];
  [key: string]: unknown;
}

export interface EnrichLayerEmailResponse {
  personal_emails?: string[];
  work_email?: string | null;
  // EnrichLayer v2 personal-email endpoint returns { emails, invalid_emails }
  emails?: string[];
  invalid_emails?: string[];
  [key: string]: unknown;
}

export interface EnrichLayerContactInfoItem {
  value: string;
  type?: string;
}

export interface EnrichLayerContactInfo {
  source: 'enrichlayer';
  emails: EnrichLayerContactInfoItem[];
  phones: EnrichLayerContactInfoItem[];
}

export interface EnrichLayerEnrichmentResult {
  profile: EnrichLayerProfileResponse;
  email: EnrichLayerEmailResponse | null;
  summaryData: Record<string, unknown>;
  contactInfo: EnrichLayerContactInfo | null;
  matchedBy: 'profile';
}

export interface EnrichLayerVerificationInput {
  linkedinUrl: string;
  nameHint?: string | null;
  headlineHint?: string | null;
  companyHint?: string | null;
}

export interface EnrichLayerVerificationResult {
  accepted: boolean;
  score: number;
  reasons: string[];
  extracted: {
    linkedinUrl: string | null;
    githubUrl: string | null;
    name: string | null;
    headline: string | null;
    company: string | null;
  };
}

const ENRICHLAYER_TIMEOUT_MS = 30_000;

// Read URLs at call time so tests can stand up a mock server and override the env var
// without needing dynamic import gymnastics.
function profileUrl(): string {
  return process.env.ENRICHLAYER_PROFILE_URL || 'https://enrichlayer.com/api/v2/profile';
}
function personalEmailUrl(): string {
  return (
    process.env.ENRICHLAYER_PERSONAL_EMAIL_URL ||
    'https://enrichlayer.com/api/v2/contact-api/personal-email'
  );
}

function getApiKey(): string {
  const apiKey = process.env.ENRICHLAYER_API_KEY;
  if (!apiKey) {
    throw new Error('ENRICHLAYER_API_KEY is not configured');
  }
  return apiKey;
}

/**
 * Errors that the queue worker should classify as terminal (no BullMQ retry).
 * Examples: 4xx from EnrichLayer (404 = no profile, 401/403 = auth), missing
 * candidate URL, verification rejection.
 */
export class EnrichLayerUnrecoverableError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'EnrichLayerUnrecoverableError';
    this.status = status;
  }
}

async function getJson<T>(url: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ENRICHLAYER_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${url}?${qs}`, {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${getApiKey()}`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError on timeout, network errors — both retryable.
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    throw new Error(
      isAbort
        ? `EnrichLayer request timed out after ${ENRICHLAYER_TIMEOUT_MS}ms`
        : `EnrichLayer network error: ${message}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const snippet = body.slice(0, 200);
    // 4xx (except 429) is a permanent client/auth error — don't retry.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new EnrichLayerUnrecoverableError(
        `EnrichLayer request failed: ${res.status} ${snippet}`,
        res.status,
      );
    }
    // 429 / 5xx — let BullMQ retry the same provider after its 5s backoff.
    throw new Error(`EnrichLayer request failed: ${res.status} ${snippet}`);
  }

  return (await res.json()) as T;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
}

function normalize(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s/:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLinkedInUrl(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function calculateNameSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const l = normalize(left);
  const r = normalize(right);
  if (!l || !r) return 0;
  if (l === r) return 1;

  const leftTokens = l.split(/\s+/).filter((token) => token.length > 1);
  const rightTokens = r.split(/\s+/).filter((token) => token.length > 1);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const intersection = leftTokens.filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  let score = intersection / union;
  if (leftTokens[0] === rightTokens[0]) score += 0.1;
  if (leftTokens[leftTokens.length - 1] === rightTokens[rightTokens.length - 1]) score += 0.1;
  return Math.min(1, score);
}

function calculateCompanyMatch(left: string | null | undefined, right: string | null | undefined): number {
  const l = normalize(left);
  const r = normalize(right);
  if (!l || !r) return 0;
  if (l.includes(r) || r.includes(l)) return 1;

  const leftTokens = new Set(l.split(/\s+/).filter((token) => token.length > 2));
  const rightTokens = r.split(/\s+/).filter((token) => token.length > 2);
  for (const token of rightTokens) {
    if (leftTokens.has(token)) return 0.8;
  }
  return 0;
}

function extractProfileFields(payload: EnrichLayerProfileResponse): EnrichLayerVerificationResult['extracted'] {
  // EnrichLayer v2 response has fields at top level (full_name, headline, etc.)
  // Older shapes nested them under `profile`. Support both.
  const profile = getObject(payload.profile) ?? (payload as Record<string, unknown>);
  const currentExperience = Array.isArray(payload.experiences) ? getObject(payload.experiences[0]) : null;
  const publicId = getFirstString(profile.public_identifier, payload.public_identifier);
  const reconstructedLinkedIn = publicId ? `https://www.linkedin.com/in/${publicId}` : null;

  return {
    linkedinUrl: getFirstString(
      profile.linkedin_url,
      profile.profile_url,
      profile.url,
      profile.public_profile_url,
      reconstructedLinkedIn,
    ),
    githubUrl: getFirstString(
      profile.github_url,
      profile.github,
      profile.github_profile,
      profile.githubProfile,
      profile.github_profile_url,
    ),
    name: getFirstString(
      profile.full_name,
      profile.name,
      profile.display_name,
      profile.candidate_name,
    ),
    headline: getFirstString(
      profile.headline,
      profile.title,
      profile.current_title,
      profile.current_position_title,
      profile.occupation,
    ),
    company: getFirstString(
      profile.company,
      profile.current_company,
      profile.company_name,
      currentExperience?.company_name,
      currentExperience?.company,
      currentExperience?.name,
    ),
  };
}

function compactProfile(payload: EnrichLayerProfileResponse): Record<string, unknown> {
  const profile = payload.profile && typeof payload.profile === 'object'
    ? payload.profile
    : {};

  return {
    profile,
    experiences: Array.isArray(payload.experiences) ? payload.experiences.slice(0, 8) : [],
    education: Array.isArray(payload.education) ? payload.education.slice(0, 5) : [],
    certifications: Array.isArray(payload.certifications) ? payload.certifications.slice(0, 10) : [],
    skills: Array.isArray(payload.skills) ? payload.skills.slice(0, 30) : [],
  };
}

export async function fetchEnrichLayerProfile(linkedinUrl: string): Promise<EnrichLayerProfileResponse> {
  return getJson<EnrichLayerProfileResponse>(profileUrl(), {
    profile_url: linkedinUrl,
  });
}

export async function fetchEnrichLayerPersonalEmail(linkedinUrl: string): Promise<EnrichLayerEmailResponse> {
  return getJson<EnrichLayerEmailResponse>(personalEmailUrl(), {
    profile_url: linkedinUrl,
    email_validation: 'fast',
  });
}

export async function enrichWithEnrichLayer(linkedinUrl: string): Promise<EnrichLayerEnrichmentResult> {
  const [profile, email] = await Promise.all([
    fetchEnrichLayerProfile(linkedinUrl),
    fetchEnrichLayerPersonalEmail(linkedinUrl).catch(() => null),
  ]);

  const emails = uniqueStrings([
    ...(profile.personal_emails ?? []),
    ...(email?.personal_emails ?? []),
    ...(email?.emails ?? []),
    email?.work_email ?? null,
  ]).map((value) => ({ value }));

  const phones = uniqueStrings(profile.personal_numbers ?? []).map((value) => ({ value }));

  return {
    profile,
    email,
    summaryData: compactProfile(profile),
    contactInfo: emails.length > 0 || phones.length > 0
      ? {
          source: 'enrichlayer',
          emails,
          phones,
        }
      : null,
    matchedBy: 'profile',
  };
}

export function verifyEnrichLayerMatch(
  input: EnrichLayerVerificationInput,
  payload: EnrichLayerProfileResponse
): EnrichLayerVerificationResult {
  const extracted = extractProfileFields(payload);
  const reasons: string[] = [];
  let score = 0;

  const expectedLinkedin = normalizeLinkedInUrl(input.linkedinUrl);
  const returnedLinkedin = normalizeLinkedInUrl(extracted.linkedinUrl);

  if (returnedLinkedin) {
    if (returnedLinkedin === expectedLinkedin) {
      score += 0.55;
    } else {
      reasons.push('linkedin_url_mismatch');
      return { accepted: false, score: 0, reasons, extracted };
    }
  } else {
    score += 0.35;
    reasons.push('linkedin_url_missing_in_response');
  }

  if (input.nameHint && extracted.name) {
    const nameScore = calculateNameSimilarity(input.nameHint, extracted.name);
    if (nameScore < 0.45) {
      reasons.push('name_mismatch');
      return { accepted: false, score, reasons, extracted };
    }
    score += nameScore >= 0.8 ? 0.25 : 0.15;
  }

  if (input.companyHint && extracted.company) {
    const companyScore = calculateCompanyMatch(input.companyHint, extracted.company);
    if (companyScore === 0) {
      // Soft signal: companyHint may be parsed from headline (e.g. "Ex-IBM" picks up old company).
      // Don't hard-reject — just record the mismatch so the score reflects it.
      reasons.push('company_mismatch_soft');
    } else {
      score += companyScore >= 1 ? 0.15 : 0.08;
    }
  }

  if (input.headlineHint && extracted.headline) {
    const expectedHeadline = normalize(input.headlineHint);
    const returnedHeadline = normalize(extracted.headline);
    if (expectedHeadline && returnedHeadline) {
      const overlaps =
        expectedHeadline.includes(returnedHeadline) ||
        returnedHeadline.includes(expectedHeadline);
      if (overlaps) score += 0.05;
    }
  }

  return {
    accepted: score >= 0.55,
    score,
    reasons,
    extracted,
  };
}
