import type { EnrichmentPlatform } from '../sources/types';

export interface EphemeralPlatformDataItem {
  platform: EnrichmentPlatform;
  platformId: string;
  profileUrl: string;
  fetchedAt: string;
  data: Record<string, unknown>;
}

const platformDataBySession = new Map<string, EphemeralPlatformDataItem[]>();

export function setEphemeralPlatformData(
  sessionId: string,
  items: EphemeralPlatformDataItem[]
): void {
  platformDataBySession.set(sessionId, items);
}

export function getEphemeralPlatformData(
  sessionId: string
): EphemeralPlatformDataItem[] | null {
  return platformDataBySession.get(sessionId) ?? null;
}

export function clearEphemeralPlatformData(sessionId: string): void {
  platformDataBySession.delete(sessionId);
}

