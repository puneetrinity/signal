'use client';

import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import type {
  CandidateData,
  IdentityCandidateData,
  EnrichmentSessionSummary,
  AISummaryStructured,
} from '@/types/linkedin';
import {
  Clock,
  Search,
  Code,
  Sparkles,
  MessageSquare,
  Lightbulb,
  AlertTriangle,
} from 'lucide-react';
import {
  IdentityCandidateCard,
  getPlatformIcon,
  getPlatformLabel,
  getConfidenceColor,
} from '@/components/IdentityCandidateCard';

interface CandidateDetailsProps {
  candidate: CandidateData;
  identityCandidates: IdentityCandidateData[];
  sessions: EnrichmentSessionSummary[];
  onRevealEmail?: (identityCandidateId: string) => Promise<string | null>;
  onConfirm?: (identityCandidateId: string) => Promise<boolean>;
  onReject?: (identityCandidateId: string) => Promise<boolean>;
}

export default function CandidateDetails({
  candidate,
  identityCandidates,
  sessions,
  onRevealEmail,
  onConfirm,
  onReject,
}: CandidateDetailsProps) {
  const confirmedIdentities = identityCandidates.filter((ic) => ic.status === 'confirmed');
  const unconfirmedIdentities = identityCandidates.filter((ic) => ic.status === 'unconfirmed');
  const rejectedIdentities = identityCandidates.filter((ic) => ic.status === 'rejected');
  const latestSession = sessions[0];

  return (
    <div className="space-y-6 text-sm text-muted-foreground">
      {/* Candidate Info */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-foreground">
          <Search className="h-4 w-4" />
          <h4 className="text-sm font-semibold">Candidate Info</h4>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="font-medium">LinkedIn ID:</span> {candidate.linkedinId}
          </div>
          {candidate.nameHint && (
            <div>
              <span className="font-medium">Name (hint):</span> {candidate.nameHint}
            </div>
          )}
          <div>
            <span className="font-medium">Status:</span>{' '}
            <Badge variant="outline" className="text-xs">
              {candidate.enrichmentStatus}
            </Badge>
          </div>
          {candidate.confidenceScore !== null && (
            <div>
              <span className="font-medium">Best confidence:</span>{' '}
              <span className={getConfidenceColor(candidate.confidenceScore)}>
                {(candidate.confidenceScore * 100).toFixed(0)}%
              </span>
            </div>
          )}
        </div>
      </div>

      <Separator />

      {/* AI Summary */}
      {latestSession?.summary && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-foreground">
            <Sparkles className="h-4 w-4 text-purple-500" />
            <h4 className="text-sm font-semibold">AI Summary</h4>
            {latestSession.summaryModel && (
              <span className="text-xs text-muted-foreground">({latestSession.summaryModel})</span>
            )}
          </div>

          <p className="text-sm leading-relaxed">{latestSession.summary}</p>

          {latestSession.summaryStructured && (
            <div className="space-y-3">
              {/* Skills */}
              {(latestSession.summaryStructured as AISummaryStructured).skills &&
               (latestSession.summaryStructured as AISummaryStructured).skills!.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <Code className="h-3 w-3" />
                    Skills
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(latestSession.summaryStructured as AISummaryStructured).skills!.map((skill, idx) => (
                      <Badge key={idx} variant="secondary" className="text-xs">
                        {skill}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Highlights */}
              {(latestSession.summaryStructured as AISummaryStructured).highlights &&
               (latestSession.summaryStructured as AISummaryStructured).highlights!.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <Lightbulb className="h-3 w-3" />
                    Highlights
                  </div>
                  <ul className="text-xs space-y-1 pl-4 list-disc">
                    {(latestSession.summaryStructured as AISummaryStructured).highlights!.map((h, idx) => (
                      <li key={idx}>{h}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Talking Points */}
              {(latestSession.summaryStructured as AISummaryStructured).talkingPoints &&
               (latestSession.summaryStructured as AISummaryStructured).talkingPoints!.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <MessageSquare className="h-3 w-3" />
                    Talking Points
                  </div>
                  <ul className="text-xs space-y-1 pl-4 list-disc">
                    {(latestSession.summaryStructured as AISummaryStructured).talkingPoints!.map((tp, idx) => (
                      <li key={idx}>{tp}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Caveats */}
              {(latestSession.summaryStructured as AISummaryStructured).caveats &&
               (latestSession.summaryStructured as AISummaryStructured).caveats!.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-xs font-medium text-orange-500">
                    <AlertTriangle className="h-3 w-3" />
                    Caveats
                  </div>
                  <ul className="text-xs space-y-1 pl-4 list-disc text-orange-600">
                    {(latestSession.summaryStructured as AISummaryStructured).caveats!.map((c, idx) => (
                      <li key={idx}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {latestSession?.summary && <Separator />}

      {/* Latest Session */}
      {latestSession && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-foreground">
            <Clock className="h-4 w-4" />
            <h4 className="text-sm font-semibold">Latest Enrichment</h4>
          </div>
          <div className="text-xs space-y-1">
            <div className="flex items-center gap-2">
              <Badge variant={latestSession.status === 'completed' ? 'default' : 'destructive'}>
                {latestSession.status}
              </Badge>
              {latestSession.durationMs && (
                <span className="text-muted-foreground">
                  {(latestSession.durationMs / 1000).toFixed(1)}s
                </span>
              )}
            </div>
            {latestSession.sourcesExecuted && (
              <div>
                <span className="font-medium">Sources:</span>{' '}
                {latestSession.sourcesExecuted.join(', ')}
              </div>
            )}
            <div>
              <span className="font-medium">Identities found:</span>{' '}
              {latestSession.identitiesFound}
            </div>
          </div>
        </div>
      )}

      {/* Identity Candidates */}
      {identityCandidates.length > 0 && (
        <>
          <Separator />
          <div className="space-y-3">
            <div className="flex items-center justify-between text-foreground">
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4" />
                <h4 className="text-sm font-semibold">
                  Identity Candidates ({identityCandidates.length})
                </h4>
              </div>
              {/* Platform summary */}
              <div className="flex items-center gap-1">
                {Array.from(new Set(identityCandidates.map((ic) => ic.platform))).map((platform) => (
                  <span key={platform} title={getPlatformLabel(platform)}>
                    {getPlatformIcon(platform)}
                  </span>
                ))}
              </div>
            </div>

            {/* Confirmed */}
            {confirmedIdentities.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-green-500">
                  Confirmed ({confirmedIdentities.length})
                </div>
                {confirmedIdentities.map((ic) => (
                  <IdentityCandidateCard key={ic.id} identity={ic} />
                ))}
              </div>
            )}

            {/* Unconfirmed */}
            {unconfirmedIdentities.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-yellow-500">
                  Pending Review ({unconfirmedIdentities.length})
                </div>
                {unconfirmedIdentities.map((ic) => (
                  <IdentityCandidateCard
                    key={ic.id}
                    identity={ic}
                    onRevealEmail={onRevealEmail}
                    onConfirm={onConfirm}
                    onReject={onReject}
                  />
                ))}
              </div>
            )}

            {/* Rejected */}
            {rejectedIdentities.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-red-500">
                  Rejected ({rejectedIdentities.length})
                </div>
                {rejectedIdentities.map((ic) => (
                  <IdentityCandidateCard key={ic.id} identity={ic} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* No identities message */}
      {identityCandidates.length === 0 && (
        <>
          <Separator />
          <div className="text-center py-4 text-muted-foreground">
            <p>No identity candidates found yet.</p>
            <p className="text-xs mt-1">Click &quot;Enrich&quot; to discover identities.</p>
          </div>
        </>
      )}
    </div>
  );
}
