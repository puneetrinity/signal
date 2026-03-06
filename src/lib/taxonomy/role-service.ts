/**
 * Canonical Role Service — single source of truth for role family detection.
 *
 * Consolidates scattered role data from:
 *   - role-family.ts (14 regex patterns)
 *   - track-resolver.ts (TECH/NON_TECH_ROLE_FAMILIES sets)
 *   - ranking.ts (ROLE_ADJACENCY table)
 *   - discovery.ts (NON_TECH_TITLE_VARIANTS)
 *
 * Deterministic regex first, Groq LLM fallback for unknowns (when enabled).
 */

import { createLogger } from '@/lib/logger';
import { getSourcingConfig } from '@/lib/sourcing/config';
import { groqClassifyRole } from './role-groq';

const log = createLogger('RoleService');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoleFamily =
  | 'backend' | 'frontend' | 'fullstack' | 'devops' | 'data' | 'qa' | 'security' | 'mobile'
  | 'technical_account_manager' | 'sales_engineer' | 'customer_success'
  | 'account_executive' | 'business_development' | 'account_manager';

export type RoleFallbackKind = 'other_tech' | 'other_non_tech' | 'unknown';

export interface RoleResolution {
  family: RoleFamily | null;
  fallbackKind: RoleFallbackKind | null;
  confidence: number;
  track: 'tech' | 'non_tech' | null;
  adjacentFamilies: RoleFamily[];
  normalizedTitle: string;
}

// ---------------------------------------------------------------------------
// Consolidated data (single source of truth)
// ---------------------------------------------------------------------------

export const ROLE_PATTERNS: Array<{ family: RoleFamily; patterns: RegExp[] }> = [
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
      /\btam\b/i,
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

export const TECH_ROLE_FAMILIES = new Set<RoleFamily>([
  'backend', 'frontend', 'fullstack', 'devops', 'data', 'qa', 'security', 'mobile',
]);

export const NON_TECH_ROLE_FAMILIES = new Set<RoleFamily>([
  'account_executive', 'customer_success', 'technical_account_manager',
  'sales_engineer', 'business_development', 'account_manager',
]);

export const ROLE_ADJACENCY: Array<[RoleFamily, RoleFamily, number]> = [
  // Tech adjacencies
  ['fullstack', 'frontend', 0.7],
  ['fullstack', 'backend', 0.7],
  ['devops', 'backend', 0.5],
  ['devops', 'security', 0.5],
  // Non-tech adjacencies
  ['account_executive', 'business_development', 0.7],
  ['account_executive', 'account_manager', 0.6],
  ['account_executive', 'sales_engineer', 0.5],
  ['customer_success', 'account_manager', 0.7],
  ['customer_success', 'technical_account_manager', 0.6],
  ['technical_account_manager', 'sales_engineer', 0.7],
  ['technical_account_manager', 'customer_success', 0.6],
  ['sales_engineer', 'account_executive', 0.5],
  ['business_development', 'account_manager', 0.5],
];

export const adjacencyMap = new Map<string, number>();
for (const [a, b, score] of ROLE_ADJACENCY) {
  adjacencyMap.set(`${a}:${b}`, score);
  adjacencyMap.set(`${b}:${a}`, score);
}

export const NON_TECH_TITLE_VARIANTS: Record<string, string[]> = {
  'account_executive': ['account executive', 'enterprise sales', 'sales executive', 'regional sales manager'],
  'customer_success': ['customer success manager', 'client success manager', 'customer success lead'],
  'technical_account_manager': ['technical account manager', 'technical customer success'],
  'sales_engineer': ['sales engineer', 'solutions engineer', 'pre-sales engineer'],
  'business_development': ['business development representative', 'sales development representative'],
  'account_manager': ['account manager', 'key account manager', 'client manager'],
};

/** Map from family → track */
export const familyToTrack = new Map<RoleFamily, 'tech' | 'non_tech'>();
for (const f of TECH_ROLE_FAMILIES) familyToTrack.set(f, 'tech');
for (const f of NON_TECH_ROLE_FAMILIES) familyToTrack.set(f, 'non_tech');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_FAMILIES = new Set<string>([...TECH_ROLE_FAMILIES, ...NON_TECH_ROLE_FAMILIES]);

function isRoleFamily(value: string): value is RoleFamily {
  return ALL_FAMILIES.has(value);
}

function getAdjacentFamilies(family: RoleFamily): RoleFamily[] {
  const seen = new Set<RoleFamily>();
  for (const [a, b] of ROLE_ADJACENCY) {
    if (a === family && !seen.has(b)) seen.add(b);
    else if (b === family && !seen.has(a)) seen.add(a);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Deterministic resolution (sync, ~0.01ms per title)
// ---------------------------------------------------------------------------

export function resolveRoleDeterministic(title: string): RoleResolution {
  const normalized = title.trim();
  if (!normalized) {
    return {
      family: null,
      fallbackKind: 'unknown',
      confidence: 0.0,
      track: null,
      adjacentFamilies: [],
      normalizedTitle: '',
    };
  }

  for (const entry of ROLE_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(normalized))) {
      return {
        family: entry.family,
        fallbackKind: null,
        confidence: 0.95,
        track: familyToTrack.get(entry.family) ?? null,
        adjacentFamilies: getAdjacentFamilies(entry.family),
        normalizedTitle: normalized,
      };
    }
  }

  return {
    family: null,
    fallbackKind: 'unknown',
    confidence: 0.0,
    track: null,
    adjacentFamilies: [],
    normalizedTitle: normalized,
  };
}

// ---------------------------------------------------------------------------
// Single-title async resolution (deterministic → cache → LLM fallback)
// ---------------------------------------------------------------------------

export async function resolveRole(
  title: string,
  context?: string,
): Promise<RoleResolution> {
  const det = resolveRoleDeterministic(title);
  if (det.family) return det;

  const config = getSourcingConfig();
  if (!config.roleGroqEnabled) return det;

  try {
    const groqResult = await groqClassifyRole(title, context ?? null, config);
    if (!groqResult) return det;

    const family = isRoleFamily(groqResult.family) ? groqResult.family : null;
    const fallbackKind = family ? null : (groqResult.fallbackKind as RoleFallbackKind | null) ?? 'unknown';

    return {
      family,
      fallbackKind,
      confidence: groqResult.confidence,
      track: family ? (familyToTrack.get(family) ?? null) : null,
      adjacentFamilies: family ? getAdjacentFamilies(family) : [],
      normalizedTitle: det.normalizedTitle,
    };
  } catch (err) {
    log.warn({ error: err, title }, 'Role Groq fallback failed, using deterministic');
    return det;
  }
}

// ---------------------------------------------------------------------------
// Batch resolution (dedupes, deterministic → batch cache → LLM for misses)
// ---------------------------------------------------------------------------

export interface RoleBatchEntry {
  key: string;
  title: string;
  context?: string;
}

export interface RoleBatchResult {
  resolutions: Map<string, RoleResolution>;
  metrics: RoleResolutionMetrics;
}

export interface RoleResolutionMetrics {
  deterministicHitRate: number;
  cacheHitRate: number;
  llmCallCount: number;
  llmEligibleCount: number;
  unknownCount: number;
  fallbackCount: number;
  confidenceDistribution: {
    high: number;   // >= 0.8
    medium: number; // 0.5–0.8
    low: number;    // < 0.5
  };
  promotionDelta: {
    wouldPromote: number;
    wouldBlock: number;
    wouldPromoteRate: number;
    wouldBlockRate: number;
  };
}

const ROLE_LLM_BATCH_CONCURRENCY = 12;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workers = Math.max(1, concurrency);
  const results = new Array<R>(items.length);
  let index = 0;

  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        results[current] = await mapper(items[current]);
      }
    }),
  );

  return results;
}

export async function resolveRolesBatch(
  entries: RoleBatchEntry[],
): Promise<RoleBatchResult> {
  const resolutions = new Map<string, RoleResolution>();
  let deterministicHits = 0;
  let cacheHits = 0;
  let llmCalls = 0;
  let unknowns = 0;
  let fallbackCount = 0;
  const confDist = { high: 0, medium: 0, low: 0 };
  const promotionDelta = { wouldPromote: 0, wouldBlock: 0, wouldPromoteRate: 0, wouldBlockRate: 0 };

  const validEntries = entries.filter((entry) => entry.key.trim().length > 0);
  const uniqueEntriesBySignature = new Map<string, { title: string; context?: string }>();
  for (const entry of validEntries) {
    const title = entry.title.trim();
    const context = entry.context?.trim() ?? '';
    if (!title) continue;
    const signature = `${title.toLowerCase()}|${context.toLowerCase()}`;
    if (!uniqueEntriesBySignature.has(signature)) {
      uniqueEntriesBySignature.set(signature, {
        title,
        context: context || undefined,
      });
    }
  }

  const resolutionBySignature = new Map<string, RoleResolution>();
  const sourceBySignature = new Map<string, 'deterministic' | 'groq_cached' | 'groq_live'>();
  const llmCandidates: Array<{ signature: string; title: string; context?: string }> = [];

  for (const [signature, entry] of uniqueEntriesBySignature) {
    const det = resolveRoleDeterministic(entry.title);
    if (det.family) {
      resolutionBySignature.set(signature, det);
      sourceBySignature.set(signature, 'deterministic');
    } else {
      llmCandidates.push({ signature, title: entry.title, context: entry.context });
    }
  }

  const config = getSourcingConfig();
  if (config.roleGroqEnabled && llmCandidates.length > 0) {
    const llmResults = await mapWithConcurrency(
      llmCandidates,
      ROLE_LLM_BATCH_CONCURRENCY,
      async (entry) => {
        try {
          const groqResult = await groqClassifyRole(entry.title, entry.context ?? null, config);
          if (!groqResult) {
            return {
              signature: entry.signature,
              resolution: resolveRoleDeterministic(entry.title),
              source: 'deterministic' as const,
              llmCalled: false,
            };
          }

          const family = isRoleFamily(groqResult.family) ? groqResult.family : null;
          const fallbackKind = family ? null : (groqResult.fallbackKind as RoleFallbackKind | null) ?? 'unknown';
          return {
            signature: entry.signature,
            resolution: {
              family,
              fallbackKind,
              confidence: groqResult.confidence,
              track: family ? (familyToTrack.get(family) ?? null) : null,
              adjacentFamilies: family ? getAdjacentFamilies(family) : [],
              normalizedTitle: entry.title,
            } satisfies RoleResolution,
            source: (groqResult.cached ? 'groq_cached' : 'groq_live') as 'groq_cached' | 'groq_live',
            llmCalled: !groqResult.cached,
          };
        } catch (err) {
          log.warn({ error: err, title: entry.title }, 'Batch role Groq failed for title');
          return {
            signature: entry.signature,
            resolution: resolveRoleDeterministic(entry.title),
            source: 'deterministic' as const,
            llmCalled: false,
          };
        }
      },
    );

    for (const result of llmResults) {
      resolutionBySignature.set(result.signature, result.resolution);
      sourceBySignature.set(result.signature, result.source);
      if (result.source === 'groq_cached') cacheHits++;
      if (result.llmCalled) llmCalls++;
    }
  } else {
    for (const entry of llmCandidates) {
      resolutionBySignature.set(entry.signature, resolveRoleDeterministic(entry.title));
      sourceBySignature.set(entry.signature, 'deterministic');
    }
  }

  // Map resolved signatures back to candidate keys
  for (const entry of validEntries) {
    const title = entry.title.trim();
    const context = entry.context?.trim() ?? '';
    const signature = `${title.toLowerCase()}|${context.toLowerCase()}`;
    const resolved = resolutionBySignature.get(signature) ?? resolveRoleDeterministic(title);
    resolutions.set(entry.key, resolved);
    const source = sourceBySignature.get(signature) ?? 'deterministic';
    if (source === 'deterministic') deterministicHits++;
  }

  // Compute metrics
  for (const [, resolution] of resolutions) {
    if (!resolution.family && resolution.fallbackKind === 'unknown') unknowns++;
    if (!resolution.family && resolution.fallbackKind && resolution.fallbackKind !== 'unknown') {
      fallbackCount++;
    }

    if (resolution.confidence >= 0.8) confDist.high++;
    else if (resolution.confidence >= 0.5) confDist.medium++;
    else confDist.low++;

    // Promotion delta: compare deterministic vs final
    // "wouldPromote" = LLM resolved a family that deterministic missed
    const det = resolveRoleDeterministic(resolution.normalizedTitle);
    if (!det.family && resolution.family && resolution.confidence >= 0.7) {
      promotionDelta.wouldPromote++;
    }
    if (det.family && !resolution.family) {
      promotionDelta.wouldBlock++;
    }
  }

  const total = resolutions.size || 1;
  promotionDelta.wouldPromoteRate = Number((promotionDelta.wouldPromote / total).toFixed(4));
  promotionDelta.wouldBlockRate = Number((promotionDelta.wouldBlock / total).toFixed(4));

  return {
    resolutions,
    metrics: {
      deterministicHitRate: Number((deterministicHits / total).toFixed(4)),
      cacheHitRate: Number((cacheHits / total).toFixed(4)),
      llmCallCount: llmCalls,
      llmEligibleCount: llmCandidates.length,
      unknownCount: unknowns,
      fallbackCount,
      confidenceDistribution: confDist,
      promotionDelta,
    },
  };
}

// ---------------------------------------------------------------------------
// Backward-compat re-export (deprecated)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use resolveRoleDeterministic() instead.
 * Kept for backward compatibility — returns string | null.
 */
export function detectRoleFamilyFromTitle(title: string): string | null {
  const resolution = resolveRoleDeterministic(title);
  return resolution.family;
}
