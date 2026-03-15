/**
 * SERP Currentness Detection
 *
 * Determines whether SERP-extracted title and location evidence is
 * current vs historical using narrow deterministic rules.
 *
 * Used by:
 *   - scripts/eval-serp-currentness.ts (evaluator)
 *   - scripts/audit-serp-currentness-prod.ts (prod audit)
 *
 * Not yet wired into production hint extraction. Measure first.
 */

import {
  extractCompanyFromHeadline,
  extractHeadlineFromTitle,
  extractLocationFromSerpResult,
} from '../enrichment/hint-extraction';

export type Currentness = 'current' | 'historical' | 'unknown';

// ---------------------------------------------------------------------------
// Temporal marker detection — narrow deterministic rules
// ---------------------------------------------------------------------------

const CURRENT_PATTERNS = [
  // Date range ending in Present (English + common translations)
  /\b\d{4}\s*[-–]\s*(?:present|atual|presente|actuellement|gegenwärtig)\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}\s*[-–]\s*(?:present|atual|presente)\b/i,
  // CJK date formats: 2020年4月 - 現在 (\b doesn't work with CJK characters)
  /\d{4}年\d{1,2}月?\s*[-–]\s*現在/,
  /\d{4}\s*[-–]\s*現在/,
  // Open-ended date range: "2022-" or "2022 -" (no end date)
  /\b(20\d{2})\s*[-–]\s*(?:\.|,|$|\s+(?:working|building|leading|focused))/i,
  // Explicit current markers
  /\b(?:currently|current(?:ly)?)\b/i,
  /\bnow\s+(?:at|based\s+in|in|leading|working|building)\b/i,
  /\b(?:joined|joining)\s+(?:in\s+)?\d{4}\b/i,
  /\b(?:i'?ve\s+been\s+(?:at|here|with))\b/i,
  /\bpresent\s+at\s+the\s+company\b/i,
  /\bpromoted\s+(?:from|to|in)\b/i,
];

const HISTORICAL_PATTERNS = [
  // Explicit historical markers
  /\b(?:formerly|former)\b/i,
  /\b(?:previously|previous)\b/i,
  /\bex[-–](?!\w*\s*(?:pert|peri|ecut|pand|plor|press|tract|tend|change))/i,
  /\bleft\s+(?:in\s+)?\d{4}\b/i,
  /\b(?:departed|resigned|transitioned\s+to|moved\s+to\s+\w+\s+(?:role|position))\b/i,
  // Date range with end date (not Present)
  /\b\d{4}\s*[-–]\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}\s*[-–]\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}\b/i,
  /\b(20\d{2})\s*[-–]\s*(20\d{2})\b/,
  // Location-specific relocation (direction-aware logic in detectLocationCurrentness)
  /\bpreviously\s+in\b/i,
  /\bformerly\s+in\b/i,
];

// Patterns that look like temporal markers but aren't
const FALSE_TEMPORAL_PATTERNS = [
  /\bpresent(?:er|ation|ing|ed)\b/i,  // presenter, presentation
  /\bformer'?s\b/i,                     // possessive or company name
];

function hasFalseTemporalMatch(text: string): boolean {
  return FALSE_TEMPORAL_PATTERNS.some(p => p.test(text));
}

function hasCurrentMarker(text: string): boolean {
  if (!text) return false;
  return CURRENT_PATTERNS.some(p => p.test(text));
}

function hasHistoricalMarker(text: string): boolean {
  if (!text) return false;
  return HISTORICAL_PATTERNS.some(p => p.test(text));
}

function normalizeText(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().trim();
}

function splitClauses(text: string): string[] {
  return text.split(/\s*[·|]\s*|\.\s+|\n+/).map(p => p.trim()).filter(Boolean);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clauseMentions(clause: string, phrases: string[]): boolean {
  const normalized = normalizeText(clause);
  return phrases.some(phrase => {
    const trimmed = normalizeText(phrase);
    if (!trimmed || trimmed.length < 3) return false;
    return new RegExp(`\\b${escapeRegex(trimmed)}\\b`, 'i').test(normalized);
  });
}

function nextNonEmptyClause(clauses: string[], index: number): string | null {
  for (let i = index + 1; i < clauses.length; i++) {
    if (clauses[i]) return clauses[i];
  }
  return null;
}

function titleMentions(searchTitle: string): string[] {
  const headline = extractHeadlineFromTitle(searchTitle);
  const company = extractCompanyFromHeadline(headline);
  const phrases = new Set<string>();
  if (headline) phrases.add(headline);
  if (company) phrases.add(company);
  if (headline) {
    const shortened = headline.replace(/\bat\s+.+$/i, '').trim();
    if (shortened.length >= 4) phrases.add(shortened);
  }
  return [...phrases];
}

export function detectTitleCurrentness(searchTitle: string, searchSnippet: string): Currentness {
  if (!searchTitle.trim() && !searchSnippet.trim()) return 'unknown';

  if ((/\bformer\b/i.test(searchTitle) || /\bex[-–]/i.test(searchTitle)) && !hasFalseTemporalMatch(searchTitle)) {
    return 'historical';
  }

  const mentions = titleMentions(searchTitle);
  const clauses = splitClauses(searchSnippet);
  const mentionClauseIndexes: number[] = [];

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    if (!clauseMentions(clause, mentions)) continue;
    mentionClauseIndexes.push(i);

    const nextClause = nextNonEmptyClause(clauses, i) ?? '';
    const local = `${clause} ${nextClause}`.trim();

    if (hasFalseTemporalMatch(local)) continue;

    if (hasHistoricalMarker(local) && !hasCurrentMarker(local)) return 'historical';
    if (hasCurrentMarker(local) && !hasHistoricalMarker(local)) return 'current';
    if (hasCurrentMarker(local) && hasHistoricalMarker(local)) return 'historical';
  }

  if (
    mentionClauseIndexes.includes(0) &&
    /\b(?:previously|former|formerly|ex[-–])\b/i.test(searchSnippet) &&
    !hasFalseTemporalMatch(searchSnippet) &&
    !/\b(?:currently|present|now at|now leading|now working)\b/i.test(searchSnippet)
  ) {
    return 'current';
  }

  const normalizedSnippet = normalizeText(searchSnippet);

  if (/\b(?:currently|now)\b/.test(normalizedSnippet) && /\b(?:consulting|advisor|advising|independent|freelance|founder|cto|ceo|vp|lead)\b/.test(normalizedSnippet)) {
    return 'historical';
  }

  if (hasCurrentMarker(searchSnippet) && !hasHistoricalMarker(searchSnippet)) return 'current';
  if (hasHistoricalMarker(searchSnippet) && !hasCurrentMarker(searchSnippet) && !hasFalseTemporalMatch(searchSnippet)) return 'historical';
  return 'unknown';
}

export function detectLocationCurrentness(searchTitle: string, searchSnippet: string, overrideLocation?: string): Currentness {
  const extractedLocation = overrideLocation ?? extractLocationFromSerpResult(searchTitle, searchSnippet);
  if (!extractedLocation) return 'unknown';

  const clauses = splitClauses(searchSnippet);
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    if (!clauseMentions(clause, [extractedLocation])) continue;

    const nextClause = nextNonEmptyClause(clauses, i) ?? '';
    const local = clause.trim();

    if (/\b(?:previously|formerly)\s+in\b/i.test(local)) return 'historical';
    if (hasHistoricalMarker(local) && !hasCurrentMarker(local)) return 'historical';
    if (hasCurrentMarker(local) && !hasHistoricalMarker(local)) return 'current';

    if (nextClause) {
      const nextHasCurrentDate = /\b(?:present|atual|presente)\b/i.test(nextClause) || /現在/.test(nextClause) || /\b(20\d{2})\s*[-–]\s*(?:\.|,|$)/.test(nextClause);
      const nextHasHistoricalDate = /\b(20\d{2})\s*[-–]\s*(20\d{2})\b/.test(nextClause);
      if (nextHasCurrentDate && !nextHasHistoricalDate) return 'current';
      if (nextHasHistoricalDate && !nextHasCurrentDate) return 'historical';
    }
  }

  const normalizedSnippet = normalizeText(searchSnippet);
  const normalizedLocation = normalizeText(extractedLocation);

  // Direction-aware relocation: "to X" means X is current, "from X" means X is historical
  const toPattern = /\b(?:now\s+(?:based\s+)?in|moved\s+to|relocated\s+to)\s+([a-z][a-z\s,.-]+)/i;
  const toMatch = searchSnippet.match(toPattern);
  if (toMatch) {
    const destination = normalizeText(toMatch[1]);
    if (destination) {
      if (destination.includes(normalizedLocation)) return 'current';
      return 'historical';
    }
  }

  const fromPattern = /\b(?:moved\s+from|relocated\s+from)\s+([a-z][a-z\s,.-]+)/i;
  const fromMatch = searchSnippet.match(fromPattern);
  if (fromMatch) {
    const origin = normalizeText(fromMatch[1]);
    if (origin) {
      if (origin.includes(normalizedLocation)) return 'historical';
      if (normalizedSnippet.includes(normalizedLocation)) return 'current';
    }
  }

  if (normalizedSnippet.includes(normalizedLocation) && hasCurrentMarker(searchSnippet) && !hasHistoricalMarker(searchSnippet)) {
    return 'current';
  }

  return 'unknown';
}

export function detectCurrentness(searchTitle: string, searchSnippet: string, overrideLocation?: string): {
  title: Currentness;
  location: Currentness;
} {
  const textBag = [searchTitle, searchSnippet].filter(Boolean).join(' ');
  if (!textBag.trim()) {
    return { title: 'unknown', location: 'unknown' };
  }
  return {
    title: detectTitleCurrentness(searchTitle, searchSnippet),
    location: detectLocationCurrentness(searchTitle, searchSnippet, overrideLocation),
  };
}
