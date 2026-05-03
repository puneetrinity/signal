/**
 * Enrichment provider selection
 *
 * Controls which enrichment engine runs for /api/v2/enrich/async jobs.
 */

export type EnrichmentProvider = 'langgraph' | 'pdl' | 'enrichlayer';

export function getEnrichmentProvider(): EnrichmentProvider {
  const env = process.env.ENRICHMENT_PROVIDER?.toLowerCase();
  if (env === 'enrichlayer') return 'enrichlayer';
  if (env === 'langgraph') return 'langgraph';
  if (!env && process.env.ENRICHLAYER_API_KEY) return 'enrichlayer';
  return 'pdl';
}

export function getEnrichmentProviderStatus(): {
  provider: EnrichmentProvider;
  enabled: boolean;
  reason?: string;
} {
  const provider = getEnrichmentProvider();

  if (provider === 'enrichlayer') {
    if (!process.env.ENRICHLAYER_API_KEY) {
      return { provider, enabled: false, reason: 'ENRICHLAYER_API_KEY is not configured' };
    }
    return { provider, enabled: true };
  }

  if (provider === 'pdl') {
    if (!process.env.PDL_API_KEY) {
      return { provider, enabled: false, reason: 'PDL_API_KEY is not configured' };
    }
    return { provider, enabled: true };
  }

  const enabled = process.env.USE_LANGGRAPH_ENRICHMENT === 'true';
  if (!enabled) {
    return { provider, enabled: false, reason: 'USE_LANGGRAPH_ENRICHMENT is not set to "true"' };
  }

  return { provider, enabled: true };
}
