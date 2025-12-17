'use client';

import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import type {
  CandidateData,
  IdentityCandidateData,
  EnrichmentSessionSummary,
} from '@/types/linkedin';
import {
  Github,
  ExternalLink,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Search,
  Mail,
  Loader2,
  Code,
  Code2,
  Package,
  Database,
  GraduationCap,
  BookOpen,
  FlaskConical,
  FileText,
  Briefcase,
  Building2,
  PenLine,
  Video,
  Twitter,
  Palette,
  Brush,
} from 'lucide-react';
import { useState } from 'react';

interface CandidateDetailsProps {
  candidate: CandidateData;
  identityCandidates: IdentityCandidateData[];
  sessions: EnrichmentSessionSummary[];
  onRevealEmail?: (identityCandidateId: string) => Promise<string | null>;
  onConfirm?: (identityCandidateId: string) => Promise<boolean>;
  onReject?: (identityCandidateId: string) => Promise<boolean>;
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.9) return 'text-green-500';
  if (confidence >= 0.7) return 'text-yellow-500';
  if (confidence >= 0.4) return 'text-orange-500';
  return 'text-red-500';
}

function getConfidenceBadgeVariant(
  bucket: string | null
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (bucket) {
    case 'auto_merge':
      return 'default';
    case 'suggest':
      return 'secondary';
    case 'low':
      return 'outline';
    case 'rejected':
      return 'destructive';
    default:
      return 'outline';
  }
}

function getPlatformIcon(platform: string) {
  switch (platform) {
    // Code & Engineering
    case 'github':
      return <Github className="h-4 w-4" />;
    case 'stackoverflow':
      return <Code className="h-4 w-4" />;
    case 'npm':
    case 'pypi':
      return <Package className="h-4 w-4" />;
    case 'dockerhub':
      return <Database className="h-4 w-4" />;
    case 'leetcode':
    case 'hackerearth':
    case 'codepen':
    case 'gitlab':
    case 'devto':
    case 'gist':
      return <Code2 className="h-4 w-4" />;
    // Data Science & ML
    case 'kaggle':
    case 'huggingface':
    case 'paperswithcode':
    case 'openreview':
      return <Database className="h-4 w-4" />;
    // Academic & Authority
    case 'orcid':
    case 'scholar':
    case 'semanticscholar':
    case 'researchgate':
    case 'university':
      return <GraduationCap className="h-4 w-4" />;
    case 'arxiv':
      return <BookOpen className="h-4 w-4" />;
    case 'patents':
      return <FlaskConical className="h-4 w-4" />;
    // Business & Founder
    case 'sec':
      return <FileText className="h-4 w-4" />;
    case 'crunchbase':
    case 'angellist':
      return <Briefcase className="h-4 w-4" />;
    case 'companyteam':
      return <Building2 className="h-4 w-4" />;
    // Content & Thought Leadership
    case 'medium':
    case 'substack':
      return <PenLine className="h-4 w-4" />;
    case 'youtube':
      return <Video className="h-4 w-4" />;
    case 'twitter':
      return <Twitter className="h-4 w-4" />;
    // Design
    case 'dribbble':
      return <Palette className="h-4 w-4" />;
    case 'behance':
      return <Brush className="h-4 w-4" />;
    default:
      return <ExternalLink className="h-4 w-4" />;
  }
}

function getPlatformLabel(platform: string): string {
  const labels: Record<string, string> = {
    // Code & Engineering
    github: 'GitHub',
    stackoverflow: 'Stack Overflow',
    npm: 'npm',
    pypi: 'PyPI',
    leetcode: 'LeetCode',
    hackerearth: 'HackerEarth',
    codepen: 'CodePen',
    gitlab: 'GitLab',
    dockerhub: 'Docker Hub',
    gist: 'GitHub Gist',
    devto: 'Dev.to',
    // Data Science & ML
    kaggle: 'Kaggle',
    huggingface: 'Hugging Face',
    paperswithcode: 'Papers With Code',
    openreview: 'OpenReview',
    // Academic
    orcid: 'ORCID',
    scholar: 'Google Scholar',
    semanticscholar: 'Semantic Scholar',
    researchgate: 'ResearchGate',
    university: 'University',
    arxiv: 'arXiv',
    patents: 'Google Patents',
    // Founder
    sec: 'SEC EDGAR',
    crunchbase: 'Crunchbase',
    angellist: 'AngelList',
    companyteam: 'Company Team',
    // Content
    medium: 'Medium',
    substack: 'Substack',
    youtube: 'YouTube',
    twitter: 'Twitter/X',
    // Design
    dribbble: 'Dribbble',
    behance: 'Behance',
  };
  return labels[platform] || platform;
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'confirmed':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'rejected':
      return <XCircle className="h-4 w-4 text-red-500" />;
    default:
      return <AlertCircle className="h-4 w-4 text-yellow-500" />;
  }
}

function IdentityCandidateCard({
  identity,
  onRevealEmail,
  onConfirm,
  onReject,
}: {
  identity: IdentityCandidateData;
  onRevealEmail?: (id: string) => Promise<string | null>;
  onConfirm?: (id: string) => Promise<boolean>;
  onReject?: (id: string) => Promise<boolean>;
}) {
  const [isRevealing, setIsRevealing] = useState(false);
  const [revealedEmail, setRevealedEmail] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);

  const handleReveal = async () => {
    if (!onRevealEmail) return;
    setIsRevealing(true);
    try {
      const email = await onRevealEmail(identity.id);
      setRevealedEmail(email);
    } finally {
      setIsRevealing(false);
    }
  };

  const handleConfirm = async () => {
    if (!onConfirm) return;
    setIsConfirming(true);
    try {
      await onConfirm(identity.id);
    } finally {
      setIsConfirming(false);
    }
  };

  const handleReject = async () => {
    if (!onReject) return;
    setIsRejecting(true);
    try {
      await onReject(identity.id);
    } finally {
      setIsRejecting(false);
    }
  };

  const hasEvidence = identity.evidence && identity.evidence.length > 0;

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {getPlatformIcon(identity.platform)}
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">{getPlatformLabel(identity.platform)}</span>
            <span className="font-medium text-foreground">{identity.platformId}</span>
          </div>
          {getStatusIcon(identity.status)}
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-sm font-mono ${getConfidenceColor(identity.confidence)}`}>
            {(identity.confidence * 100).toFixed(0)}%
          </span>
          {identity.confidenceBucket && (
            <Badge variant={getConfidenceBadgeVariant(identity.confidenceBucket)}>
              {identity.confidenceBucket.replace('_', ' ')}
            </Badge>
          )}
        </div>
      </div>

      <a
        href={identity.profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-blue-500 hover:underline flex items-center gap-1"
      >
        {identity.profileUrl}
        <ExternalLink className="h-3 w-3" />
      </a>

      {identity.hasContradiction && identity.contradictionNote && (
        <div className="text-sm text-orange-500 flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {identity.contradictionNote}
        </div>
      )}

      {identity.scoreBreakdown && Object.keys(identity.scoreBreakdown).length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">Score breakdown: </span>
          {Object.entries(identity.scoreBreakdown)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${k}: ${(v * 100).toFixed(0)}%`)
            .join(', ')}
        </div>
      )}

      {hasEvidence && (
        <div className="text-xs text-muted-foreground space-y-1">
          <span className="font-medium">Evidence:</span>
          {identity.evidence!.slice(0, 2).map((ev, idx) => (
            <div key={idx} className="flex items-center gap-1 pl-2">
              <span>{ev.type === 'commit_email' ? 'Commit' : ev.type}:</span>
              <a
                href={ev.commitUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline truncate max-w-[200px]"
              >
                {ev.repoFullName}
              </a>
            </div>
          ))}
        </div>
      )}

      {revealedEmail && (
        <div className="text-sm flex items-center gap-2 p-2 bg-green-500/10 rounded">
          <Mail className="h-4 w-4 text-green-500" />
          <span className="font-mono">{revealedEmail}</span>
        </div>
      )}

      {identity.status === 'unconfirmed' && (
        <div className="flex flex-wrap gap-2 pt-2">
          {hasEvidence && onRevealEmail && !revealedEmail && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleReveal}
              disabled={isRevealing}
            >
              {isRevealing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Mail className="h-3 w-3 mr-1" />
              )}
              Reveal Email
            </Button>
          )}
          {onConfirm && (
            <Button
              size="sm"
              variant="default"
              onClick={handleConfirm}
              disabled={isConfirming}
            >
              {isConfirming ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3 w-3 mr-1" />
              )}
              Confirm
            </Button>
          )}
          {onReject && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleReject}
              disabled={isRejecting}
            >
              {isRejecting ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <XCircle className="h-3 w-3 mr-1" />
              )}
              Reject
            </Button>
          )}
        </div>
      )}
    </div>
  );
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
