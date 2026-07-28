import { afterEach, describe, expect, it } from 'vitest';
import { getSourcingConfig } from '../config';
import {
  buildLayer1SlugIndex,
  selectTwoLayerCandidateIds,
  type SlimPoolCandidate,
} from '../two-layer-pool';

const pool: SlimPoolCandidate[] = [
  { id: 'local-alice', linkedinId: 'Alice-Case', linkedinUrl: 'https://www.linkedin.com/in/Alice-Case' },
  { id: 'local-bravo', linkedinId: 'bravo', linkedinUrl: 'https://www.linkedin.com/in/bravo' },
  { id: 'local-charlie', linkedinId: 'charlie', linkedinUrl: 'https://www.linkedin.com/in/charlie' },
];

const originalTwoLayerFlag = process.env.SOURCE_TWO_LAYER_POOL_ENABLED;

afterEach(() => {
  if (originalTwoLayerFlag === undefined) delete process.env.SOURCE_TWO_LAYER_POOL_ENABLED;
  else process.env.SOURCE_TWO_LAYER_POOL_ENABLED = originalTwoLayerFlag;
});

describe('two-layer pool selection', () => {
  it('honors the feature flag', () => {
    process.env.SOURCE_TWO_LAYER_POOL_ENABLED = 'false';
    expect(getSourcingConfig().twoLayerPoolEnabled).toBe(false);

    process.env.SOURCE_TWO_LAYER_POOL_ENABLED = 'true';
    expect(getSourcingConfig().twoLayerPoolEnabled).toBe(true);
  });

  it('resolves vector identities against Layer 1 and adds the recent embedding-lag lane', () => {
    const selection = selectTwoLayerCandidateIds({
      slimPool: pool,
      slimBySlug: buildLayer1SlugIndex(pool),
      vectorResults: [
        { linkedin_id: '', linkedin_url: 'https://www.linkedin.com/in/alice-case/' },
        { linkedin_id: null, linkedin_url: 'https://www.linkedin.com/in/bravo/' },
      ],
      recentK: 2,
      fallbackHydrateCap: 10,
    });

    expect(selection.vectorLaneResolved).toBe(2);
    expect(selection.recentLaneAdded).toBe(0);
    expect(selection.fallbackHydrateUsed).toBe(false);
    expect([...selection.ids]).toEqual(['local-alice', 'local-bravo']);
  });

  it('preserves the Layer-1 canonical ID for fresh entries with different LinkedIn casing', () => {
    const selection = selectTwoLayerCandidateIds({
      slimPool: pool,
      slimBySlug: buildLayer1SlugIndex(pool),
      vectorResults: [{ linkedin_id: 'ALICE-CASE', linkedin_url: null }],
      recentK: 0,
      fallbackHydrateCap: 10,
    });

    expect(selection.ids).toEqual(new Set(['local-alice']));
  });

  it('hydrates candidates resolved by canonical Memory link before the recent lane', () => {
    const selection = selectTwoLayerCandidateIds({
      slimPool: pool,
      slimBySlug: buildLayer1SlugIndex(pool),
      vectorResults: [
        {
          id: 'global-charlie',
          linkedin_id: null,
          linkedin_url: null,
        },
      ],
      resolvedVectorIdByGlobalId: new Map([
        ['global-charlie', 'local-charlie'],
      ]),
      recentK: 1,
      fallbackHydrateCap: 10,
    });

    expect(selection.vectorLaneResolved).toBe(1);
    expect(selection.recentLaneAdded).toBe(1);
    expect([...selection.ids]).toEqual(['local-charlie', 'local-alice']);
  });

  it('lets the canonical global link win over a conflicting LinkedIn slug', () => {
    const selection = selectTwoLayerCandidateIds({
      slimPool: pool,
      slimBySlug: buildLayer1SlugIndex(pool),
      vectorResults: [
        {
          id: 'global-alice',
          linkedin_id: 'bravo',
          linkedin_url: null,
        },
      ],
      resolvedVectorIdByGlobalId: new Map([
        ['global-alice', 'local-alice'],
      ]),
      recentK: 0,
      fallbackHydrateCap: 10,
    });

    expect([...selection.ids]).toEqual(['local-alice']);
  });

  it('fails open to bounded recency hydration when Memory is unavailable', () => {
    const selection = selectTwoLayerCandidateIds({
      slimPool: pool,
      slimBySlug: buildLayer1SlugIndex(pool),
      vectorResults: null,
      recentK: 2,
      fallbackHydrateCap: 2,
    });

    expect(selection.fallbackHydrateUsed).toBe(true);
    expect(selection.vectorLaneResolved).toBe(0);
    expect(selection.recentLaneAdded).toBe(0);
    expect([...selection.ids]).toEqual(['local-alice', 'local-bravo']);
  });

  it('keeps Layer-1 membership available even when a candidate is outside Layer 2', () => {
    const layer1Membership = buildLayer1SlugIndex(pool);
    const selection = selectTwoLayerCandidateIds({
      slimPool: pool,
      slimBySlug: layer1Membership,
      vectorResults: [{ linkedin_id: 'alice-case', linkedin_url: null }],
      recentK: 0,
      fallbackHydrateCap: 10,
    });

    expect(selection.ids.has('local-charlie')).toBe(false);
    expect(layer1Membership.get('charlie')).toBe('local-charlie');
  });
});
