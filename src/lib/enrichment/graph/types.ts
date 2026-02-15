/**
 * LangGraph Enrichment Types
 *
 * State annotations and types for the graph-based enrichment flow.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { Annotation } from '@langchain/langgraph';
import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, DiscoveredIdentity, ScoreBreakdown, PlatformDiagnostics } from '../sources/types';
import type { Tier1ShadowDiagnostics, Tier1GapDiagnostics } from '../bridge-types';

// Re-export for convenience
export type { PlatformDiagnostics };

/**
 * Candidate hints for enrichment
 */
export interface EnrichmentHints {
  linkedinId: string;
  linkedinUrl: string;
  nameHint: string | null;
  headlineHint: string | null;
  locationHint: string | null;
  companyHint: string | null;
  roleType: RoleType | null;
  serpTitle?: string;
  serpSnippet?: string;
  serpMeta?: Record<string, unknown>;
}

/**
 * Platform query result
 */
export interface PlatformQueryResult {
  platform: EnrichmentPlatform;
  identities: DiscoveredIdentity[];
  queriesExecuted: number;
  searchQueries: string[];
  durationMs: number;
  error?: string;

  // Phase A.5: Per-platform diagnostics
  diagnostics?: PlatformDiagnostics;
}

/**
 * Run trace for observability - stored in EnrichmentSession.runTrace
 */
export interface EnrichmentRunTrace {
  /** Input context */
  input: {
    candidateId: string;
    linkedinId: string;
    linkedinUrl: string;
  };
  /** Seed hints used */
  seed: {
    nameHint: string | null;
    headlineHint: string | null;
    locationHint: string | null;
    companyHint: string | null;
    roleType: string | null;
  };
  /** Per-platform results */
  platformResults: Record<string, {
    queriesExecuted: number;
    rawResultCount: number;
    matchedResultCount?: number;
    identitiesFound: number;
    /** Identities above minConfidence threshold (platform-local, added in persistResultsNode) */
    identitiesAboveMinConfidence?: number;
    /** Identities passing persist guard (platform-local, added in persistResultsNode) */
    identitiesPassingPersistGuard?: number;
    /** Identities successfully persisted to DB (added in persistResultsNode) */
    identitiesPersisted?: number;
    /** Sample unmatched URLs for pattern debugging (max 3) */
    unmatchedSampleUrls?: string[];
    /** Shadow scoring diagnostics (dynamic vs static comparison) */
    shadowScoring?: PlatformDiagnostics['shadowScoring'];
    /** Primary scorer version used for static/persisted confidence. */
    scoringVersion?: string;
    /** Dynamic scorer version when shadow scoring is emitted. */
    dynamicScoringVersion?: string;
    /** Scoring mode used by this platform run. */
    scoringMode?: PlatformDiagnostics['scoringMode'];
    bestConfidence: number | null;
    durationMs: number;
    error?: string;
    rateLimited?: boolean;
    /** Tier-1 shadow evaluation diagnostics */
    tier1Shadow?: Tier1ShadowDiagnostics;
    /** Tier-1 near-pass diagnostics */
    tier1Gap?: Tier1GapDiagnostics;
  }>;
  /** Final aggregated results */
  final: {
    totalQueriesExecuted: number;
    platformsQueried: number;
    platformsWithHits: number;
    /** Total identities found across all platforms (before any filtering) */
    identitiesFoundTotal: number;
    /** Identities above minConfidence threshold */
    identitiesAboveMinConfidence: number;
    /** Identities passing persist guard (shouldPersistIdentity + platform guards) */
    identitiesPassingPersistGuard: number;
    /** Actual DB upserts attempted */
    identitiesPersisted: number;
    /** DB errors during persist (should be 0 in healthy system) */
    persistErrors?: number;
    bestConfidence: number | null;
    durationMs: number;
    /**
     * Provider usage summary across platforms in this run.
     * Counts are per-platform (not per-query).
     */
    providersUsed?: Record<string, number>;
    /** Scorer versions observed across platform runs (counts are per-platform). */
    scoringVersions?: Record<string, number>;
    /** Dynamic scorer versions observed across platform runs (counts are per-platform). */
    dynamicScoringVersions?: Record<string, number>;
    /** Providers that were rate limited during this run (best-effort). */
    rateLimitedProviders?: string[];
    /**
     * Variant stats aggregated across all platforms.
     * Includes both raw variantIds and canonical aggregations.
     */
    variantStats?: {
      executed: {
        raw: string[];
        canonical: Record<string, number>;
      };
      rejected: {
        raw: string[];
        canonical: Record<string, number>;
      };
    };
    /**
     * Summary metadata for draft/verified tracking.
     * Used to determine if summary needs regeneration after confirmation.
     */
    summaryMeta?: {
      mode: 'draft' | 'verified';
      confirmedCount: number;
      identityKey: string;
      identityIds: string[];
    };
    /** Tier-1 shadow evaluation diagnostics (aggregated across platforms) */
    tier1Shadow?: Tier1ShadowDiagnostics;
    /** Tier-1 near-pass diagnostics (aggregated across platforms) */
    tier1Gap?: Tier1GapDiagnostics;
  };
  /** Failure reason if any */
  failureReason?: string;
}

/**
 * Error entry for tracking failures
 */
export interface EnrichmentError {
  platform: EnrichmentPlatform | 'system';
  message: string;
  timestamp: string;
  recoverable: boolean;
}

/**
 * Progress event for SSE streaming
 */
export interface EnrichmentProgressEvent {
  type: 'node_start' | 'node_complete' | 'platform_result' | 'identity_found' | 'complete' | 'error';
  node?: string;
  platform?: EnrichmentPlatform;
  data?: {
    identitiesFound?: number;
    queriesExecuted?: number;
    confidence?: number;
    error?: string;
  };
  timestamp: string;
}

/**
 * Budget configuration for enrichment
 */
export interface EnrichmentBudget {
  /** Maximum total queries across all platforms */
  maxQueries: number;
  /** Maximum number of platforms to query */
  maxPlatforms: number;
  /** Maximum identities to return per platform */
  maxIdentitiesPerPlatform: number;
  /** Overall timeout in milliseconds */
  timeoutMs: number;
  /** Confidence threshold to stop early */
  minConfidenceForEarlyStop: number;
  /** Maximum platforms to query in parallel (cost control) */
  maxParallelPlatforms: number;
}

/**
 * Parse environment variable as integer with fallback
 */
function parseEnvInt(envVar: string | undefined, defaultValue: number): number {
  if (!envVar) return defaultValue;
  const parsed = parseInt(envVar, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Default budget configuration
 *
 * Environment overrides:
 * - ENRICHMENT_MAX_PARALLEL_PLATFORMS: Override maxParallelPlatforms
 * - ENRICHMENT_MAX_PLATFORMS: Override maxPlatforms
 * - ENRICHMENT_MAX_QUERIES: Override maxQueries
 */
export const DEFAULT_BUDGET: EnrichmentBudget = {
  maxQueries: parseEnvInt(process.env.ENRICHMENT_MAX_QUERIES, 30),
  maxPlatforms: parseEnvInt(process.env.ENRICHMENT_MAX_PLATFORMS, 8),
  maxIdentitiesPerPlatform: parseEnvInt(process.env.ENRICHMENT_MAX_IDENTITIES_PER_PLATFORM, 3),
  timeoutMs: 60000,
  minConfidenceForEarlyStop: 0.9,
  maxParallelPlatforms: parseEnvInt(process.env.ENRICHMENT_MAX_PARALLEL_PLATFORMS, 3),
};

/**
 * LangGraph State Annotation for Enrichment
 *
 * Defines the shape of state that flows through the graph.
 * Uses reducers for arrays to accumulate results from parallel nodes.
 */
export const EnrichmentStateAnnotation = Annotation.Root({
  // Input state
  tenantId: Annotation<string>, // Required for multi-tenancy
  candidateId: Annotation<string>,
  sessionId: Annotation<string>,
  roleType: Annotation<RoleType>,
  hints: Annotation<EnrichmentHints>,
  budget: Annotation<EnrichmentBudget>,

  // Platforms to query (determined by role)
  platformsToQuery: Annotation<EnrichmentPlatform[]>,
  platformsRemaining: Annotation<EnrichmentPlatform[]>,

  // Accumulated results (reducers merge arrays)
  identitiesFound: Annotation<DiscoveredIdentity[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  platformResults: Annotation<PlatformQueryResult[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  errors: Annotation<EnrichmentError[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  progressEvents: Annotation<EnrichmentProgressEvent[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  // Counters
  queriesExecuted: Annotation<number>({
    reducer: (current, update) => current + update,
    default: () => 0,
  }),
  sourcesExecuted: Annotation<string[]>({
    reducer: (current, update) => [...new Set([...current, ...update])],
    default: () => [],
  }),

  // Control flow
  status: Annotation<'pending' | 'running' | 'completed' | 'failed' | 'early_stopped'>,
  earlyStopReason: Annotation<string | null>,
  bestConfidence: Annotation<number | null>,

  // Timing
  startedAt: Annotation<string>,
  completedAt: Annotation<string | null>,

  // Observability (reducers needed for parallel Send() updates)
  lastCompletedNode: Annotation<string | null>({
    reducer: (_, update) => update, // Last writer wins for parallel nodes
    default: () => null,
  }),
  progressPct: Annotation<number>({
    reducer: (current, update) => Math.max(current, update), // Keep highest progress
    default: () => 0,
  }),
  errorsBySource: Annotation<Record<string, string[]>>({
    reducer: (current, update) => {
      const merged = { ...current };
      for (const [source, errors] of Object.entries(update)) {
        merged[source] = [...(merged[source] || []), ...errors];
      }
      return merged;
    },
    default: () => ({}),
  }),

  // Summary output (stored; platform data remains ephemeral)
  summaryText: Annotation<string | null>,
  summaryStructured: Annotation<Record<string, unknown> | null>,
  summaryEvidence: Annotation<Array<Record<string, unknown>> | null>,
  summaryModel: Annotation<string | null>,
  summaryTokens: Annotation<number | null>,
  summaryGeneratedAt: Annotation<string | null>,
  /** Summary metadata: mode (draft/verified), confirmedCount, identityKey */
  summaryMeta: Annotation<Record<string, unknown> | null>,

  // Persist filter stats (set by persistResultsNode)
  persistStats: Annotation<{
    identitiesFoundTotal: number;
    identitiesAboveMinConfidence: number;
    identitiesPassingPersistGuard: number;
    identitiesPersisted: number;
    persistErrors: number;
    perPlatform: Record<string, {
      found: number;
      aboveMinConfidence: number;
      passingPersistGuard: number;
      persisted: number;
    }>;
  } | null>,
});

/**
 * Type alias for the state
 */
export type EnrichmentState = typeof EnrichmentStateAnnotation.State;

/**
 * Partial state for node returns
 */
export type PartialEnrichmentState = Partial<EnrichmentState>;

/**
 * Input for starting enrichment
 */
export interface EnrichmentGraphInput {
  tenantId: string; // Required for multi-tenancy
  candidateId: string;
  /**
   * Optional session ID to use for this run (recommended for async jobs).
   * When omitted, the graph will generate one.
   */
  sessionId?: string;
  roleType?: RoleType;
  budget?: Partial<EnrichmentBudget>;
}

/**
 * Output from enrichment graph
 */
export interface EnrichmentGraphOutput {
  candidateId: string;
  sessionId: string;
  status: EnrichmentState['status'];
  identitiesFound: DiscoveredIdentity[];
  bestConfidence: number | null;
  platformResults: PlatformQueryResult[];
  queriesExecuted: number;
  sourcesExecuted: string[];
  earlyStopReason: string | null;
  durationMs: number;
  errors: EnrichmentError[];
}
