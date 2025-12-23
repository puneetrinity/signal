'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  AlertCircle,
  ChevronRight,
  Users,
  RefreshCw,
} from 'lucide-react';
import {
  getPlatformIcon,
  getPlatformLabel,
  getConfidenceColor,
  getConfidenceBadgeVariant,
} from '@/components/IdentityCandidateCard';
import Link from 'next/link';
import { useReviewQueue, useConfirmIdentity, useRejectIdentity } from '@/lib/api/hooks';

function getTierBadge(tier: number | null | undefined) {
  switch (tier) {
    case 1:
      return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Tier 1 - Auto</Badge>;
    case 2:
      return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">Tier 2 - Review</Badge>;
    case 3:
      return <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">Tier 3 - Low</Badge>;
    default:
      return <Badge variant="outline">Unknown</Badge>;
  }
}

export default function ReviewQueuePage() {
  const [selectedTier, setSelectedTier] = useState<number | null>(null);

  // React Query hooks
  const {
    data,
    isLoading,
    error,
    refetch,
  } = useReviewQueue(selectedTier !== null ? { bridgeTier: selectedTier } : undefined);

  const confirmMutation = useConfirmIdentity();
  const rejectMutation = useRejectIdentity();

  const items = data?.items || [];
  const stats = data?.stats || null;

  const handleConfirm = (id: string) => {
    confirmMutation.mutate(id);
  };

  const handleReject = (id: string) => {
    rejectMutation.mutate(id);
  };

  const isActionLoading = (id: string) =>
    (confirmMutation.isPending && confirmMutation.variables === id) ||
    (rejectMutation.isPending && rejectMutation.variables === id);

  return (
    <div className="min-h-screen bg-background pt-24 pb-12">
      <div className="container mx-auto px-4 max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Review Queue</h1>
            <p className="text-muted-foreground mt-1">
              Process identity matches that need human review
            </p>
          </div>
          <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <Card
              className={`cursor-pointer transition-colors ${selectedTier === null ? 'ring-2 ring-primary' : ''}`}
              onClick={() => setSelectedTier(null)}
            >
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-foreground">{stats.totalUnconfirmed}</div>
                <div className="text-sm text-muted-foreground">Total Pending</div>
              </CardContent>
            </Card>
            <Card
              className={`cursor-pointer transition-colors ${selectedTier === 2 ? 'ring-2 ring-yellow-500' : ''}`}
              onClick={() => setSelectedTier(selectedTier === 2 ? null : 2)}
            >
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-yellow-500">{stats.tierCounts.tier2}</div>
                <div className="text-sm text-muted-foreground">Tier 2 - Review</div>
              </CardContent>
            </Card>
            <Card
              className={`cursor-pointer transition-colors ${selectedTier === 3 ? 'ring-2 ring-orange-500' : ''}`}
              onClick={() => setSelectedTier(selectedTier === 3 ? null : 3)}
            >
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-orange-500">{stats.tierCounts.tier3}</div>
                <div className="text-sm text-muted-foreground">Tier 3 - Low</div>
              </CardContent>
            </Card>
            <Card
              className={`cursor-pointer transition-colors ${selectedTier === 1 ? 'ring-2 ring-green-500' : ''}`}
              onClick={() => setSelectedTier(selectedTier === 1 ? null : 1)}
            >
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-green-500">{stats.tierCounts.tier1}</div>
                <div className="text-sm text-muted-foreground">Tier 1 - Auto</div>
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
              <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">No items to review</h3>
              <p className="text-muted-foreground">
                {selectedTier !== null
                  ? `No Tier ${selectedTier} identities pending review.`
                  : 'All identity candidates have been processed.'}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Review Items */}
        {!isLoading && !error && items.length > 0 && (
          <div className="space-y-3">
            {items.map((item) => (
              <Card key={item.id} className="hover:border-primary/50 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    {/* Platform Icon */}
                    <div className="flex-shrink-0 h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                      {getPlatformIcon(item.platform)}
                    </div>

                    {/* Main Content */}
                    <div className="flex-1 min-w-0">
                      {/* Top Row: Platform + Handle + Tier */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-foreground">{item.platformId}</span>
                        <span className="text-sm text-muted-foreground">on {getPlatformLabel(item.platform)}</span>
                        {getTierBadge(item.bridgeTier)}
                        <span className={`text-sm font-mono ${getConfidenceColor(item.confidence)}`}>
                          {(item.confidence * 100).toFixed(0)}%
                        </span>
                        {item.confidenceBucket && (
                          <Badge variant={getConfidenceBadgeVariant(item.confidenceBucket)} className="text-xs">
                            {item.confidenceBucket.replace('_', ' ')}
                          </Badge>
                        )}
                      </div>

                      {/* Persist Reason (Why matched) */}
                      {item.persistReason && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-1">
                          {item.persistReason}
                        </p>
                      )}

                      {/* Candidate Info */}
                      {item.candidate && (
                        <div className="flex items-center gap-2 mt-2 text-sm">
                          <span className="text-muted-foreground">Candidate:</span>
                          <Link
                            href={`/enrich/${item.candidateId}`}
                            className="text-blue-500 hover:underline flex items-center gap-1"
                          >
                            {item.candidate.nameHint || item.candidate.linkedinId}
                            <ChevronRight className="h-3 w-3" />
                          </Link>
                        </div>
                      )}

                      {/* Contradiction Warning */}
                      {item.hasContradiction && item.contradictionNote && (
                        <div className="flex items-center gap-1 mt-2 text-sm text-orange-500">
                          <AlertCircle className="h-3 w-3" />
                          {item.contradictionNote}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <a
                        href={item.profileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleReject(item.id)}
                        disabled={isActionLoading(item.id)}
                      >
                        {isActionLoading(item.id) ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <XCircle className="h-3 w-3" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleConfirm(item.id)}
                        disabled={isActionLoading(item.id)}
                      >
                        {isActionLoading(item.id) ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
