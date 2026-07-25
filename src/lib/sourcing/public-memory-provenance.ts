const PRIVATE_PUBLIC_PROVENANCE_KEYS = new Set([
  'tenant_id',
  'signal_candidate_id',
  'job_id',
  'request_id',
  'serp_query',
  'search_query',
  'discovered_at',
]);

/**
 * Public provenance records only that a provider observed the public profile.
 * Tenant, job, query, request and activity details stay in Signal.
 */
export function buildPublicWebDiscoverySourceDetail(
  provider: string | null | undefined,
): Record<string, string> {
  const normalizedProvider = provider?.trim().toLowerCase();
  return normalizedProvider ? { provider: normalizedProvider } : {};
}

export function isExplicitPublicSourcingProvenance({
  captureSource,
  provider,
}: {
  captureSource: string | null | undefined;
  provider: string | null | undefined;
}): boolean {
  return (
    captureSource?.trim().toLowerCase() === 'sourcing' &&
    provider?.trim().toLowerCase() === 'crustdata'
  );
}

export function assertPublicSourceDetailIsNonPrivate(
  detail: Record<string, unknown>,
): void {
  const leakedKey = Object.keys(detail).find((key) =>
    PRIVATE_PUBLIC_PROVENANCE_KEYS.has(key.toLowerCase()),
  );
  if (leakedKey) {
    throw new Error(`Private provenance key cannot be public: ${leakedKey}`);
  }
}
