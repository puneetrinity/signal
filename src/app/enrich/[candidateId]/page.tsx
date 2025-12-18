'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAuthHeaders } from '@/contexts/ApiKeyContext';
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
  Github,
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

        {/* AI Summary */}
        {status === 'completed' && session?.summary && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-purple-500" />
                AI Summary
                {session.summaryModel && (
                  <span className="text-sm font-normal text-muted-foreground">
                    ({session.summaryModel})
                  </span>
                )}
              </CardTitle>
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
        )}

        {/* Identity Candidates */}
        {identityCandidates.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="h-5 w-5" />
                Discovered Identities ({identityCandidates.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {identityCandidates.map((ic) => (
                  <div
                    key={ic.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-muted/20"
                  >
                    <div className="flex items-center gap-3">
                      {ic.platform === 'github' ? (
                        <Github className="h-5 w-5" />
                      ) : (
                        <ExternalLink className="h-5 w-5" />
                      )}
                      <div>
                        <div className="font-medium">{ic.platformId}</div>
                        <a
                          href={ic.profileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-blue-500 hover:underline"
                        >
                          {ic.profileUrl}
                        </a>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-mono ${
                          ic.confidence >= 0.9
                            ? 'text-green-500'
                            : ic.confidence >= 0.7
                            ? 'text-yellow-500'
                            : 'text-orange-500'
                        }`}
                      >
                        {(ic.confidence * 100).toFixed(0)}%
                      </span>
                      <Badge variant={ic.confidenceBucket === 'auto_merge' ? 'default' : 'secondary'}>
                        {ic.confidenceBucket?.replace('_', ' ')}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

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
