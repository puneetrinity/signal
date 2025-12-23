'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Activity,
  Zap,
  Search,
} from 'lucide-react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { useSessions } from '@/lib/api/hooks';

interface SessionItem {
  id: string;
  candidateId: string;
  status: string;
  roleType: string | null;
  sourcesPlanned: string[] | null;
  sourcesExecuted: string[] | null;
  queriesPlanned: number | null;
  queriesExecuted: number | null;
  identitiesFound: number;
  identitiesConfirmed: number;
  finalConfidence: number | null;
  earlyStopReason: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  hasSummary: boolean;
  summaryModel: string | null;
  runTrace?: unknown;
  candidate?: {
    id: string;
    linkedinId: string;
    linkedinUrl: string;
    nameHint: string | null;
  };
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'running':
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
    case 'pending':
    case 'queued':
      return <Clock className="h-4 w-4 text-yellow-500" />;
    default:
      return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
  }
}

function getStatusBadge(status: string) {
  switch (status) {
    case 'completed':
      return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Completed</Badge>;
    case 'failed':
      return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Failed</Badge>;
    case 'running':
      return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">Running</Badge>;
    case 'pending':
    case 'queued':
      return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">Pending</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function formatDuration(ms: number | null): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export default function SessionsPage() {
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set());

  // React Query hook
  const {
    data,
    isLoading,
    error,
    refetch,
  } = useSessions(selectedStatus ? { status: selectedStatus } : undefined);

  const items = (data?.items || []) as SessionItem[];
  const stats = data?.stats || null;

  const toggleTrace = (id: string) => {
    setExpandedTraces((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-background pt-24 pb-12">
      <div className="container mx-auto px-4 max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Sessions</h1>
            <p className="text-muted-foreground mt-1">
              Monitor enrichment runs and debug issues
            </p>
          </div>
          <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
            <Card
              className={`cursor-pointer transition-colors ${selectedStatus === null ? 'ring-2 ring-primary' : ''}`}
              onClick={() => setSelectedStatus(null)}
            >
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-foreground">{stats.totalSessions}</div>
                <div className="text-sm text-muted-foreground">Total</div>
              </CardContent>
            </Card>
            <Card
              className={`cursor-pointer transition-colors ${selectedStatus === 'running' ? 'ring-2 ring-blue-500' : ''}`}
              onClick={() => setSelectedStatus(selectedStatus === 'running' ? null : 'running')}
            >
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-blue-500">{stats.statusCounts.running}</div>
                <div className="text-sm text-muted-foreground">Running</div>
              </CardContent>
            </Card>
            <Card
              className={`cursor-pointer transition-colors ${selectedStatus === 'pending' ? 'ring-2 ring-yellow-500' : ''}`}
              onClick={() => setSelectedStatus(selectedStatus === 'pending' ? null : 'pending')}
            >
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-yellow-500">{stats.statusCounts.pending}</div>
                <div className="text-sm text-muted-foreground">Pending</div>
              </CardContent>
            </Card>
            <Card
              className={`cursor-pointer transition-colors ${selectedStatus === 'completed' ? 'ring-2 ring-green-500' : ''}`}
              onClick={() => setSelectedStatus(selectedStatus === 'completed' ? null : 'completed')}
            >
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-green-500">{stats.statusCounts.completed}</div>
                <div className="text-sm text-muted-foreground">Completed</div>
              </CardContent>
            </Card>
            <Card
              className={`cursor-pointer transition-colors ${selectedStatus === 'failed' ? 'ring-2 ring-red-500' : ''}`}
              onClick={() => setSelectedStatus(selectedStatus === 'failed' ? null : 'failed')}
            >
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-red-500">{stats.statusCounts.failed}</div>
                <div className="text-sm text-muted-foreground">Failed</div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Loading State */}
        {isLoading && (
          <div className="space-y-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <Skeleton className="h-10 w-10 rounded" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-48" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                    <Skeleton className="h-8 w-20" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Error State */}
        {error && (
          <Card className="border-red-500/50 bg-red-500/10">
            <CardContent className="p-6 text-center">
              <AlertCircle className="h-8 w-8 text-red-500 mx-auto mb-2" />
              <p className="text-red-500">{error instanceof Error ? error.message : 'Unknown error'}</p>
              <Button variant="outline" className="mt-4" onClick={() => refetch()}>
                Try Again
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Empty State */}
        {!isLoading && !error && items.length === 0 && (
          <Card>
            <CardContent className="p-12 text-center">
              <Activity className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">No sessions found</h3>
              <p className="text-muted-foreground">
                {selectedStatus
                  ? `No ${selectedStatus} sessions.`
                  : 'No enrichment sessions have been run yet.'}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Sessions List */}
        {!isLoading && !error && items.length > 0 && (
          <div className="space-y-3">
            {items.map((session) => (
              <Collapsible key={session.id} open={expandedTraces.has(session.id)}>
                <Card className="hover:border-primary/50 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      {/* Status Icon */}
                      <div className="flex-shrink-0 h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                        {getStatusIcon(session.status)}
                      </div>

                      {/* Main Content */}
                      <div className="flex-1 min-w-0">
                        {/* Top Row */}
                        <div className="flex items-center gap-2 flex-wrap">
                          {getStatusBadge(session.status)}
                          {session.candidate && (
                            <Link
                              href={`/enrich/${session.candidateId}`}
                              className="text-foreground hover:text-blue-500 font-medium flex items-center gap-1"
                            >
                              {session.candidate.nameHint || session.candidate.linkedinId}
                              <ChevronRight className="h-3 w-3" />
                            </Link>
                          )}
                          <span className="text-sm text-muted-foreground">
                            {formatDistanceToNow(new Date(session.createdAt), { addSuffix: true })}
                          </span>
                        </div>

                        {/* Metrics Row */}
                        <div className="flex items-center gap-4 mt-2 text-sm">
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Search className="h-3 w-3" />
                            <span>{session.queriesExecuted || 0} queries</span>
                          </div>
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Zap className="h-3 w-3" />
                            <span>{session.identitiesFound} found</span>
                          </div>
                          {session.finalConfidence !== null && (
                            <div className="flex items-center gap-1 text-muted-foreground">
                              <span
                                className={`font-mono ${
                                  session.finalConfidence >= 0.9
                                    ? 'text-green-500'
                                    : session.finalConfidence >= 0.7
                                    ? 'text-yellow-500'
                                    : 'text-orange-500'
                                }`}
                              >
                                {(session.finalConfidence * 100).toFixed(0)}%
                              </span>
                            </div>
                          )}
                          <div className="text-muted-foreground">
                            {formatDuration(session.durationMs)}
                          </div>
                        </div>

                        {/* Error Message */}
                        {session.errorMessage && (
                          <div className="mt-2 text-sm text-red-500 line-clamp-1">
                            {session.errorMessage}
                          </div>
                        )}

                        {/* Early Stop Reason */}
                        {session.earlyStopReason && (
                          <div className="mt-2 text-sm text-blue-500">
                            Early stopped: {session.earlyStopReason}
                          </div>
                        )}
                      </div>

                      {/* Expand Button */}
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleTrace(session.id)}
                        >
                          {expandedTraces.has(session.id) ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      </CollapsibleTrigger>
                    </div>
                  </CardContent>

                  {/* Collapsible Run Trace */}
                  <CollapsibleContent>
                    <div className="border-t border-border/50 p-4 bg-muted/30">
                      <h4 className="text-sm font-medium text-foreground mb-3">Run Trace</h4>
                      {session.runTrace ? (
                        <pre className="text-xs bg-background p-3 rounded-lg overflow-auto max-h-96 font-mono">
                          {JSON.stringify(session.runTrace, null, 2)}
                        </pre>
                      ) : (
                        <p className="text-sm text-muted-foreground">No run trace available</p>
                      )}

                      {/* Sources Executed */}
                      {session.sourcesExecuted && session.sourcesExecuted.length > 0 && (
                        <div className="mt-4">
                          <h4 className="text-sm font-medium text-foreground mb-2">Sources Executed</h4>
                          <div className="flex flex-wrap gap-1">
                            {session.sourcesExecuted.map((source) => (
                              <Badge key={source} variant="outline" className="text-xs">
                                {source}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
