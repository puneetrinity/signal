import type { SeniorityBand } from '@/lib/taxonomy/seniority';

export interface NonTechSignals {
  companyAlignment: {
    sources: Array<{ source: string; company: string; matchType: 'exact' | 'fuzzy' }>;
    corroborationCount: number;
    freshnessDays: number | null;
  };
  seniorityValidation: {
    normalizedBand: SeniorityBand | null;
    confidence: number;
    sources: string[];
  };
  freshness: {
    lastValidatedAt: string | null;
    ageDays: number | null;
    stale: boolean;
  };
  contradictions: {
    count: number;
    details: string[];
  };
}

export interface NonTechGateResults {
  corroboration: boolean;
  contradictions: boolean;
  freshness: boolean;
  seniorityConfidence: boolean;
  scoreFloor: boolean;
}

export interface NonTechScore {
  tier: 1 | 2 | 3;
  overallScore: number;
  topReasons: string[];
  gateResults: NonTechGateResults;
}
