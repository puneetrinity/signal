/**
 * Variant Taxonomy - Canonical variant mapping
 *
 * Maps raw variantIds to a minimal canonical taxonomy for metrics/dashboards.
 * Raw variantIds are preserved for traceability; canonical variants enable aggregation.
 *
 * Canonical taxonomy:
 * - handle:primary    - direct linkedinId-based handle
 * - handle:derived    - transformed handle (collapsed, underscore, dot)
 * - name:full         - full name only
 * - name:full+company - name with company context
 * - name:full+location - name with location context
 * - name:full+title   - name with job title/headline
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

/**
 * Canonical variant types for metrics aggregation
 */
export type CanonicalVariant =
  | 'handle:primary'
  | 'handle:derived'
  | 'name:full'
  | 'name:full+company'
  | 'name:full+location'
  | 'name:full+title';

/**
 * Mapping rules from raw variantIds to canonical variants
 */
const CANONICAL_MAPPINGS: Record<string, CanonicalVariant> = {
  // Handle variants → handle:primary or handle:derived
  'handle:clean': 'handle:primary',
  'handle:clean_direct': 'handle:primary',
  'handle:clean_users': 'handle:primary',
  'handle:clean_user_path': 'handle:primary',
  'handle:raw': 'handle:primary',

  'handle:derived': 'handle:derived',
  'handle:collapsed': 'handle:derived',
  'handle:collapsed_direct': 'handle:derived',
  'handle:collapsed_users': 'handle:derived',
  'handle:underscore': 'handle:derived',
  'handle:dot': 'handle:derived',

  // Name variants → name:full
  'name:full': 'name:full',
  'name:full_author': 'name:full',
  'name:full_scoped': 'name:full',
  'name:full_at_handle_guess': 'name:full',
  'name:full_user_search': 'name:full',
  'name:full_maintainer': 'name:full',
  'name:author': 'name:full',
  'name:author_page': 'name:full',
  'name:profile': 'name:full',
  'name:citations': 'name:full',
  'name:inventor': 'name:full',
  'name:talks': 'name:full',
  'name:edu': 'name:full',

  // Name + company variants → name:full+company
  'name+company': 'name:full+company',
  'name+company_team': 'name:full+company',
  'name+company_exec': 'name:full+company',
  'name+company_inventor': 'name:full+company',
  'name:company_domain_guess': 'name:full+company',
  'name:edu+company': 'name:full+company',
  'company:org': 'name:full+company',

  // Name + location variants → name:full+location
  'name+location': 'name:full+location',
  'name:edu+location': 'name:full+location',

  // Name + title/headline variants → name:full+title
  'name+headline_title': 'name:full+title',

  // Special cases that should map to name:full (searching for handle text in name mode)
  'handle:package_search': 'name:full',
  'name:tilde_handle_literal': 'name:full',
};

/**
 * Map a raw variantId to its canonical form
 *
 * @param rawVariantId - The raw variantId from buildQueryCandidates
 * @returns The canonical variant for metrics aggregation
 */
export function canonicalizeVariant(rawVariantId: string): CanonicalVariant {
  // Direct mapping lookup
  if (rawVariantId in CANONICAL_MAPPINGS) {
    return CANONICAL_MAPPINGS[rawVariantId];
  }

  // Pattern-based fallbacks
  if (rawVariantId.startsWith('handle:')) {
    // Unknown handle variant → derive based on content
    if (rawVariantId.includes('clean') || rawVariantId.includes('primary') || rawVariantId.includes('raw')) {
      return 'handle:primary';
    }
    return 'handle:derived';
  }

  if (rawVariantId.startsWith('name:') || rawVariantId.startsWith('name+')) {
    // Check for compound variants
    if (rawVariantId.includes('company') || rawVariantId.includes('org')) {
      return 'name:full+company';
    }
    if (rawVariantId.includes('location')) {
      return 'name:full+location';
    }
    if (rawVariantId.includes('title') || rawVariantId.includes('headline')) {
      return 'name:full+title';
    }
    return 'name:full';
  }

  // Legacy/unknown → default to name:full
  console.warn(`[variant-taxonomy] Unknown variantId: ${rawVariantId}, defaulting to name:full`);
  return 'name:full';
}

/**
 * Aggregate variant counts by canonical form
 *
 * @param variantIds - Array of raw variantIds
 * @returns Map of canonical variant → count
 */
export function aggregateByCanonical(variantIds: string[]): Record<CanonicalVariant, number> {
  const counts: Record<CanonicalVariant, number> = {
    'handle:primary': 0,
    'handle:derived': 0,
    'name:full': 0,
    'name:full+company': 0,
    'name:full+location': 0,
    'name:full+title': 0,
  };

  for (const variantId of variantIds) {
    const canonical = canonicalizeVariant(variantId);
    counts[canonical]++;
  }

  return counts;
}

/**
 * Build variant stats for runTrace
 *
 * @param executedVariants - Raw variantIds of executed queries
 * @param rejectedVariants - Raw variantIds of rejected queries
 * @returns Stats object for runTrace
 */
export function buildVariantStats(
  executedVariants: string[],
  rejectedVariants: string[]
): {
  executed: { raw: string[]; canonical: Record<CanonicalVariant, number> };
  rejected: { raw: string[]; canonical: Record<CanonicalVariant, number> };
} {
  return {
    executed: {
      raw: executedVariants,
      canonical: aggregateByCanonical(executedVariants),
    },
    rejected: {
      raw: rejectedVariants,
      canonical: aggregateByCanonical(rejectedVariants),
    },
  };
}
