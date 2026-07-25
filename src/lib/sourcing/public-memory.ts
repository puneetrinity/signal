import { createHash } from "node:crypto";
import { resolveLocationDeterministic } from "@/lib/taxonomy/location-service";
import {
  resolveRoleDeterministic,
  type RoleFamily,
} from "@/lib/taxonomy/role-service";
import {
  normalizeSeniorityFromText,
  type SeniorityBand,
} from "@/lib/taxonomy/seniority";
import type { JobRequirements } from "./jd-digest";

export const PUBLIC_MARKET_KEY_VERSION = 1 as const;

export function canApplyPlatformPublicExclusions({
  excludeKnownEnabled,
  publicMemoryHydrationEnabled,
  platformExclusionEnabled,
  publicSearchAvailable,
}: {
  excludeKnownEnabled: boolean;
  publicMemoryHydrationEnabled: boolean;
  platformExclusionEnabled: boolean;
  publicSearchAvailable: boolean | null;
}): boolean {
  return (
    excludeKnownEnabled &&
    publicMemoryHydrationEnabled &&
    platformExclusionEnabled &&
    publicSearchAvailable === true
  );
}

export function mergePublicExclusionIds(
  memoryIds: number[],
  localLagIds: number[],
  limit: number,
): number[] {
  return Array.from(new Set([...memoryIds, ...localLagIds])).slice(
    0,
    Math.max(0, limit),
  );
}

export interface PublicMarket {
  version: typeof PUBLIC_MARKET_KEY_VERSION;
  coarseMarketKey: string;
  roleFamily: RoleFamily;
  locationCity: string;
  locationCountryCode: string;
  seniorityBand: SeniorityBand;
}

export interface ObservedPublicMarketInput {
  roleFamily: RoleFamily | null;
  location: string | null;
  seniorityLevel: string | null;
}

const SENIORITY_INPUT_ALIASES: Readonly<Record<string, string>> = {
  entry: "junior",
  "entry level": "junior",
  executive: "cxo",
  "owner / partner": "cxo",
  owner: "cxo",
  partner: "cxo",
};

function resolveCanonicalRole(
  requirements: JobRequirements,
): RoleFamily | null {
  const candidates = [
    requirements.roleFamily,
    requirements.title,
    ...requirements.titleSearchTerms,
  ];

  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const resolved = resolveRoleDeterministic(
      candidate.replaceAll("_", " "),
    ).family;
    if (resolved) return resolved;
  }

  // Generic labels such as "software engineering" are intentionally not
  // guessed as backend. A missing key only forgoes reuse; a wrong broad key
  // could exclude relevant public profiles from another organisation's buy.
  return null;
}

interface CanonicalLocation {
  city: string;
  countryCode: string;
}

function resolveCanonicalLocation(
  location: string | null,
): CanonicalLocation | null {
  const resolved = resolveLocationDeterministic(location);
  if (!resolved.city || !resolved.countryCode) return null;
  return { city: resolved.city, countryCode: resolved.countryCode };
}

function resolveCanonicalSeniority(
  seniority: string | null,
): SeniorityBand | null {
  const normalized = seniority?.trim().toLowerCase();
  if (!normalized) return null;
  return normalizeSeniorityFromText(
    SENIORITY_INPUT_ALIASES[normalized] ?? normalized,
  );
}

function buildPublicMarketFromCanonicalDimensions({
  roleFamily,
  location,
  seniorityBand,
}: {
  roleFamily: RoleFamily;
  location: CanonicalLocation;
  seniorityBand: SeniorityBand;
}): PublicMarket {
  const components = {
    version: PUBLIC_MARKET_KEY_VERSION,
    roleFamily,
    locationCity: location.city,
    locationCountryCode: location.countryCode,
    seniorityBand,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(components))
    .digest("hex");

  return {
    ...components,
    coarseMarketKey: `public-market:v${PUBLIC_MARKET_KEY_VERSION}:${digest}`,
  };
}

/**
 * Build the coarse, platform-level market identity used for public-profile
 * coverage and purchase deduplication. It deliberately excludes skills,
 * title variants and adjacency: those belong to the fine per-query ladder key.
 */
export function buildPublicMarket(
  requirements: JobRequirements,
): PublicMarket | null {
  const roleFamily = resolveCanonicalRole(requirements);
  const location = resolveCanonicalLocation(requirements.location);
  const seniorityBand = resolveCanonicalSeniority(requirements.seniorityLevel);
  if (!roleFamily || !location || !seniorityBand) return null;

  return buildPublicMarketFromCanonicalDimensions({
    roleFamily,
    seniorityBand,
    location,
  });
}

export function buildPublicMarketsForQuery(
  requirements: JobRequirements,
): PublicMarket[] {
  const seniorityLevels = requirements.querySeniorityLevels?.length
    ? requirements.querySeniorityLevels
    : [requirements.seniorityLevel];
  const byKey = new Map<string, PublicMarket>();
  for (const seniorityLevel of seniorityLevels) {
    const market = buildPublicMarket({
      ...requirements,
      seniorityLevel,
      querySeniorityLevels: [],
    });
    if (market) byKey.set(market.coarseMarketKey, market);
  }
  return Array.from(byKey.values());
}

export function buildObservedPublicMarket(
  input: ObservedPublicMarketInput,
): PublicMarket | null {
  if (!input.roleFamily) return null;
  const location = resolveCanonicalLocation(input.location);
  const seniorityBand = resolveCanonicalSeniority(input.seniorityLevel);
  if (!location || !seniorityBand) return null;
  return buildPublicMarketFromCanonicalDimensions({
    roleFamily: input.roleFamily,
    location,
    seniorityBand,
  });
}

export function toActiveGraphPublicMarket(market: PublicMarket): {
  version: typeof PUBLIC_MARKET_KEY_VERSION;
  coarse_market_key: string;
  role_family: RoleFamily;
  location_city: string;
  location_country_code: string;
  seniority_band: SeniorityBand;
} {
  return {
    version: market.version,
    coarse_market_key: market.coarseMarketKey,
    role_family: market.roleFamily,
    location_city: market.locationCity,
    location_country_code: market.locationCountryCode,
    seniority_band: market.seniorityBand,
  };
}
