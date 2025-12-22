'use client';

import { useCallback } from 'react';
import type { ProfileSummaryV2 } from '@/types/linkedin';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, Sparkles } from 'lucide-react';

interface ProfileSummaryCardProps {
  summary: ProfileSummaryV2;
}

export default function ProfileSummaryCard({ summary }: ProfileSummaryCardProps) {
  const hasValidCandidateId = summary.candidateId !== null;

  // Open enrichment page in new tab with autostart
  const openEnrichmentPage = useCallback(() => {
    if (!hasValidCandidateId) return;
    window.open(`/enrich/${summary.candidateId}?autostart=1`, '_blank');
  }, [hasValidCandidateId, summary.candidateId]);

  const displayTitle = summary.name || summary.title;

  return (
    <Card className="transition-shadow hover:shadow-lg">
      <CardHeader>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold leading-tight line-clamp-2 text-foreground">
            {displayTitle}
          </h3>
          {summary.headline && (
            <p className="text-sm text-muted-foreground line-clamp-2">{summary.headline}</p>
          )}
          {summary.location && (
            <Badge variant="secondary" className="w-fit">
              {summary.location}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 text-sm text-muted-foreground">
        {summary.snippet && (
          <p className="line-clamp-4 leading-relaxed">{summary.snippet}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={openEnrichmentPage}
            disabled={!hasValidCandidateId}
            className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 disabled:opacity-50"
            title={!hasValidCandidateId ? 'Candidate failed to persist' : undefined}
          >
            <Sparkles className="mr-1 h-4 w-4" />
            Enrich
          </Button>

          <Button size="sm" variant="outline" asChild>
            <a
              href={summary.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              LinkedIn
            </a>
          </Button>
        </div>

        {/* Show error for invalid candidateId */}
        {!hasValidCandidateId && (
          <div className="text-center py-2 text-muted-foreground">
            <p className="text-orange-500 text-xs">Candidate not persisted</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
