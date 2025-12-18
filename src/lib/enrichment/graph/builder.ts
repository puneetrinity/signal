/**
 * LangGraph Enrichment Graph Builder
 *
 * Assembles the enrichment graph with parallel platform execution
 * and conditional routing.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { StateGraph, END } from '@langchain/langgraph';
import { v4 as uuidv4 } from 'uuid';
import {
  EnrichmentStateAnnotation,
  type EnrichmentState,
  type EnrichmentGraphInput,
  type EnrichmentGraphOutput,
  DEFAULT_BUDGET,
} from './types';
import {
  loadCandidateNode,
  githubBridgeNode,
  searchPlatformsBatchNode,
  aggregateResultsNode,
  persistResultsNode,
  fetchPlatformDataNode,
  generateSummaryNode,
  persistSummaryNode,
  shouldContinueSearching,
} from './nodes';

/**
 * Node names in the graph
 */
const NODES = {
  LOAD_CANDIDATE: 'loadCandidate',
  GITHUB_BRIDGE: 'githubBridge',
  SEARCH_PLATFORMS: 'searchPlatformsBatch',
  AGGREGATE: 'aggregate',
  PERSIST_IDENTITIES: 'persistIdentities',
  FETCH_PLATFORM_DATA: 'fetchPlatformData',
  GENERATE_SUMMARY: 'generateSummary',
  PERSIST_SUMMARY: 'persistSummary',
} as const;

/**
 * Route from GitHub bridge to either search platforms or aggregate.
 *
 * NOTE: We run search-based discovery in a single batch node to avoid
 * duplicate dispatch/race conditions from parallel Send() fan-out.
 */
function routeAfterGitHub(state: EnrichmentState): string {
  // If we found a high-confidence GitHub match, skip to aggregate
  if (state.earlyStopReason || !shouldContinueSearching(state)) {
    return NODES.AGGREGATE;
  }

  return NODES.SEARCH_PLATFORMS;
}

/**
 * Build the enrichment graph
 */
export function buildEnrichmentGraph() {
  const graph = new StateGraph(EnrichmentStateAnnotation)
    // Add nodes
    .addNode(NODES.LOAD_CANDIDATE, loadCandidateNode)
    .addNode(NODES.GITHUB_BRIDGE, githubBridgeNode)
    .addNode(NODES.SEARCH_PLATFORMS, searchPlatformsBatchNode)
    .addNode(NODES.AGGREGATE, aggregateResultsNode)
    .addNode(NODES.PERSIST_IDENTITIES, persistResultsNode)
    .addNode(NODES.FETCH_PLATFORM_DATA, fetchPlatformDataNode)
    .addNode(NODES.GENERATE_SUMMARY, generateSummaryNode)
    .addNode(NODES.PERSIST_SUMMARY, persistSummaryNode)

    // Add edges
    .addEdge('__start__', NODES.LOAD_CANDIDATE)
    .addConditionalEdges(NODES.LOAD_CANDIDATE, (state) => {
      if (state.status === 'failed') {
        return END;
      }
      return NODES.GITHUB_BRIDGE;
    })
    .addConditionalEdges(NODES.GITHUB_BRIDGE, routeAfterGitHub)
    .addEdge(NODES.SEARCH_PLATFORMS, NODES.AGGREGATE)
    .addEdge(NODES.AGGREGATE, NODES.PERSIST_IDENTITIES)
    .addEdge(NODES.PERSIST_IDENTITIES, NODES.FETCH_PLATFORM_DATA)
    .addEdge(NODES.FETCH_PLATFORM_DATA, NODES.GENERATE_SUMMARY)
    .addEdge(NODES.GENERATE_SUMMARY, NODES.PERSIST_SUMMARY)
    .addEdge(NODES.PERSIST_SUMMARY, END);

  return graph.compile();
}

/**
 * Create initial state from input
 */
export function createInitialState(input: EnrichmentGraphInput): Partial<EnrichmentState> {
  return {
    candidateId: input.candidateId,
    sessionId: input.sessionId || uuidv4(),
    roleType: input.roleType || 'general',
    budget: { ...DEFAULT_BUDGET, ...input.budget },
    status: 'pending',
    identitiesFound: [],
    platformResults: [],
    errors: [],
    progressEvents: [],
    queriesExecuted: 0,
    sourcesExecuted: [],
    earlyStopReason: null,
    bestConfidence: null,
    completedAt: null,
    summaryText: null,
    summaryStructured: null,
    summaryEvidence: null,
    summaryModel: null,
    summaryTokens: null,
    summaryGeneratedAt: null,
  };
}

/**
 * Check if Postgres checkpointer should be used for resumability
 */
function shouldUseCheckpointer(): boolean {
  return process.env.USE_LANGGRAPH_CHECKPOINTER === 'true';
}

/**
 * Get the database connection string for checkpointer
 */
function getCheckpointerConnectionString(): string | null {
  return process.env.DIRECT_URL || process.env.DATABASE_URL || null;
}

// Cached compiled graph with checkpointer (singleton)
let compiledGraphWithCheckpointer: Awaited<
  ReturnType<typeof buildEnrichmentGraphWithCheckpointer>
> | null = null;

/**
 * Run enrichment for a candidate
 *
 * If USE_LANGGRAPH_CHECKPOINTER=true and a valid database connection is available,
 * the graph will use a Postgres checkpointer for state persistence and resumability.
 * The sessionId is used as the thread_id for checkpoint identification.
 */
export async function runEnrichment(
  input: EnrichmentGraphInput,
  options?: {
    onProgress?: (event: EnrichmentState['progressEvents'][0]) => void;
  }
): Promise<EnrichmentGraphOutput> {
  const startTime = Date.now();

  // Determine if we should use checkpointer for resumability
  const useCheckpointer = shouldUseCheckpointer();
  const connectionString = getCheckpointerConnectionString();

  let graph;
  if (useCheckpointer && connectionString) {
    // Use graph with checkpointer for resumability
    if (!compiledGraphWithCheckpointer) {
      console.log('[runEnrichment] Initializing graph with Postgres checkpointer');
      compiledGraphWithCheckpointer = await buildEnrichmentGraphWithCheckpointer(connectionString);
    }
    graph = compiledGraphWithCheckpointer;
  } else {
    // Use basic graph without checkpointer
    graph = buildEnrichmentGraph();
  }

  const initialState = createInitialState(input);

  // Use sessionId as thread_id for checkpointer resumability
  const threadId = (initialState as EnrichmentState).sessionId;
  const config = useCheckpointer ? { configurable: { thread_id: threadId } } : undefined;

  // Stream the graph execution
  const stream = await graph.stream(initialState as EnrichmentState, {
    streamMode: 'values',
    ...config,
  });

  let finalState: EnrichmentState | null = null;

  let emittedProgressCount = 0;
  for await (const state of stream) {
    finalState = state as EnrichmentState;

    // Emit progress events if callback provided
    if (options?.onProgress && finalState.progressEvents) {
      const nextEvents = finalState.progressEvents.slice(emittedProgressCount);
      emittedProgressCount = finalState.progressEvents.length;
      for (const event of nextEvents) {
        options.onProgress(event);
      }
    }
  }

  if (!finalState) {
    throw new Error('Graph execution produced no final state');
  }

  return {
    candidateId: input.candidateId,
    sessionId: finalState.sessionId,
    status: finalState.status,
    identitiesFound: finalState.identitiesFound,
    bestConfidence: finalState.bestConfidence,
    platformResults: finalState.platformResults,
    queriesExecuted: finalState.queriesExecuted,
    sourcesExecuted: finalState.sourcesExecuted,
    earlyStopReason: finalState.earlyStopReason,
    durationMs: Date.now() - startTime,
    errors: finalState.errors,
  };
}

/**
 * Build graph with PostgreSQL checkpointer for resumability
 */
export async function buildEnrichmentGraphWithCheckpointer(
  connectionString: string
) {
  // Dynamic import (non-literal) to avoid TS module resolution errors when the optional
  // dependency isn't installed in all environments.
  const moduleName = '@langchain/langgraph-checkpoint-postgres';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  const { PostgresSaver } = await import(moduleName);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  const checkpointer = PostgresSaver.fromConnString(connectionString);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  await checkpointer.setup();

  const graph = new StateGraph(EnrichmentStateAnnotation)
    .addNode(NODES.LOAD_CANDIDATE, loadCandidateNode)
    .addNode(NODES.GITHUB_BRIDGE, githubBridgeNode)
    .addNode(NODES.SEARCH_PLATFORMS, searchPlatformsBatchNode)
    .addNode(NODES.AGGREGATE, aggregateResultsNode)
    .addNode(NODES.PERSIST_IDENTITIES, persistResultsNode)
    .addNode(NODES.FETCH_PLATFORM_DATA, fetchPlatformDataNode)
    .addNode(NODES.GENERATE_SUMMARY, generateSummaryNode)
    .addNode(NODES.PERSIST_SUMMARY, persistSummaryNode)
    .addEdge('__start__', NODES.LOAD_CANDIDATE)
    .addConditionalEdges(NODES.LOAD_CANDIDATE, (state) => {
      if (state.status === 'failed') {
        return END;
      }
      return NODES.GITHUB_BRIDGE;
    })
    .addConditionalEdges(NODES.GITHUB_BRIDGE, routeAfterGitHub)
    .addEdge(NODES.SEARCH_PLATFORMS, NODES.AGGREGATE)
    .addEdge(NODES.AGGREGATE, NODES.PERSIST_IDENTITIES)
    .addEdge(NODES.PERSIST_IDENTITIES, NODES.FETCH_PLATFORM_DATA)
    .addEdge(NODES.FETCH_PLATFORM_DATA, NODES.GENERATE_SUMMARY)
    .addEdge(NODES.GENERATE_SUMMARY, NODES.PERSIST_SUMMARY)
    .addEdge(NODES.PERSIST_SUMMARY, END);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  return graph.compile({ checkpointer });
}

export default {
  buildEnrichmentGraph,
  buildEnrichmentGraphWithCheckpointer,
  runEnrichment,
  createInitialState,
};
