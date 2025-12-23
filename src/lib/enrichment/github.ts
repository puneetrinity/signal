/**
 * GitHub API Client for Identity Discovery
 *
 * Provides methods for:
 * - User search by name/keywords
 * - Profile fetching
 * - Commit email extraction (evidence pointers only)
 *
 * Rate limits: 60 req/hour unauthenticated, 5000 req/hour with token
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

/**
 * GitHub user search result
 */
export interface GitHubUserSearchResult {
  login: string;
  id: number;
  html_url: string;
  avatar_url: string;
  type: string; // 'User' | 'Organization'
  score: number; // GitHub's relevance score
}

/**
 * GitHub user profile
 */
export interface GitHubUserProfile {
  login: string;
  id: number;
  html_url: string;
  name: string | null;
  company: string | null;
  blog: string | null;
  location: string | null;
  email: string | null; // Public email (often null)
  bio: string | null;
  twitter_username: string | null;
  public_repos: number;
  followers: number;
  following: number;
  created_at: string;
}

/**
 * GitHub commit with author info
 */
export interface GitHubCommit {
  sha: string;
  html_url: string;
  commit: {
    author: {
      name: string;
      email: string;
      date: string;
    };
    message: string;
  };
  author: {
    login: string;
    id: number;
  } | null;
}

/**
 * Evidence pointer for a commit email (NOT the email itself)
 */
export interface CommitEmailEvidence {
  type: 'commit_email';
  commitUrl: string;
  commitSha: string;
  repoFullName: string;
  authorName: string;
  // Email is NOT stored here - derived on demand at confirmation time
}

/**
 * GitHub API error
 */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public rateLimitRemaining?: number,
    public rateLimitReset?: Date
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/**
 * Retry configuration
 */
interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

// Replay mode types (inline to avoid external import)
interface MockGitHubSearchResult {
  login: string;
  name?: string;
  company?: string;
  bio?: string;
  html_url: string;
  followers?: number;
  public_repos?: number;
}

interface MockGitHubUser {
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

// Replay mode module (lazy loaded only when needed)
let replayModule: {
  mockGitHubUserSearch: (query: string) => MockGitHubSearchResult[];
  mockGitHubGetUser: (username: string) => MockGitHubUser | null;
} | null = null;

async function getReplayModule() {
  if (!replayModule && process.env.ENRICHMENT_EVAL_REPLAY === '1') {
    try {
      // Dynamic import only when replay mode is enabled
      // This path is relative from the build output, not source
      const mod = await import(/* webpackIgnore: true */ '../../../eval/replay');
      replayModule = mod;
    } catch (e) {
      console.warn('[GitHub] Replay mode enabled but module not found:', e);
      return null;
    }
  }
  return replayModule;
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function calculateBackoff(attempt: number, config: RetryConfig): number {
  const delay = config.baseDelayMs * Math.pow(2, attempt);
  return Math.min(delay, config.maxDelayMs);
}

/**
 * GitHub API Client
 */
export class GitHubClient {
  private baseUrl = 'https://api.github.com';
  private token: string | null;
  private retryConfig: RetryConfig;

  // Track rate limit state
  private rateLimitRemaining: number = 60;
  private rateLimitReset: Date | null = null;

  constructor(token?: string, retryConfig?: Partial<RetryConfig>) {
    this.token = token || process.env.GITHUB_TOKEN || null;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  /**
   * Check if we should fail-fast due to rate limit
   */
  private shouldFailFast(): boolean {
    // Fail fast if we have very few requests remaining and reset is not soon
    if (this.rateLimitRemaining <= 5 && this.rateLimitReset) {
      const msUntilReset = this.rateLimitReset.getTime() - Date.now();
      // If reset is more than 5 minutes away, fail fast
      if (msUntilReset > 5 * 60 * 1000) {
        return true;
      }
    }
    return false;
  }

  /**
   * Wait for rate limit reset if needed
   */
  private async waitForRateLimitIfNeeded(): Promise<void> {
    if (this.rateLimitRemaining <= 0 && this.rateLimitReset) {
      const msUntilReset = this.rateLimitReset.getTime() - Date.now();
      if (msUntilReset > 0 && msUntilReset < 60000) {
        // Wait up to 1 minute for reset
        console.log(
          `[GitHub] Rate limit exhausted, waiting ${Math.ceil(msUntilReset / 1000)}s for reset`
        );
        await sleep(msUntilReset + 1000); // Add 1s buffer
      }
    }
  }

  /**
   * Make authenticated request to GitHub API with retry/backoff
   *
   * TODO (scale hardening): Add optional AbortSignal support for cancellation.
   * When implementing:
   * - Add `signal?: AbortSignal` parameter
   * - Pass signal to fetch(): fetch(url, { ...options, signal })
   * - In retry loop: if (signal?.aborted) throw new Error('Aborted')
   * - On catch: if (error.name === 'AbortError') don't retry, rethrow immediately
   * - Thread signal through getUser(), getUserRepos(), extractEmailFromCommit()
   *
   * @see src/lib/enrichment/graph/nodes.ts withTimeout() for caller context
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    // Check if we should fail fast
    if (this.shouldFailFast()) {
      throw new GitHubApiError(
        `GitHub API rate limit nearly exhausted (${this.rateLimitRemaining} remaining). Reset at ${this.rateLimitReset?.toISOString()}`,
        429,
        this.rateLimitRemaining,
        this.rateLimitReset || undefined
      );
    }

    // Wait for rate limit reset if needed
    await this.waitForRateLimitIfNeeded();

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...((options.headers as Record<string, string>) || {}),
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
          ...options,
          headers,
        });

        // Update rate limit tracking
        const remaining = response.headers.get('X-RateLimit-Remaining');
        const reset = response.headers.get('X-RateLimit-Reset');

        if (remaining) {
          this.rateLimitRemaining = parseInt(remaining, 10);
        }
        if (reset) {
          this.rateLimitReset = new Date(parseInt(reset, 10) * 1000);
        }

        // Handle rate limit response
        if (response.status === 429 || response.status === 403) {
          const retryAfter = response.headers.get('Retry-After');
          const waitMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : calculateBackoff(attempt, this.retryConfig);

          if (attempt < this.retryConfig.maxRetries && waitMs < 60000) {
            console.log(
              `[GitHub] Rate limited (${response.status}), retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${this.retryConfig.maxRetries})`
            );
            await sleep(waitMs);
            continue;
          }

          throw new GitHubApiError(
            `GitHub API rate limited after ${attempt + 1} attempts`,
            response.status,
            this.rateLimitRemaining,
            this.rateLimitReset || undefined
          );
        }

        // Handle other errors
        if (!response.ok) {
          const errorBody = await response.text();

          // Retry on 5xx errors
          if (response.status >= 500 && attempt < this.retryConfig.maxRetries) {
            const waitMs = calculateBackoff(attempt, this.retryConfig);
            console.log(
              `[GitHub] Server error (${response.status}), retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${this.retryConfig.maxRetries})`
            );
            await sleep(waitMs);
            continue;
          }

          throw new GitHubApiError(
            `GitHub API error: ${response.status} - ${errorBody}`,
            response.status,
            this.rateLimitRemaining,
            this.rateLimitReset || undefined
          );
        }

        // Log warning if rate limit is getting low
        if (this.rateLimitRemaining < 100) {
          console.warn(
            `[GitHub] Rate limit low: ${this.rateLimitRemaining} remaining, resets at ${this.rateLimitReset?.toISOString()}`
          );
        }

        return response.json();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on client errors (4xx except 429/403)
        if (error instanceof GitHubApiError && error.statusCode < 500 && error.statusCode !== 429 && error.statusCode !== 403) {
          throw error;
        }

        // Retry on network errors
        if (attempt < this.retryConfig.maxRetries) {
          const waitMs = calculateBackoff(attempt, this.retryConfig);
          console.log(
            `[GitHub] Request failed, retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${this.retryConfig.maxRetries}): ${lastError.message}`
          );
          await sleep(waitMs);
        }
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus(): { remaining: number; resetAt: Date | null } {
    return {
      remaining: this.rateLimitRemaining,
      resetAt: this.rateLimitReset,
    };
  }

  /**
   * Search for GitHub users by query
   *
   * @param query - Search terms (name, keywords)
   * @param maxResults - Maximum results to return
   * @returns Array of user search results
   */
  async searchUsers(
    query: string,
    maxResults: number = 10
  ): Promise<GitHubUserSearchResult[]> {
    // Check for replay mode
    if (process.env.ENRICHMENT_EVAL_REPLAY === '1') {
      const replay = await getReplayModule();
      if (replay) {
        const mockResults = replay.mockGitHubUserSearch(query);
        return mockResults.map((r, idx) => ({
          login: r.login,
          id: idx + 1000,
          html_url: r.html_url,
          avatar_url: '',
          type: 'User',
          score: 100 - idx,
        })).slice(0, maxResults);
      }
      // Fall through to real API if replay module not available
    }

    const params = new URLSearchParams({
      q: `${query} type:user`,
      per_page: Math.min(maxResults, 100).toString(),
      sort: 'followers', // Prefer users with more followers
    });

    const response = await this.request<{
      total_count: number;
      incomplete_results: boolean;
      items: GitHubUserSearchResult[];
    }>(`/search/users?${params}`);

    return response.items.slice(0, maxResults);
  }

  /**
   * Get detailed user profile
   *
   * @param username - GitHub username
   * @returns User profile
   */
  async getUser(username: string): Promise<GitHubUserProfile> {
    // Check for replay mode
    if (process.env.ENRICHMENT_EVAL_REPLAY === '1') {
      const replay = await getReplayModule();
      if (replay) {
        const mockUser = replay.mockGitHubGetUser(username);
        if (mockUser) {
          return {
            login: mockUser.login,
            id: 1000,
            html_url: mockUser.html_url,
            name: mockUser.name,
            company: mockUser.company,
            blog: mockUser.blog,
            location: mockUser.location,
            email: null,
            bio: mockUser.bio,
            twitter_username: null,
            public_repos: mockUser.public_repos,
            followers: mockUser.followers,
            following: 0,
            created_at: '2020-01-01T00:00:00Z',
          };
        }
        throw new GitHubApiError(`User not found in replay: ${username}`, 404);
      }
      // Fall through to real API if replay module not available
    }

    return this.request<GitHubUserProfile>(`/users/${encodeURIComponent(username)}`);
  }

  /**
   * Get recent commits by a user across their repos
   * Returns evidence pointers, NOT extracted emails
   *
   * @param username - GitHub username
   * @param maxRepos - Maximum repos to check
   * @param maxCommitsPerRepo - Maximum commits per repo
   * @returns Array of commit evidence pointers
   */
  async getCommitEvidence(
    username: string,
    maxRepos: number = 5,
    maxCommitsPerRepo: number = 3
  ): Promise<CommitEmailEvidence[]> {
    const evidence: CommitEmailEvidence[] = [];

    try {
      // Get user's repos (sorted by recent push)
      const repos = await this.request<
        Array<{
          full_name: string;
          pushed_at: string;
          fork: boolean;
        }>
      >(
        `/users/${encodeURIComponent(username)}/repos?sort=pushed&per_page=${maxRepos}`
      );

      // Filter out forks (less likely to have their real commits)
      const ownedRepos = repos.filter((r) => !r.fork).slice(0, maxRepos);

      // Get commits from each repo
      for (const repo of ownedRepos) {
        try {
          const commits = await this.request<GitHubCommit[]>(
            `/repos/${repo.full_name}/commits?author=${encodeURIComponent(username)}&per_page=${maxCommitsPerRepo}`
          );

          for (const commit of commits) {
            // Only include commits where the GitHub user matches
            if (commit.author?.login?.toLowerCase() === username.toLowerCase()) {
              evidence.push({
                type: 'commit_email',
                commitUrl: commit.html_url,
                commitSha: commit.sha,
                repoFullName: repo.full_name,
                authorName: commit.commit.author.name,
                // Note: email NOT stored here - extracted on demand
              });
            }
          }
        } catch (error) {
          // Skip repos we can't access
          console.warn(
            `[GitHub] Failed to get commits for ${repo.full_name}:`,
            error instanceof Error ? error.message : error
          );
        }
      }
    } catch (error) {
      console.error(
        `[GitHub] Failed to get repos for ${username}:`,
        error instanceof Error ? error.message : error
      );
    }

    return evidence;
  }

  /**
   * Extract email from a specific commit (for confirmation flow)
   * Only call this when revealing email to recruiter
   *
   * ⚠️ COMPLIANCE NOTE: This extracts PII (email) from public commits.
   * Ensure appropriate consent/legal basis before exposing to end users.
   *
   * @param repoFullName - Repository full name (owner/repo)
   * @param commitSha - Commit SHA
   * @returns Email address or null
   */
  async extractEmailFromCommit(
    repoFullName: string,
    commitSha: string
  ): Promise<string | null> {
    // Check if email extraction is allowed
    if (process.env.DISABLE_EMAIL_EXTRACTION === 'true') {
      console.warn('[GitHub] Email extraction disabled via DISABLE_EMAIL_EXTRACTION');
      return null;
    }

    try {
      console.log(`[GitHub] Extracting email from commit (compliance-sensitive operation)`);

      const commit = await this.request<GitHubCommit>(
        `/repos/${repoFullName}/commits/${commitSha}`
      );

      const email = commit.commit.author.email;

      // Filter out GitHub's noreply addresses
      if (email && !email.includes('noreply.github.com')) {
        return email;
      }

      return null;
    } catch (error) {
      console.error(
        `[GitHub] Failed to extract email from commit ${commitSha}:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  /**
   * Get user's top repositories with language info
   * @param username - GitHub username
   * @param limit - Max repos to return
   */
  async getUserRepos(
    username: string,
    limit: number = 10
  ): Promise<Array<{ name: string; language: string | null; stars: number; description: string | null }>> {
    try {
      const repos = await this.request<
        Array<{
          name: string;
          language: string | null;
          stargazers_count: number;
          description: string | null;
          fork: boolean;
        }>
      >(`/users/${encodeURIComponent(username)}/repos?sort=pushed&per_page=${limit}`);

      return repos
        .filter((r) => !r.fork)
        .slice(0, limit)
        .map((r) => ({
          name: r.name,
          language: r.language,
          stars: r.stargazers_count,
          description: r.description,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Check rate limit status
   */
  async getRateLimit(): Promise<{
    limit: number;
    remaining: number;
    reset: Date;
    used: number;
  }> {
    const response = await this.request<{
      resources: {
        core: {
          limit: number;
          remaining: number;
          reset: number;
          used: number;
        };
      };
    }>('/rate_limit');

    return {
      limit: response.resources.core.limit,
      remaining: response.resources.core.remaining,
      reset: new Date(response.resources.core.reset * 1000),
      used: response.resources.core.used,
    };
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    authenticated: boolean;
    rateLimit?: { remaining: number; limit: number };
    error?: string;
  }> {
    try {
      const rateLimit = await this.getRateLimit();
      return {
        healthy: true,
        authenticated: !!this.token,
        rateLimit: {
          remaining: rateLimit.remaining,
          limit: rateLimit.limit,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        authenticated: !!this.token,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

// Singleton instance
let githubClient: GitHubClient | null = null;
let hasLoggedTokenWarning = false;

/**
 * Get GitHub client instance
 */
export function getGitHubClient(): GitHubClient {
  if (!githubClient) {
    githubClient = new GitHubClient();

    // Log warning about unauthenticated rate limits
    if (!process.env.GITHUB_TOKEN && !hasLoggedTokenWarning) {
      hasLoggedTokenWarning = true;
      console.warn(
        '[GitHub] ⚠️  GITHUB_TOKEN not set - using unauthenticated rate limits (60 req/hr vs 5000 req/hr with token). ' +
        'Get a token at: https://github.com/settings/tokens'
      );
    }
  }
  return githubClient;
}

export default GitHubClient;
