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
  // --- Non-tech role families ---
  // ORDER MATTERS: specific families before generic ones (first-match wins)
  {
    family: 'technical_account_manager',
    patterns: [
      /\btechnical account manager\b/i,
      /\btechnical account lead\b/i,
      /\btechnical customer success\b/i,
    ],
  },
  {
    family: 'sales_engineer',
    patterns: [
      /\bsales engineer\b/i,
      /\bpre[- ]?sales engineer\b/i,
      /\bsolutions engineer\b/i,
    ],
  },
  {
    family: 'customer_success',
    patterns: [
      /\bcustomer success\b/i,
      /\bclient success\b/i,
      /\bcsm\b/i,
    ],
  },
  {
    family: 'account_executive',
    patterns: [
      /\baccount executive\b/i,
      /\benterprise sales\b/i,
      /\bsales executive\b/i,
      /\bregional sales\b/i,
    ],
  },
  {
    family: 'business_development',
    patterns: [
      /\bbusiness development\b/i,
      /\bbdr\b/i,
      /\bsdr\b/i,
      /\bsales development\b/i,
    ],
  },
  {
    family: 'account_manager',
    patterns: [
      /\baccount manager\b/i,
      /\bkey account\b/i,
      /\bclient manager\b/i,
      /\brelationship manager\b/i,
    ],
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
