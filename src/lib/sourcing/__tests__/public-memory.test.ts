import { afterEach, describe, expect, it } from "vitest";
import type { JobRequirements } from "../jd-digest";
import {
  buildObservedPublicMarket,
  buildPublicMarket,
  buildPublicMarketsForQuery,
  canApplyPlatformPublicExclusions,
  mergePublicExclusionIds,
  toActiveGraphPublicMarket,
} from "../public-memory";
import { getSourcingConfig } from "../config";

function requirements(
  overrides: Partial<JobRequirements> = {},
): JobRequirements {
  return {
    title: "Senior Backend Python Engineer",
    topSkills: ["python", "django"],
    seniorityLevel: "senior",
    domain: "software",
    roleFamily: "backend",
    location: "Bengaluru, India",
    experienceYears: 5,
    experienceYearsMax: null,
    education: null,
    titleSearchTerms: ["backend engineer", "python developer"],
    adjacentBuckets: [],
    adjacentLocations: [],
    ...overrides,
  };
}

const originalHydrationFlag =
  process.env.SOURCE_PUBLIC_MEMORY_HYDRATION_ENABLED;
const originalExclusionFlag = process.env.SOURCE_PLATFORM_EXCLUSION_ENABLED;

afterEach(() => {
  if (originalHydrationFlag === undefined) {
    delete process.env.SOURCE_PUBLIC_MEMORY_HYDRATION_ENABLED;
  } else {
    process.env.SOURCE_PUBLIC_MEMORY_HYDRATION_ENABLED = originalHydrationFlag;
  }
  if (originalExclusionFlag === undefined) {
    delete process.env.SOURCE_PLATFORM_EXCLUSION_ENABLED;
  } else {
    process.env.SOURCE_PLATFORM_EXCLUSION_ENABLED = originalExclusionFlag;
  }
});

describe("public Memory market identity", () => {
  it("converges canonical role, city aliases and seniority aliases", () => {
    const canonical = buildPublicMarket(requirements());
    const aliased = buildPublicMarket(
      requirements({
        title: "Sr. Back-end Developer",
        roleFamily: null,
        seniorityLevel: "Sr.",
        location: "Greater Bengaluru Area, India",
        titleSearchTerms: ["server-side engineer"],
      }),
    );

    expect(canonical).not.toBeNull();
    expect(aliased).toEqual(canonical);
    expect(canonical).toMatchObject({
      version: 1,
      roleFamily: "backend",
      locationCity: "bangalore",
      locationCountryCode: "IN",
      seniorityBand: "senior",
    });
    expect(
      buildPublicMarket(requirements({ location: "Bangalore Urban, India" })),
    ).toEqual(canonical);
  });

  it("does not let skills or title-query variants fragment the coarse key", () => {
    const python = buildPublicMarket(requirements());
    const java = buildPublicMarket(
      requirements({
        topSkills: ["java", "spring"],
        titleSearchTerms: ["api developer", "java developer"],
        adjacentBuckets: [["spring developer"]],
      }),
    );

    expect(java?.coarseMarketKey).toBe(python?.coarseMarketKey);
  });

  it("keeps country and seniority in the market boundary", () => {
    const base = buildPublicMarket(requirements());
    const otherCountry = buildPublicMarket(
      requirements({ location: "Bangalore, United States" }),
    );
    const otherSeniority = buildPublicMarket(
      requirements({ seniorityLevel: "mid" }),
    );

    expect(otherCountry?.coarseMarketKey).not.toBe(base?.coarseMarketKey);
    expect(otherSeniority?.coarseMarketKey).not.toBe(base?.coarseMarketKey);
  });

  it("fails closed for generic engineering instead of guessing backend", () => {
    const market = buildPublicMarket(
      requirements({
        title: "Senior Software Engineer",
        roleFamily: "software engineering",
        titleSearchTerms: ["software developer"],
      }),
    );

    expect(market).toBeNull();
  });

  it("requires all four canonical dimensions", () => {
    expect(buildPublicMarket(requirements({ location: "Remote" }))).toBeNull();
    expect(
      buildPublicMarket(requirements({ seniorityLevel: null })),
    ).toBeNull();
  });

  it("serializes the Memory API contract without raw query fields", () => {
    const market = buildPublicMarket(requirements());
    expect(market).not.toBeNull();

    expect(toActiveGraphPublicMarket(market!)).toEqual({
      version: 1,
      coarse_market_key: market!.coarseMarketKey,
      role_family: "backend",
      location_city: "bangalore",
      location_country_code: "IN",
      seniority_band: "senior",
    });
  });

  it("builds one exclusion key per queried seniority band", () => {
    const markets = buildPublicMarketsForQuery(
      requirements({
        seniorityLevel: "senior",
        querySeniorityLevels: ["mid", "senior", "lead"],
      }),
    );
    expect(markets.map((market) => market.seniorityBand).sort()).toEqual([
      "lead",
      "mid",
      "senior",
    ]);
  });

  it("records observed mid or lead evidence without false senior membership", () => {
    const mid = buildObservedPublicMarket({
      roleFamily: "backend",
      location: "Bengaluru, India",
      seniorityLevel: "mid",
    });
    const lead = buildObservedPublicMarket({
      roleFamily: "backend",
      location: "Bangalore Urban, India",
      seniorityLevel: "lead",
    });
    expect(mid?.seniorityBand).toBe("mid");
    expect(lead?.seniorityBand).toBe("lead");
    expect([mid?.seniorityBand, lead?.seniorityBand]).not.toContain("senior");
    expect(
      buildObservedPublicMarket({
        roleFamily: "backend",
        location: "Bengaluru, India",
        seniorityLevel: null,
      }),
    ).toBeNull();
  });

  it("maps Crustdata Owner / Partner into the cxo market band", () => {
    expect(
      buildObservedPublicMarket({
        roleFamily: "backend",
        location: "Bengaluru, India",
        seniorityLevel: "Owner / Partner",
      })?.seniorityBand,
    ).toBe("cxo");
  });

  it("keeps coarse-market Memory IDs ahead of the bounded local lag tail", () => {
    expect(mergePublicExclusionIds([1, 2, 4], [3, 1], 4)).toEqual([
      1, 2, 4, 3,
    ]);
    expect(mergePublicExclusionIds([1, 2, 4], [3, 1], 2)).toEqual([1, 2]);
  });
});

describe("public Memory rollout flags", () => {
  it("never applies platform IDs without a valid public hydration response", () => {
    const base = {
      excludeKnownEnabled: true,
      publicMemoryHydrationEnabled: true,
      platformExclusionEnabled: true,
    };
    expect(
      canApplyPlatformPublicExclusions({
        ...base,
        publicSearchAvailable: true,
      }),
    ).toBe(true);
    expect(
      canApplyPlatformPublicExclusions({
        ...base,
        publicSearchAvailable: null,
      }),
    ).toBe(false);
    expect(
      canApplyPlatformPublicExclusions({
        ...base,
        publicSearchAvailable: false,
      }),
    ).toBe(false);
    expect(
      canApplyPlatformPublicExclusions({
        ...base,
        publicMemoryHydrationEnabled: false,
        publicSearchAvailable: true,
      }),
    ).toBe(false);
  });

  it("defaults hydration and platform exclusion off independently", () => {
    delete process.env.SOURCE_PUBLIC_MEMORY_HYDRATION_ENABLED;
    delete process.env.SOURCE_PLATFORM_EXCLUSION_ENABLED;

    const config = getSourcingConfig();
    expect(config.publicMemoryHydrationEnabled).toBe(false);
    expect(config.platformExclusionEnabled).toBe(false);
  });

  it("does not implicitly enable one public surface from the other", () => {
    process.env.SOURCE_PUBLIC_MEMORY_HYDRATION_ENABLED = "true";
    process.env.SOURCE_PLATFORM_EXCLUSION_ENABLED = "false";
    expect(getSourcingConfig()).toMatchObject({
      publicMemoryHydrationEnabled: true,
      platformExclusionEnabled: false,
    });

    process.env.SOURCE_PUBLIC_MEMORY_HYDRATION_ENABLED = "false";
    process.env.SOURCE_PLATFORM_EXCLUSION_ENABLED = "true";
    expect(getSourcingConfig()).toMatchObject({
      publicMemoryHydrationEnabled: false,
      platformExclusionEnabled: true,
    });
  });
});
