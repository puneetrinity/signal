/**
 * Pure transforms: raw Prisma results → normalized summaries.
 * Shapes match the spec in docs/superpowers/specs/2026-03-17-signal-debug-agent-design.md
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Row = Record<string, unknown>;

// ---- Helpers ----

function safeJson<T = JsonValue>(val: unknown): T | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val as T;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return null; }
  }
  return null;
}

function pick<T extends Row, K extends string>(obj: T, keys: K[]): Partial<T> {
  const out: Row = {};
  for (const k of keys) {
    if (k in obj) out[k] = obj[k];
  }
  return out as Partial<T>;
}

function countBy(rows: Row[], field: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const val = String(row[field] ?? 'unknown');
    out[val] = (out[val] ?? 0) + 1;
  }
  return out;
}

// ---- 1. formatRequestResults ----

export function formatRequestResults(
  request: Row,
  allCandidates: Row[],
  opts: { limit: number; offset: number; includeDiagnostics: boolean },
) {
  const diagnostics = safeJson<Row>(request.diagnostics);
  const trackDecision = opts.includeDiagnostics ? diagnostics?.trackDecision ?? null : null;

  const counts = {
    total: allCandidates.length,
    enriched: allCandidates.filter((c) => c.enrichmentStatus === 'completed').length,
    withSnapshot: allCandidates.filter((c) => c.hasSnapshot).length,
    withIdentity: allCandidates.filter((c) => (c.identityCount as number) > 0).length,
    byLocationMatchType: countBy(allCandidates, 'locationMatchType'),
    bySkillScoreMethod: countBy(allCandidates, 'skillScoreMethod'),
  };

  const page = allCandidates.slice(opts.offset, opts.offset + opts.limit);

  return {
    request: {
      id: request.id,
      externalJobId: request.externalJobId,
      status: request.status,
      resultCount: request.resultCount,
      queriesExecuted: request.queriesExecuted,
      requestedAt: request.requestedAt,
      completedAt: request.completedAt,
      lastRerankedAt: request.lastRerankedAt,
      trackDecision,
    },
    candidateCounts: counts,
    candidates: page,
  };
}

// ---- 2. formatCandidateDetails ----

export function formatCandidateDetails(
  candidate: Row,
  snapshots: Row[],
  identities: Row[],
  confirmedIdentities: Row[],
  sessions: Row[],
) {
  return {
    candidate: pick(candidate, [
      'id', 'linkedinUrl', 'linkedinId', 'nameHint', 'headlineHint', 'locationHint',
      'companyHint', 'seniorityHint', 'enrichmentStatus', 'confidenceScore',
      'locationConfidence', 'locationSource',
    ]),
    snapshots: snapshots.map((s) => pick(s, [
      'id', 'track', 'skillsNormalized', 'roleType', 'seniorityBand', 'location',
      'activityRecencyDays', 'computedAt', 'staleAfter',
    ])),
    identities: identities.map((i) => ({
      ...pick(i, [
        'id', 'platform', 'platformId', 'profileUrl', 'confidence', 'confidenceBucket',
        'bridgeTier', 'bridgeSignals', 'status', 'hasContradiction', 'contradictionNote',
      ]),
      scoreBreakdown: extractScoreBreakdown(i.scoreBreakdown),
    })),
    confirmedIdentities: confirmedIdentities.map((c) => pick(c, [
      'id', 'platform', 'platformId', 'confirmedBy', 'confirmedAt',
    ])),
    sessions: sessions.map(formatSessionSummary),
  };
}

function extractScoreBreakdown(raw: unknown): Row | null {
  const sb = safeJson<Row>(raw);
  if (!sb) return null;
  return pick(sb as Row, ['bridgeWeight', 'nameMatch', 'handleMatch', 'companyMatch', 'locationMatch', 'total']);
}

// ---- 3. formatRequestCandidate ----

export function formatRequestCandidate(
  request: Row,
  jsc: Row,
  candidate: Row,
  snapshot: Row | null,
  identities: Row[],
  session: Row | null,
) {
  const diagnostics = safeJson<Row>(request.diagnostics);
  const fitBreakdown = safeJson<Row>(jsc.fitBreakdown);

  return {
    request: {
      id: request.id,
      externalJobId: request.externalJobId,
      status: request.status,
      trackDecision: diagnostics?.trackDecision ?? null,
    },
    candidateInRequest: {
      rank: jsc.rank,
      fitScore: jsc.fitScore,
      fitBreakdown: fitBreakdown ? pick(fitBreakdown as Row, [
        'skillScore', 'skillScoreMethod', 'roleScore', 'seniorityScore',
        'effectiveSeniorityScore', 'activityFreshnessScore', 'locationBoost',
        'matchTier', 'locationMatchType', 'dataConfidence', 'unknownLocationPromotion',
      ]) : null,
      enrichmentStatus: jsc.enrichmentStatus,
    },
    candidate: pick(candidate, [
      'linkedinUrl', 'linkedinId', 'nameHint', 'headlineHint', 'locationHint',
      'companyHint', 'seniorityHint', 'enrichmentStatus', 'confidenceScore',
    ]),
    snapshot: snapshot ? pick(snapshot, [
      'track', 'skillsNormalized', 'roleType', 'seniorityBand', 'location',
      'activityRecencyDays', 'computedAt',
    ]) : null,
    topIdentities: identities.slice(0, 5).map((i) => ({
      ...pick(i, ['platform', 'platformId', 'confidence', 'bridgeTier', 'bridgeSignals']),
      scoreBreakdown: extractScoreBreakdown(i.scoreBreakdown),
    })),
    latestSession: session ? formatSessionSummary(session) : null,
  };
}

// ---- 4. formatJobSummary ----

export function formatJobSummary(requests: Row[]) {
  return {
    requests: requests.map((r) => {
      const diagnostics = safeJson<Row>(r.diagnostics);
      const candidates = (r.candidates as Row[]) ?? [];
      return {
        id: r.id,
        externalJobId: r.externalJobId,
        status: r.status,
        resultCount: r.resultCount,
        requestedAt: r.requestedAt,
        completedAt: r.completedAt,
        trackDecision: diagnostics?.trackDecision ?? null,
        topCandidates: candidates.slice(0, 5).map((c) => {
          const fb = safeJson<Row>(c.fitBreakdown);
          return {
            rank: c.rank,
            candidateId: c.candidateId,
            fitScore: c.fitScore,
            fitBreakdown: fb ? pick(fb as Row, ['skillScore', 'roleScore', 'locationBoost']) : null,
          };
        }),
      };
    }),
  };
}

// ---- Session summary helper ----

function formatSessionSummary(session: Row) {
  const trace = safeJson<Row>(session.runTrace);
  const final_ = trace?.final as Row | undefined;
  const platformResults = trace?.platformResults as Record<string, Row> | undefined;
  const summaryMeta = trace?.summaryMeta as Row | undefined;

  const perPlatform: Record<string, Row> = {};
  if (platformResults) {
    for (const [platform, pd] of Object.entries(platformResults)) {
      perPlatform[platform] = {
        queries: pd.queriesExecuted ?? 0,
        matched: pd.matchedResultCount ?? pd.rawResultCount ?? 0,
        persisted: pd.identitiesPersisted ?? 0,
        bestConfidence: pd.bestConfidence ?? 0,
      };
    }
  }

  return {
    id: session.id,
    status: session.status,
    roleType: session.roleType,
    createdAt: session.createdAt,
    queriesExecuted: session.queriesExecuted,
    identitiesFound: session.identitiesFound,
    finalConfidence: session.finalConfidence,
    identitiesPersisted: final_?.identitiesPersisted ?? null,
    earlyStopReason: session.earlyStopReason,
    runTraceSummary: {
      totalQueries: final_?.totalQueriesExecuted ?? session.queriesExecuted ?? 0,
      platformsQueried: final_?.platformsQueried ?? Object.keys(perPlatform).length,
      platformsWithHits: final_?.platformsWithHits ?? 0,
      bestConfidence: final_?.bestConfidence ?? 0,
      durationMs: final_?.durationMs ?? 0,
      tier1Enforced: final_?.tier1Enforced ?? 0,
      tier1EnforceThreshold: final_?.tier1EnforceThreshold ?? null,
      perPlatform,
    },
    summaryMeta: summaryMeta ? pick(summaryMeta as Row, ['mode', 'confirmedCount', 'identityKey']) : null,
    errorMessage: session.errorMessage ?? null,
  };
}
