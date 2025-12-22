'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { IdentityCandidateCard } from '@/components/IdentityCandidateCard';
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

/**
 * UI state machine for enrichment page
 * - idle: No session or not started
 * - running: Session in progress
 * - completed: Session finished successfully
 * - failed: Session failed
 */
type EnrichmentUIState = 'idle' | 'running' | 'completed' | 'failed';

interface ProgressEvent {
  type: string;
  node?: string;
  data?: unknown;
  timestamp: string;
}

export default function EnrichmentPage({ params }: PageProps) {
  const resolvedParams = use(params);
  const { candidateId } = resolvedParams;
  const router = useRouter();
  const searchParams = useSearchParams();

  // Check for autostart query param (used when opening from search results)
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

  // Fetch candidate data and determine initial state
  const fetchCandidate = useCallback(async () => {
    try {
      const response = await fetch(`/api/v2/enrich?candidateId=${candidateId}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load candidate');
      }

      setCandidate(data.candidate);
      setIdentityCandidates(data.identityCandidates || []);

      // Determine UI state from latest session
      if (data.sessions && data.sessions.length > 0) {
        const latestSession = data.sessions[0];
        setSession(latestSession);

        // Map session status to UI state
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

  // Start enrichment via async endpoint
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
        // Detect misconfiguration (LangGraph disabled)
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

  // Subscribe to summary regeneration stream
  const subscribeToSummaryRegeneration = useCallback((regenSessionId: string) => {
    setSummaryRegenerating(true);

    // Scroll to summary card so user can see the regeneration
    setTimeout(() => {
      summaryCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);

    const eventSource = new EventSource(`/api/v2/enrich/session/stream?sessionId=${regenSessionId}`);

    // Timeout fallback - if stream doesn't complete in 60s, stop waiting
    const timeoutId = setTimeout(() => {
      if (eventSource.readyState !== EventSource.CLOSED) {
        eventSource.close();
        setSummaryRegenerating(false);
        fetchCandidate(); // Try to fetch anyway
      }
    }, 60000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      setSummaryRegenerating(false);
      eventSource.close();
    };

    eventSource.addEventListener('completed', async () => {
      cleanup();
      // Refresh to get updated summary
      await fetchCandidate();
      // Scroll to show the verified badge
      setTimeout(() => {
        summaryCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    });

    eventSource.addEventListener('failed', (e) => {
      const data = JSON.parse(e.data);
      console.error('Summary regeneration failed:', data.error);
      cleanup();
    });

    eventSource.onerror = () => {
      cleanup();
    };

    return eventSource;
  }, [fetchCandidate]);

  // Confirm an identity candidate
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

      // Refresh identity data immediately
      await fetchCandidate();

      // If summary regeneration was triggered, subscribe to stream for updates
      if (data.summaryRegeneration?.triggered && data.summaryRegeneration?.sessionId) {
        console.log(`[Enrich] Summary regeneration triggered: ${data.summaryRegeneration.reason}`);
        subscribeToSummaryRegeneration(data.summaryRegeneration.sessionId);
      }

      return true;
    } catch (err) {
      console.error('Confirm error:', err);
      return false;
    }
  }, [fetchCandidate, subscribeToSummaryRegeneration]);

  // Reject an identity candidate
  const handleReject = useCallback(async (identityCandidateId: string): Promise<boolean> => {
    try {
      // Backend uses DELETE method for rejection
      const response = await fetch('/api/v2/identity/confirm', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityCandidateId }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to reject identity');
      }
      // Refresh data
      await fetchCandidate();
      return true;
    } catch (err) {
      console.error('Reject error:', err);
      return false;
    }
  }, [fetchCandidate]);

  // Reveal email for an identity candidate
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

  // Subscribe to SSE stream for enrichment progress
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
      // Refresh data
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
      // Fetch final status
      fetchCandidate();
    };

    return eventSource;
  }, [fetchCandidate]);

  // Handle start enrichment button click
  const handleStartEnrichment = useCallback(async () => {
    const result = await startEnrichment();
    if (result?.sessionId) {
      subscribeToStream(result.sessionId);
    }
  }, [startEnrichment, subscribeToStream]);

  // Initial load - fetch candidate and optionally start enrichment if ?autostart=1
  useEffect(() => {
    let eventSource: EventSource | null = null;

    const init = async () => {
      try {
        const result = await fetchCandidate();

        // If already running, subscribe to the existing session
        if (result?.shouldSubscribe && result?.sessionId) {
          eventSource = subscribeToStream(result.sessionId);
          setSessionId(result.sessionId);
        }
        // If autostart=1 and not already enriched/running, start enrichment
        else if (shouldAutostart && !autostartTriggered.current && result?.data) {
          const hasSession = result.data.sessions && result.data.sessions.length > 0;
          const latestStatus = hasSession ? result.data.sessions[0].status : null;

          // Only autostart if no session or if last session failed
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

  // Get failure reason from session
  const getFailureReason = (): string => {
    if (!session) return 'Unknown error';

    // Try runTrace.failureReason first
    const runTrace = session.runTrace as { failureReason?: string } | null;
    if (runTrace?.failureReason) {
      return runTrace.failureReason;
    }

    // Fall back to errorMessage on session
    const sessionAny = session as { errorMessage?: string };
    if (sessionAny.errorMessage) {
      return sessionAny.errorMessage;
    }

    return 'Enrichment failed. Please try again.';
  };

  // Format relative time
  const formatRelativeTime = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const summary = session?.summaryStructured as AISummaryStructured | null;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
        <div className="container mx-auto px-4 py-8">
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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <Button variant="ghost" onClick={() => router.back()} className="mb-6">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-3xl font-bold mb-2">{candidate?.nameHint || 'Unknown'}</h1>
              {candidate?.linkedinUrl && (
                <a
                  href={candidate.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                >
                  LinkedIn Profile
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <StatusBadge state={uiState} />
          </div>

          {/* Last enriched time */}
          {session?.completedAt && uiState !== 'running' && (
            <p className="text-sm text-muted-foreground mt-2">
              Last enriched: {formatRelativeTime(session.completedAt)}
              {session.durationMs && ` (${(session.durationMs / 1000).toFixed(1)}s)`}
            </p>
          )}
        </div>

        {/* Misconfiguration Error */}
        {isMisconfigured && (
          <Card className="mb-6 border-red-300 bg-red-50 dark:bg-red-950/30">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-red-800 dark:text-red-200">
                    Enrichment Misconfigured
                  </h3>
                  <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                    The enrichment system is not properly configured. Please contact your administrator
                    to enable LangGraph enrichment (USE_LANGGRAPH_ENRICHMENT=true).
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Generic Error (non-misconfig) */}
        {error && !isMisconfigured && (
          <Card className="mb-6 border-red-200 bg-red-50 dark:bg-red-950/20">
            <CardContent className="pt-6">
              <p className="text-red-600 flex items-center gap-2">
                <XCircle className="h-4 w-4" />
                {error}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Idle State - Show start button */}
        {uiState === 'idle' && !isMisconfigured && (
          <Card className="mb-6">
            <CardContent className="pt-6">
              <div className="text-center py-8">
                <Search className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">Not Enriched Yet</h3>
                <p className="text-muted-foreground mb-6">
                  Start enrichment to discover platform identities for this candidate.
                </p>
                <Button onClick={handleStartEnrichment} size="lg">
                  <Play className="mr-2 h-4 w-4" />
                  Start Enrichment
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Running State - Show progress */}
        {uiState === 'running' && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                Enriching...
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {progressEvents.map((event, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    <span className="text-muted-foreground">
                      {event.node || event.type}
                    </span>
                  </div>
                ))}
                {progressEvents.length === 0 && (
                  <p className="text-muted-foreground">Starting enrichment process...</p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Failed State - Show error and retry */}
        {uiState === 'failed' && !isMisconfigured && (
          <Card className="mb-6 border-red-200">
            <CardContent className="pt-6">
              <div className="text-center py-4">
                <XCircle className="h-12 w-12 mx-auto text-red-500 mb-4" />
                <h3 className="text-lg font-semibold mb-2">Enrichment Failed</h3>
                <p className="text-muted-foreground mb-6">{getFailureReason()}</p>
                <Button onClick={handleStartEnrichment} variant="outline">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Retry Enrichment
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Identity Candidates - Show for completed state */}
        {uiState === 'completed' && identityCandidates.length > 0 && (() => {
          const confirmed = identityCandidates.filter((ic) => ic.status === 'confirmed');
          const unconfirmed = identityCandidates.filter((ic) => ic.status === 'unconfirmed');
          const rejected = identityCandidates.filter((ic) => ic.status === 'rejected');

          return (
            <Card className="mb-6">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Search className="h-5 w-5" />
                    Discovered Identities ({identityCandidates.length})
                  </CardTitle>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleStartEnrichment}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Re-enrich
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Confirmed identities */}
                {confirmed.length > 0 && (
                  <div className="space-y-3">
                    <div className="text-sm font-medium text-green-600">
                      Confirmed ({confirmed.length})
                    </div>
                    {confirmed.map((ic) => (
                      <IdentityCandidateCard key={ic.id} identity={ic} />
                    ))}
                  </div>
                )}

                {/* Unconfirmed identities - actionable */}
                {unconfirmed.length > 0 && (
                  <div className="space-y-3">
                    <div className="text-sm font-medium text-yellow-600">
                      Pending Review ({unconfirmed.length})
                    </div>
                    {unconfirmed.map((ic) => (
                      <IdentityCandidateCard
                        key={ic.id}
                        identity={ic}
                        onConfirm={handleConfirm}
                        onReject={handleReject}
                        onRevealEmail={handleRevealEmail}
                      />
                    ))}
                  </div>
                )}

                {/* Rejected identities */}
                {rejected.length > 0 && (
                  <div className="space-y-3">
                    <div className="text-sm font-medium text-red-600">
                      Rejected ({rejected.length})
                    </div>
                    {rejected.map((ic) => (
                      <IdentityCandidateCard key={ic.id} identity={ic} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })()}

        {/* No identities found */}
        {uiState === 'completed' && identityCandidates.length === 0 && (
          <Card className="mb-6">
            <CardContent className="pt-6 text-center">
              <p className="text-muted-foreground">No identity candidates discovered.</p>
              <p className="text-sm mt-1 text-muted-foreground">
                Try adding more context to the candidate&apos;s profile.
              </p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={handleStartEnrichment}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Re-enrich
              </Button>
            </CardContent>
          </Card>
        )}

        {/* AI Summary */}
        {uiState === 'completed' && session?.summary && (() => {
          // Count identities by status for display
          const confirmedCount = identityCandidates.filter(
            (ic) => ic.status === 'confirmed'
          ).length;
          const autoMergeCount = identityCandidates.filter(
            (ic) => ic.confidenceBucket === 'auto_merge'
          ).length;
          const totalIdentities = identityCandidates.length;

          // Check if summary is verified (from runTrace metadata)
          const summaryMode = session.runTrace?.final?.summaryMeta?.mode || 'draft';
          const isVerified = summaryMode === 'verified';

          return (
            <Card
              ref={summaryCardRef}
              className={`mb-6 ${isVerified ? 'border-green-200 dark:border-green-800' : 'border-amber-200 dark:border-amber-800'}`}
            >
              <CardHeader>
                <div className="flex items-start justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-purple-500" />
                    AI Summary
                    {summaryRegenerating && (
                      <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                    )}
                  </CardTitle>
                  {summaryRegenerating ? (
                    <Badge variant="outline" className="border-blue-500 text-blue-700 dark:text-blue-400">
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      Regenerating
                    </Badge>
                  ) : isVerified ? (
                    <Badge variant="outline" className="border-green-500 text-green-700 dark:text-green-400">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Verified
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Draft
                    </Badge>
                  )}
                </div>
                <div className="text-sm text-muted-foreground mt-2 space-y-1">
                  {isVerified ? (
                    <p className="text-green-600">
                      <CheckCircle2 className="h-3 w-3 inline mr-1" />
                      Based on {confirmedCount} confirmed {confirmedCount === 1 ? 'identity' : 'identities'}
                    </p>
                  ) : (
                    <>
                      <p>
                        Based on {totalIdentities} discovered {totalIdentities === 1 ? 'identity' : 'identities'}
                        {autoMergeCount > 0 && ` (${autoMergeCount} high-confidence)`}
                      </p>
                      {confirmedCount > 0 && !summaryRegenerating && (
                        <p className="text-green-600">
                          <CheckCircle2 className="h-3 w-3 inline mr-1" />
                          {confirmedCount} confirmed — verified summary generating automatically
                        </p>
                      )}
                      {summaryRegenerating && (
                        <p className="text-blue-600">
                          <Loader2 className="h-3 w-3 inline mr-1 animate-spin" />
                          Generating verified summary from confirmed identities...
                        </p>
                      )}
                    </>
                  )}
                </div>
                {session.summaryModel && (
                  <span className="text-xs text-muted-foreground">
                    Model: {session.summaryModel}
                  </span>
                )}
              </CardHeader>
              <CardContent className="space-y-6">
                <p className="text-base leading-relaxed">{session.summary}</p>

              {summary && (
                <>
                  {/* Skills */}
                  {summary.skills && summary.skills.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Code className="h-4 w-4" />
                        Skills
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {summary.skills.map((skill, idx) => (
                          <Badge key={idx} variant="secondary">
                            {skill}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <Separator />

                  {/* Highlights */}
                  {summary.highlights && summary.highlights.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Lightbulb className="h-4 w-4" />
                        Highlights
                      </div>
                      <ul className="space-y-2 pl-6 list-disc">
                        {summary.highlights.map((h, idx) => (
                          <li key={idx} className="text-sm">{h}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <Separator />

                  {/* Talking Points */}
                  {summary.talkingPoints && summary.talkingPoints.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <MessageSquare className="h-4 w-4" />
                        Talking Points
                      </div>
                      <ul className="space-y-2 pl-6 list-disc">
                        {summary.talkingPoints.map((tp, idx) => (
                          <li key={idx} className="text-sm">{tp}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Caveats */}
                  {summary.caveats && summary.caveats.length > 0 && (
                    <>
                      <Separator />
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm font-medium text-orange-600">
                          <AlertTriangle className="h-4 w-4" />
                          Caveats
                        </div>
                        <ul className="space-y-2 pl-6 list-disc text-orange-600">
                          {summary.caveats.map((c, idx) => (
                            <li key={idx} className="text-sm">{c}</li>
                          ))}
                        </ul>
                      </div>
                    </>
                  )}
                </>
              )}
            </CardContent>
          </Card>
          );
        })()}

        {/* Metadata */}
        {session && uiState === 'completed' && (
          <div className="text-xs text-muted-foreground text-center space-x-4">
            {session.durationMs && <span>Duration: {(session.durationMs / 1000).toFixed(1)}s</span>}
            {session.sourcesExecuted && (
              <span>Sources: {session.sourcesExecuted.join(', ')}</span>
            )}
            <span>Completed: {new Date(session.completedAt || session.createdAt).toLocaleString()}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ state }: { state: EnrichmentUIState }) {
  const config = {
    idle: {
      label: 'Not Started',
      icon: Clock,
      className: 'bg-gray-100 text-gray-800 border-gray-200',
    },
    running: {
      label: 'Running',
      icon: Loader2,
      className: 'bg-blue-100 text-blue-800 border-blue-200',
    },
    completed: {
      label: 'Completed',
      icon: CheckCircle2,
      className: 'bg-green-100 text-green-800 border-green-200',
    },
    failed: {
      label: 'Failed',
      icon: XCircle,
      className: 'bg-red-100 text-red-800 border-red-200',
    },
  }[state];

  const Icon = config.icon;

  return (
    <Badge variant="outline" className={config.className}>
      <Icon className={`mr-1 h-3 w-3 ${state === 'running' ? 'animate-spin' : ''}`} />
      {config.label}
    </Badge>
  );
}
