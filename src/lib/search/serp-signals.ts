import { deriveCountryCodeFromLocationText as deriveCountryCodeFromLocationService } from '@/lib/taxonomy/location-service';

interface SerperMeta {
  resultDate?: unknown;
  linkedinHost?: unknown;
  linkedinLocale?: unknown;
  localeCountryCode?: unknown;
}

export interface ParsedSerpSignals {
  resultDateRaw: string | null;
  resultDate: Date | null;
  resultDateDays: number | null;
  linkedinHost: string | null;
  linkedinLocale: string | null;
  localeCountryCode: string | null;
}

const LINKEDIN_LOCALE_TO_COUNTRY_CODE: Record<string, string> = {
  ae: 'AE',
  au: 'AU',
  br: 'BR',
  ca: 'CA',
  de: 'DE',
  es: 'ES',
  fr: 'FR',
  id: 'ID',
  ie: 'IE',
  in: 'IN',
  it: 'IT',
  jp: 'JP',
  mx: 'MX',
  nl: 'NL',
  sg: 'SG',
  uk: 'GB',
  us: 'US',
};

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseDate(value: string): Date | null {
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;

  const cleaned = value
    .replace(/^updated\s+/i, '')
    .replace(/^posted\s+/i, '')
    .replace(/^as of\s+/i, '')
    .trim();
  const cleanedDate = new Date(cleaned);
  if (!Number.isNaN(cleanedDate.getTime())) return cleanedDate;

  return null;
}

function parseResultDateDays(value: string | null, now: Date): {
  parsedDate: Date | null;
  days: number | null;
} {
  if (!value) return { parsedDate: null, days: null };
  const parsedDate = parseDate(value);
  if (!parsedDate) return { parsedDate: null, days: null };
  const diffMs = now.getTime() - parsedDate.getTime();
  const days = Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
  return { parsedDate, days };
}

export function localeToCountryCode(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const normalized = locale.trim().toLowerCase();
  return LINKEDIN_LOCALE_TO_COUNTRY_CODE[normalized] ?? null;
}

export function deriveCountryCodeFromLocationText(
  location: string | null | undefined,
): string | null {
  return deriveCountryCodeFromLocationService(location);
}

export function assessLocationCountryConsistency(
  location: string | null | undefined,
  localeCountryCode: string | null | undefined,
): 'match' | 'mismatch' | 'unknown' {
  if (!location || !localeCountryCode) return 'unknown';
  const locationCountryCode = deriveCountryCodeFromLocationText(location);
  if (!locationCountryCode) return 'unknown';
  return locationCountryCode === localeCountryCode ? 'match' : 'mismatch';
}

// ---------------------------------------------------------------------------
// SERP evidence confidence — consolidated score from scattered SERP signals
// ---------------------------------------------------------------------------

export interface SerpEvidence {
  confidence: number;           // 0-1 composite, 0 = no evidence
  hasResultDate: boolean;
  resultDateDays: number | null;
  hasLocale: boolean;
  localeCountryCode: string | null;
}

export function computeSerpEvidence(searchMeta: unknown): SerpEvidence {
  const signals = extractSerpSignals(searchMeta);

  let confidence = 0;

  if (signals.resultDateDays !== null) {
    confidence += 0.4;
    if (signals.resultDateDays <= 30) confidence += 0.3;
    else if (signals.resultDateDays <= 90) confidence += 0.15;
  }

  if (signals.localeCountryCode) {
    confidence += 0.3;
  }

  return {
    confidence: Math.min(1.0, confidence),
    hasResultDate: signals.resultDateDays !== null,
    resultDateDays: signals.resultDateDays,
    hasLocale: !!signals.localeCountryCode,
    localeCountryCode: signals.localeCountryCode,
  };
}

// ---------------------------------------------------------------------------
// Core extraction
// ---------------------------------------------------------------------------

export function extractSerpSignals(
  searchMeta: unknown,
  now: Date = new Date(),
): ParsedSerpSignals {
  const metaObj = safeRecord(searchMeta);
  const serperObj = safeRecord(metaObj?.serper) as SerperMeta | null;

  const resultDateRaw = safeString(serperObj?.resultDate);
  const linkedinHost = safeString(serperObj?.linkedinHost);
  const linkedinLocaleRaw = safeString(serperObj?.linkedinLocale);
  const linkedinLocale = linkedinLocaleRaw ? linkedinLocaleRaw.toLowerCase() : null;
  const explicitLocaleCountryCode = safeString(serperObj?.localeCountryCode);
  const localeCountryCode = explicitLocaleCountryCode ?? localeToCountryCode(linkedinLocale);
  const { parsedDate, days } = parseResultDateDays(resultDateRaw, now);

  return {
    resultDateRaw,
    resultDate: parsedDate,
    resultDateDays: days,
    linkedinHost,
    linkedinLocale,
    localeCountryCode,
  };
}
