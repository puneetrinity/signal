import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { parseFullEnrichCompletion } from './providers';

interface FullEnrichWebhookIdentity {
  operationId: string;
  generation: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function verifyFullEnrichSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const provided = signatureHeader
    .trim()
    .replace(/^sha1=/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(provided)) return false;
  const expected = createHmac('sha1', secret)
    .update(rawBody)
    .digest('hex');
  const providedBuffer = Buffer.from(provided, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export function parseFullEnrichWebhookIdentity(
  payload: unknown,
): FullEnrichWebhookIdentity | null {
  const root = asRecord(payload);
  const data = Array.isArray(root?.data) ? root.data : [];
  const item = asRecord(data[0]);
  const custom = asRecord(item?.custom) ?? asRecord(root?.custom);
  const serialized =
    typeof custom?.operation === 'string'
      ? custom.operation
      : typeof item?.custom === 'string'
        ? item.custom
        : typeof root?.custom === 'string'
          ? root.custom
          : null;
  if (!serialized) return null;
  try {
    const parsed = asRecord(JSON.parse(serialized));
    const operationId =
      typeof parsed?.operation_id === 'string'
        ? parsed.operation_id
        : null;
    const generation =
      typeof parsed?.generation === 'number'
        ? parsed.generation
        : Number.NaN;
    return operationId &&
      Number.isInteger(generation) &&
      generation >= 1
      ? { operationId, generation }
      : null;
  } catch {
    return null;
  }
}

export function parseFullEnrichWebhookResult(
  payload: unknown,
  providerRecordId: string,
) {
  return parseFullEnrichCompletion(payload, providerRecordId);
}

export function getFullEnrichWebhookProviderRecordId(
  payload: unknown,
): string | null {
  const root = asRecord(payload);
  const value = root?.enrichment_id ?? root?.id;
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}
