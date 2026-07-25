import { normalizeContactEmail, type StagedContactEvidenceItem } from "./types";

const FULLENRICH_BASE_URL =
  "https://app.fullenrich.com/api/v2/contact/enrich/bulk";
const ENRICHLAYER_URL =
  "https://enrichlayer.com/api/v2/contact-api/personal-email";
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

export interface ContactProviderCandidate {
  linkedinUrl: string;
  nameHint: string | null;
  companyHint: string | null;
}

export type FullEnrichStartResult =
  | { kind: "started"; providerRecordId: string }
  | { kind: "ambiguous"; code: string }
  | { kind: "failed"; code: string };

export type FullEnrichPollResult =
  | { kind: "pending"; code?: string }
  | {
      kind: "found";
      evidence: StagedContactEvidenceItem[];
    }
  | { kind: "not_found" }
  | { kind: "failed"; code: string };

export type EnrichLayerResult =
  | {
      kind: "found";
      evidence: StagedContactEvidenceItem[];
    }
  | { kind: "not_found" }
  | { kind: "ambiguous"; code: string }
  | { kind: "failed"; code: string };

export interface ContactProviderClient {
  startFullEnrich(input: {
    operationId: string;
    generation: number;
    requestKey: string;
    candidate: ContactProviderCandidate;
  }): Promise<FullEnrichStartResult>;
  pollFullEnrich(input: {
    providerRecordId: string;
  }): Promise<FullEnrichPollResult>;
  callEnrichLayer(input: {
    requestKey: string;
    candidate: ContactProviderCandidate;
  }): Promise<EnrichLayerResult>;
}

function providerTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.CONTACT_PROVIDER_TIMEOUT_MS ||
      String(DEFAULT_PROVIDER_TIMEOUT_MS),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PROVIDER_TIMEOUT_MS;
}

async function providerFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs());
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function splitName(value: string | null): {
  firstName: string;
  lastName: string;
} {
  const parts = (value || "").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
}

function fullEnrichWebhookUrl(): string | null {
  const base = process.env.SIGNAL_PUBLIC_BASE_URL;
  if (!base) return null;
  try {
    return new URL("/api/webhooks/fullenrich", base).toString();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function acceptedFullEnrichEvidence(
  emailValue: unknown,
  statusValue: unknown,
  providerRecordId: string,
  observedAt: string,
): StagedContactEvidenceItem | null {
  const email = normalizeContactEmail(emailValue);
  const status = asString(statusValue)?.toUpperCase();
  if (!email || !status) return null;

  if (status === "DELIVERABLE") {
    return {
      email,
      provider: "fullenrich",
      providerRecordId,
      confidence: 0.95,
      observedAt,
      validatedAt: observedAt,
      status: "verified",
    };
  }
  if (status === "HIGH_PROBABILITY" || status === "CATCH_ALL") {
    return {
      email,
      provider: "fullenrich",
      providerRecordId,
      confidence: status === "HIGH_PROBABILITY" ? 0.75 : 0.6,
      observedAt,
      validatedAt: null,
      status: "found",
    };
  }
  return null;
}

function collectFullEnrichEvidence(
  payload: Record<string, unknown>,
  providerRecordId: string,
  observedAt: string,
): StagedContactEvidenceItem[] {
  const data = Array.isArray(payload.data) ? payload.data : [];
  const first = asRecord(data[0]);
  const contact = asRecord(first?.contact_info);
  if (!contact) return [];

  const values: Array<{ email: unknown; status: unknown }> = [];
  for (const field of ["work_emails", "personal_emails"]) {
    const emails = contact[field];
    if (!Array.isArray(emails)) continue;
    for (const entry of emails) {
      const record = asRecord(entry);
      if (record) {
        values.push({
          email: record.email,
          status: record.status,
        });
      }
    }
  }
  for (const field of [
    "most_probable_work_email",
    "most_probable_personal_email",
  ]) {
    const record = asRecord(contact[field]);
    if (record) {
      values.push({
        email: record.email,
        status: record.status,
      });
    }
  }

  const strongestByEmail = new Map<string, StagedContactEvidenceItem>();
  for (const value of values) {
    const evidence = acceptedFullEnrichEvidence(
      value.email,
      value.status,
      providerRecordId,
      observedAt,
    );
    if (!evidence) continue;
    const current = strongestByEmail.get(evidence.email);
    if (!current || evidence.confidence > current.confidence) {
      strongestByEmail.set(evidence.email, evidence);
    }
  }
  return Array.from(strongestByEmail.values())
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 10);
}

export function parseFullEnrichCompletion(
  payload: unknown,
  providerRecordId: string,
  observedAt = new Date().toISOString(),
): FullEnrichPollResult {
  const record = asRecord(payload);
  if (!record) return { kind: "pending", code: "fullenrich_invalid_poll" };
  const status = asString(record.status)?.toUpperCase();
  if (
    status === "FAILED" ||
    status === "ERROR" ||
    status === "CANCELED" ||
    status === "CANCELLED" ||
    status === "CREDITS_INSUFFICIENT" ||
    status === "RATE_LIMIT" ||
    status === "UNKNOWN"
  ) {
    return { kind: "failed", code: "fullenrich_failed" };
  }
  if (status !== "FINISHED" && status !== "COMPLETED" && status !== "DONE") {
    return { kind: "pending" };
  }
  const evidence = collectFullEnrichEvidence(
    record,
    providerRecordId,
    observedAt,
  );
  return evidence.length > 0
    ? { kind: "found", evidence }
    : { kind: "not_found" };
}

function parseEnrichLayerEmails(payload: unknown): string[] | null {
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.emails)) return null;
  const emails = record.emails
    .map((value) => {
      const entry = asRecord(value);
      return normalizeContactEmail(entry?.email ?? value);
    })
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(emails));
}

export class ExternalContactProviderClient implements ContactProviderClient {
  async startFullEnrich({
    operationId,
    generation,
    requestKey,
    candidate,
  }: {
    operationId: string;
    generation: number;
    requestKey: string;
    candidate: ContactProviderCandidate;
  }): Promise<FullEnrichStartResult> {
    const apiKey = process.env.FULLENRICH_API_KEY;
    const webhookUrl = fullEnrichWebhookUrl();
    if (!apiKey) {
      return { kind: "failed", code: "fullenrich_not_configured" };
    }
    if (!webhookUrl) {
      return {
        kind: "failed",
        code: "fullenrich_webhook_not_configured",
      };
    }
    const { firstName, lastName } = splitName(candidate.nameHint);
    try {
      const response = await providerFetch(FULLENRICH_BASE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `ealana-contact-${requestKey}`,
          webhook_url: webhookUrl,
          data: [
            {
              first_name: firstName,
              last_name: lastName,
              company_name: candidate.companyHint || "",
              linkedin_url: candidate.linkedinUrl,
              enrich_fields: ["contact.personal_emails"],
              custom: {
                operation: JSON.stringify({
                  operation_id: operationId,
                  generation,
                }),
              },
            },
          ],
        }),
      });
      if (!response.ok) {
        return response.status >= 500
          ? { kind: "ambiguous", code: "fullenrich_start_ambiguous" }
          : { kind: "failed", code: "fullenrich_start_rejected" };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return {
          kind: "ambiguous",
          code: "fullenrich_start_invalid_response",
        };
      }
      const providerRecordId = asString(asRecord(payload)?.enrichment_id);
      return providerRecordId
        ? { kind: "started", providerRecordId }
        : {
            kind: "ambiguous",
            code: "fullenrich_start_missing_id",
          };
    } catch {
      return {
        kind: "ambiguous",
        code: "fullenrich_start_ambiguous",
      };
    }
  }

  async pollFullEnrich({
    providerRecordId,
  }: {
    providerRecordId: string;
  }): Promise<FullEnrichPollResult> {
    const apiKey = process.env.FULLENRICH_API_KEY;
    if (!apiKey) {
      return { kind: "failed", code: "fullenrich_not_configured" };
    }
    try {
      const response = await providerFetch(
        `${FULLENRICH_BASE_URL}/${encodeURIComponent(providerRecordId)}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      );
      if (!response.ok) {
        return response.status >= 500 ||
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429
          ? { kind: "pending", code: "fullenrich_poll_unavailable" }
          : { kind: "failed", code: "fullenrich_poll_rejected" };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return {
          kind: "pending",
          code: "fullenrich_invalid_poll",
        };
      }
      return parseFullEnrichCompletion(payload, providerRecordId);
    } catch {
      return {
        kind: "pending",
        code: "fullenrich_poll_unavailable",
      };
    }
  }

  async callEnrichLayer({
    requestKey,
    candidate,
  }: {
    requestKey: string;
    candidate: ContactProviderCandidate;
  }): Promise<EnrichLayerResult> {
    const apiKey = process.env.ENRICHLAYER_API_KEY;
    if (!apiKey) {
      return { kind: "failed", code: "enrichlayer_not_configured" };
    }
    const url = new URL(ENRICHLAYER_URL);
    url.searchParams.set("profile_url", candidate.linkedinUrl);
    url.searchParams.set("email_validation", "fast");
    url.searchParams.set("page_size", "10");
    try {
      const response = await providerFetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        return response.status >= 500
          ? { kind: "ambiguous", code: "enrichlayer_ambiguous" }
          : { kind: "failed", code: "enrichlayer_rejected" };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return {
          kind: "ambiguous",
          code: "enrichlayer_invalid_response",
        };
      }
      const emails = parseEnrichLayerEmails(payload)?.slice(0, 10);
      if (!emails) {
        return {
          kind: "ambiguous",
          code: "enrichlayer_invalid_response",
        };
      }
      if (emails.length === 0) return { kind: "not_found" };
      const observedAt = new Date().toISOString();
      return {
        kind: "found",
        evidence: emails.map((email) => ({
          email,
          provider: "enrichlayer",
          providerRecordId: requestKey,
          confidence: 0.55,
          observedAt,
          validatedAt: null,
          status: "found",
        })),
      };
    } catch {
      return { kind: "ambiguous", code: "enrichlayer_ambiguous" };
    }
  }
}
