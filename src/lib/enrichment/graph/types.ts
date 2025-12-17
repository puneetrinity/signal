/**
 * LangGraph Enrichment Types
 *
 * State annotations and types for the graph-based enrichment flow.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { Annotation } from '@langchain/langgraph';
import type { RoleType } from '@/types/linkedin';
import type { EnrichmentPlatform, DiscoveredIdentity, ScoreBreakdown } from '../sources/types';

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
  maxPlatforms: parseEnvInt(process.env.ENRICHMENT_MAX_PLATFORMS, 5),
  maxIdentitiesPerPlatform: 5,
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

  // Observability
  lastCompletedNode: Annotation<string | null>,
  progressPct: Annotation<number>,
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
