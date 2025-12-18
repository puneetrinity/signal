/**
 * Tenant Settings Module
 *
 * Manages per-tenant configuration and policy knobs.
 * Settings are cached in memory with TTL to reduce DB queries.
 *
 * ## Available Policy Knobs (defined, not yet enforced)
 *
 * - `rateLimitMultiplier`: Multiplier for base rate limits (1.0 = standard)
 * - `maxEnrichmentsPerDay`: Daily enrichment quota per tenant
 * - `maxQueriesPerEnrichment`: Max API queries per enrichment session
 * - `maxParallelPlatforms`: Max platforms queried in parallel
 * - `allowContactStorage`: Whether confirmed identities can store PII
 * - `features`: Feature flags (summaryEnabled, autoConfirmHighConfidence)
 * - `plan`: Tenant tier (free, pro, enterprise)
 *
 * ## How to Wire Policy Enforcement
 *
 * 1. Rate limits: Call `getEffectiveRateLimit(tenantId, baseLimit)` in rate-limit checks
 * 2. Enrichment budget: Call `getEnrichmentBudget(tenantId)` in enrichment graph init
 * 3. Feature flags: Call `hasFeature(tenantId, 'featureName')` before feature code
 * 4. Contact storage: Check `settings.allowContactStorage` in identity/confirm route
 *
 * ## Current Status
 *
 * Settings are stored and queryable but NOT yet enforced in application logic.
 * This is Phase C7 infrastructure - enforcement is a separate task.
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { prisma } from '@/lib/prisma';
import type { TenantSettings, Prisma } from '@prisma/client';

/**
 * Tenant settings with parsed features
 */
export interface TenantSettingsWithFeatures {
  tenantId: string;
  rateLimitMultiplier: number;
  maxEnrichmentsPerDay: number;
  maxQueriesPerEnrichment: number;
  maxParallelPlatforms: number;
  features: TenantFeatures;
  allowContactStorage: boolean;
  plan: string;
}

/**
 * Feature flags for tenants
 */
export interface TenantFeatures {
  summaryEnabled: boolean;
  autoConfirmHighConfidence: boolean;
  // Add more features as needed
}

/**
 * Default feature flags
 */
const DEFAULT_FEATURES: TenantFeatures = {
  summaryEnabled: true,
  autoConfirmHighConfidence: false,
};

/**
 * Default settings for new tenants
 */
const DEFAULT_SETTINGS: Omit<TenantSettingsWithFeatures, 'tenantId'> = {
  rateLimitMultiplier: 1.0,
  maxEnrichmentsPerDay: 100,
  maxQueriesPerEnrichment: 30,
  maxParallelPlatforms: 3,
  features: DEFAULT_FEATURES,
  allowContactStorage: true,
  plan: 'free',
};

/**
 * In-memory cache for tenant settings
 */
const settingsCache = new Map<string, {
  settings: TenantSettingsWithFeatures;
  expiresAt: number;
}>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Parse features JSON into typed object
 */
function parseFeatures(featuresJson: unknown): TenantFeatures {
  if (!featuresJson || typeof featuresJson !== 'object') {
    return DEFAULT_FEATURES;
  }

  const features = featuresJson as Record<string, unknown>;
  return {
    summaryEnabled: typeof features.summaryEnabled === 'boolean'
      ? features.summaryEnabled
      : DEFAULT_FEATURES.summaryEnabled,
    autoConfirmHighConfidence: typeof features.autoConfirmHighConfidence === 'boolean'
      ? features.autoConfirmHighConfidence
      : DEFAULT_FEATURES.autoConfirmHighConfidence,
  };
}

/**
 * Convert DB record to typed settings
 */
function toTypedSettings(record: TenantSettings): TenantSettingsWithFeatures {
  return {
    tenantId: record.tenantId,
    rateLimitMultiplier: record.rateLimitMultiplier,
    maxEnrichmentsPerDay: record.maxEnrichmentsPerDay,
    maxQueriesPerEnrichment: record.maxQueriesPerEnrichment,
    maxParallelPlatforms: record.maxParallelPlatforms,
    features: parseFeatures(record.features),
    allowContactStorage: record.allowContactStorage,
    plan: record.plan,
  };
}

/**
 * Get settings for a tenant
 * Returns default settings if tenant hasn't customized
 */
export async function getTenantSettings(tenantId: string): Promise<TenantSettingsWithFeatures> {
  // Check cache first
  const cached = settingsCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.settings;
  }

  // Query database
  const record = await prisma.tenantSettings.findUnique({
    where: { tenantId },
  });

  if (record) {
    const settings = toTypedSettings(record);
    settingsCache.set(tenantId, {
      settings,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return settings;
  }

  // Return defaults for unregistered tenants
  const defaultSettings = {
    tenantId,
    ...DEFAULT_SETTINGS,
  };

  // Cache defaults too
  settingsCache.set(tenantId, {
    settings: defaultSettings,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return defaultSettings;
}

/**
 * Create or update tenant settings
 */
export async function upsertTenantSettings(
  tenantId: string,
  updates: Partial<Omit<TenantSettingsWithFeatures, 'tenantId'>>
): Promise<TenantSettingsWithFeatures> {
  // Cast features to Prisma-compatible JSON type
  const createFeatures = (updates.features ?? DEFAULT_SETTINGS.features) as unknown as Prisma.InputJsonValue;
  const updateFeatures = updates.features as unknown as Prisma.InputJsonValue | undefined;

  const record = await prisma.tenantSettings.upsert({
    where: { tenantId },
    create: {
      tenantId,
      rateLimitMultiplier: updates.rateLimitMultiplier ?? DEFAULT_SETTINGS.rateLimitMultiplier,
      maxEnrichmentsPerDay: updates.maxEnrichmentsPerDay ?? DEFAULT_SETTINGS.maxEnrichmentsPerDay,
      maxQueriesPerEnrichment: updates.maxQueriesPerEnrichment ?? DEFAULT_SETTINGS.maxQueriesPerEnrichment,
      maxParallelPlatforms: updates.maxParallelPlatforms ?? DEFAULT_SETTINGS.maxParallelPlatforms,
      features: createFeatures,
      allowContactStorage: updates.allowContactStorage ?? DEFAULT_SETTINGS.allowContactStorage,
      plan: updates.plan ?? DEFAULT_SETTINGS.plan,
    },
    update: {
      ...(updates.rateLimitMultiplier !== undefined && { rateLimitMultiplier: updates.rateLimitMultiplier }),
      ...(updates.maxEnrichmentsPerDay !== undefined && { maxEnrichmentsPerDay: updates.maxEnrichmentsPerDay }),
      ...(updates.maxQueriesPerEnrichment !== undefined && { maxQueriesPerEnrichment: updates.maxQueriesPerEnrichment }),
      ...(updates.maxParallelPlatforms !== undefined && { maxParallelPlatforms: updates.maxParallelPlatforms }),
      ...(updateFeatures !== undefined && { features: updateFeatures }),
      ...(updates.allowContactStorage !== undefined && { allowContactStorage: updates.allowContactStorage }),
      ...(updates.plan !== undefined && { plan: updates.plan }),
    },
  });

  const settings = toTypedSettings(record);

  // Update cache
  settingsCache.set(tenantId, {
    settings,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return settings;
}

/**
 * Invalidate cached settings for a tenant
 */
export function invalidateTenantSettingsCache(tenantId: string): void {
  settingsCache.delete(tenantId);
}

/**
 * Check if a tenant has a specific feature enabled
 */
export async function hasFeature(
  tenantId: string,
  feature: keyof TenantFeatures
): Promise<boolean> {
  const settings = await getTenantSettings(tenantId);
  return settings.features[feature];
}

/**
 * Get effective rate limit for a tenant
 * Applies the tenant's rate limit multiplier to base limits
 */
export async function getEffectiveRateLimit(
  tenantId: string,
  baseLimit: number
): Promise<number> {
  const settings = await getTenantSettings(tenantId);
  return Math.floor(baseLimit * settings.rateLimitMultiplier);
}

/**
 * Get effective enrichment budget for a tenant
 */
export async function getEnrichmentBudget(tenantId: string): Promise<{
  maxEnrichmentsPerDay: number;
  maxQueriesPerEnrichment: number;
  maxParallelPlatforms: number;
}> {
  const settings = await getTenantSettings(tenantId);
  return {
    maxEnrichmentsPerDay: settings.maxEnrichmentsPerDay,
    maxQueriesPerEnrichment: settings.maxQueriesPerEnrichment,
    maxParallelPlatforms: settings.maxParallelPlatforms,
  };
}

export default {
  getTenantSettings,
  upsertTenantSettings,
  invalidateTenantSettingsCache,
  hasFeature,
  getEffectiveRateLimit,
  getEnrichmentBudget,
};
