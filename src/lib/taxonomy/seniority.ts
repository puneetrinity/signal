export const SENIORITY_LADDER = [
  'intern', 'junior', 'mid', 'senior', 'staff', 'principal',
  'lead', 'manager', 'director', 'vp', 'cxo',
] as const;

export type SeniorityBand = typeof SENIORITY_LADDER[number];

// Aliases that map to a ladder band (checked before the ladder scan)
const SENIORITY_ALIASES: Array<[RegExp, SeniorityBand]> = [
  // C-suite → cxo
  [/\bcto\b/, 'cxo'],
  [/\bceo\b/, 'cxo'],
  [/\bcfo\b/, 'cxo'],
  [/\bcoo\b/, 'cxo'],
  // VP compounds → vp
  [/\bsvp\b/, 'vp'],
  [/\bevp\b/, 'vp'],
  // Senior abbreviation → senior
  [/\bsr\.?\b/, 'senior'],
  // Phrase mappings
  [/\bhead of\b/, 'director'],
  [/\bassociate\b(?=\s+(?:software|developer|engineer|analyst|designer|consultant|product))/i, 'junior'],
];

// Contexts where a seniority keyword is not actually indicating level
const SENIORITY_FALSE_POSITIVE_PATTERNS = [
  /\bsenior\s+living\b/i,
  /\bsenior\s+care\b/i,
  /\bsenior\s+citizen\b/i,
  /\bsenior\s+home\b/i,
];

/**
 * Extract seniority band from free-text (e.g. headline).
 *
 * 1. Check phrase/alias mappings first (C-suite, VP compounds, Sr., etc.)
 * 2. Scan ladder keywords highest-to-lowest
 * 3. Guard against false positives from non-role contexts
 */
export function normalizeSeniorityFromText(text: string | null | undefined): SeniorityBand | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // Phase 1: alias/phrase checks (highest priority)
  for (const [pattern, band] of SENIORITY_ALIASES) {
    if (pattern.test(lower)) return band;
  }

  // Phase 2: ladder keyword scan (highest-to-lowest)
  for (let i = SENIORITY_LADDER.length - 1; i >= 0; i--) {
    const band = SENIORITY_LADDER[i];
    const escaped = band.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lower)) {
      // Phase 3: guard against false positives
      if (SENIORITY_FALSE_POSITIVE_PATTERNS.some(fp => fp.test(lower))) {
        return null;
      }
      return band;
    }
  }

  return null;
}

/** Absolute ladder distance between two bands. */
export function seniorityDistance(a: SeniorityBand, b: SeniorityBand): number {
  const ai = SENIORITY_LADDER.indexOf(a);
  const bi = SENIORITY_LADDER.indexOf(b);
  return Math.abs(ai - bi);
}
