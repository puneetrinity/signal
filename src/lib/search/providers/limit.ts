/**
 * Lightweight in-process concurrency limiter (no external deps).
 *
 * Used to avoid bursty outbound requests to SERP providers even if the caller
 * fan-outs aggressively.
 */

import type { SearchProviderType } from './types';

type LimiterGlobal = {
  providerLimiters?: Partial<Record<SearchProviderType, Limiter>>;
};

class Limiter {
  private readonly max: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

function getConcurrencyFromEnv(provider: SearchProviderType): number {
  const raw = process.env.SEARCH_PROVIDER_CONCURRENCY || process.env.ENRICHMENT_PROVIDER_CONCURRENCY;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  // Default: 4 for main search, 2 for enrichment; if shared env is used, pick conservative.
  const fallback = provider === 'serper' || provider === 'brave' ? 2 : 2;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getProviderLimiter(provider: SearchProviderType): Limiter {
  const globalForLimiter = globalThis as unknown as LimiterGlobal;
  globalForLimiter.providerLimiters ??= {};

  const existing = globalForLimiter.providerLimiters[provider];
  if (existing) return existing;

  const limiter = new Limiter(getConcurrencyFromEnv(provider));
  globalForLimiter.providerLimiters[provider] = limiter;
  return limiter;
}

