'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  X,
  ExternalLink,
  AlertCircle,
  Link2,
  GitCommit,
  BarChart3,
  Shield,
} from 'lucide-react';
import type { IdentityCandidateData, CommitEmailEvidence } from '@/types/linkedin';
import { getPlatformIcon, getPlatformLabel, getConfidenceColor } from './IdentityCandidateCard';

interface EvidenceDrawerProps {
  identity: IdentityCandidateData;
  isOpen: boolean;
  onClose: () => void;
}

/** Score breakdown field labels for display */
const SCORE_FIELD_LABELS: Record<string, string> = {
  handleMatch: 'Handle Match',
  bridgeWeight: 'Bridge Weight',
  nameMatch: 'Name Match',
  companyMatch: 'Company Match',
  locationMatch: 'Location Match',
  profileCompleteness: 'Profile Completeness',
  activityScore: 'Activity Score',
  total: 'Total Score',
};

/** Bridge signal descriptions */
const BRIDGE_SIGNAL_LABELS: Record<string, string> = {
  linkedin_url_in_bio: 'LinkedIn URL found in profile bio',
  linkedin_url_in_blog: 'LinkedIn URL found in website/blog field',
  linkedin_url_in_page: 'LinkedIn URL found on external page',
  linkedin_url_in_team_page: 'LinkedIn URL found on team page (multiple profiles)',
  commit_email_domain: 'Commit email matches company domain',
  cross_platform_handle: 'Same username across platforms',
  mutual_reference: 'Both profiles link to each other',
  verified_domain: 'Verified company domain',
  email_in_public_page: 'Email found in public page',
  conference_speaker: 'Listed as conference speaker with LinkedIn',
  none: 'No bridge signals',
};

function getTierLabel(tier: number | null | undefined): string {
  switch (tier) {
    case 1:
      return 'Tier 1 - Auto-merge eligible';
    case 2:
      return 'Tier 2 - Human review required';
    case 3:
      return 'Tier 3 - Low confidence';
    default:
      return 'Unknown tier';
  }
}

function getTierColor(tier: number | null | undefined): string {
  switch (tier) {
    case 1:
      return 'text-green-500';
    case 2:
      return 'text-yellow-500';
    case 3:
      return 'text-orange-500';
    default:
      return 'text-muted-foreground';
  }
}

export function EvidenceDrawer({ identity, isOpen, onClose }: EvidenceDrawerProps) {
  if (!isOpen) return null;

  const hasEvidence = identity.evidence && identity.evidence.length > 0;
  const hasScoreBreakdown = identity.scoreBreakdown && Object.keys(identity.scoreBreakdown).length > 0;
  const hasBridgeSignals = identity.bridgeSignals && identity.bridgeSignals.length > 0;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-50 transition-opacity"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-background border-l border-border z-50 overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 bg-background border-b border-border p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
              {getPlatformIcon(identity.platform)}
            </div>
            <div>
              <div className="font-medium text-foreground">{identity.platformId}</div>
              <div className="text-sm text-muted-foreground">{getPlatformLabel(identity.platform)}</div>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 space-y-6">
          {/* Confidence & Tier */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Confidence
            </h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-foreground">Score</span>
                <span className={`font-mono font-bold ${getConfidenceColor(identity.confidence)}`}>
                  {(identity.confidence * 100).toFixed(1)}%
                </span>
              </div>
              {identity.confidenceBucket && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-foreground">Bucket</span>
                  <Badge variant="outline">{identity.confidenceBucket.replace('_', ' ')}</Badge>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-sm text-foreground">Tier</span>
                <span className={`text-sm font-medium ${getTierColor(identity.bridgeTier)}`}>
                  {getTierLabel(identity.bridgeTier)}
                </span>
              </div>
            </div>
          </div>

          <Separator />

          {/* Persist Reason */}
          {identity.persistReason && (
            <>
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-3">Why This Matched</h3>
                <p className="text-sm text-foreground bg-muted/50 p-3 rounded-lg">
                  {identity.persistReason}
                </p>
              </div>
              <Separator />
            </>
          )}

          {/* Bridge Signals */}
          {hasBridgeSignals && (
            <>
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                  <Link2 className="h-4 w-4" />
                  Bridge Signals
                </h3>
                <div className="space-y-2">
                  {identity.bridgeSignals!.map((signal) => (
                    <div
                      key={signal}
                      className="flex items-start gap-2 text-sm bg-muted/30 p-2 rounded"
                    >
                      <Badge variant="outline" className="text-xs shrink-0">
                        {signal.replace(/_/g, ' ')}
                      </Badge>
                      <span className="text-muted-foreground text-xs">
                        {BRIDGE_SIGNAL_LABELS[signal] || signal}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <Separator />
            </>
          )}

          {/* Evidence */}
          {hasEvidence && (
            <>
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                  <GitCommit className="h-4 w-4" />
                  Evidence
                </h3>
                <div className="space-y-2">
                  {(identity.evidence as CommitEmailEvidence[]).map((ev, idx) => (
                    <div key={idx} className="bg-muted/30 p-3 rounded-lg space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {ev.type === 'commit_email' ? 'Commit' : ev.type}
                        </Badge>
                        <span className="text-sm text-foreground">{ev.authorName}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">{ev.repoFullName}</div>
                      <a
                        href={ev.commitUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-500 hover:underline flex items-center gap-1"
                      >
                        View commit
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  ))}
                </div>
              </div>
              <Separator />
            </>
          )}

          {/* Score Breakdown */}
          {hasScoreBreakdown && (
            <>
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                  <BarChart3 className="h-4 w-4" />
                  Score Breakdown
                </h3>
                <div className="space-y-2">
                  {Object.entries(identity.scoreBreakdown!)
                    .filter(([, value]) => typeof value === 'number' && !isNaN(value))
                    .sort(([, a], [, b]) => (b as number) - (a as number))
                    .map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between">
                        <span className="text-sm text-foreground">
                          {SCORE_FIELD_LABELS[key] || key}
                        </span>
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                key === 'total'
                                  ? 'bg-primary'
                                  : (value as number) > 0.2
                                  ? 'bg-green-500'
                                  : (value as number) > 0.1
                                  ? 'bg-yellow-500'
                                  : 'bg-muted-foreground'
                              }`}
                              style={{ width: `${Math.min((value as number) * 100, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono text-muted-foreground w-12 text-right">
                            {((value as number) * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
              <Separator />
            </>
          )}

          {/* Contradiction */}
          {identity.hasContradiction && identity.contradictionNote && (
            <div>
              <h3 className="text-sm font-medium text-orange-500 mb-3 flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                Contradiction Detected
              </h3>
              <p className="text-sm text-orange-400 bg-orange-500/10 p-3 rounded-lg border border-orange-500/20">
                {identity.contradictionNote}
              </p>
            </div>
          )}

          {/* Profile Link */}
          <div>
            <a
              href={identity.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full p-3 bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors"
            >
              <ExternalLink className="h-4 w-4" />
              View Profile on {getPlatformLabel(identity.platform)}
            </a>
          </div>
        </div>
      </div>
    </>
  );
}

// Hook for managing drawer state
export function useEvidenceDrawer() {
  const [selectedIdentity, setSelectedIdentity] = useState<IdentityCandidateData | null>(null);

  const openDrawer = (identity: IdentityCandidateData) => {
    setSelectedIdentity(identity);
  };

  const closeDrawer = () => {
    setSelectedIdentity(null);
  };

  return {
    selectedIdentity,
    isOpen: selectedIdentity !== null,
    openDrawer,
    closeDrawer,
  };
}
