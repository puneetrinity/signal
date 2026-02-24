/**
 * Shared hint sanitization utilities.
 *
 * Used by upsert-candidates, ranking location guard, and backfill scripts.
 */

export const PLACEHOLDER_HINTS = new Set(['na', 'n/a', 'unknown', 'none', 'null', '-', '...']);

export function normalizeHint(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

export function isNoisyHint(value: string): boolean {
  const lower = value.toLowerCase();
  if (PLACEHOLDER_HINTS.has(lower)) return true;
  if (/\.{3,}|…/.test(value)) return true;
  if (/\blinkedin\b|\bview\b.*\bprofile\b|https?:\/\/|www\./i.test(value)) return true;
  return false;
}

export function hintQualityScore(value: string | null): number {
  if (!value) return 0;
  if (isNoisyHint(value)) return 0;
  const words = value.split(/\s+/).filter(Boolean).length;
  return Math.min(4, Math.max(1, words));
}

export function shouldReplaceHint(existing: string | null, incoming: string | undefined): boolean {
  const normalizedIncoming = normalizeHint(incoming);
  if (!normalizedIncoming) return false;
  const incomingScore = hintQualityScore(normalizedIncoming);
  if (incomingScore === 0) return false;
  return incomingScore > hintQualityScore(existing);
}
