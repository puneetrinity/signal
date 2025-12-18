'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  CachedProfile,
  ProfileSummary,
  ProfileSummaryV2,
} from '@/types/linkedin';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Brain,
  Loader2,
  Sparkles,
} from 'lucide-react';
import ProfileDetails from '@/components/ProfileDetails';

interface ProfileSummaryCardProps {
  summary: ProfileSummary | ProfileSummaryV2;
}

// Type guard for v2 summary - checks if candidateId field exists (v2 response shape)
function isV2Summary(summary: ProfileSummary | ProfileSummaryV2): summary is ProfileSummaryV2 {
  return 'candidateId' in summary;
}

// Check if v2 summary has a valid candidateId (not null)
function hasValidCandidateId(summary: ProfileSummaryV2): boolean {
  return summary.candidateId !== null;
}

export default function ProfileSummaryCard({ summary }: ProfileSummaryCardProps) {
  const router = useRouter();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isResearching, setIsResearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [researchError, setResearchError] = useState<string | null>(null);

  // v1 state
  const [fullProfile, setFullProfile] = useState<CachedProfile | null>(null);

  const isV2Mode = isV2Summary(summary);
  const v2HasValidId = isV2Mode && hasValidCandidateId(summary as ProfileSummaryV2);

  // v2: Open enrichment page in new tab
  const openEnrichmentPage = useCallback(() => {
    if (!isV2Mode || !v2HasValidId) return;

    const candidateId = (summary as ProfileSummaryV2).candidateId;
    window.open(`/enrich/${candidateId}`, '_blank');
  }, [isV2Mode, v2HasValidId, summary]);

  // Handle expand - v1 only (v2 uses dedicated enrich page)
  const handleExpand = useCallback(async () => {
    // v2 cards don't have expandable details - use Enrich button instead
    if (isV2Mode) return;

    if (!isExpanded) {
      setIsLoading(true);
      setError(null);

      try {
        // v1: Fetch scraped profile
        if (!fullProfile) {
          const response = await fetch(
            `/api/profile/${encodeURIComponent(summary.linkedinId)}`
          );
          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || 'Failed to load profile');
          }

          setFullProfile(data.profile as CachedProfile);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load details');
      } finally {
        setIsLoading(false);
      }
    }

    setIsExpanded((prev) => !prev);
  }, [isExpanded, isV2Mode, fullProfile, summary.linkedinId]);

  // Handle research (v1 only)
  const handleResearch = useCallback(async () => {
    setIsResearching(true);
    setResearchError(null);

    try {
      const response = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          linkedinUrl: summary.linkedinUrl,
          personName: summary.name || summary.title,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to initiate research');
      }

      router.push(`/research/${data.researchId}`);
    } catch (err) {
      setResearchError(err instanceof Error ? err.message : 'Failed to start research');
      setIsResearching(false);
    }
  }, [summary.linkedinUrl, summary.name, summary.title, router]);

  const displayTitle = summary.name || summary.title;

  return (
    <Card className="transition-shadow hover:shadow-lg">
      <CardHeader>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold leading-tight line-clamp-2 text-foreground flex-1">
              {displayTitle}
            </h3>
            {isV2Mode && (
              <Badge variant="outline" className="text-xs shrink-0">
                v2
              </Badge>
            )}
          </div>
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
          {/* v2: Enrich button opens dedicated page */}
          {isV2Mode ? (
            <Button
              size="sm"
              onClick={openEnrichmentPage}
              disabled={!v2HasValidId}
              className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 disabled:opacity-50"
              title={!v2HasValidId ? 'Candidate failed to persist' : undefined}
            >
              <Sparkles className="mr-1 h-4 w-4" />
              Enrich
            </Button>
          ) : (
            /* v1: Research button */
            <Button
              size="sm"
              onClick={handleResearch}
              disabled={isResearching}
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
            >
              {isResearching ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Brain className="mr-1 h-4 w-4" />
                  Research Person
                </>
              )}
            </Button>
          )}

          {/* v1 only: Expand to view scraped details */}
          {!isV2Mode && (
            <Button size="sm" variant="outline" onClick={handleExpand} disabled={isLoading}>
              {isLoading ? (
                'Loading...'
              ) : isExpanded ? (
                <>
                  <ChevronUp className="mr-1 h-4 w-4" />
                  Hide details
                </>
              ) : (
                <>
                  <ChevronDown className="mr-1 h-4 w-4" />
                  View details
                </>
              )}
            </Button>
          )}

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

        {researchError && <p className="text-sm text-destructive mt-2">{researchError}</p>}

        {/* v2: Show error for invalid candidateId */}
        {isV2Mode && !v2HasValidId && (
          <div className="text-center py-2 text-muted-foreground">
            <p className="text-orange-500 text-xs">Candidate not persisted</p>
          </div>
        )}

        {/* v1 only: Expandable profile details */}
        {!isV2Mode && isExpanded && (
          <div className="border-t pt-4">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {!error && isLoading && (
              <p className="text-sm text-muted-foreground">Loading details...</p>
            )}
            {!error && !isLoading && fullProfile && (
              <ProfileDetails profile={fullProfile} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
