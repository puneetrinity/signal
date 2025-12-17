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
  const { candidate, identities, platformData } = input;

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

  return `You are helping a recruiter. Write a concise candidate summary using ONLY the provided inputs.

STRICT RULES:
- Do NOT include or infer email addresses, phone numbers, home addresses, or any private identifiers.
- If information is missing/uncertain, say so briefly in caveats.
- Prefer concrete signals from platform profiles over guesses.

Candidate (SERP hints, not authoritative):
${JSON.stringify(candidate, null, 2)}

Discovered identities (ranked signals):
${JSON.stringify(identityLines, null, 2)}

Fetched platform data (public profile fields only; may be partial):
${JSON.stringify(platformDataLines, null, 2)}

Return JSON matching the schema: summary (string), structured (skills/highlights/talkingPoints), confidence (0-1), caveats (array).`;
}

export async function generateCandidateSummary(
  input: GenerateSummaryInput
): Promise<{
  summary: CandidateSummary;
  evidence: CandidateSummaryEvidenceItem[];
  model: string;
  tokens: number | null;
}> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is required for summary generation');
  }

  const { model, modelName } = await createGroqModel(apiKey);
  const prompt = buildPrompt(input);

  const { object, usage } = await generateObject({
    model,
    schema: CandidateSummarySchema,
    prompt,
    temperature: 0.3,
  });

  const evidence: CandidateSummaryEvidenceItem[] = [];
  for (const identity of input.identities) {
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
  };
}

