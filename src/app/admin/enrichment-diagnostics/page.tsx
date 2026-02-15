'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Activity,
  AlertTriangle,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';

interface SessionItem {
  id: string;
  candidateId: string;
  status: string;
  sourcesExecuted: string[] | null;
  queriesExecuted: number | null;
  identitiesFound: number;
  finalConfidence: number | null;
  errorMessage?: string | null;
  runTrace?: unknown;
}

interface SessionsApiStats {
  shadowScoring?: {
    sessionsWithShadow: number;
    profilesScored: number;
    bucketChanges: number;
    avgDelta: number;
  };
  scoringVersions?: Record<string, number>;
  dynamicScoringVersions?: Record<string, number>;
}

interface PlatformAggregate {
  sessions: number;
  rawHits: number;
  matchedHits: number;
  persisted: number;
  rateLimited: number;
  totalQueries: number;
  unmatchedSamples: string[];
}

interface Tier1ShadowAggregate {
  totalEvaluated: number;
  wouldAutoMerge: number;
  actuallyPromoted: number;
  blocked: number;
  blockReasonCounts: Record<string, number>;
  sessionsWithData: number;
  samples: Array<{
    platform: string;
    platformId: string;
    signals: string[];
    blockReasons: string[];
    confidenceScore: number;
    wouldAutoMerge: boolean;
    bridgeTier: number;
  }>;
}

interface Tier1GapAggregate {
  sessionsWithData: number;
  totalSignalCandidates: number;
  belowThreshold: number;
  avgDistanceToThreshold: number;
  componentDeficitTotals: Record<string, number>;
  samples: Array<{
    platform: string;
    platformId: string;
    bridgeTier: number;
    confidenceScore: number;
    threshold: number;
    distanceToThreshold: number;
    signals: string[];
    topDeficits: Array<{
      component: string;
      current: number;
      max: number;
      deficit: number;
    }>;
  }>;
}

interface DiagnosticsSummary {
  totalSessions: number;
  completed: number;
  failed: number;
  running: number;
  buckets: Record<string, number>;
  platforms: Record<string, PlatformAggregate>;
  providers: Record<string, number>;
  failureReasons: Record<string, number>;
  tier1Shadow: Tier1ShadowAggregate;
  tier1Gap: Tier1GapAggregate;
}

const DEFAULT_LIMIT = 200;
const BUCKET_LABELS: Record<string, string> = {
  success: 'Success (persisted)',
  filtered_out: 'Filtered out (no persist)',
  no_platform_matches: 'No platform matches',
  no_serp_results: 'No SERP results',
  no_platforms: 'No platforms queried',
  failed: 'Failed',
};

function formatPct(numerator: number, denominator: number): string {
  if (!denominator) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function inferProvider(sourcesExecuted: string[] | null): 'pdl' | 'langgraph' | 'unknown' {
  if (!sourcesExecuted || sourcesExecuted.length === 0) return 'unknown';
  if (sourcesExecuted.includes('pdl')) return 'pdl';
  return 'langgraph';
}

function classifySession(session: SessionItem, platformResults: Record<string, unknown>): string {
  if (session.status === 'failed') return 'failed';

  const results = Object.values(platformResults || {}) as Array<Record<string, unknown>>;
  if (results.length === 0) return 'no_platforms';

  const anyRaw = results.some((r) => (r.rawResultCount as number | undefined) && (r.rawResultCount as number) > 0);
  const anyMatched = results.some((r) => {
    const matched = r.matchedResultCount as number | undefined;
    if (typeof matched === 'number') return matched > 0;
    const identitiesFound = r.identitiesFound as number | undefined;
    return typeof identitiesFound === 'number' ? identitiesFound > 0 : false;
  });
  const anyPersisted = results.some((r) => {
    const persisted = r.identitiesPersisted as number | undefined;
    if (typeof persisted === 'number') return persisted > 0;
    const found = r.identitiesFound as number | undefined;
    return typeof found === 'number' ? found > 0 : false;
  });

  if (!anyRaw) return 'no_serp_results';
  if (anyRaw && !anyMatched) return 'no_platform_matches';
  if (anyMatched && !anyPersisted) return 'filtered_out';
  return 'success';
}

function buildSummary(sessions: SessionItem[]): DiagnosticsSummary {
  const summary: DiagnosticsSummary = {
    totalSessions: sessions.length,
    completed: 0,
    failed: 0,
    running: 0,
    buckets: {
      success: 0,
      filtered_out: 0,
      no_platform_matches: 0,
      no_serp_results: 0,
      no_platforms: 0,
      failed: 0,
    },
    platforms: {},
    providers: {},
    failureReasons: {},
    tier1Shadow: {
      totalEvaluated: 0,
      wouldAutoMerge: 0,
      actuallyPromoted: 0,
      blocked: 0,
      blockReasonCounts: {},
      sessionsWithData: 0,
      samples: [],
    },
    tier1Gap: {
      sessionsWithData: 0,
      totalSignalCandidates: 0,
      belowThreshold: 0,
      avgDistanceToThreshold: 0,
      componentDeficitTotals: {},
      samples: [],
    },
  };

  for (const session of sessions) {
    if (session.status === 'completed') summary.completed += 1;
    if (session.status === 'failed') summary.failed += 1;
    if (session.status === 'running' || session.status === 'queued') summary.running += 1;

    const trace = (session.runTrace || {}) as Record<string, unknown>;
    const platformResults = (trace.platformResults || {}) as Record<string, Record<string, unknown>>;
    const final = (trace.final || {}) as Record<string, unknown>;

    const bucket = classifySession(session, platformResults);
    summary.buckets[bucket] = (summary.buckets[bucket] || 0) + 1;

    if (session.status === 'failed') {
      const failureReason = (trace.failureReason as string | undefined) || session.errorMessage || 'Unknown failure';
      summary.failureReasons[failureReason] = (summary.failureReasons[failureReason] || 0) + 1;
    }

    // Aggregate Tier-1 shadow from trace.final
    const tier1Shadow = final.tier1Shadow as {
      totalEvaluated?: number;
      wouldAutoMerge?: number;
      actuallyPromoted?: number;
      blocked?: number;
      blockReasonCounts?: Record<string, number>;
      samples?: Array<Record<string, unknown>>;
    } | undefined;
    if (tier1Shadow && typeof tier1Shadow.totalEvaluated === 'number' && tier1Shadow.totalEvaluated > 0) {
      summary.tier1Shadow.sessionsWithData++;
      summary.tier1Shadow.totalEvaluated += tier1Shadow.totalEvaluated;
      summary.tier1Shadow.wouldAutoMerge += tier1Shadow.wouldAutoMerge ?? 0;
      summary.tier1Shadow.actuallyPromoted += tier1Shadow.actuallyPromoted ?? 0;
      summary.tier1Shadow.blocked += tier1Shadow.blocked ?? 0;
      for (const [reason, count] of Object.entries(tier1Shadow.blockReasonCounts || {})) {
        summary.tier1Shadow.blockReasonCounts[reason] =
          (summary.tier1Shadow.blockReasonCounts[reason] || 0) + (count || 0);
      }
      for (const sample of (tier1Shadow.samples || []) as Array<Record<string, unknown>>) {
        if (summary.tier1Shadow.samples.length < 50) {
          summary.tier1Shadow.samples.push({
            platform: (sample.platform as string) || '',
            platformId: (sample.platformId as string) || '',
            signals: Array.isArray(sample.signals) ? (sample.signals as string[]) : [],
            blockReasons: Array.isArray(sample.blockReasons) ? (sample.blockReasons as string[]) : [],
            confidenceScore: (sample.confidenceScore as number) || 0,
            wouldAutoMerge: (sample.wouldAutoMerge as boolean) || false,
            bridgeTier: (sample.bridgeTier as number) || 3,
          });
        }
      }
    }

    // Aggregate Tier-1 near-pass diagnostics from trace.final
    const tier1Gap = final.tier1Gap as {
      totalSignalCandidates?: number;
      belowThreshold?: number;
      avgDistanceToThreshold?: number;
      componentDeficitTotals?: Record<string, number>;
      samples?: Array<Record<string, unknown>>;
    } | undefined;
    if (tier1Gap && typeof tier1Gap.totalSignalCandidates === 'number' && tier1Gap.totalSignalCandidates > 0) {
      summary.tier1Gap.sessionsWithData++;
      summary.tier1Gap.totalSignalCandidates += tier1Gap.totalSignalCandidates;
      const below = tier1Gap.belowThreshold ?? 0;
      summary.tier1Gap.belowThreshold += below;
      const currentAvg = summary.tier1Gap.avgDistanceToThreshold;
      const prevCount = summary.tier1Gap.belowThreshold - below;
      const weightedPrev = currentAvg * prevCount;
      const weightedNext = (tier1Gap.avgDistanceToThreshold ?? 0) * below;
      summary.tier1Gap.avgDistanceToThreshold =
        summary.tier1Gap.belowThreshold > 0
          ? (weightedPrev + weightedNext) / summary.tier1Gap.belowThreshold
          : 0;
      for (const [component, total] of Object.entries(tier1Gap.componentDeficitTotals || {})) {
        summary.tier1Gap.componentDeficitTotals[component] =
          (summary.tier1Gap.componentDeficitTotals[component] || 0) + (total || 0);
      }
      for (const sample of (tier1Gap.samples || []) as Array<Record<string, unknown>>) {
        if (summary.tier1Gap.samples.length < 50) {
          summary.tier1Gap.samples.push({
            platform: (sample.platform as string) || '',
            platformId: (sample.platformId as string) || '',
            bridgeTier: (sample.bridgeTier as number) || 3,
            confidenceScore: (sample.confidenceScore as number) || 0,
            threshold: (sample.threshold as number) || 0.85,
            distanceToThreshold: (sample.distanceToThreshold as number) || 0,
            signals: Array.isArray(sample.signals) ? (sample.signals as string[]) : [],
            topDeficits: Array.isArray(sample.topDeficits)
              ? (sample.topDeficits as Array<Record<string, unknown>>).map((d) => ({
                  component: (d.component as string) || '',
                  current: (d.current as number) || 0,
                  max: (d.max as number) || 0,
                  deficit: (d.deficit as number) || 0,
                }))
              : [],
          });
        }
      }
    }

    const providersUsed = (final.providersUsed || {}) as Record<string, number>;
    for (const [provider, count] of Object.entries(providersUsed)) {
      summary.providers[provider] = (summary.providers[provider] || 0) + (count || 0);
    }

    for (const [platform, result] of Object.entries(platformResults)) {
      const aggregate = summary.platforms[platform] || {
        sessions: 0,
        rawHits: 0,
        matchedHits: 0,
        persisted: 0,
        rateLimited: 0,
        totalQueries: 0,
        unmatchedSamples: [],
      };

      aggregate.sessions += 1;
      const rawCount = (result.rawResultCount as number | undefined) || 0;
      const matchedCount = (result.matchedResultCount as number | undefined) || 0;
      const identitiesFound = (result.identitiesFound as number | undefined) || 0;
      const persisted = typeof result.identitiesPersisted === 'number'
        ? (result.identitiesPersisted as number)
        : identitiesFound;
      const rateLimited = result.rateLimited as boolean | undefined;
      const queriesExecuted = (result.queriesExecuted as number | undefined) || 0;
      const unmatchedSampleUrls = Array.isArray(result.unmatchedSampleUrls)
        ? (result.unmatchedSampleUrls as string[])
        : [];

      if (rawCount > 0) aggregate.rawHits += 1;
      if (matchedCount > 0) aggregate.matchedHits += 1;
      if (persisted > 0) aggregate.persisted += 1;
      if (rateLimited) aggregate.rateLimited += 1;
      aggregate.totalQueries += queriesExecuted;
      if (unmatchedSampleUrls.length > 0) {
        const existing = new Set(aggregate.unmatchedSamples);
        for (const url of unmatchedSampleUrls) {
          if (aggregate.unmatchedSamples.length >= 3) break;
          if (existing.has(url)) continue;
          existing.add(url);
          aggregate.unmatchedSamples.push(url);
        }
      }

      summary.platforms[platform] = aggregate;
    }
  }

  return summary;
}

export default function EnrichmentDiagnosticsPage() {
  const [limitInput, setLimitInput] = useState(String(DEFAULT_LIMIT));
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'failed' | 'running'>('all');
  const [providerFilter, setProviderFilter] = useState<'all' | 'langgraph' | 'pdl'>('all');
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [apiStats, setApiStats] = useState<SessionsApiStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('includeTrace', 'true');
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      const response = await fetch(`/api/v2/sessions?${params.toString()}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to load sessions');
      }
      const data = await response.json();
      setSessions((data.items || []) as SessionItem[]);
      setApiStats((data.stats || null) as SessionsApiStats | null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }, [limit, fromDate, toDate]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      if (statusFilter !== 'all' && session.status !== statusFilter) return false;
      if (providerFilter === 'all') return true;
      const provider = inferProvider(session.sourcesExecuted);
      return provider === providerFilter;
    });
  }, [sessions, statusFilter, providerFilter]);

  const summary = useMemo(() => buildSummary(filteredSessions), [filteredSessions]);

  const platformRows = useMemo(() => {
    const rows = Object.entries(summary.platforms).map(([platform, data]) => ({
      platform,
      ...data,
      rawRate: formatPct(data.rawHits, data.sessions),
      matchRate: formatPct(data.matchedHits, data.sessions),
      persistRate: formatPct(data.persisted, data.sessions),
      avgQueries: data.sessions ? (data.totalQueries / data.sessions).toFixed(1) : '0.0',
    }));

    return rows.sort((a, b) => b.persisted - a.persisted);
  }, [summary.platforms]);

  const providerRows = useMemo(() => {
    return Object.entries(summary.providers).sort((a, b) => b[1] - a[1]);
  }, [summary.providers]);

  const failureRows = useMemo(() => {
    return Object.entries(summary.failureReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [summary.failureReasons]);

  const applyLimit = () => {
    const parsed = parseInt(limitInput, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setLimitInput(String(DEFAULT_LIMIT));
      setLimit(DEFAULT_LIMIT);
      return;
    }
    setLimit(Math.min(parsed, 500));
  };

  return (
    <div className="min-h-screen bg-background pt-24 pb-12">
      <div className="container mx-auto px-4 max-w-6xl space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Enrichment Diagnostics</h1>
            <p className="text-muted-foreground mt-1">
              Summarized telemetry for recent enrichment runs (LangGraph + PDL).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-40"
            />
            <Input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-40"
            />
            <Input
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              className="w-24"
              inputMode="numeric"
            />
            <Button variant="outline" onClick={applyLimit}>
              Apply
            </Button>
            <Button variant="outline" onClick={fetchSessions} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusFilter === 'all' ? 'default' : 'outline'} onClick={() => setStatusFilter('all')} className="cursor-pointer">
            All
          </Badge>
          <Badge variant={statusFilter === 'completed' ? 'default' : 'outline'} onClick={() => setStatusFilter('completed')} className="cursor-pointer">
            Completed
          </Badge>
          <Badge variant={statusFilter === 'failed' ? 'default' : 'outline'} onClick={() => setStatusFilter('failed')} className="cursor-pointer">
            Failed
          </Badge>
          <Badge variant={statusFilter === 'running' ? 'default' : 'outline'} onClick={() => setStatusFilter('running')} className="cursor-pointer">
            Running
          </Badge>
          <span className="text-muted-foreground text-xs ml-2">Status filter</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={providerFilter === 'all' ? 'default' : 'outline'} onClick={() => setProviderFilter('all')} className="cursor-pointer">
            All Providers
          </Badge>
          <Badge variant={providerFilter === 'langgraph' ? 'default' : 'outline'} onClick={() => setProviderFilter('langgraph')} className="cursor-pointer">
            LangGraph
          </Badge>
          <Badge variant={providerFilter === 'pdl' ? 'default' : 'outline'} onClick={() => setProviderFilter('pdl')} className="cursor-pointer">
            PDL
          </Badge>
          <span className="text-muted-foreground text-xs ml-2">Provider filter</span>
        </div>

        {loading && (
          <div className="grid gap-4 md:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="pt-6">
                  <Skeleton className="h-6 w-24" />
                  <Skeleton className="h-4 w-32 mt-2" />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {error && (
          <Card className="border-red-500/50 bg-red-500/10">
            <CardContent className="pt-6 text-center">
              <AlertTriangle className="h-6 w-6 text-red-500 mx-auto mb-2" />
              <p className="text-red-500 text-sm">{error}</p>
            </CardContent>
          </Card>
        )}

        {!loading && !error && (
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Activity className="h-4 w-4" />
                  Sessions
                </div>
                <div className="text-2xl font-bold text-foreground">{summary.totalSessions}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <ShieldCheck className="h-4 w-4" />
                  Completed
                </div>
                <div className="text-2xl font-bold text-green-500">{summary.completed}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertTriangle className="h-4 w-4" />
                  Failed
                </div>
                <div className="text-2xl font-bold text-red-500">{summary.failed}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Search className="h-4 w-4" />
                  Running
                </div>
                <div className="text-2xl font-bold text-blue-500">{summary.running}</div>
              </CardContent>
            </Card>
          </div>
        )}

        {!loading && !error && (
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Shadow Scoring</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span>Sessions with shadow</span>
                  <Badge variant="outline">{apiStats?.shadowScoring?.sessionsWithShadow ?? 0}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Profiles scored</span>
                  <Badge variant="outline">{apiStats?.shadowScoring?.profilesScored ?? 0}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Bucket changes</span>
                  <Badge variant="outline">{apiStats?.shadowScoring?.bucketChanges ?? 0}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Avg delta</span>
                  <Badge variant="outline">
                    {(apiStats?.shadowScoring?.avgDelta ?? 0).toFixed(4)}
                  </Badge>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Static Scorer Versions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {Object.entries(apiStats?.scoringVersions || {}).length === 0 && (
                  <span className="text-muted-foreground">No scorer version data recorded.</span>
                )}
                {Object.entries(apiStats?.scoringVersions || {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([version, count]) => (
                    <div key={version} className="flex items-center justify-between">
                      <span>{version}</span>
                      <Badge variant="outline">{count}</Badge>
                    </div>
                  ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Dynamic Scorer Versions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {Object.entries(apiStats?.dynamicScoringVersions || {}).length === 0 && (
                  <span className="text-muted-foreground">No dynamic scorer data recorded.</span>
                )}
                {Object.entries(apiStats?.dynamicScoringVersions || {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([version, count]) => (
                    <div key={version} className="flex items-center justify-between">
                      <span>{version}</span>
                      <Badge variant="outline">{count}</Badge>
                    </div>
                  ))}
              </CardContent>
            </Card>
          </div>
        )}

        {!loading && !error && summary.tier1Shadow.sessionsWithData > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Tier-1 Shadow Evaluation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-4 text-sm">
                <div className="flex items-center justify-between">
                  <span>Sessions with data</span>
                  <Badge variant="outline">{summary.tier1Shadow.sessionsWithData}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Total evaluated</span>
                  <Badge variant="outline">{summary.tier1Shadow.totalEvaluated}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Would auto-merge</span>
                  <Badge variant="outline">{summary.tier1Shadow.wouldAutoMerge}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Blocked</span>
                  <Badge variant="outline">{summary.tier1Shadow.blocked}</Badge>
                </div>
              </div>
              {Object.keys(summary.tier1Shadow.blockReasonCounts).length > 0 && (
                <div>
                  <div className="text-sm font-medium mb-2">Block Reasons</div>
                  <div className="grid gap-1 text-sm">
                    {Object.entries(summary.tier1Shadow.blockReasonCounts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([reason, count]) => (
                        <div key={reason} className="flex items-center justify-between">
                          <span className="text-muted-foreground">{reason}</span>
                          <Badge variant="outline">{count}</Badge>
                        </div>
                      ))}
                  </div>
                </div>
              )}
              {summary.tier1Shadow.samples.length > 0 && (
                <div>
                  <div className="text-sm font-medium mb-2">
                    Samples ({summary.tier1Shadow.samples.length})
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-muted-foreground border-b">
                          <th className="py-1">Platform</th>
                          <th className="py-1">ID</th>
                          <th className="py-1">Tier</th>
                          <th className="py-1">Confidence</th>
                          <th className="py-1">Signals</th>
                          <th className="py-1">Block Reasons</th>
                          <th className="py-1">Would Merge</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.tier1Shadow.samples.map((sample, i) => (
                          <tr key={i} className="border-b last:border-b-0">
                            <td className="py-1">{sample.platform}</td>
                            <td className="py-1 font-mono text-xs">{sample.platformId}</td>
                            <td className="py-1">{sample.bridgeTier}</td>
                            <td className="py-1">{sample.confidenceScore.toFixed(2)}</td>
                            <td className="py-1 text-xs">{sample.signals.join(', ') || '-'}</td>
                            <td className="py-1 text-xs">{sample.blockReasons.join(', ') || '-'}</td>
                            <td className="py-1">
                              <Badge variant={sample.wouldAutoMerge ? 'default' : 'outline'}>
                                {sample.wouldAutoMerge ? 'Yes' : 'No'}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {!loading && !error && summary.tier1Gap.sessionsWithData > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Tier-1 Near-Pass Diagnostics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-5 text-sm">
                <div className="flex items-center justify-between">
                  <span>Sessions with data</span>
                  <Badge variant="outline">{summary.tier1Gap.sessionsWithData}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Signal candidates</span>
                  <Badge variant="outline">{summary.tier1Gap.totalSignalCandidates}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Below 0.85</span>
                  <Badge variant="outline">{summary.tier1Gap.belowThreshold}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Avg distance to 0.85</span>
                  <Badge variant="outline">{summary.tier1Gap.avgDistanceToThreshold.toFixed(3)}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Near-pass rate</span>
                  <Badge variant="outline">
                    {formatPct(summary.tier1Gap.belowThreshold, summary.tier1Gap.totalSignalCandidates)}
                  </Badge>
                </div>
              </div>
              {Object.keys(summary.tier1Gap.componentDeficitTotals).length > 0 && (
                <div>
                  <div className="text-sm font-medium mb-2">Top Deficit Components</div>
                  <div className="grid gap-1 text-sm">
                    {Object.entries(summary.tier1Gap.componentDeficitTotals)
                      .sort((a, b) => b[1] - a[1])
                      .map(([component, total]) => (
                        <div key={component} className="flex items-center justify-between">
                          <span className="text-muted-foreground">{component}</span>
                          <Badge variant="outline">{total.toFixed(2)}</Badge>
                        </div>
                      ))}
                  </div>
                </div>
              )}
              {summary.tier1Gap.samples.length > 0 && (
                <div>
                  <div className="text-sm font-medium mb-2">
                    Near-pass Samples ({summary.tier1Gap.samples.length})
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-muted-foreground border-b">
                          <th className="py-1">Platform</th>
                          <th className="py-1">ID</th>
                          <th className="py-1">Tier</th>
                          <th className="py-1">Confidence</th>
                          <th className="py-1">Gap to 0.85</th>
                          <th className="py-1">Signals</th>
                          <th className="py-1">Top Deficits</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.tier1Gap.samples.map((sample, i) => (
                          <tr key={i} className="border-b last:border-b-0">
                            <td className="py-1">{sample.platform}</td>
                            <td className="py-1 font-mono text-xs">{sample.platformId}</td>
                            <td className="py-1">{sample.bridgeTier}</td>
                            <td className="py-1">{sample.confidenceScore.toFixed(2)}</td>
                            <td className="py-1">{sample.distanceToThreshold.toFixed(3)}</td>
                            <td className="py-1 text-xs">{sample.signals.join(', ') || '-'}</td>
                            <td className="py-1 text-xs">
                              {sample.topDeficits
                                .map((d) => `${d.component}:${d.deficit.toFixed(2)}`)
                                .join(', ') || '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {!loading && !error && (
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Funnel Buckets</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {Object.entries(summary.buckets).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between">
                    <span>{BUCKET_LABELS[key] || key}</span>
                    <Badge variant="outline">{value}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Provider Usage</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {providerRows.length === 0 && (
                  <span className="text-muted-foreground">No provider data recorded.</span>
                )}
                {providerRows.map(([provider, count]) => (
                  <div key={provider} className="flex items-center justify-between">
                    <span>{provider}</span>
                    <Badge variant="outline">{count}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}

        {!loading && !error && (
          <Card>
            <CardHeader>
              <CardTitle>Platform Performance</CardTitle>
            </CardHeader>
            <CardContent>
              {platformRows.length === 0 ? (
                <div className="text-sm text-muted-foreground">No platform data available.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-muted-foreground border-b">
                        <th className="py-2">Platform</th>
                        <th className="py-2">Sessions</th>
                        <th className="py-2">Raw Hit</th>
                        <th className="py-2">Match</th>
                        <th className="py-2">Persist</th>
                        <th className="py-2">Rate Limited</th>
                        <th className="py-2">Avg Queries</th>
                      </tr>
                    </thead>
                    <tbody>
                      {platformRows.map((row) => (
                        <tr key={row.platform} className="border-b last:border-b-0">
                          <td className="py-2 font-medium">{row.platform}</td>
                          <td className="py-2">{row.sessions}</td>
                          <td className="py-2">{row.rawRate}</td>
                          <td className="py-2">{row.matchRate}</td>
                          <td className="py-2">{row.persistRate}</td>
                          <td className="py-2">{row.rateLimited}</td>
                          <td className="py-2">{row.avgQueries}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {!loading && !error && platformRows.some((row) => row.unmatchedSamples.length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle>Unmatched URL Samples</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {platformRows
                .filter((row) => row.unmatchedSamples.length > 0)
                .map((row) => (
                  <div key={row.platform} className="space-y-1">
                    <div className="font-medium">{row.platform}</div>
                    <div className="text-muted-foreground">
                      {row.unmatchedSamples.map((url) => (
                        <div key={url}>{url}</div>
                      ))}
                    </div>
                  </div>
                ))}
            </CardContent>
          </Card>
        )}

        {!loading && !error && (
          <Card>
            <CardHeader>
              <CardTitle>Top Failure Reasons</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {failureRows.length === 0 && (
                <span className="text-muted-foreground">No failures captured.</span>
              )}
              {failureRows.map(([reason, count]) => (
                <div key={reason} className="flex items-center justify-between">
                  <span className="truncate max-w-[70%]">{reason}</span>
                  <Badge variant="outline">{count}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {!loading && !error && (
          <Card className="bg-muted/40">
            <CardContent className="pt-6 text-sm text-muted-foreground">
              Showing {filteredSessions.length} sessions (limit {limit}).
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
