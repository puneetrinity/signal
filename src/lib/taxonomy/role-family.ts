const ROLE_PATTERNS: Array<{ family: string; patterns: RegExp[] }> = [
  {
    family: 'devops',
    patterns: [/\bdevops\b/i, /\bsre\b/i, /\bsite reliability\b/i, /\bplatform engineer\b/i],
  },
  {
    family: 'fullstack',
    patterns: [/\bfull[- ]?stack\b/i, /\bfull stack\b/i],
  },
  {
    family: 'frontend',
    patterns: [/\bfront[- ]?end\b/i, /\bui engineer\b/i, /\breact\b/i, /\bangular\b/i],
  },
  {
    family: 'backend',
    patterns: [/\bback[- ]?end\b/i, /\bapi engineer\b/i, /\bserver[- ]?side\b/i],
  },
  {
    family: 'data',
    patterns: [/\bdata engineer\b/i, /\bdata scientist\b/i, /\bml engineer\b/i, /\banalytics\b/i],
  },
  {
    family: 'qa',
    patterns: [/\bqa\b/i, /\bquality assurance\b/i, /\btest automation\b/i, /\bselenium\b/i],
  },
  {
    family: 'security',
    patterns: [
      /\b(application|cloud|cyber|information)\s+security\b/i,
      /\bsecurity\s+(engineer|analyst|architect|lead|specialist|consultant)\b/i,
    ],
  },
  {
    family: 'mobile',
    patterns: [/\bandroid\b/i, /\bios\b/i, /\bmobile\b/i, /\breact native\b/i, /\bflutter\b/i],
  },
];

export function detectRoleFamilyFromTitle(title: string): string | null {
  const normalized = title.trim();
  if (!normalized) return null;

  for (const entry of ROLE_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(normalized))) {
      return entry.family;
    }
  }
  return null;
}
