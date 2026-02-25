/**
 * Non-tech signal extractors — read existing DB data, no new API calls.
 */

import { normalizeSeniorityFromText, type SeniorityBand } from '@/lib/taxonomy/seniority';
import type { NonTechConfig } from '../config';
import { assessLocationCountryConsistency, extractSerpSignals } from '@/lib/search/serp-signals';

interface CandidateData {
  companyHint: string | null;
  headlineHint: string | null;
  locationHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
  searchMeta: unknown;
  lastEnrichedAt: Date | null;
}

interface IdentityRecord {
  platform: string;
  confidence: number;
  hasContradiction: boolean;
  contradictionNote: string | null;
  updatedAt: Date;
}

interface SnapshotData {
  computedAt: Date;
  staleAfter: Date;
}

export function extractCompanyAlignment(
  candidate: CandidateData,
  identities: IdentityRecord[],
): {
  sources: Array<{ source: string; company: string; matchType: 'exact' | 'fuzzy' }>;
  corroborationCount: number;
  freshnessDays: number | null;
} {
  const sources: Array<{ source: string; company: string; matchType: 'exact' | 'fuzzy' }> = [];
  const companyHint = candidate.companyHint?.trim().toLowerCase();
  if (!companyHint) {
    return { sources, corroborationCount: 0, freshnessDays: null };
  }

  // Check headline for company mention
  if (candidate.headlineHint) {
    const headlineLower = candidate.headlineHint.toLowerCase();
    if (headlineLower.includes(companyHint)) {
      sources.push({ source: 'headline', company: candidate.companyHint!, matchType: 'exact' });
    }
  }

  // Check SERP title for company mention
  if (candidate.searchTitle) {
    const titleLower = candidate.searchTitle.toLowerCase();
    if (titleLower.includes(companyHint)) {
      sources.push({ source: 'serp_title', company: candidate.companyHint!, matchType: 'exact' });
    }
  }

  // Check SERP snippet for company mention
  if (candidate.searchSnippet) {
    const snippetLower = candidate.searchSnippet.toLowerCase();
    if (snippetLower.includes(companyHint)) {
      sources.push({ source: 'serp_snippet', company: candidate.companyHint!, matchType: 'exact' });
    }
  }

  // NOTE: Do not count identity rows as corroboration for company alignment.
  // Identity records do not contain explicit company evidence and can inflate
  // corroboration without proving company match.

  // Freshness based on most recent identity update
  let freshnessDays: number | null = null;
  const timestamps = identities.map((i) => i.updatedAt.getTime());
  if (candidate.lastEnrichedAt) timestamps.push(candidate.lastEnrichedAt.getTime());
  if (timestamps.length > 0) {
    const most_recent = Math.max(...timestamps);
    freshnessDays = Math.floor((Date.now() - most_recent) / (24 * 60 * 60 * 1000));
  }

  return {
    sources,
    corroborationCount: sources.length,
    freshnessDays,
  };
}

export function extractSeniorityValidation(
  candidate: CandidateData,
): {
  normalizedBand: SeniorityBand | null;
  confidence: number;
  sources: string[];
} {
  const sources: string[] = [];
  let band: SeniorityBand | null = null;

  // Try headline first (highest confidence)
  if (candidate.headlineHint) {
    const headlineBand = normalizeSeniorityFromText(candidate.headlineHint);
    if (headlineBand) {
      band = headlineBand;
      sources.push('headline');
    }
  }

  // Try SERP title as secondary
  if (candidate.searchTitle) {
    const titleBand = normalizeSeniorityFromText(candidate.searchTitle);
    if (titleBand) {
      if (!band) band = titleBand;
      sources.push('serp_title');
    }
  }

  // Confidence: multiple sources agreeing = higher confidence
  let confidence = 0;
  if (sources.length >= 2) confidence = 1.0;
  else if (sources.length === 1) confidence = 0.8;

  return { normalizedBand: band, confidence, sources };
}

export function extractFreshness(
  candidate: CandidateData,
  snapshot: SnapshotData | null,
  config: NonTechConfig,
): {
  lastValidatedAt: string | null;
  ageDays: number | null;
  stale: boolean;
} {
  const timestamps: number[] = [];
  if (candidate.lastEnrichedAt) timestamps.push(candidate.lastEnrichedAt.getTime());
  const serpSignals = extractSerpSignals(candidate.searchMeta);
  if (serpSignals.resultDate) timestamps.push(serpSignals.resultDate.getTime());
  if (timestamps.length === 0 && snapshot) timestamps.push(snapshot.computedAt.getTime());

  if (timestamps.length === 0) {
    return { lastValidatedAt: null, ageDays: null, stale: true };
  }

  const mostRecent = Math.max(...timestamps);
  const ageDays = Math.floor((Date.now() - mostRecent) / (24 * 60 * 60 * 1000));

  return {
    lastValidatedAt: new Date(mostRecent).toISOString(),
    ageDays,
    stale: ageDays > config.maxSourceAgeDays,
  };
}

export function extractSerpContext(
  candidate: CandidateData,
): {
  resultDate: string | null;
  ageDays: number | null;
  linkedinHost: string | null;
  linkedinLocale: string | null;
  locationConsistency: 'match' | 'mismatch' | 'unknown';
} {
  const signals = extractSerpSignals(candidate.searchMeta);
  return {
    resultDate: signals.resultDateRaw,
    ageDays: signals.resultDateDays,
    linkedinHost: signals.linkedinHost,
    linkedinLocale: signals.linkedinLocale,
    locationConsistency: assessLocationCountryConsistency(
      candidate.locationHint,
      signals.localeCountryCode,
    ),
  };
}

export function extractContradictions(
  identities: IdentityRecord[],
): {
  count: number;
  details: string[];
} {
  const contradicted = identities.filter((i) => i.hasContradiction);
  return {
    count: contradicted.length,
    details: contradicted
      .map((i) => i.contradictionNote)
      .filter((note): note is string => !!note),
  };
}
