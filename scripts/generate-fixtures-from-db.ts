/**
 * Generate Eval Fixtures from Production Database
 *
 * Connects to the Railway PostgreSQL database and generates eval fixtures
 * from real candidate data, including confirmed identities, high-confidence
 * identity candidates, and negative examples.
 *
 * Usage:
 *   npx tsx scripts/generate-fixtures-from-db.ts
 *   npx tsx scripts/generate-fixtures-from-db.ts --output eval/fixtures/candidates-real.jsonl
 *   npx tsx scripts/generate-fixtures-from-db.ts --dry-run
 *
 * The generated JSONL file can be used with the eval harness:
 *   npx tsx scripts/eval-enrichment.ts --fixture eval/fixtures/candidates-real.jsonl
 */

import pg from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const { Client } = pg;

/**
 * Deterministic pseudo-random number generator seeded by a string key.
 * Returns a function that produces stable values in [0, 1) for the same key.
 */
function seededRng(seed: string): () => number {
  const hash = crypto.createHash('sha256').update(seed).digest();
  let offset = 0;
  return () => {
    // Read 4 bytes as uint32, advance offset (wrap around at 28 to stay in 32-byte hash)
    const val = hash.readUInt32BE(offset % 28);
    offset += 4;
    return (val & 0x7fffffff) / 0x80000000;
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required.');
  process.exit(1);
}

/** LinkedIn IDs with known confirmed identities (ground truth) */
const CONFIRMED_LINKEDIN_IDS = ['umair-ahmad-khan', 'kitarp29', 'yogi-dev'];

/** Minimum confidence threshold for "high-confidence" identity candidates */
const HIGH_CONFIDENCE_THRESHOLD = 0.5;

/** Number of negative examples (no identities) to sample */
const NEGATIVE_SAMPLE_SIZE = 5;

// ---------------------------------------------------------------------------
// Types (row shapes from SQL queries)
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  tenantId: string;
  linkedinUrl: string;
  linkedinId: string;
  searchTitle: string | null;
  searchSnippet: string | null;
  searchMeta: Record<string, unknown> | null;
  nameHint: string | null;
  companyHint: string | null;
  locationHint: string | null;
  headlineHint: string | null;
  enrichmentStatus: string;
  confidenceScore: number | null;
}

interface IdentityCandidateRow {
  id: string;
  candidateId: string;
  platform: string;
  platformId: string;
  profileUrl: string;
  confidence: number;
  bridgeTier: number | null;
  bridgeSignals: string[] | null;
  persistReason: string | null;
  scoreBreakdown: Record<string, unknown> | null;
  evidence: Record<string, unknown> | null;
}

interface ConfirmedIdentityRow {
  id: string;
  candidateId: string;
  platform: string;
  platformId: string;
  profileUrl: string;
  confirmedBy: string;
  profileData: Record<string, unknown> | null;
}

interface EvalFixture {
  candidateId: string;
  tenantId: string;
  linkedinUrl: string;
  linkedinId: string;
  serp: {
    title: string;
    snippet: string;
    meta?: Record<string, unknown>;
  };
  gold: {
    confirmedIdentity: { platform: string; url: string; username: string } | null;
    autoMergeAllowed: boolean;
    tier: 1 | 2 | 3;
  };
  mock: {
    webSearch: { queries: Record<string, MockSearchResult[]> };
    githubUserSearch: { queries: Record<string, MockGitHubSearchResult[]> };
    githubUser: Record<string, MockGitHubUser>;
  };
}

interface MockSearchResult {
  url: string;
  title: string;
  snippet: string;
}

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

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { outputPath: string; dryRun: boolean; verbose: boolean } {
  const args = process.argv.slice(2);
  let outputPath = 'eval/fixtures/candidates-real.jsonl';
  let dryRun = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    }
  }

  return { outputPath, dryRun, verbose };
}

// ---------------------------------------------------------------------------
// Database queries
// ---------------------------------------------------------------------------

async function fetchCandidatesByLinkedinIds(
  client: pg.Client,
  linkedinIds: string[]
): Promise<CandidateRow[]> {
  if (linkedinIds.length === 0) return [];
  const placeholders = linkedinIds.map((_: string, i: number) => `$${i + 1}`).join(', ');
  const result = await client.query<CandidateRow>(
    `SELECT
       id, "tenantId", "linkedinUrl", "linkedinId",
       "searchTitle", "searchSnippet", "searchMeta",
       "nameHint", "companyHint", "locationHint", "headlineHint",
       "enrichmentStatus", "confidenceScore"
     FROM candidates
     WHERE "linkedinId" IN (${placeholders})
     ORDER BY "createdAt"`,
    linkedinIds
  );
  return result.rows;
}

async function fetchHighConfidenceCandidates(
  client: pg.Client,
  minConfidence: number,
  excludeLinkedinIds: string[]
): Promise<CandidateRow[]> {
  // Find candidates that have at least one identity_candidate >= threshold
  // but exclude the ones already fetched as confirmed
  const excludePlaceholders = excludeLinkedinIds.map((_: string, i: number) => `$${i + 2}`).join(', ');
  const excludeClause = excludeLinkedinIds.length > 0
    ? `AND c."linkedinId" NOT IN (${excludePlaceholders})`
    : '';

  const result = await client.query<CandidateRow>(
    `SELECT DISTINCT ON (c.id)
       c.id, c."tenantId", c."linkedinUrl", c."linkedinId",
       c."searchTitle", c."searchSnippet", c."searchMeta",
       c."nameHint", c."companyHint", c."locationHint", c."headlineHint",
       c."enrichmentStatus", c."confidenceScore"
     FROM candidates c
     JOIN identity_candidates ic ON ic."candidateId" = c.id
     WHERE ic.confidence >= $1
       ${excludeClause}
     ORDER BY c.id, ic.confidence DESC`,
    [minConfidence, ...excludeLinkedinIds]
  );
  return result.rows;
}

async function fetchNegativeExamples(
  client: pg.Client,
  limit: number,
  excludeCandidateIds: string[]
): Promise<CandidateRow[]> {
  // Candidates with completed enrichment but NO identity_candidates at all
  const excludePlaceholders = excludeCandidateIds.map((_: string, i: number) => `$${i + 2}`).join(', ');
  const excludeClause = excludeCandidateIds.length > 0
    ? `AND c.id NOT IN (${excludePlaceholders})`
    : '';

  const result = await client.query<CandidateRow>(
    `SELECT
       c.id, c."tenantId", c."linkedinUrl", c."linkedinId",
       c."searchTitle", c."searchSnippet", c."searchMeta",
       c."nameHint", c."companyHint", c."locationHint", c."headlineHint",
       c."enrichmentStatus", c."confidenceScore"
     FROM candidates c
     LEFT JOIN identity_candidates ic ON ic."candidateId" = c.id
     WHERE ic.id IS NULL
       AND c."enrichmentStatus" = 'completed'
       ${excludeClause}
     ORDER BY c."createdAt" DESC
     LIMIT $1`,
    [limit, ...excludeCandidateIds]
  );
  return result.rows;
}

async function fetchConfirmedIdentities(
  client: pg.Client,
  candidateIds: string[]
): Promise<ConfirmedIdentityRow[]> {
  if (candidateIds.length === 0) return [];
  const placeholders = candidateIds.map((_, i) => `$${i + 1}`).join(', ');
  const result = await client.query<ConfirmedIdentityRow>(
    `SELECT
       id, "candidateId", platform, "platformId", "profileUrl",
       "confirmedBy", "profileData"
     FROM confirmed_identities
     WHERE "candidateId" IN (${placeholders})`,
    candidateIds
  );
  return result.rows;
}

async function fetchIdentityCandidates(
  client: pg.Client,
  candidateIds: string[]
): Promise<IdentityCandidateRow[]> {
  if (candidateIds.length === 0) return [];
  const placeholders = candidateIds.map((_, i) => `$${i + 1}`).join(', ');
  const result = await client.query<IdentityCandidateRow>(
    `SELECT
       id, "candidateId", platform, "platformId", "profileUrl",
       confidence, "bridgeTier", "bridgeSignals", "persistReason",
       "scoreBreakdown", evidence
     FROM identity_candidates
     WHERE "candidateId" IN (${placeholders})
     ORDER BY confidence DESC`,
    candidateIds
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Mock data generation
// ---------------------------------------------------------------------------

/**
 * Build synthetic mock web search results.
 *
 * Causally faithful: only include signals that match the actual scoring path.
 * - bridge_url path: reverse-URL search returns the GitHub profile with LinkedIn URL
 * - commit_email / name_company: reverse-URL returns empty, name search may return GitHub profile
 * - none: all queries return empty
 */
function buildMockWebSearch(
  candidate: CandidateRow,
  githubUsername: string | null,
  tier: 1 | 2 | 3,
  bridgeSignals: string[],
  scoringPath: 'bridge_url' | 'commit_email' | 'name_company' | 'none'
): Record<string, MockSearchResult[]> {
  const queries: Record<string, MockSearchResult[]> = {};
  const linkedinUrl = candidate.linkedinUrl;

  // Reverse-URL query (the primary Tier-1 detection path)
  const reverseQuery = `"${linkedinUrl}"`;
  const reverseQuerySiteGh = `"${linkedinUrl}" site:github.com`;

  if (scoringPath === 'bridge_url' && githubUsername) {
    // Only for actual bridge_url path: reverse URL search finds the GitHub profile
    const ghResult: MockSearchResult = {
      url: `https://github.com/${githubUsername}`,
      title: `${githubUsername} (${candidate.nameHint || candidate.linkedinId})`,
      snippet: `${candidate.headlineHint || 'Developer'}. ${linkedinUrl}`,
    };
    queries[reverseQuery] = [ghResult];
    queries[reverseQuerySiteGh] = [ghResult];
  } else {
    // Non-Tier-1 paths: reverse URL search finds nothing
    queries[reverseQuery] = [];
    queries[reverseQuerySiteGh] = [];
  }

  // Name-based web search (used by query strategies for all paths)
  if (candidate.nameHint) {
    const nameQuery = `"${candidate.nameHint}" github`;
    if (githubUsername && scoringPath !== 'none') {
      // The name search surfaces the GitHub profile (but without LinkedIn URL in snippet)
      queries[nameQuery] = [
        {
          url: `https://github.com/${githubUsername}`,
          title: `${githubUsername} (${candidate.nameHint})`,
          snippet: `${candidate.companyHint || ''} ${candidate.locationHint || ''}`.trim(),
        },
      ];
    } else {
      queries[nameQuery] = [];
    }
  }

  return queries;
}

/**
 * Build synthetic mock GitHub user search results.
 *
 * Causally faithful: the search results contain only the signals the
 * pipeline actually uses per scoring path. No LinkedIn URLs in bios
 * unless the scoring path is bridge_url.
 *
 * For name_company path: the GitHub user search returns a user with
 * matching name/company (triggering nameMatch + companyMatch in scoring).
 * For commit_email path: the user may or may not appear in search, but
 * the commit evidence is what drives the score.
 */
function buildMockGitHubUserSearch(
  candidate: CandidateRow,
  githubUsername: string | null,
  tier: 1 | 2 | 3,
  bridgeSignals: string[],
  scoringPath: 'bridge_url' | 'commit_email' | 'name_company' | 'none',
  scoreBreakdown: Record<string, number> | null,
  rng: () => number
): Record<string, MockGitHubSearchResult[]> {
  const queries: Record<string, MockGitHubSearchResult[]> = {};
  const name = candidate.nameHint || '';
  const company = candidate.companyHint || '';
  const linkedinUrl = candidate.linkedinUrl;

  // Only bridge_url path puts LinkedIn URL in bio
  const bioText = scoringPath === 'bridge_url'
    ? `${candidate.headlineHint || 'Developer'}. ${linkedinUrl}`
    : candidate.headlineHint || '';

  // For name_company and commit_email paths: user appears in name search
  // For bridge_url: user also appears (found via multiple paths)
  // For none: no match
  const userAppearsInSearch = scoringPath !== 'none' && githubUsername;

  // Build the match result (if applicable)
  const matchResult: MockGitHubSearchResult | null = userAppearsInSearch
    ? {
        login: githubUsername,
        name: name || githubUsername,
        company: company || undefined,
        bio: bioText || undefined,
        html_url: `https://github.com/${githubUsername}`,
        followers: 100 + Math.floor(rng() * 2000),
        public_repos: 5 + Math.floor(rng() * 80),
      }
    : null;

  // Primary: name search
  if (name) {
    const nameQuery = `"${name}"`;
    if (matchResult) {
      queries[nameQuery] = [matchResult];
    } else if (!githubUsername) {
      // Negative example: return unrelated users
      queries[nameQuery] = buildUnrelatedSearchResults(name, rng);
    } else {
      queries[nameQuery] = [];
    }
  }

  // Name + company query (only if company hint exists and was part of scoring)
  if (name && company) {
    const nameCompanyQuery = `"${name}" "${company}"`;
    if (matchResult && scoreBreakdown && scoreBreakdown.companyMatch > 0) {
      queries[nameCompanyQuery] = [matchResult];
    } else if (!githubUsername) {
      queries[nameCompanyQuery] = buildUnrelatedSearchResults(name, rng);
    } else {
      queries[nameCompanyQuery] = [];
    }
  }

  // Company-only query
  if (company) {
    const companyQuery = `"${company}" github`;
    if (matchResult && scoreBreakdown && scoreBreakdown.companyMatch > 0) {
      queries[companyQuery] = [matchResult];
    } else {
      queries[companyQuery] = [];
    }
  }

  // Handle / slug-based queries
  if (candidate.linkedinId) {
    const slugQuery = candidate.linkedinId;
    if (matchResult && scoreBreakdown && scoreBreakdown.handleMatch > 0) {
      queries[slugQuery] = [matchResult];
    } else {
      queries[slugQuery] = [];
    }
  }

  return queries;
}

/**
 * Build a full mock GitHub user profile for the matched identity.
 *
 * Causally faithful: the profile contains only the signals the pipeline
 * actually uses per scoring path.
 * - bridge_url: LinkedIn URL in bio and/or blog field
 * - commit_email: commit evidence exists (separate from profile), profile has name/company
 * - name_company: profile has matching name/company, NO LinkedIn URL anywhere
 */
function buildMockGitHubUser(
  candidate: CandidateRow,
  githubUsername: string,
  tier: 1 | 2 | 3,
  bridgeSignals: string[],
  scoringPath: 'bridge_url' | 'commit_email' | 'name_company' | 'none',
  evidence: Record<string, unknown> | unknown,
  rng: () => number
): MockGitHubUser {
  const linkedinUrl = candidate.linkedinUrl;

  // Only bridge_url path has LinkedIn URL in bio/blog
  let bioText: string | null = null;
  let blogField = '';

  if (scoringPath === 'bridge_url') {
    if (bridgeSignals.includes('linkedin_url_in_bio')) {
      bioText = `${candidate.headlineHint || 'Developer'}. ${linkedinUrl}`;
    }
    if (bridgeSignals.includes('linkedin_url_in_blog')) {
      blogField = linkedinUrl;
    }
    // If neither specific signal but still bridge_url path, put it in bio
    if (!bioText && !blogField) {
      bioText = `${candidate.headlineHint || 'Developer'}. ${linkedinUrl}`;
    }
  } else {
    // Non-bridge paths: no LinkedIn URL in profile
    bioText = candidate.headlineHint || null;
  }

  return {
    login: githubUsername,
    name: candidate.nameHint || null,
    company: candidate.companyHint || null,
    location: candidate.locationHint || null,
    bio: bioText,
    blog: blogField,
    html_url: `https://github.com/${githubUsername}`,
    followers: 100 + Math.floor(rng() * 2000),
    public_repos: 5 + Math.floor(rng() * 80),
  };
}

/**
 * Generate unrelated GitHub search results for negative examples.
 */
function buildUnrelatedSearchResults(nameHint: string, rng: () => number): MockGitHubSearchResult[] {
  const fakeUsers = [
    { login: 'unrelated-user-1', name: 'Someone Else', company: 'OtherCorp' },
    { login: 'random-dev-42', name: 'Random Developer', company: 'UnknownInc' },
    { login: 'code-monkey-99', name: 'Code Monkey', company: '' },
  ];

  return fakeUsers.map((u) => ({
    login: u.login,
    name: u.name,
    company: u.company || undefined,
    bio: 'Just a developer',
    html_url: `https://github.com/${u.login}`,
    followers: Math.floor(rng() * 50),
    public_repos: Math.floor(rng() * 10),
  }));
}

// ---------------------------------------------------------------------------
// Fixture building
// ---------------------------------------------------------------------------

/**
 * Determine the gold tier and auto-merge eligibility for a candidate.
 *
 * Causal faithfulness: the gold tier reflects what the enrichment pipeline
 * would *actually detect*, not the recruiter's manual confirmation status.
 * A recruiter-confirmed Tier-3 match stays Tier-3 in gold labels because
 * the pipeline never produced a Tier-1 bridge for it.
 *
 * Rules:
 *   - Use the identity_candidate's actual bridge_tier/bridge_signals from DB
 *   - If bridge_tier is NULL but score_breakdown has bridgeWeight > 0,
 *     infer commit-email evidence (Tier-3 with commit signals)
 *   - confirmed_identities table tells us the gold identity, NOT the tier
 *   - autoMerge is only true for Tier-1 with explicit bridge signals
 */
function determineGold(
  confirmed: ConfirmedIdentityRow | null,
  topIdentityCandidate: IdentityCandidateRow | null,
  _knownGithub: string | null
): {
  confirmedIdentity: { platform: string; url: string; username: string } | null;
  autoMergeAllowed: boolean;
  tier: 1 | 2 | 3;
  bridgeSignals: string[];
  /** The scoring path observed in production, for mock generation */
  scoringPath: 'bridge_url' | 'commit_email' | 'name_company' | 'none';
} {
  // Determine the identity (who) from confirmed_identities or top candidate
  const identity = confirmed
    ? {
        platform: confirmed.platform,
        url: confirmed.profileUrl,
        username: confirmed.platformId,
      }
    : topIdentityCandidate && topIdentityCandidate.confidence >= 0.5
      ? {
          platform: topIdentityCandidate.platform,
          url: topIdentityCandidate.profileUrl,
          username: topIdentityCandidate.platformId,
        }
      : null;

  // No identity at all
  if (!identity) {
    return {
      confirmedIdentity: null,
      autoMergeAllowed: false,
      tier: 3,
      bridgeSignals: [],
      scoringPath: 'none',
    };
  }

  // Determine the tier/signals from the *pipeline's actual output*
  const signals: string[] =
    (topIdentityCandidate?.bridgeSignals as string[] | null) || [];
  const bridgeTier = topIdentityCandidate?.bridgeTier ?? null;
  const scoreBreakdown = topIdentityCandidate?.scoreBreakdown as Record<string, number> | null;
  const evidence = topIdentityCandidate?.evidence;

  // Infer scoring path from the score_breakdown
  let scoringPath: 'bridge_url' | 'commit_email' | 'name_company' | 'none' = 'none';
  if (signals.some(s => s.includes('linkedin_url'))) {
    scoringPath = 'bridge_url';
  } else if (scoreBreakdown?.bridgeWeight && scoreBreakdown.bridgeWeight > 0) {
    // bridgeWeight > 0 with no URL signals means commit-email evidence
    scoringPath = 'commit_email';
  } else if (scoreBreakdown && (scoreBreakdown.nameMatch > 0 || scoreBreakdown.companyMatch > 0)) {
    scoringPath = 'name_company';
  }

  // Determine tier from actual DB data
  let tier: 1 | 2 | 3;
  if (bridgeTier === 1) {
    tier = 1;
  } else if (bridgeTier === 2) {
    tier = 2;
  } else if (bridgeTier === 3) {
    tier = 3;
  } else {
    // bridgeTier is NULL — infer from scoring path
    // commit_email evidence without explicit tier = Tier 3 (no bidirectional bridge)
    // name_company match without bridge = Tier 3
    tier = scoringPath === 'bridge_url' ? 1 : 3;
  }

  // Auto-merge only for Tier-1 with explicit bridge signals
  const autoMerge = tier === 1 && signals.length > 0;

  return {
    confirmedIdentity: identity,
    autoMergeAllowed: autoMerge,
    tier,
    bridgeSignals: signals,
    scoringPath,
  };
}

/**
 * Build a complete EvalFixture from a candidate row and its associated data.
 */
function buildFixture(
  candidate: CandidateRow,
  confirmed: ConfirmedIdentityRow | null,
  topIdentityCandidate: IdentityCandidateRow | null,
  knownGithub: string | null
): EvalFixture {
  const gold = determineGold(confirmed, topIdentityCandidate, knownGithub);
  const scoreBreakdown = topIdentityCandidate?.scoreBreakdown as Record<string, number> | null;
  const evidence = topIdentityCandidate?.evidence;
  const rng = seededRng(candidate.linkedinId);

  const githubUsername = gold.confirmedIdentity?.platform === 'github'
    ? gold.confirmedIdentity.username
    : topIdentityCandidate?.platform === 'github'
      ? topIdentityCandidate.platformId
      : null;

  // Build SERP data from actual DB fields
  const serp: EvalFixture['serp'] = {
    title: candidate.searchTitle || `${candidate.nameHint || candidate.linkedinId} | LinkedIn`,
    snippet: candidate.searchSnippet || buildFallbackSnippet(candidate),
  };
  if (candidate.searchMeta && Object.keys(candidate.searchMeta).length > 0) {
    serp.meta = candidate.searchMeta;
  }

  // Build mock data — pass scoringPath and scoreBreakdown for causal faithfulness
  const mockWebSearch = buildMockWebSearch(
    candidate,
    githubUsername,
    gold.tier,
    gold.bridgeSignals,
    gold.scoringPath
  );

  const mockGitHubSearch = buildMockGitHubUserSearch(
    candidate,
    githubUsername,
    gold.tier,
    gold.bridgeSignals,
    gold.scoringPath,
    scoreBreakdown,
    rng
  );

  const mockGitHubUser: Record<string, MockGitHubUser> = {};
  if (githubUsername) {
    mockGitHubUser[githubUsername] = buildMockGitHubUser(
      candidate,
      githubUsername,
      gold.tier,
      gold.bridgeSignals,
      gold.scoringPath,
      evidence,
      rng
    );
  }

  return {
    candidateId: candidate.id,
    tenantId: candidate.tenantId,
    linkedinUrl: candidate.linkedinUrl,
    linkedinId: candidate.linkedinId,
    serp,
    gold: {
      confirmedIdentity: gold.confirmedIdentity,
      autoMergeAllowed: gold.autoMergeAllowed,
      tier: gold.tier,
    },
    mock: {
      webSearch: { queries: mockWebSearch },
      githubUserSearch: { queries: mockGitHubSearch },
      githubUser: mockGitHubUser,
    },
  };
}

/**
 * Build a fallback SERP snippet from available hints when searchSnippet is null.
 */
function buildFallbackSnippet(candidate: CandidateRow): string {
  const parts: string[] = [];
  if (candidate.locationHint) parts.push(candidate.locationHint);
  if (candidate.headlineHint) parts.push(candidate.headlineHint);
  if (candidate.companyHint) parts.push(`at ${candidate.companyHint}`);
  return parts.length > 0 ? parts.join('. ') + '.' : 'LinkedIn profile.';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { outputPath, dryRun, verbose } = parseArgs();
  const startTime = Date.now();

  console.log('========================================');
  console.log('Generate Eval Fixtures from Database');
  console.log('========================================');
  console.log(`Output: ${outputPath}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');

  // Connect to database
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('Connected to database.');

  try {
    // ------------------------------------------------------------------
    // Step 1: Fetch confirmed-identity candidates (ground truth)
    // ------------------------------------------------------------------
    console.log('\n--- Step 1: Fetching confirmed-identity candidates ---');
    const confirmedCandidates = await fetchCandidatesByLinkedinIds(
      client,
      CONFIRMED_LINKEDIN_IDS
    );
    console.log(`Found ${confirmedCandidates.length} candidates with confirmed LinkedIn IDs.`);

    // Also try to find any candidates that have rows in confirmed_identities table
    // but were not in our hardcoded list
    const allConfirmedResult = await client.query<{ candidateId: string }>(
      `SELECT DISTINCT "candidateId" FROM confirmed_identities`
    );
    const confirmedCandidateIdsFromDB = allConfirmedResult.rows.map((r: { candidateId: string }) => r.candidateId);
    const additionalConfirmedIds = confirmedCandidateIdsFromDB.filter(
      (id) => !confirmedCandidates.some((c) => c.id === id)
    );

    let additionalConfirmed: CandidateRow[] = [];
    if (additionalConfirmedIds.length > 0) {
      const placeholders = additionalConfirmedIds.map((_: string, i: number) => `$${i + 1}`).join(', ');
      const addResult = await client.query<CandidateRow>(
        `SELECT
           id, "tenantId", "linkedinUrl", "linkedinId",
           "searchTitle", "searchSnippet", "searchMeta",
           "nameHint", "companyHint", "locationHint", "headlineHint",
           "enrichmentStatus", "confidenceScore"
         FROM candidates
         WHERE id IN (${placeholders})`,
        additionalConfirmedIds
      );
      additionalConfirmed = addResult.rows;
      console.log(
        `Found ${additionalConfirmed.length} additional candidates with confirmed_identities in DB.`
      );
    }

    const allGroundTruthCandidates = [...confirmedCandidates, ...additionalConfirmed];

    // ------------------------------------------------------------------
    // Step 2: Fetch high-confidence identity candidates
    // ------------------------------------------------------------------
    console.log('\n--- Step 2: Fetching high-confidence identity candidates ---');
    const allGroundTruthLinkedinIds = allGroundTruthCandidates.map((c) => c.linkedinId);
    const highConfCandidates = await fetchHighConfidenceCandidates(
      client,
      HIGH_CONFIDENCE_THRESHOLD,
      allGroundTruthLinkedinIds
    );
    console.log(`Found ${highConfCandidates.length} candidates with high-confidence identities.`);

    // ------------------------------------------------------------------
    // Step 3: Fetch negative examples
    // ------------------------------------------------------------------
    console.log('\n--- Step 3: Fetching negative examples ---');
    const alreadyFetchedIds = [
      ...allGroundTruthCandidates.map((c) => c.id),
      ...highConfCandidates.map((c) => c.id),
    ];
    const negativeCandidates = await fetchNegativeExamples(
      client,
      NEGATIVE_SAMPLE_SIZE,
      alreadyFetchedIds
    );
    console.log(`Found ${negativeCandidates.length} negative-example candidates.`);

    // ------------------------------------------------------------------
    // Step 4: Fetch associated identity data
    // ------------------------------------------------------------------
    console.log('\n--- Step 4: Fetching identity data ---');
    const allCandidates = [
      ...allGroundTruthCandidates,
      ...highConfCandidates,
      ...negativeCandidates,
    ];
    const allCandidateIds = allCandidates.map((c) => c.id);

    const confirmedIdentities = await fetchConfirmedIdentities(client, allCandidateIds);
    const identityCandidates = await fetchIdentityCandidates(client, allCandidateIds);

    console.log(`Fetched ${confirmedIdentities.length} confirmed identities.`);
    console.log(`Fetched ${identityCandidates.length} identity candidates.`);

    // Index by candidate_id
    const confirmedByCandidate = new Map<string, ConfirmedIdentityRow>();
    for (const ci of confirmedIdentities) {
      // Keep the first (we only need one per candidate for the fixture)
      if (!confirmedByCandidate.has(ci.candidateId)) {
        confirmedByCandidate.set(ci.candidateId, ci);
      }
    }

    const identityCandidatesByCandidate = new Map<string, IdentityCandidateRow[]>();
    for (const ic of identityCandidates) {
      const list = identityCandidatesByCandidate.get(ic.candidateId) || [];
      list.push(ic);
      identityCandidatesByCandidate.set(ic.candidateId, list);
    }

    // ------------------------------------------------------------------
    // Step 5: Build fixtures
    // ------------------------------------------------------------------
    console.log('\n--- Step 5: Building fixtures ---');
    const fixtures: EvalFixture[] = [];

    for (const candidate of allCandidates) {
      const confirmed = confirmedByCandidate.get(candidate.id) || null;
      const icList = identityCandidatesByCandidate.get(candidate.id) || [];
      const topIc = icList.length > 0 ? icList[0] : null; // Already sorted by confidence DESC

      const fixture = buildFixture(candidate, confirmed, topIc, null);
      fixtures.push(fixture);

      if (verbose) {
        const goldLabel = fixture.gold.confirmedIdentity
          ? `${fixture.gold.confirmedIdentity.platform}:${fixture.gold.confirmedIdentity.username}`
          : 'null';
        console.log(
          `  [${fixture.gold.tier === 1 ? 'T1' : fixture.gold.tier === 2 ? 'T2' : 'T3'}] ` +
          `${candidate.linkedinId} -> ${goldLabel} ` +
          `(autoMerge=${fixture.gold.autoMergeAllowed})`
        );
      }
    }

    // ------------------------------------------------------------------
    // Step 6: Write output
    // ------------------------------------------------------------------
    console.log(`\n--- Step 6: Writing ${fixtures.length} fixtures ---`);

    if (dryRun) {
      console.log('[DRY RUN] Would write to:', outputPath);
      console.log('\nFixture summary:');
      for (const f of fixtures) {
        const goldLabel = f.gold.confirmedIdentity
          ? `${f.gold.confirmedIdentity.platform}:${f.gold.confirmedIdentity.username}`
          : 'null';
        console.log(
          `  ${f.linkedinId.padEnd(30)} tier=${f.gold.tier} autoMerge=${f.gold.autoMergeAllowed ? 'Y' : 'N'} gold=${goldLabel}`
        );
      }
    } else {
      // Ensure output directory exists
      const outputDir = path.dirname(outputPath);
      fs.mkdirSync(outputDir, { recursive: true });

      // Write JSONL (one JSON object per line)
      const lines = fixtures.map((f) => JSON.stringify(f));
      fs.writeFileSync(outputPath, lines.join('\n') + '\n');
      console.log(`Wrote ${fixtures.length} fixtures to ${outputPath}`);
    }

    // ------------------------------------------------------------------
    // Summary
    // ------------------------------------------------------------------
    const tier1Count = fixtures.filter((f) => f.gold.tier === 1).length;
    const tier2Count = fixtures.filter((f) => f.gold.tier === 2).length;
    const tier3Count = fixtures.filter((f) => f.gold.tier === 3).length;
    const autoMergeCount = fixtures.filter((f) => f.gold.autoMergeAllowed).length;
    const nullGoldCount = fixtures.filter((f) => f.gold.confirmedIdentity === null).length;

    console.log('\n========================================');
    console.log('Summary');
    console.log('========================================');
    console.log(`Total fixtures:      ${fixtures.length}`);
    console.log(`  Tier 1 (auto):     ${tier1Count}`);
    console.log(`  Tier 2 (review):   ${tier2Count}`);
    console.log(`  Tier 3 (weak/no):  ${tier3Count}`);
    console.log(`  Auto-merge=true:   ${autoMergeCount}`);
    console.log(`  Gold=null (neg):   ${nullGoldCount}`);
    console.log(`Duration:            ${Date.now() - startTime}ms`);
  } finally {
    await client.end();
    console.log('\nDatabase connection closed.');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
