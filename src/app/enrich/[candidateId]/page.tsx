'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { IdentityCandidateCard } from '@/components/IdentityCandidateCard';
import { EvidenceDrawer, useEvidenceDrawer } from '@/components/EvidenceDrawer';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowLeft,
  Clock,
  ExternalLink,
  Sparkles,
  Code,
  MessageSquare,
  Lightbulb,
  AlertTriangle,
  Search,
  Play,
  RefreshCw,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Zap,
  Users,
  BarChart3,
} from 'lucide-react';
import type {
  CandidateData,
  IdentityCandidateData,
  EnrichmentSessionSummary,
  AISummaryStructured,
} from '@/types/linkedin';

interface PageProps {
  params: Promise<{ candidateId: string }>;
}

type EnrichmentUIState = 'idle' | 'running' | 'completed' | 'failed';

interface ProgressEvent {
  type: string;
  node?: string;
  data?: { queriesExecuted?: number; identitiesFound?: number; platform?: string };
  timestamp: string;
}

export default function EnrichmentPage({ params }: PageProps) {
  const resolvedParams = use(params);
  const { candidateId } = resolvedParams;
  const router = useRouter();
  const searchParams = useSearchParams();
  const shouldAutostart = searchParams.get('autostart') === '1';

  const [uiState, setUIState] = useState<EnrichmentUIState>('idle');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMisconfigured, setIsMisconfigured] = useState(false);
  const [, setSessionId] = useState<string | null>(null);
  const [progressEvents, setProgressEvents] = useState<ProgressEvent[]>([]);
  const [candidate, setCandidate] = useState<CandidateData | null>(null);
  const [identityCandidates, setIdentityCandidates] = useState<IdentityCandidateData[]>([]);
  const [session, setSession] = useState<EnrichmentSessionSummary | null>(null);
  const [summaryRegenerating, setSummaryRegenerating] = useState(false);
  const summaryCardRef = useRef<HTMLDivElement>(null);
  const autostartTriggered = useRef(false);

  // Collapsible states for tier sections
  const [tier1Open, setTier1Open] = useState(true);
  const [tier2Open, setTier2Open] = useState(true);
  const [tier3Open, setTier3Open] = useState(false);

  // Evidence drawer
  const evidenceDrawer = useEvidenceDrawer();

  // Group identities by tier and status
  const groupedIdentities = {
    // Tier 1 + Confirmed = "Confirmed / Auto"
    confirmed: identityCandidates.filter(
      (ic) => ic.status === 'confirmed' || (ic.status === 'unconfirmed' && ic.bridgeTier === 1)
    ),
    // Tier 2 unconfirmed = "Needs Review"
    needsReview: identityCandidates.filter(
      (ic) => ic.status === 'unconfirmed' && ic.bridgeTier === 2
    ),
    // Tier 3 unconfirmed = "Low Confidence" (including null/undefined bridgeTier)
    lowConfidence: identityCandidates.filter(
      (ic) => ic.status === 'unconfirmed' && (ic.bridgeTier === 3 || !ic.bridgeTier)
    ),
    // Rejected
    rejected: identityCandidates.filter((ic) => ic.status === 'rejected'),
  };

  // Progress metrics from events
  const progressMetrics = {
    queriesExecuted: progressEvents
      .filter((e) => e.data?.queriesExecuted)
      .reduce((max, e) => Math.max(max, e.data?.queriesExecuted || 0), 0),
    identitiesFound: progressEvents
      .filter((e) => e.data?.identitiesFound)
      .reduce((max, e) => Math.max(max, e.data?.identitiesFound || 0), 0),
    platformsCompleted: new Set(
      progressEvents.filter((e) => e.data?.platform).map((e) => e.data?.platform)
    ).size,
  };

  const fetchCandidate = useCallback(async () => {
    try {
      const response = await fetch(`/api/v2/enrich?candidateId=${candidateId}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load candidate');
      }

      setCandidate(data.candidate);
      setIdentityCandidates(data.identityCandidates || []);

      if (data.sessions && data.sessions.length > 0) {
        const latestSession = data.sessions[0];
        setSession(latestSession);

        if (latestSession.status === 'running' || latestSession.status === 'queued') {
          setUIState('running');
          return { data, shouldSubscribe: true, sessionId: latestSession.id };
        } else if (latestSession.status === 'completed') {
          setUIState('completed');
        } else if (latestSession.status === 'failed') {
          setUIState('failed');
        }
      } else {
        setUIState('idle');
      }

      return { data, shouldSubscribe: false, sessionId: null };
    } catch (err) {
      throw err;
    }
  }, [candidateId]);

  const startEnrichment = useCallback(async () => {
    setError(null);
    setIsMisconfigured(false);
    setProgressEvents([]);

    try {
      const response = await fetch('/api/v2/enrich/async', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 400 && data.error?.includes('not enabled')) {
          setIsMisconfigured(true);
          setError('Enrichment is misconfigured. Contact admin to enable LangGraph enrichment.');
          return null;
        }
        throw new Error(data.error || 'Failed to start enrichment');
      }

      if (data.sessionId) {
        setSessionId(data.sessionId);
        setUIState('running');
      }

      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start enrichment');
      return null;
    }
  }, [candidateId]);

  const subscribeToSummaryRegeneration = useCallback((regenSessionId: string) => {
    setSummaryRegenerating(true);
    setTimeout(() => {
      summaryCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);

    const eventSource = new EventSource(`/api/v2/enrich/session/stream?sessionId=${regenSessionId}`);

    const timeoutId = setTimeout(() => {
      if (eventSource.readyState !== EventSource.CLOSED) {
        eventSource.close();
        setSummaryRegenerating(false);
        fetchCandidate();
      }
    }, 60000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      setSummaryRegenerating(false);
      eventSource.close();
    };

    eventSource.addEventListener('completed', async () => {
      cleanup();
      await fetchCandidate();
      setTimeout(() => {
        summaryCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    });

    eventSource.addEventListener('failed', () => cleanup());
    eventSource.onerror = () => cleanup();

    return eventSource;
  }, [fetchCandidate]);

  const handleConfirm = useCallback(async (identityCandidateId: string): Promise<boolean> => {
    try {
      const response = await fetch('/api/v2/identity/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityCandidateId, method: 'recruiter_manual' }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to confirm identity');
      }

      const data = await response.json();
      await fetchCandidate();

      if (data.summaryRegeneration?.triggered && data.summaryRegeneration?.sessionId) {
        subscribeToSummaryRegeneration(data.summaryRegeneration.sessionId);
      }

      return true;
    } catch (err) {
      console.error('Confirm error:', err);
      return false;
    }
  }, [fetchCandidate, subscribeToSummaryRegeneration]);

  const handleReject = useCallback(async (identityCandidateId: string): Promise<boolean> => {
    try {
      const response = await fetch('/api/v2/identity/confirm', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityCandidateId }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to reject identity');
      }
      await fetchCandidate();
      return true;
    } catch (err) {
      console.error('Reject error:', err);
      return false;
    }
  }, [fetchCandidate]);

  const handleRevealEmail = useCallback(async (identityCandidateId: string): Promise<string | null> => {
    try {
      const response = await fetch('/api/v2/identity/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityCandidateId }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to reveal email');
      }
      const data = await response.json();
      return data.email || null;
    } catch (err) {
      console.error('Reveal email error:', err);
      return null;
    }
  }, []);

  const handleRegenerateSummary = useCallback(async () => {
    try {
      const response = await fetch('/api/v2/enrich/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to regenerate summary');
      }

      const data = await response.json();
      if (data.sessionId) {
        subscribeToSummaryRegeneration(data.sessionId);
      }
    } catch (err) {
      console.error('Regenerate summary error:', err);
      setError(err instanceof Error ? err.message : 'Failed to regenerate summary');
    }
  }, [candidateId, subscribeToSummaryRegeneration]);

  const subscribeToStream = useCallback((sid: string) => {
    const eventSource = new EventSource(`/api/v2/enrich/session/stream?sessionId=${sid}`);

    eventSource.addEventListener('connected', (e) => {
      const data = JSON.parse(e.data);
      setUIState('running');
      setProgressEvents((prev) => [...prev, { type: 'connected', timestamp: data.timestamp }]);
    });

    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      setProgressEvents((prev) => [
        ...prev,
        { type: 'progress', node: data.progress?.node, data: data.progress, timestamp: data.timestamp },
      ]);
    });

    eventSource.addEventListener('completed', (e) => {
      const data = JSON.parse(e.data);
      setUIState('completed');
      setProgressEvents((prev) => [...prev, { type: 'completed', timestamp: data.timestamp }]);
      eventSource.close();
      fetchCandidate();
    });

    eventSource.addEventListener('failed', (e) => {
      const data = JSON.parse(e.data);
      setUIState('failed');
      setError(data.error || 'Enrichment failed');
      setProgressEvents((prev) => [...prev, { type: 'failed', timestamp: data.timestamp }]);
      eventSource.close();
    });

    eventSource.addEventListener('timeout', () => {
      setError('Stream timeout. Check status below.');
      eventSource.close();
      fetchCandidate();
    });

    eventSource.onerror = () => {
      eventSource.close();
      fetchCandidate();
    };

    return eventSource;
  }, [fetchCandidate]);

  const handleStartEnrichment = useCallback(async () => {
    const result = await startEnrichment();
    if (result?.sessionId) {
      subscribeToStream(result.sessionId);
    }
  }, [startEnrichment, subscribeToStream]);

  const copyToClipboard = (value: string) => {
    if (value) {
      navigator.clipboard.writeText(value);
    }
  };

  const copyLinkedInUrl = () => {
    if (candidate?.linkedinUrl) {
      navigator.clipboard.writeText(candidate.linkedinUrl);
    }
  };

  useEffect(() => {
    let eventSource: EventSource | null = null;

    const init = async () => {
      try {
        const result = await fetchCandidate();

        if (result?.shouldSubscribe && result?.sessionId) {
          eventSource = subscribeToStream(result.sessionId);
          setSessionId(result.sessionId);
        } else if (shouldAutostart && !autostartTriggered.current && result?.data) {
          const hasSession = result.data.sessions && result.data.sessions.length > 0;
          const latestStatus = hasSession ? result.data.sessions[0].status : null;

          if (!hasSession || latestStatus === 'failed') {
            autostartTriggered.current = true;
            const enrichResult = await startEnrichment();
            if (enrichResult?.sessionId) {
              eventSource = subscribeToStream(enrichResult.sessionId);
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load candidate');
      } finally {
        setIsLoading(false);
      }
    };

    init();

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [candidateId, fetchCandidate, shouldAutostart, startEnrichment, subscribeToStream]);

  const getFailureReason = (): string => {
    if (!session) return 'Unknown error';
    const runTrace = session.runTrace as { failureReason?: string } | null;
    if (runTrace?.failureReason) return runTrace.failureReason;
    const sessionAny = session as { errorMessage?: string };
    if (sessionAny.errorMessage) return sessionAny.errorMessage;
    return 'Enrichment failed. Please try again.';
  };

  const summary = session?.summaryStructured as AISummaryStructured | null;
  const confirmedCount = identityCandidates.filter((ic) => ic.status === 'confirmed').length;
  const summaryMode = session?.runTrace?.final?.summaryMeta?.mode || 'draft';
  const isVerifiedSummary = summaryMode === 'verified';
  const usingPdl = summary?.source === 'pdl';

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background pt-24">
        <div className="container mx-auto px-4 max-w-4xl">
          <div className="flex items-center justify-center min-h-[60vh]">
            <div className="text-center space-y-4">
              <Loader2 className="w-12 h-12 animate-spin mx-auto text-primary" />
              <p className="text-muted-foreground">Loading candidate...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pt-24 pb-12">
      {/* Evidence Drawer */}
      {evidenceDrawer.selectedIdentity && (
        <EvidenceDrawer
          identity={evidenceDrawer.selectedIdentity}
          isOpen={evidenceDrawer.isOpen}
          onClose={evidenceDrawer.closeDrawer}
        />
      )}

      <div className="container mx-auto px-4 max-w-4xl">
        {/* Back Button */}
        <Button variant="ghost" onClick={() => router.back()} className="mb-4">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>

        {/* SECTION 1: Status + Actions Bar (Sticky) */}
        <div className="sticky top-20 z-40 bg-background/95 backdrop-blur-sm border-b border-border -mx-4 px-4 py-3 mb-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            {/* Left: Name + Status */}
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-foreground">
                {candidate?.nameHint || candidate?.linkedinId || 'Unknown'}
              </h1>
              <StatusBadge state={uiState} />
            </div>

            {/* Right: Actions */}
            <div className="flex items-center gap-2">
              {uiState === 'idle' && !isMisconfigured && (
                <Button onClick={handleStartEnrichment} size="sm">
                  <Play className="mr-1 h-3 w-3" />
                  Enrich
                </Button>
              )}
              {(uiState === 'completed' || uiState === 'failed') && (
                <Button onClick={handleStartEnrichment} variant="outline" size="sm">
                  <RefreshCw className="mr-1 h-3 w-3" />
                  Re-enrich
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={copyLinkedInUrl}>
                <Copy className="h-3 w-3" />
              </Button>
              {candidate?.linkedinUrl && (
                <a href={candidate.linkedinUrl} target="_blank" rel="noopener noreferrer">
                  <Button variant="ghost" size="sm">
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                </a>
              )}
            </div>
          </div>

          {/* Compact Metrics */}
          {uiState === 'completed' && (
            <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" />
                {identityCandidates.length} found
              </span>
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-green-500" />
                {confirmedCount} confirmed
              </span>
              <span className="flex items-center gap-1">
                <Search className="h-3 w-3" />
                {session?.queriesExecuted || 0} queries
              </span>
              {session?.finalConfidence && (
                <span className="flex items-center gap-1">
                  <BarChart3 className="h-3 w-3" />
                  {(session.finalConfidence * 100).toFixed(0)}% best
                </span>
              )}
            </div>
          )}
        </div>

        {/* Error States */}
        {isMisconfigured && (
          <Card className="mb-6 border-red-500/50 bg-red-500/10">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-red-500 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-red-500">Enrichment Misconfigured</h3>
                  <p className="text-sm text-red-400 mt-1">
                    Contact admin to enable LangGraph enrichment (USE_LANGGRAPH_ENRICHMENT=true).
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {error && !isMisconfigured && (
          <Card className="mb-6 border-red-500/50 bg-red-500/10">
            <CardContent className="pt-6">
              <p className="text-red-500 flex items-center gap-2">
                <XCircle className="h-4 w-4" />
                {error}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Running State - Progress Timeline */}
        {uiState === 'running' && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                Enriching...
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* Progress Bar */}
              <div className="mb-4">
                <div className="flex items-center justify-between text-sm text-muted-foreground mb-1">
                  <span>{progressEvents.find((e) => e.node)?.node || 'Starting...'}</span>
                  <span>{Math.min(progressEvents.length * 15, 90)}%</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(progressEvents.length * 15, 90)}%` }}
                  />
                </div>
              </div>

              {/* Live Counters */}
              <div className="flex items-center gap-6 text-sm">
                <div className="flex items-center gap-2">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <span className="font-mono">{progressMetrics.queriesExecuted}</span>
                  <span className="text-muted-foreground">queries</span>
                </div>
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-muted-foreground" />
                  <span className="font-mono">{progressMetrics.platformsCompleted}</span>
                  <span className="text-muted-foreground">platforms</span>
                </div>
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="font-mono">{progressMetrics.identitiesFound}</span>
                  <span className="text-muted-foreground">found</span>
                </div>
              </div>

              {/* Expandable Details */}
              <Collapsible className="mt-4">
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs text-muted-foreground">
                    <ChevronRight className="h-3 w-3 mr-1" />
                    Show event log
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2">
                  <div className="space-y-1 text-xs font-mono bg-muted/30 p-2 rounded max-h-40 overflow-auto">
                    {progressEvents.map((event, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <CheckCircle2 className="h-3 w-3 text-green-500" />
                        <span className="text-muted-foreground">{event.node || event.type}</span>
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </CardContent>
          </Card>
        )}

        {/* Idle/Failed State - Start Button */}
        {(uiState === 'idle' || uiState === 'failed') && !isMisconfigured && (
          <Card className="mb-6">
            <CardContent className="pt-6">
              <div className="text-center py-8">
                {uiState === 'failed' ? (
                  <>
                    <XCircle className="h-12 w-12 mx-auto text-red-500 mb-4" />
                    <h3 className="text-lg font-semibold mb-2">Enrichment Failed</h3>
                    <p className="text-muted-foreground mb-6">{getFailureReason()}</p>
                  </>
                ) : (
                  <>
                    <Search className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <h3 className="text-lg font-semibold mb-2">Not Enriched Yet</h3>
                    <p className="text-muted-foreground mb-6">
                      Start enrichment to discover platform identities.
                    </p>
                  </>
                )}
                <Button onClick={handleStartEnrichment} size="lg">
                  <Play className="mr-2 h-4 w-4" />
                  {uiState === 'failed' ? 'Retry Enrichment' : 'Start Enrichment'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* SECTION 2: Identities (Tier-grouped, progressive disclosure) */}
        {uiState === 'completed' && identityCandidates.length > 0 && (
          <div className="space-y-4 mb-6">
            {/* Tier 1: Confirmed / Auto-merge */}
            {groupedIdentities.confirmed.length > 0 && (
              <Collapsible open={tier1Open} onOpenChange={setTier1Open}>
                <Card>
                  <CollapsibleTrigger asChild>
                    <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors">
                      <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                          Confirmed / Auto-Merge
                          <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                            {groupedIdentities.confirmed.length}
                          </Badge>
                        </CardTitle>
                        {tier1Open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="pt-0 space-y-3">
                      {groupedIdentities.confirmed.map((ic) => (
                        <IdentityCandidateCard
                          key={ic.id}
                          identity={ic}
                          onConfirm={ic.status === 'unconfirmed' ? handleConfirm : undefined}
                          onReject={ic.status === 'unconfirmed' ? handleReject : undefined}
                          onRevealEmail={handleRevealEmail}
                          onViewEvidence={evidenceDrawer.openDrawer}
                        />
                      ))}
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            )}

            {/* Tier 2: Needs Review */}
            {groupedIdentities.needsReview.length > 0 && (
              <Collapsible open={tier2Open} onOpenChange={setTier2Open}>
                <Card>
                  <CollapsibleTrigger asChild>
                    <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors">
                      <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <AlertCircle className="h-4 w-4 text-yellow-500" />
                          Needs Review
                          <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
                            {groupedIdentities.needsReview.length}
                          </Badge>
                        </CardTitle>
                        {tier2Open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="pt-0 space-y-3">
                      {groupedIdentities.needsReview.map((ic) => (
                        <IdentityCandidateCard
                          key={ic.id}
                          identity={ic}
                          onConfirm={handleConfirm}
                          onReject={handleReject}
                          onRevealEmail={handleRevealEmail}
                          onViewEvidence={evidenceDrawer.openDrawer}
                        />
                      ))}
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            )}

            {/* Tier 3: Low Confidence (collapsed by default) */}
            {groupedIdentities.lowConfidence.length > 0 && (
              <Collapsible open={tier3Open} onOpenChange={setTier3Open}>
                <Card className="opacity-80">
                  <CollapsibleTrigger asChild>
                    <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors">
                      <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2 text-base text-muted-foreground">
                          <Search className="h-4 w-4" />
                          Low Confidence
                          <Badge variant="outline">
                            {groupedIdentities.lowConfidence.length}
                          </Badge>
                        </CardTitle>
                        {tier3Open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="pt-0 space-y-3">
                      {groupedIdentities.lowConfidence.map((ic) => (
                        <IdentityCandidateCard
                          key={ic.id}
                          identity={ic}
                          onConfirm={handleConfirm}
                          onReject={handleReject}
                          onRevealEmail={handleRevealEmail}
                          onViewEvidence={evidenceDrawer.openDrawer}
                        />
                      ))}
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            )}

            {/* Rejected */}
            {groupedIdentities.rejected.length > 0 && (
              <Collapsible>
                <Card className="opacity-60">
                  <CollapsibleTrigger asChild>
                    <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors">
                      <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2 text-base text-muted-foreground">
                          <XCircle className="h-4 w-4 text-red-500" />
                          Rejected
                          <Badge variant="outline" className="text-red-400">
                            {groupedIdentities.rejected.length}
                          </Badge>
                        </CardTitle>
                        <ChevronRight className="h-4 w-4" />
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="pt-0 space-y-3">
                      {groupedIdentities.rejected.map((ic) => (
                        <IdentityCandidateCard
                          key={ic.id}
                          identity={ic}
                          onViewEvidence={evidenceDrawer.openDrawer}
                        />
                      ))}
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            )}
          </div>
        )}

        {/* No identities found */}
        {uiState === 'completed' && identityCandidates.length === 0 && (
          <Card className="mb-6">
            <CardContent className="pt-6 text-center">
              <p className="text-muted-foreground">
                {usingPdl
                  ? 'No identity candidates discovered (PDL-only enrichment).'
                  : 'No identity candidates discovered.'}
              </p>
              <Button variant="outline" className="mt-4" onClick={handleStartEnrichment}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Re-enrich
              </Button>
            </CardContent>
          </Card>
        )}

        {/* SECTION 3: AI Summary */}
        {uiState === 'completed' && session?.summary && (
          <Card
            ref={summaryCardRef}
            className={`mb-6 ${isVerifiedSummary ? 'border-green-500/30' : 'border-amber-500/30'}`}
          >
            <CardHeader>
              <div className="flex items-start justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-purple-500" />
                  Summary
                  {summaryRegenerating && (
                    <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                  )}
                </CardTitle>
                <div className="flex items-center gap-2">
                  {summaryRegenerating ? (
                    <Badge variant="outline" className="border-blue-500 text-blue-400">
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      Regenerating
                    </Badge>
                  ) : isVerifiedSummary ? (
                    <Badge variant="outline" className="border-green-500 text-green-400">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Verified ({confirmedCount} confirmed)
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-amber-500 text-amber-400">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Draft (unconfirmed sources)
                    </Badge>
                  )}
                  {confirmedCount > 0 && !summaryRegenerating && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleRegenerateSummary}
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      Regenerate
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <p className="text-base leading-relaxed">{session.summary}</p>

              {summary && (
                <>
                  {summary.contactRestricted && (
                    <>
                      <Separator />
                      <div className="flex items-center gap-2 text-sm text-orange-500">
                        <AlertTriangle className="h-4 w-4" />
                        Contact details are restricted by tenant policy.
                      </div>
                    </>
                  )}

                  {summary.contact && (summary.contact.emails.length > 0 || summary.contact.phones.length > 0) && (
                    <>
                      <Separator />
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Zap className="h-4 w-4" />
                          Contact Details
                        </div>
                        {summary.contact.emails.length > 0 && (
                          <div className="space-y-2">
                            <div className="text-xs text-muted-foreground">Emails</div>
                            <div className="flex flex-wrap gap-2">
                              {summary.contact.emails.map((email, idx) => (
                                <Button
                                  key={`email-${idx}`}
                                  variant="outline"
                                  size="sm"
                                  onClick={() => copyToClipboard(email.value)}
                                >
                                  {email.value}
                                  <Copy className="ml-2 h-3 w-3" />
                                </Button>
                              ))}
                            </div>
                          </div>
                        )}
                        {summary.contact.phones.length > 0 && (
                          <div className="space-y-2">
                            <div className="text-xs text-muted-foreground">Phones</div>
                            <div className="flex flex-wrap gap-2">
                              {summary.contact.phones.map((phone, idx) => (
                                <Button
                                  key={`phone-${idx}`}
                                  variant="outline"
                                  size="sm"
                                  onClick={() => copyToClipboard(phone.value)}
                                >
                                  {phone.value}
                                  <Copy className="ml-2 h-3 w-3" />
                                </Button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {summary.skills && summary.skills.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Code className="h-4 w-4" />
                        Skills
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {summary.skills.map((skill, idx) => (
                          <Badge key={idx} variant="secondary">{skill}</Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {summary.highlights && summary.highlights.length > 0 && (
                    <>
                      <Separator />
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Lightbulb className="h-4 w-4" />
                          Highlights
                        </div>
                        <ul className="space-y-1 pl-6 list-disc text-sm">
                          {summary.highlights.map((h, idx) => (
                            <li key={idx}>{h}</li>
                          ))}
                        </ul>
                      </div>
                    </>
                  )}

                  {summary.talkingPoints && summary.talkingPoints.length > 0 && (
                    <>
                      <Separator />
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <MessageSquare className="h-4 w-4" />
                          Talking Points
                        </div>
                        <ul className="space-y-1 pl-6 list-disc text-sm">
                          {summary.talkingPoints.map((tp, idx) => (
                            <li key={idx}>{tp}</li>
                          ))}
                        </ul>
                      </div>
                    </>
                  )}

                  {summary.caveats && summary.caveats.length > 0 && (
                    <>
                      <Separator />
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm font-medium text-orange-500">
                          <AlertTriangle className="h-4 w-4" />
                          Caveats
                        </div>
                        <ul className="space-y-1 pl-6 list-disc text-sm text-orange-500">
                          {summary.caveats.map((c, idx) => (
                            <li key={idx}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    </>
                  )}
                </>
              )}

              {session.summaryModel && (
                <div className="text-xs text-muted-foreground pt-2">
                  Model: {session.summaryModel}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Metadata Footer */}
        {session && uiState === 'completed' && (
          <div className="text-xs text-muted-foreground text-center space-x-4">
            {session.durationMs && <span>Duration: {(session.durationMs / 1000).toFixed(1)}s</span>}
            <span>Completed: {new Date(session.completedAt || session.createdAt).toLocaleString()}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ state }: { state: EnrichmentUIState }) {
  const config = {
    idle: { label: 'Not Started', icon: Clock, className: 'bg-muted text-muted-foreground' },
    running: { label: 'Running', icon: Loader2, className: 'bg-blue-500/20 text-blue-400' },
    completed: { label: 'Completed', icon: CheckCircle2, className: 'bg-green-500/20 text-green-400' },
    failed: { label: 'Failed', icon: XCircle, className: 'bg-red-500/20 text-red-400' },
  }[state];

  const Icon = config.icon;

  return (
    <Badge variant="outline" className={config.className}>
      <Icon className={`mr-1 h-3 w-3 ${state === 'running' ? 'animate-spin' : ''}`} />
      {config.label}
    </Badge>
  );
}
