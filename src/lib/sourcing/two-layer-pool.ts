export interface SlimPoolCandidate {
  id: string;
  linkedinId: string;
  linkedinUrl: string | null;
}

export interface VectorPoolIdentity {
  id?: string;
  linkedin_id: string | null;
  linkedin_url: string | null;
}

export interface TwoLayerSelection {
  ids: Set<string>;
  vectorLaneResolved: number;
  recentLaneAdded: number;
  fallbackHydrateUsed: boolean;
}

function extractLinkedInSlug(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(/^\/in\/([^/]+)/i);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function buildLayer1SlugIndex(rows: SlimPoolCandidate[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of rows) {
    if (row.linkedinId) index.set(row.linkedinId.toLowerCase(), row.id);
    if (row.linkedinUrl) {
      const slug = extractLinkedInSlug(row.linkedinUrl);
      if (slug) index.set(slug, row.id);
    }
  }
  return index;
}

export function selectTwoLayerCandidateIds({
  slimPool,
  slimBySlug,
  vectorResults,
  resolvedVectorIdByGlobalId = new Map(),
  recentK,
  fallbackHydrateCap,
}: {
  slimPool: SlimPoolCandidate[];
  slimBySlug: ReadonlyMap<string, string>;
  vectorResults: VectorPoolIdentity[] | null;
  resolvedVectorIdByGlobalId?: ReadonlyMap<string, string>;
  recentK: number;
  fallbackHydrateCap: number;
}): TwoLayerSelection {
  const ids = new Set<string>();
  if (vectorResults === null) {
    for (const row of slimPool.slice(0, fallbackHydrateCap)) ids.add(row.id);
    return {
      ids,
      vectorLaneResolved: 0,
      recentLaneAdded: 0,
      fallbackHydrateUsed: true,
    };
  }

  for (const result of vectorResults) {
    const linkedLocalId = result.id
      ? resolvedVectorIdByGlobalId.get(result.id)
      : undefined;
    if (linkedLocalId) {
      ids.add(linkedLocalId);
      continue;
    }
    const linkedinId = result.linkedin_id?.trim();
    const slug = linkedinId
      ? linkedinId.toLowerCase()
      : (result.linkedin_url ? extractLinkedInSlug(result.linkedin_url) : null);
    if (!slug) continue;
    const localId = slimBySlug.get(slug);
    if (localId) ids.add(localId);
  }
  const vectorLaneResolved = ids.size;

  let recentLaneAdded = 0;
  for (const row of slimPool.slice(0, recentK)) {
    if (!ids.has(row.id)) {
      ids.add(row.id);
      recentLaneAdded += 1;
    }
  }

  return {
    ids,
    vectorLaneResolved,
    recentLaneAdded,
    fallbackHydrateUsed: false,
  };
}
