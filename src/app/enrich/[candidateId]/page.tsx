'use client';

// Disable static prerendering - this page requires auth
export const dynamic = 'force-dynamic';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAuthHeaders } from '@/contexts/ApiKeyContext';
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

type EnrichmentStatus = 'pending' | 'running' | 'completed' | 'failed';

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
  const getAuthHeaders = useAuthHeaders();

  const [status, setStatus] = useState<EnrichmentStatus>('pending');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [progressEvents, setProgressEvents] = useState<ProgressEvent[]>([]);
  const [candidate, setCandidate] = useState<CandidateData | null>(null);
  const [identityCandidates, setIdentityCandidates] = useState<IdentityCandidateData[]>([]);
  const [session, setSession] = useState<EnrichmentSessionSummary | null>(null);
  const [summaryRegenerating, setSummaryRegenerating] = useState(false);
  const summaryCardRef = useRef<HTMLDivElement>(null);

  // Fetch candidate data
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
        setSession(data.sessions[0]);
      }
      return data;
    } catch (err) {
      throw err;
    }
  }, [candidateId]);

  // Start enrichment via async endpoint (uses LangGraph with AI summary)
  const startEnrichment = useCallback(async () => {
    try {
      const response = await fetch('/api/v2/enrich/async', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ candidateId }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start enrichment');
      }

      if (data.sessionId) {
        setSessionId(data.sessionId);
      }

      return data;
    } catch (err) {
      throw err;
    }
  }, [candidateId, getAuthHeaders]);

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
        headers: getAuthHeaders(),
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
  }, [getAuthHeaders, fetchCandidate, subscribeToSummaryRegeneration]);

  // Reject an identity candidate
  const handleReject = useCallback(async (identityCandidateId: string): Promise<boolean> => {
    try {
      // Backend uses DELETE method for rejection
      const response = await fetch('/api/v2/identity/confirm', {
        method: 'DELETE',
        headers: getAuthHeaders(),
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
  }, [getAuthHeaders, fetchCandidate]);

  // Reveal email for an identity candidate
  const handleRevealEmail = useCallback(async (identityCandidateId: string): Promise<string | null> => {
    try {
      const response = await fetch('/api/v2/identity/reveal', {
        method: 'POST',
        headers: getAuthHeaders(),
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
  }, [getAuthHeaders]);

  // Subscribe to SSE stream
  const subscribeToStream = useCallback((sid: string) => {
    const eventSource = new EventSource(`/api/v2/enrich/session/stream?sessionId=${sid}`);

    eventSource.addEventListener('connected', (e) => {
      const data = JSON.parse(e.data);
      setStatus('running');
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
      setStatus('completed');
      setProgressEvents((prev) => [...prev, { type: 'completed', timestamp: data.timestamp }]);
      eventSource.close();
      // Refresh data
      fetchCandidate();
    });

    eventSource.addEventListener('failed', (e) => {
      const data = JSON.parse(e.data);
      setStatus('failed');
      setError(data.error || 'Enrichment failed');
      setProgressEvents((prev) => [...prev, { type: 'failed', timestamp: data.timestamp }]);
      eventSource.close();
    });

    eventSource.addEventListener('timeout', (e) => {
      const data = JSON.parse(e.data);
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

  // Initial load - fetch candidate and start enrichment
  useEffect(() => {
    let eventSource: EventSource | null = null;

    const init = async () => {
      try {
        // First, fetch existing candidate data
        await fetchCandidate();

        // Start enrichment via async endpoint
        setStatus('running');
        const result = await startEnrichment();

        // Async endpoint returns sessionId directly
        if (result.sessionId) {
          eventSource = subscribeToStream(result.sessionId);
        } else {
          // No session returned, enrichment may have been instant or already done
          await fetchCandidate();
          setStatus('completed');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start enrichment');
        setStatus('failed');
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
  }, [candidateId, fetchCandidate, startEnrichment, subscribeToStream]);

  const summary = session?.summaryStructured as AISummaryStructured | null;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-center min-h-[60vh]">
            <div className="text-center space-y-4">
              <Loader2 className="w-12 h-12 animate-spin mx-auto text-primary" />
              <p className="text-muted-foreground">Loading enrichment...</p>
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
            <StatusBadge status={status} />
          </div>
        </div>

        {/* Error */}
        {error && (
          <Card className="mb-6 border-red-200 bg-red-50 dark:bg-red-950/20">
            <CardContent className="pt-6">
              <p className="text-red-600 flex items-center gap-2">
                <XCircle className="h-4 w-4" />
                {error}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Progress */}
        {status === 'running' && (
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
              </div>
            </CardContent>
          </Card>
        )}

        {/* Identity Candidates - Primary section for confirmation */}
        {identityCandidates.length > 0 && (() => {
          const confirmed = identityCandidates.filter((ic) => ic.status === 'confirmed');
          const unconfirmed = identityCandidates.filter((ic) => ic.status === 'unconfirmed');
          const rejected = identityCandidates.filter((ic) => ic.status === 'rejected');

          return (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Search className="h-5 w-5" />
                  Discovered Identities ({identityCandidates.length})
                </CardTitle>
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
        {status === 'completed' && identityCandidates.length === 0 && (
          <Card className="mb-6">
            <CardContent className="pt-6 text-center text-muted-foreground">
              <p>No identity candidates discovered.</p>
              <p className="text-sm mt-1">
                Try adding more context to the candidate&apos;s profile.
              </p>
            </CardContent>
          </Card>
        )}

        {/* AI Summary */}
        {status === 'completed' && session?.summary && (() => {
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
        {session && (
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

function StatusBadge({ status }: { status: EnrichmentStatus }) {
  const config = {
    pending: {
      label: 'Pending',
      icon: Clock,
      className: 'bg-yellow-100 text-yellow-800 border-yellow-200',
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
  }[status];

  const Icon = config.icon;

  return (
    <Badge variant="outline" className={config.className}>
      <Icon className={`mr-1 h-3 w-3 ${status === 'running' ? 'animate-spin' : ''}`} />
      {config.label}
    </Badge>
  );
}
