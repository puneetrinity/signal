export const SENIORITY_LADDER = [
  'intern', 'junior', 'mid', 'senior', 'staff', 'principal',
  'lead', 'manager', 'director', 'vp', 'cxo',
] as const;

export type SeniorityBand = typeof SENIORITY_LADDER[number];

/**
 * Extract seniority band from free-text (e.g. headline).
 * Scans highest-to-lowest so "VP" matches before shorter substrings.
 */
export function normalizeSeniorityFromText(text: string | null | undefined): SeniorityBand | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (let i = SENIORITY_LADDER.length - 1; i >= 0; i--) {
    const band = SENIORITY_LADDER[i];
    const escaped = band.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lower)) return band;
  }
  return null;
}

/** Absolute ladder distance between two bands. */
export function seniorityDistance(a: SeniorityBand, b: SeniorityBand): number {
  const ai = SENIORITY_LADDER.indexOf(a);
  const bi = SENIORITY_LADDER.indexOf(b);
  return Math.abs(ai - bi);
}
