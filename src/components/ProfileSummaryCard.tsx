'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  CachedProfile,
  ProfileSummary,
  ProfileSummaryV2,
  CandidateData,
  IdentityCandidateData,
  EnrichmentSessionSummary,
} from '@/types/linkedin';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuthHeaders } from '@/contexts/ApiKeyContext';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Brain,
  Loader2,
  Sparkles,
} from 'lucide-react';
import ProfileDetails from '@/components/ProfileDetails';
import CandidateDetails from '@/components/CandidateDetails';

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
  const getAuthHeaders = useAuthHeaders();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [isResearching, setIsResearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [researchError, setResearchError] = useState<string | null>(null);

  // v1 state
  const [fullProfile, setFullProfile] = useState<CachedProfile | null>(null);

  // v2 state
  const [candidateData, setCandidateData] = useState<CandidateData | null>(null);
  const [identityCandidates, setIdentityCandidates] = useState<IdentityCandidateData[]>([]);
  const [sessions, setSessions] = useState<EnrichmentSessionSummary[]>([]);

  const isV2Mode = isV2Summary(summary);
  const v2HasValidId = isV2Mode && hasValidCandidateId(summary as ProfileSummaryV2);

  // v2: Fetch candidate details
  const fetchV2Details = useCallback(async () => {
    if (!isV2Mode || !v2HasValidId) return;

    const candidateId = (summary as ProfileSummaryV2).candidateId;
    const response = await fetch(`/api/v2/enrich?candidateId=${candidateId}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to load candidate details');
    }

    setCandidateData(data.candidate);
    setIdentityCandidates(data.identityCandidates || []);
    setSessions(data.sessions || []);

    return data;
  }, [isV2Mode, v2HasValidId, summary]);

  // v2: Run enrichment
  const runEnrichment = useCallback(async () => {
    if (!isV2Mode || !v2HasValidId) return;

    const candidateId = (summary as ProfileSummaryV2).candidateId;
    setIsEnriching(true);
    setError(null);

    try {
      const response = await fetch('/api/v2/enrich', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ candidateId }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Handle auth errors gracefully
        if (response.status === 401) {
          throw new Error('Authentication required. Please configure API keys.');
        }
        throw new Error(data.error || 'Enrichment failed');
      }

      // Refresh details after enrichment
      await fetchV2Details();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enrichment failed');
    } finally {
      setIsEnriching(false);
    }
  }, [isV2Mode, v2HasValidId, summary, fetchV2Details, getAuthHeaders]);

  // v2: Reveal email
  const handleRevealEmail = useCallback(
    async (identityCandidateId: string): Promise<string | null> => {
      try {
        const response = await fetch('/api/v2/identity/reveal', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ identityCandidateId }),
        });

        const data = await response.json();

        if (!response.ok) {
          if (response.status === 401) {
            setError('Authentication required for email reveal.');
            return null;
          }
          throw new Error(data.error || 'Failed to reveal email');
        }

        return data.email || null;
      } catch (err) {
        console.error('Reveal email error:', err);
        return null;
      }
    },
    [getAuthHeaders]
  );

  // v2: Confirm identity
  const handleConfirm = useCallback(
    async (identityCandidateId: string): Promise<boolean> => {
      try {
        const response = await fetch('/api/v2/identity/confirm', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            identityCandidateId,
            method: 'recruiter_manual',
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          if (response.status === 401) {
            setError('Authentication required for identity confirmation.');
            return false;
          }
          throw new Error(data.error || 'Failed to confirm identity');
        }

        // Refresh details after confirmation
        await fetchV2Details();
        return true;
      } catch (err) {
        console.error('Confirm error:', err);
        return false;
      }
    },
    [fetchV2Details, getAuthHeaders]
  );

  // v2: Reject identity
  const handleReject = useCallback(
    async (identityCandidateId: string): Promise<boolean> => {
      try {
        const response = await fetch('/api/v2/identity/confirm', {
          method: 'DELETE',
          headers: getAuthHeaders(),
          body: JSON.stringify({ identityCandidateId }),
        });

        const data = await response.json();

        if (!response.ok) {
          if (response.status === 401) {
            setError('Authentication required for identity rejection.');
            return false;
          }
          throw new Error(data.error || 'Failed to reject identity');
        }

        // Refresh details after rejection
        await fetchV2Details();
        return true;
      } catch (err) {
        console.error('Reject error:', err);
        return false;
      }
    },
    [fetchV2Details, getAuthHeaders]
  );

  // Handle expand - different behavior for v1 vs v2
  const handleExpand = useCallback(async () => {
    if (!isExpanded) {
      setIsLoading(true);
      setError(null);

      try {
        if (isV2Mode) {
          // v2: Fetch candidate details
          await fetchV2Details();
        } else {
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
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load details');
      } finally {
        setIsLoading(false);
      }
    }

    setIsExpanded((prev) => !prev);
  }, [isExpanded, isV2Mode, fetchV2Details, fullProfile, summary.linkedinId]);

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
  const hasIdentities = identityCandidates.length > 0;
  const needsEnrichment = isV2Mode && v2HasValidId && candidateData && !hasIdentities;

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
          {/* v2: Enrich button (instead of Research) */}
          {isV2Mode ? (
            <Button
              size="sm"
              onClick={runEnrichment}
              disabled={isEnriching || !v2HasValidId}
              className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 disabled:opacity-50"
              title={!v2HasValidId ? 'Candidate failed to persist' : undefined}
            >
              {isEnriching ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Enriching...
                </>
              ) : (
                <>
                  <Sparkles className="mr-1 h-4 w-4" />
                  Enrich
                </>
              )}
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

          <Button size="sm" variant="outline" asChild>
            <a
              href={summary.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              Open LinkedIn
            </a>
          </Button>
        </div>

        {researchError && <p className="text-sm text-destructive mt-2">{researchError}</p>}

        {isExpanded && (
          <div className="border-t pt-4">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {!error && isLoading && (
              <p className="text-sm text-muted-foreground">Loading details...</p>
            )}

            {/* v2: Error state for null candidateId */}
            {!error && !isLoading && isV2Mode && !v2HasValidId && (
              <div className="text-center py-4 text-muted-foreground">
                <p className="text-orange-500">Candidate not persisted</p>
                <p className="text-xs mt-1">
                  This result failed to save. Try searching again or use LinkedIn directly.
                </p>
              </div>
            )}

            {/* v2: Candidate details with enrichment */}
            {!error && !isLoading && isV2Mode && v2HasValidId && candidateData && (
              <>
                {needsEnrichment && (
                  <div className="text-center py-4 text-muted-foreground">
                    <p>No enrichment data yet.</p>
                    <p className="text-xs mt-1">
                      Click &quot;Enrich&quot; to discover GitHub profiles and emails.
                    </p>
                  </div>
                )}
                {hasIdentities && (
                  <CandidateDetails
                    candidate={candidateData}
                    identityCandidates={identityCandidates}
                    sessions={sessions}
                    onRevealEmail={handleRevealEmail}
                    onConfirm={handleConfirm}
                    onReject={handleReject}
                  />
                )}
              </>
            )}

            {/* v1: Scraped profile details */}
            {!error && !isLoading && !isV2Mode && fullProfile && (
              <ProfileDetails profile={fullProfile} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
