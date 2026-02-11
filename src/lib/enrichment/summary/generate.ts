import { generateObject } from 'ai';
import { z } from 'zod';

import type { EphemeralPlatformDataItem } from '@/lib/enrichment/graph/ephemeral';
import type { DiscoveredIdentity } from '@/lib/enrichment/sources/types';

export const CandidateSummaryStructuredSchema = z.object({
  skills: z.array(z.string().min(1).max(60)).max(30).default([]),
  highlights: z.array(z.string().min(1).max(200)).max(12).default([]),
  talkingPoints: z.array(z.string().min(1).max(200)).max(12).default([]),
});

export const CandidateSummarySchema = z.object({
  summary: z.string().min(1).max(2000),
  structured: CandidateSummaryStructuredSchema,
  confidence: z.number().min(0).max(1).default(0.6),
  caveats: z.array(z.string().min(1).max(200)).max(10).default([]),
});

export type CandidateSummary = z.infer<typeof CandidateSummarySchema>;

export interface CandidateSummaryEvidenceItem {
  platform: string;
  url: string;
  dataType: string;
}

/**
 * Summary generation mode
 * - draft: Generated from unconfirmed identities during initial enrichment
 * - verified: Generated from confirmed identities after user confirmation
 */
export type SummaryMode = 'draft' | 'verified';

export interface GenerateSummaryInput {
  candidate: {
    linkedinId: string;
    linkedinUrl: string;
    nameHint: string | null;
    headlineHint: string | null;
    locationHint: string | null;
    companyHint: string | null;
    roleType: string | null;
  };
  identities: DiscoveredIdentity[];
  platformData: EphemeralPlatformDataItem[];
  /** Optional supplemental data (e.g., PDL enrichment) */
  supplementalData?: Record<string, unknown> | null;
  /** Summary mode - affects prompt and caveats */
  mode?: SummaryMode;
  /** Number of confirmed identities used (for verified mode) */
  confirmedCount?: number;
}

async function createGroqModel(apiKey: string) {
  const moduleName = '@ai-sdk/groq';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groqSdk: any = await import(/* webpackIgnore: true */ moduleName);
  const groq = groqSdk.createGroq({ apiKey });
  const modelName =
    process.env.ENRICHMENT_SUMMARY_MODEL ||
    process.env.GROQ_MODEL ||
    'meta-llama/llama-4-scout-17b-16e-instruct';
  return { model: groq(modelName), modelName };
}

function buildPrompt(input: GenerateSummaryInput): string {
  const {
    candidate,
    identities,
    platformData,
    supplementalData,
    mode = 'draft',
    confirmedCount = 0,
  } = input;

  const identityLines = identities.slice(0, 25).map((i) => ({
    platform: i.platform,
    platformId: i.platformId,
    profileUrl: i.profileUrl,
    confidence: i.confidence,
  }));

  const platformDataLines = platformData.slice(0, 25).map((p) => ({
    platform: p.platform,
    platformId: p.platformId,
    profileUrl: p.profileUrl,
    data: p.data,
  }));

  // Mode-specific instructions
  const modeInstructions = mode === 'verified'
    ? `VERIFICATION STATUS: This summary is based on ${confirmedCount} CONFIRMED identities that have been verified by a recruiter.
Write with higher confidence since identities have been verified.`
    : `VERIFICATION STATUS: This is a DRAFT summary based on UNCONFIRMED identities.
The identities have been matched algorithmically but NOT verified by a human.
Include appropriate caveats about unverified sources. Be more cautious with claims.`;

  return `You are helping a recruiter understand a software engineering candidate. Write a concise summary using ONLY the provided inputs.

${modeInstructions}

STRICT RULES:
- Do NOT include or infer email addresses, phone numbers, home addresses, or any private identifiers.
- Extract SKILLS from: programming languages in repos, technologies mentioned in bio/headline, frameworks evident from repo names.
- HIGHLIGHTS should include: notable repos (especially with stars), years of experience indicators, companies worked at.
- TALKING POINTS should be conversation starters a recruiter could use.
${mode === 'draft' ? '- CAVEATS must include a note about unverified identity sources.' : ''}

OUTPUT REQUIREMENTS:
- "skills": Array of programming languages/frameworks/tools (e.g., "JavaScript", "React", "Python", "AWS"). Extract from languages array and repo names.
- "highlights": Notable achievements, metrics (stars, repos, followers), companies.
- "talkingPoints": Questions or topics to discuss with the candidate.
- "summary": 2-3 sentence overview.
- "confidence": 0-1 based on data quality${mode === 'draft' ? ' (cap at 0.7 for unverified sources)' : ''}.
- "caveats": Important warnings or limitations${mode === 'draft' ? ' (MUST include unverified source warning)' : ''}.

Candidate (SERP hints):
${JSON.stringify(candidate, null, 2)}

Discovered identities:
${JSON.stringify(identityLines, null, 2)}

Platform data (includes languages and repos):
${JSON.stringify(platformDataLines, null, 2)}

Supplemental data (if provided; may include enriched profile context):
${JSON.stringify(supplementalData ?? {}, null, 2)}

Return valid JSON matching schema: { summary, structured: { skills, highlights, talkingPoints }, confidence, caveats }.`;
}

/**
 * Summary metadata for tracking mode and source identities
 */
export interface SummaryMeta {
  mode: SummaryMode;
  confirmedCount: number;
  /** Sorted, joined identity IDs for staleness detection (not a hash, can be long) */
  identityKey: string;
  /** Identity IDs used in this summary (platform:platformId format) */
  identityIds: string[];
}

export async function generateCandidateSummary(
  input: GenerateSummaryInput
): Promise<{
  summary: CandidateSummary;
  evidence: CandidateSummaryEvidenceItem[];
  model: string;
  tokens: number | null;
  meta: SummaryMeta;
}> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is required for summary generation');
  }

  const mode = input.mode || 'draft';
  const confirmedCount = input.confirmedCount || 0;

  const { model, modelName } = await createGroqModel(apiKey);
  const prompt = buildPrompt(input);

  const { object, usage } = await generateObject({
    model,
    schema: CandidateSummarySchema,
    prompt,
    temperature: 0.3,
  });

  const evidence: CandidateSummaryEvidenceItem[] = [];
  const identityIds: string[] = [];

  for (const identity of input.identities) {
    // Use platform:platformId as identity key since we may not have DB IDs
    identityIds.push(`${identity.platform}:${identity.platformId}`);

    evidence.push({
      platform: identity.platform,
      url: identity.profileUrl,
      dataType: 'profile',
    });

    for (const ev of identity.evidence || []) {
      evidence.push({
        platform: ev.sourcePlatform,
        url: ev.sourceUrl,
        dataType: ev.type,
      });
    }
  }

  // Create a stable hash of identity IDs for staleness detection
  const identityKey = identityIds.sort().join('|');

  const tokens =
    typeof usage?.totalTokens === 'number'
      ? usage.totalTokens
      : typeof usage?.inputTokens === 'number' && typeof usage?.outputTokens === 'number'
        ? usage.inputTokens + usage.outputTokens
        : null;

  return {
    summary: object,
    evidence: evidence.slice(0, 100),
    model: `groq/${modelName}`,
    tokens,
    meta: {
      mode,
      confirmedCount,
      identityKey,
      identityIds,
    },
  };
}
