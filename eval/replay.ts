/**
 * Replay Mode Infrastructure
 *
 * Provides mock executors for web search and GitHub API
 * that return deterministic results from fixture data.
 */

import * as fs from 'fs';
import * as readline from 'readline';
import type {
  EvalFixture,
  FixtureMocks,
  MockSearchResult,
  MockGitHubSearchResult,
  MockGitHubUser,
} from './types';

/**
 * Check if replay mode is enabled
 */
export function isReplayMode(): boolean {
  return process.env.ENRICHMENT_EVAL_REPLAY === '1';
}

/**
 * Get fixture path from environment
 */
export function getFixturePath(): string {
  return process.env.ENRICHMENT_EVAL_FIXTURE_PATH || 'eval/fixtures/candidates.jsonl';
}

/**
 * In-memory fixture store (loaded once per eval run)
 */
let fixtureStore: Map<string, EvalFixture> | null = null;

/**
 * Currently active fixture for replay
 */
let activeFixture: EvalFixture | null = null;

/**
 * Trace of queries executed during replay
 */
export interface ReplayTrace {
  webSearchQueries: string[];
  githubSearchQueries: string[];
  githubUserFetches: string[];
}

let currentTrace: ReplayTrace = {
  webSearchQueries: [],
  githubSearchQueries: [],
  githubUserFetches: [],
};

/**
 * Load all fixtures from JSONL file
 */
export async function loadFixtures(path?: string): Promise<Map<string, EvalFixture>> {
  if (fixtureStore) {
    return fixtureStore;
  }

  const fixturePath = path || getFixturePath();
  const fixtures = new Map<string, EvalFixture>();

  const fileStream = fs.createReadStream(fixturePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      const fixture = JSON.parse(line) as EvalFixture;
      fixtures.set(fixture.candidateId, fixture);
      // Also index by linkedinId for easier lookup
      fixtures.set(fixture.linkedinId, fixture);
    }
  }

  fixtureStore = fixtures;
  console.log(`[ReplayMode] Loaded ${fixtures.size / 2} fixtures from ${fixturePath}`);
  return fixtures;
}

/**
 * Set the active fixture for the current enrichment run
 */
export function setActiveFixture(fixture: EvalFixture): void {
  activeFixture = fixture;
  currentTrace = {
    webSearchQueries: [],
    githubSearchQueries: [],
    githubUserFetches: [],
  };
}

/**
 * Get the current replay trace
 */
export function getReplayTrace(): ReplayTrace {
  return { ...currentTrace };
}

/**
 * Clear the active fixture
 */
export function clearActiveFixture(): void {
  activeFixture = null;
}

/**
 * Get fixture by candidate ID or LinkedIn ID
 */
export async function getFixture(id: string): Promise<EvalFixture | null> {
  const fixtures = await loadFixtures();
  return fixtures.get(id) || null;
}

/**
 * Mock web search executor
 *
 * Returns results from the active fixture's mock.webSearch.queries
 */
export function mockWebSearch(query: string): MockSearchResult[] {
  if (!activeFixture) {
    console.warn('[ReplayMode] No active fixture set for web search');
    return [];
  }

  currentTrace.webSearchQueries.push(query);

  // Try exact match first
  const exactResults = activeFixture.mock.webSearch.queries[query];
  if (exactResults) {
    console.log(`[ReplayMode] Web search "${query}" -> ${exactResults.length} results`);
    return exactResults;
  }

  // Try normalized match (lowercase, trimmed)
  const normalizedQuery = query.toLowerCase().trim();
  for (const [key, results] of Object.entries(activeFixture.mock.webSearch.queries)) {
    if (key.toLowerCase().trim() === normalizedQuery) {
      console.log(`[ReplayMode] Web search "${query}" (normalized) -> ${results.length} results`);
      return results;
    }
  }

  // Try partial match (query contains fixture query or vice versa)
  for (const [key, results] of Object.entries(activeFixture.mock.webSearch.queries)) {
    if (normalizedQuery.includes(key.toLowerCase()) || key.toLowerCase().includes(normalizedQuery)) {
      console.log(`[ReplayMode] Web search "${query}" (partial) -> ${results.length} results`);
      return results;
    }
  }

  console.log(`[ReplayMode] Web search "${query}" -> 0 results (no mock)`);
  return [];
}

/**
 * Mock GitHub user search executor
 *
 * Returns results from the active fixture's mock.githubUserSearch.queries
 */
export function mockGitHubUserSearch(query: string): MockGitHubSearchResult[] {
  if (!activeFixture) {
    console.warn('[ReplayMode] No active fixture set for GitHub search');
    return [];
  }

  currentTrace.githubSearchQueries.push(query);

  // Try exact match first
  const exactResults = activeFixture.mock.githubUserSearch.queries[query];
  if (exactResults) {
    console.log(`[ReplayMode] GitHub search "${query}" -> ${exactResults.length} results`);
    return exactResults;
  }

  // Try normalized match
  const normalizedQuery = query.toLowerCase().trim();
  for (const [key, results] of Object.entries(activeFixture.mock.githubUserSearch.queries)) {
    if (key.toLowerCase().trim() === normalizedQuery) {
      console.log(`[ReplayMode] GitHub search "${query}" (normalized) -> ${results.length} results`);
      return results;
    }
  }

  // Try partial match for name queries
  for (const [key, results] of Object.entries(activeFixture.mock.githubUserSearch.queries)) {
    const keyLower = key.toLowerCase().replace(/"/g, '');
    const queryLower = normalizedQuery.replace(/"/g, '');
    if (keyLower.includes(queryLower) || queryLower.includes(keyLower)) {
      console.log(`[ReplayMode] GitHub search "${query}" (partial) -> ${results.length} results`);
      return results;
    }
  }

  console.log(`[ReplayMode] GitHub search "${query}" -> 0 results (no mock)`);
  return [];
}

/**
 * Mock GitHub user profile fetch
 *
 * Returns user from the active fixture's mock.githubUser
 */
export function mockGitHubGetUser(username: string): MockGitHubUser | null {
  if (!activeFixture) {
    console.warn('[ReplayMode] No active fixture set for GitHub user fetch');
    return null;
  }

  currentTrace.githubUserFetches.push(username);

  const user = activeFixture.mock.githubUser[username];
  if (user) {
    console.log(`[ReplayMode] GitHub user "${username}" -> found`);
    return user;
  }

  // Try case-insensitive match
  const userLower = username.toLowerCase();
  for (const [key, profile] of Object.entries(activeFixture.mock.githubUser)) {
    if (key.toLowerCase() === userLower) {
      console.log(`[ReplayMode] GitHub user "${username}" (case-insensitive) -> found`);
      return profile;
    }
  }

  console.log(`[ReplayMode] GitHub user "${username}" -> not found`);
  return null;
}

/**
 * Reset fixture store (for testing)
 */
export function resetFixtureStore(): void {
  fixtureStore = null;
  activeFixture = null;
  currentTrace = {
    webSearchQueries: [],
    githubSearchQueries: [],
    githubUserFetches: [],
  };
}

export default {
  isReplayMode,
  loadFixtures,
  setActiveFixture,
  clearActiveFixture,
  getFixture,
  getReplayTrace,
  mockWebSearch,
  mockGitHubUserSearch,
  mockGitHubGetUser,
  resetFixtureStore,
};
