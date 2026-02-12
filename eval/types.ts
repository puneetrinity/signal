/**
 * Evaluation Harness Types
 *
 * Defines the fixture format and evaluation result types for
 * offline testing of the enrichment pipeline.
 */

import type { BridgeTier, BridgeSignal } from '../src/lib/enrichment/bridge-types';

/**
 * Gold standard identity for evaluation
 */
export interface GoldIdentity {
  platform: string;
  url: string;
  username: string;
}

/**
 * Gold standard labels for a candidate
 */
export interface GoldLabels {
  /** The confirmed identity (null if no match expected) */
  confirmedIdentity: GoldIdentity | null;
  /** Whether auto-merge should be allowed for this candidate */
  autoMergeAllowed: boolean;
  /** Expected tier (1, 2, or 3) */
  tier: BridgeTier;
}

/**
 * Mock web search result
 */
export interface MockSearchResult {
  url: string;
  title: string;
  snippet: string;
}

/**
 * Mock GitHub user from search
 */
export interface MockGitHubSearchResult {
  login: string;
  name?: string;
  company?: string;
  bio?: string;
  html_url: string;
  followers?: number;
  public_repos?: number;
}

/**
 * Mock GitHub user profile (full)
 */
export interface MockGitHubUser {
  login: string;
  name: string | null;
  company: string | null;
  location: string | null;
  bio: string | null;
  blog: string;
  html_url: string;
  followers: number;
  public_repos: number;
}

/**
 * Mock data for a fixture
 */
export interface FixtureMocks {
  /** Web search results by query */
  webSearch: {
    queries: Record<string, MockSearchResult[]>;
  };
  /** GitHub user search results by query */
  githubUserSearch: {
    queries: Record<string, MockGitHubSearchResult[]>;
  };
  /** GitHub user profiles by username */
  githubUser: Record<string, MockGitHubUser>;
}

/**
 * SERP data from original LinkedIn search
 */
export interface SerpData {
  title: string;
  snippet: string;
  /** KG/answerBox metadata from Serper.dev (optional, for KG-enriched fixtures) */
  meta?: Record<string, unknown>;
}

/**
 * Single fixture (one line in JSONL)
 */
export interface EvalFixture {
  candidateId: string;
  tenantId: string;
  linkedinUrl: string;
  linkedinId: string;
  serp: SerpData;
  gold: GoldLabels;
  mock: FixtureMocks;
}

/**
 * Discovered identity from enrichment (simplified for eval)
 */
export interface EvalDiscoveredIdentity {
  platform: string;
  platformId: string;
  profileUrl: string;
  confidence: number;
  bridgeTier: BridgeTier;
  bridgeSignals: BridgeSignal[];
  persistReason: string;
  autoMergeEligible: boolean;
}

/**
 * Result of running enrichment on a single fixture
 */
export interface EvalCandidateResult {
  candidateId: string;
  linkedinId: string;

  // Outputs
  identitiesFound: EvalDiscoveredIdentity[];
  persistedIdentities: EvalDiscoveredIdentity[];
  topIdentity: EvalDiscoveredIdentity | null;

  // Decisions
  autoMergeDecision: boolean;
  autoMergedIdentity: EvalDiscoveredIdentity | null;

  // Metrics
  queriesExecuted: number;
  queriesByType: Record<string, number>;
  bridgesDetected: number;
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;

  // Correctness (computed from gold)
  topIdentityCorrect: boolean | null;
  autoMergeCorrect: boolean | null;
  tierCorrect: boolean;
  hasContradiction: boolean;

  // Trace for debugging
  trace: {
    webSearchQueries: string[];
    githubSearchQueries: string[];
    bridgeSignalsFound: BridgeSignal[];
  };
}

/**
 * Aggregate evaluation summary
 */
export interface EvalSummary {
  // Counts
  totalCandidates: number;
  candidatesWithPersistedIdentity: number;
  candidatesWithTier1: number;
  candidatesWithTier2: number;
  candidatesWithTier3Only: number;

  // Auto-merge metrics
  autoMergeAttempts: number;
  autoMergeCorrect: number;
  autoMergeIncorrect: number;
  autoMergePrecision: number;
  autoMergeRecall: number;

  // Tier detection
  tier1ExpectedCount: number;
  tier1DetectedCount: number;
  tier1DetectionRecall: number;

  // Top-1 accuracy
  topIdentityAttempts: number;
  topIdentityCorrect: number;
  topIdentityAccuracy: number;

  // Tier correctness
  tierCorrectCount: number;
  tierAccuracy: number;

  // Cost metrics
  avgQueriesPerCandidate: number;
  totalQueries: number;

  // Contradiction tracking
  contradictionCount: number;
  contradictionRate: number;

  // CI gate results
  passedCIGates: boolean;
  ciGateResults: {
    autoMergePrecision: { passed: boolean; value: number; threshold: number };
    tier1DetectionRecall: { passed: boolean; value: number; threshold: number };
    candidatesWithPersistedIdentity: { passed: boolean; value: number; threshold: number };
  };
}

/**
 * Eval run configuration
 */
export interface EvalConfig {
  thresholds: {
    autoMergeMinScore: number;
    tier2HandleMin: number;
    tier2NameMin: number;
    persistMinScore: number;
  };
  caps: {
    tier2GlobalMax: number;
  };
  modes: {
    enableUrlReverse: boolean;
    enableHintConfidenceGating: boolean;
  };
  ciGates: {
    autoMergePrecision: number;
    tier1DetectionRecall: number;
    candidatesWithPersistedIdentityDelta: number;
  };
}

/**
 * Full eval run output
 */
export interface EvalOutput {
  config: EvalConfig;
  summary: EvalSummary;
  results: EvalCandidateResult[];
  timestamp: string;
  durationMs: number;
}
