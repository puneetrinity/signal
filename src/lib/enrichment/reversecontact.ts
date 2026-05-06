export interface ReverseContactProfileResponse {
  [key: string]: unknown;
}

export interface ReverseContactSignalResult {
  activeSeeker: boolean | null;
  openToWork: boolean | null;
  freshness: string | null;
  raw: ReverseContactProfileResponse | null;
}

function reverseContactProfileUrl(): string {
  return (
    process.env.REVERSECONTACT_PROFILE_URL ||
    'https://api.reversecontact.com/enrichment/profile'
  );
}

function getApiKey(): string {
  const apiKey = process.env.REVERSECONTACT_API_KEY;
  if (!apiKey) {
    throw new Error('REVERSECONTACT_API_KEY is not configured');
  }
  return apiKey;
}

function timeoutMs(): number {
  const raw = process.env.REVERSECONTACT_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
}

function getBoolean(obj: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', 'yes', '1'].includes(normalized)) return true;
      if (['false', 'no', '0'].includes(normalized)) return false;
    }
  }
  return null;
}

function getString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function extractSignals(data: ReverseContactProfileResponse | null): ReverseContactSignalResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { activeSeeker: null, openToWork: null, freshness: null, raw: data };
  }

  const activeSeeker = getBoolean(data, [
    'activeSeeker',
    'active_seeker',
    'isActiveSeeker',
    'is_active_seeker',
  ]);
  const openToWork = getBoolean(data, [
    'openToWork',
    'open_to_work',
    'isOpenToWork',
    'is_open_to_work',
  ]);
  const freshness = getString(data, [
    'freshness',
    'availability',
    'updateDate',
    'updatedAt',
  ]);

  return {
    activeSeeker: activeSeeker ?? openToWork,
    openToWork,
    freshness,
    raw: data,
  };
}

export async function fetchReverseContactSignals(linkedinUrl: string): Promise<ReverseContactSignalResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs());

  try {
    const qs = new URLSearchParams({ linkedInUrl: linkedinUrl }).toString();
    const response = await fetch(`${reverseContactProfileUrl()}?${qs}`, {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        'x-api-key': getApiKey(),
      },
      signal: controller.signal,
    });

    const text = await response.text();
    const parsed = text ? JSON.parse(text) as ReverseContactProfileResponse : null;

    if (!response.ok) {
      throw new Error(
        `ReverseContact request failed: ${response.status} ${
          typeof parsed === 'object' && parsed && 'error' in parsed
            ? JSON.stringify((parsed as Record<string, unknown>).error)
            : text.slice(0, 200)
        }`,
      );
    }

    return extractSignals(parsed);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`ReverseContact request timed out after ${timeoutMs()}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function getReverseContactStatus(): {
  enabled: boolean;
  reason?: string;
} {
  if (!process.env.REVERSECONTACT_API_KEY) {
    return { enabled: false, reason: 'REVERSECONTACT_API_KEY is not configured' };
  }
  return { enabled: true };
}
