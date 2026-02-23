export type IdentityDisplayStatus = 'verified' | 'review' | 'weak';

export interface IdentityCandidateSignal {
  platform: string;
  status: string;
  confidence: number;
  bridgeTier: number | null;
  updatedAt: Date;
  discoveredAt: Date;
}

export interface ConfirmedIdentitySignal {
  platform: string;
  confirmedAt: Date;
}

export interface IdentitySummary {
  bestBridgeTier: number | null;
  maxIdentityConfidence: number | null;
  hasConfirmedIdentity: boolean;
  needsReview: boolean;
  platforms: string[];
  displayStatus: IdentityDisplayStatus;
  lastIdentityCheckAt: string | null;
}

const VERIFIED_CONFIDENCE_FLOOR = 0.85;

function pickBestBridgeTier(signals: IdentityCandidateSignal[]): number | null {
  const tiers = signals
    .map((s) => s.bridgeTier)
    .filter((tier): tier is number => tier === 1 || tier === 2 || tier === 3);
  if (tiers.length === 0) return null;
  return Math.min(...tiers);
}

function pickMaxConfidence(signals: IdentityCandidateSignal[]): number | null {
  if (signals.length === 0) return null;
  return Math.max(...signals.map((s) => s.confidence));
}

function pickLastIdentityCheckAt(
  identitySignals: IdentityCandidateSignal[],
  confirmedSignals: ConfirmedIdentitySignal[],
): string | null {
  const timestamps: number[] = [];
  for (const signal of identitySignals) {
    timestamps.push(signal.updatedAt.getTime());
    timestamps.push(signal.discoveredAt.getTime());
  }
  for (const signal of confirmedSignals) {
    timestamps.push(signal.confirmedAt.getTime());
  }
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

export function summarizeIdentitySignals(
  identitySignals: IdentityCandidateSignal[],
  confirmedSignals: ConfirmedIdentitySignal[],
): IdentitySummary {
  const bestBridgeTier = pickBestBridgeTier(identitySignals);
  const maxIdentityConfidence = pickMaxConfidence(identitySignals);
  const hasConfirmedIdentity = confirmedSignals.length > 0;
  const tier1ButBelowVerifiedFloor =
    bestBridgeTier === 1 &&
    maxIdentityConfidence !== null &&
    maxIdentityConfidence < VERIFIED_CONFIDENCE_FLOOR;
  const needsReview = bestBridgeTier === 2 || tier1ButBelowVerifiedFloor;

  let displayStatus: IdentityDisplayStatus = 'weak';
  if (
    hasConfirmedIdentity ||
    (bestBridgeTier === 1 &&
      maxIdentityConfidence !== null &&
      maxIdentityConfidence >= VERIFIED_CONFIDENCE_FLOOR)
  ) {
    displayStatus = 'verified';
  } else if (needsReview) {
    displayStatus = 'review';
  }

  const platforms = Array.from(
    new Set([...identitySignals.map((s) => s.platform), ...confirmedSignals.map((s) => s.platform)]),
  ).sort();

  return {
    bestBridgeTier,
    maxIdentityConfidence,
    hasConfirmedIdentity,
    needsReview,
    platforms,
    displayStatus,
    lastIdentityCheckAt: pickLastIdentityCheckAt(identitySignals, confirmedSignals),
  };
}
