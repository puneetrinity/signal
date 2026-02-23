/**
 * Job Track Classifier — Deterministic Scorer + Groq Fallback Orchestration
 *
 * Classifies a job as tech | non_tech | blended based on keyword scoring.
 * Falls back to Groq LLM for low-confidence cases (when enabled).
 *
 * Invariant: resolveTrack() never throws — any error returns a safe deterministic fallback.
 */

import { detectRoleFamilyFromTitle } from '@/lib/taxonomy/role-family';
import { createLogger } from '@/lib/logger';
import { getSourcingConfig, type SourcingConfig } from './config';
import type { SourcingJobContextInput } from './jd-digest';
import type { JobRequirements } from './jd-digest';
import type { JobTrack, TrackDecision } from './types';
import { groqClassifyTrack } from './track-groq';

const log = createLogger('TrackResolver');

// ---------------------------------------------------------------------------
// Keyword taxonomy
// ---------------------------------------------------------------------------

interface WeightedKeyword {
  term: string;
  weight: number;
}

const TECH_KEYWORDS: WeightedKeyword[] = [
  // Programming languages (strong)
  ...['python', 'javascript', 'typescript', 'java', 'go', 'golang', 'rust', 'c\\+\\+', 'c#',
    'ruby', 'scala', 'kotlin', 'swift', 'php', 'perl', 'haskell', 'elixir', 'clojure',
    'r language', 'matlab', 'julia', 'solidity', 'sql', 'graphql',
  ].map((t) => ({ term: t, weight: 1.0 })),
  // Frameworks / tools (strong)
  ...['react', 'angular', 'vue', 'svelte', 'next\\.js', 'nextjs', 'nuxt', 'django', 'flask',
    'fastapi', 'spring boot', 'express', 'nest\\.js', 'nestjs', 'rails', 'laravel',
    'kubernetes', 'k8s', 'terraform', 'docker', 'ansible', 'jenkins', 'circleci',
    'github actions', 'aws', 'azure', 'gcp', 'google cloud',
    'pytorch', 'tensorflow', 'keras', 'scikit-learn', 'spark', 'kafka', 'airflow',
    'redis', 'elasticsearch', 'mongodb', 'postgresql', 'mysql', 'dynamodb', 'cassandra',
    'grafana', 'prometheus', 'datadog', 'splunk',
  ].map((t) => ({ term: t, weight: 1.0 })),
  // Engineering roles (strong)
  ...['software engineer', 'backend engineer', 'frontend engineer', 'fullstack engineer',
    'full stack engineer', 'full-stack engineer', 'devops engineer', 'sre',
    'site reliability', 'platform engineer', 'infrastructure engineer',
    'ml engineer', 'machine learning engineer', 'data engineer', 'data scientist',
    'security engineer', 'cloud engineer', 'mobile engineer', 'ios engineer',
    'android engineer', 'embedded engineer', 'firmware engineer', 'systems engineer',
    'software developer', 'web developer', 'application developer',
    'qa engineer', 'test automation', 'sdet',
  ].map((t) => ({ term: t, weight: 1.0 })),
  // Moderate tech signals
  ...['agile', 'scrum', 'git', 'linux', 'algorithm', 'sdk', 'api', 'microservices',
    'ci\\/cd', 'ci cd', 'cicd', 'rest api', 'restful', 'grpc', 'oauth', 'saas',
    'cloud native', 'serverless', 'distributed systems', 'machine learning',
    'deep learning', 'nlp', 'computer vision', 'llm', 'genai', 'generative ai',
  ].map((t) => ({ term: t, weight: 0.5 })),
];

const NON_TECH_KEYWORDS: WeightedKeyword[] = [
  // Sales (strong)
  ...['account executive', 'sdr', 'sales development', 'business development representative',
    'bdr', 'quota', 'pipeline management', 'crm', 'salesforce', 'hubspot',
    'sales manager', 'sales director', 'vp sales', 'revenue operations',
    'inside sales', 'outside sales', 'enterprise sales', 'solution selling',
  ].map((t) => ({ term: t, weight: 1.0 })),
  // Marketing (strong)
  ...['content marketing', 'seo', 'sem', 'demand generation', 'brand manager',
    'marketing manager', 'growth marketing', 'performance marketing',
    'social media manager', 'copywriter', 'content strategist',
    'marketing director', 'cmo', 'digital marketing', 'email marketing',
    'product marketing', 'pmm',
  ].map((t) => ({ term: t, weight: 1.0 })),
  // HR (strong)
  ...['recruiter', 'talent acquisition', 'hrbp', 'hr business partner', 'onboarding',
    'people operations', 'hr manager', 'hr director', 'compensation and benefits',
    'total rewards', 'employee relations', 'chro',
  ].map((t) => ({ term: t, weight: 1.0 })),
  // Finance (strong)
  ...['financial analyst', 'cpa', 'fp&a', 'controller', 'accountant', 'bookkeeper',
    'cfo', 'treasury', 'audit', 'tax analyst', 'investment analyst',
    'financial planning', 'accounts payable', 'accounts receivable',
  ].map((t) => ({ term: t, weight: 1.0 })),
  // Ops (strong)
  ...['operations manager', 'procurement', 'supply chain', 'logistics',
    'warehouse manager', 'inventory management', 'coo', 'office manager',
    'facilities manager', 'fleet manager',
  ].map((t) => ({ term: t, weight: 1.0 })),
  // Legal (strong)
  ...['paralegal', 'corporate attorney', 'legal counsel', 'general counsel',
    'compliance officer', 'regulatory affairs', 'contract manager',
  ].map((t) => ({ term: t, weight: 1.0 })),
  // Customer success (strong)
  ...['customer success', 'account manager', 'client success', 'customer support manager',
    'customer experience', 'client relations',
  ].map((t) => ({ term: t, weight: 1.0 })),
  // Moderate non-tech signals
  ...['stakeholder management', 'budget', 'vendor management', 'excel',
    'powerpoint', 'presentation skills', 'negotiation', 'territory management',
    'p&l', 'profit and loss', 'kpi reporting', 'project management',
  ].map((t) => ({ term: t, weight: 0.5 })),
];

// Pre-compile regexes for performance
const TECH_PATTERNS = TECH_KEYWORDS.map((kw) => ({
  ...kw,
  regex: new RegExp(`\\b${kw.term}\\b`, 'i'),
}));

const NON_TECH_PATTERNS = NON_TECH_KEYWORDS.map((kw) => ({
  ...kw,
  regex: new RegExp(`\\b${kw.term}\\b`, 'i'),
}));

// ---------------------------------------------------------------------------
// Deterministic scoring (synchronous, <1ms)
// ---------------------------------------------------------------------------

export interface DeterministicResult {
  track: JobTrack;
  confidence: number;
  techScore: number;
  nonTechScore: number;
  matchedTechKeywords: string[];
  matchedNonTechKeywords: string[];
  roleFamilySignal: string | null;
}

export function scoreDeterministic(
  jobContext: SourcingJobContextInput,
  requirements: JobRequirements,
  config: SourcingConfig,
): DeterministicResult {
  // Build text bag from all available signals
  const parts: string[] = [];
  if (jobContext.title) parts.push(jobContext.title);
  if (jobContext.jdDigest) parts.push(jobContext.jdDigest);
  if (jobContext.skills) parts.push(jobContext.skills.join(' '));
  if (jobContext.goodToHaveSkills) parts.push(jobContext.goodToHaveSkills.join(' '));
  const textBag = parts.join(' ');

  // Match keywords
  let techRaw = 0;
  let nonTechRaw = 0;
  const matchedTech: string[] = [];
  const matchedNonTech: string[] = [];
  let strongTechCount = 0;
  let strongNonTechCount = 0;

  for (const kw of TECH_PATTERNS) {
    if (kw.regex.test(textBag)) {
      techRaw += kw.weight;
      matchedTech.push(kw.term);
      if (kw.weight >= 1.0) strongTechCount++;
    }
  }

  for (const kw of NON_TECH_PATTERNS) {
    if (kw.regex.test(textBag)) {
      nonTechRaw += kw.weight;
      matchedNonTech.push(kw.term);
      if (kw.weight >= 1.0) strongNonTechCount++;
    }
  }

  // Role family boost: all 8 families in role-family.ts are tech
  const roleFamilySignal = requirements.roleFamily
    ?? (jobContext.title ? detectRoleFamilyFromTitle(jobContext.title) : null);

  if (roleFamilySignal) {
    techRaw += 2.0;
  }

  // Zero signals → default to tech with low confidence
  if (techRaw === 0 && nonTechRaw === 0) {
    return {
      track: 'tech',
      confidence: 0.30,
      techScore: 0,
      nonTechScore: 0,
      matchedTechKeywords: [],
      matchedNonTechKeywords: [],
      roleFamilySignal,
    };
  }

  // Normalize scores
  const total = techRaw + nonTechRaw;
  const techScore = techRaw / total;
  const nonTechScore = nonTechRaw / total;
  const margin = Math.abs(techScore - nonTechScore);

  let track: JobTrack;
  let confidence: number;

  // Override: 5+ strong matches on one side with 0 on the other
  if (strongTechCount >= 5 && strongNonTechCount === 0) {
    track = 'tech';
    confidence = Math.max(0.95, Math.min(0.99, 0.6 + margin * 0.8));
  } else if (strongNonTechCount >= 5 && strongTechCount === 0) {
    track = 'non_tech';
    confidence = Math.max(0.95, Math.min(0.99, 0.6 + margin * 0.8));
  } else if (margin < config.trackBlendThreshold) {
    track = 'blended';
    confidence = 0.5 + margin;
  } else {
    track = techScore > nonTechScore ? 'tech' : 'non_tech';
    confidence = Math.min(0.99, 0.6 + margin * 0.8);
  }

  return {
    track,
    confidence,
    techScore: Number(techScore.toFixed(4)),
    nonTechScore: Number(nonTechScore.toFixed(4)),
    matchedTechKeywords: matchedTech,
    matchedNonTechKeywords: matchedNonTech,
    roleFamilySignal,
  };
}

// ---------------------------------------------------------------------------
// Main export: resolveTrack (never throws)
// ---------------------------------------------------------------------------

export async function resolveTrack(
  jobContext: SourcingJobContextInput,
  requirements: JobRequirements,
  hint?: { jobTrackHint?: string; jobTrackHintSource?: string; jobTrackHintReason?: string },
): Promise<TrackDecision> {
  const config = getSourcingConfig();

  try {
    // 1. Explicit hint → return immediately
    if (hint?.jobTrackHint === 'tech' || hint?.jobTrackHint === 'non_tech') {
      const hintTrack = hint.jobTrackHint as 'tech' | 'non_tech';
      const det = scoreDeterministic(jobContext, requirements, config);
      return {
        track: hintTrack,
        confidence: 1.0,
        method: 'deterministic',
        classifierVersion: config.trackClassifierVersion,
        deterministicSignals: {
          techScore: det.techScore,
          nonTechScore: det.nonTechScore,
          matchedTechKeywords: det.matchedTechKeywords,
          matchedNonTechKeywords: det.matchedNonTechKeywords,
          roleFamilySignal: det.roleFamilySignal,
        },
        hintUsed: {
          hint: hintTrack,
          source: hint.jobTrackHintSource ?? 'unknown',
          reason: hint.jobTrackHintReason,
        },
        resolvedAt: new Date().toISOString(),
      };
    }

    // 2. Deterministic scoring
    const det = scoreDeterministic(jobContext, requirements, config);

    const baseDeterministicSignals = {
      techScore: det.techScore,
      nonTechScore: det.nonTechScore,
      matchedTechKeywords: det.matchedTechKeywords,
      matchedNonTechKeywords: det.matchedNonTechKeywords,
      roleFamilySignal: det.roleFamilySignal,
    };

    // 3. High confidence → return deterministic
    if (det.confidence >= config.trackLowConfThreshold) {
      return {
        track: det.track,
        confidence: det.confidence,
        method: 'deterministic',
        classifierVersion: config.trackClassifierVersion,
        deterministicSignals: baseDeterministicSignals,
        resolvedAt: new Date().toISOString(),
      };
    }

    // 4. Low confidence → try Groq if enabled
    if (config.trackGroqEnabled) {
      try {
        const groqResult = await groqClassifyTrack(jobContext, config);

        // Merge rules (section 5 of spec)
        const detLeaning = det.track === 'blended' ? null : det.track;
        let mergedTrack: JobTrack;
        let mergedConfidence: number;

        if (detLeaning && groqResult.track === detLeaning && groqResult.confidence >= 0.60) {
          // Groq agrees with deterministic leaning, high Groq confidence → single track
          mergedTrack = groqResult.track;
          mergedConfidence = Math.max(det.confidence, groqResult.confidence);
        } else if (det.track === 'blended' && groqResult.confidence >= 0.80) {
          // Deterministic was blended, Groq confident → adopt Groq track
          mergedTrack = groqResult.track;
          mergedConfidence = groqResult.confidence;
        } else if (detLeaning && groqResult.track !== detLeaning) {
          // Groq disagrees → keep blended (never flip without strong support)
          mergedTrack = 'blended';
          mergedConfidence = det.confidence;
        } else {
          // Groq confidence low → keep deterministic
          mergedTrack = det.track;
          mergedConfidence = det.confidence;
        }

        return {
          track: mergedTrack,
          confidence: mergedConfidence,
          method: 'deterministic+groq',
          classifierVersion: config.trackClassifierVersion,
          deterministicSignals: baseDeterministicSignals,
          groqResult,
          resolvedAt: new Date().toISOString(),
        };
      } catch (groqErr) {
        log.warn({ error: groqErr }, 'Groq fallback failed, using deterministic result');
      }
    }

    // 5. Fallback: return deterministic result
    return {
      track: det.track,
      confidence: det.confidence,
      method: 'deterministic',
      classifierVersion: config.trackClassifierVersion,
      deterministicSignals: baseDeterministicSignals,
      resolvedAt: new Date().toISOString(),
    };
  } catch (err) {
    // Invariant: never throw — return safe default
    log.error({ error: err }, 'resolveTrack unexpected error, returning safe fallback');
    return {
      track: 'tech',
      confidence: 0.30,
      method: 'deterministic',
      classifierVersion: config.trackClassifierVersion,
      deterministicSignals: {
        techScore: 0,
        nonTechScore: 0,
        matchedTechKeywords: [],
        matchedNonTechKeywords: [],
        roleFamilySignal: null,
      },
      resolvedAt: new Date().toISOString(),
    };
  }
}
