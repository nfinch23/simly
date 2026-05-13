import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergePairResults,
  planRingScan,
  poolSignature,
  selectTopRings,
  TOP_RINGS_TO_KEEP,
  RingCacheStore,
  type RingCacheEntry,
} from './ring-cache';
import { makeItemIdentity, type ParsedItem } from './simc-export-parser';
import type { RingPairResult } from '@simly/shared';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'simly-ring-cache-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshStore(): RingCacheStore {
  return new RingCacheStore({ cwd: tmp, name: `r-${Math.random().toString(36).slice(2)}` });
}

function fakeRing(item_id: number, ilvl = 272): ParsedItem {
  return {
    slot: 'finger1',
    item_id,
    name: `R${item_id}`,
    ilvl,
    bonus_ids: [],
    is_equipped: false,
    identity: makeItemIdentity(item_id, [], undefined),
    extras: {},
  };
}

function fakePair(
  a: ParsedItem,
  b: ParsedItem,
  mean_dps: number,
): RingPairResult {
  const id = [a.identity, b.identity].sort().join('|');
  return {
    pair_id: `r_${id.slice(0, 12)}`,
    finger1: { item_id: a.item_id, name: a.name, ilvl: a.ilvl, identity: a.identity },
    finger2: { item_id: b.item_id, name: b.name, ilvl: b.ilvl, identity: b.identity },
    mean_dps,
    delta_pct: 0,
  };
}

describe('poolSignature', () => {
  it('is stable regardless of input order', () => {
    const A = fakeRing(1);
    const B = fakeRing(2);
    const C = fakeRing(3);
    expect(poolSignature([A, B, C])).toBe(poolSignature([C, B, A]));
  });

  it('changes when a new ring is added', () => {
    const A = fakeRing(1);
    const B = fakeRing(2);
    const C = fakeRing(3);
    expect(poolSignature([A, B])).not.toBe(poolSignature([A, B, C]));
  });
});

describe('selectTopRings', () => {
  it('returns the top N rings by best pair appearance', () => {
    const A = fakeRing(1);
    const B = fakeRing(2);
    const C = fakeRing(3);
    const D = fakeRing(4);
    const E = fakeRing(5);
    const F = fakeRing(6);
    const pairs = [
      fakePair(A, B, 120_000),
      fakePair(C, E, 110_000),
      fakePair(D, F, 100_000),
      fakePair(A, C, 95_000),
    ];
    const top = selectTopRings(pairs, 4);
    expect(top).toHaveLength(4);
    expect(top).toContain(A.identity);
    expect(top).toContain(B.identity);
    expect(top).toContain(C.identity);
    expect(top).toContain(E.identity);
    expect(top).not.toContain(D.identity);
    expect(top).not.toContain(F.identity);
  });

  it('respects a custom N', () => {
    const A = fakeRing(1);
    const B = fakeRing(2);
    const C = fakeRing(3);
    expect(selectTopRings([fakePair(A, B, 100), fakePair(B, C, 90)], 2)).toHaveLength(2);
  });

  it('TOP_RINGS_TO_KEEP defaults to 4', () => {
    expect(TOP_RINGS_TO_KEEP).toBe(4);
  });
});

describe('RingCacheStore', () => {
  it('stores and retrieves entries by character_key + scenario', () => {
    const store = freshStore();
    const entry: RingCacheEntry = {
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      pool_signature: 'sig-1',
      pairs: [],
      top_ring_identities: ['x', 'y'],
      last_simmed_at: 1000,
    };
    store.put(entry);
    expect(store.get('F-S-us', 'single_target_patchwerk')).toEqual(entry);
    expect(store.get('OTHER', 'single_target_patchwerk')).toBeUndefined();
  });

  it('overwrites on put', () => {
    const store = freshStore();
    const base = {
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      pairs: [],
      top_ring_identities: [],
      last_simmed_at: 1,
    };
    store.put({ ...base, pool_signature: 'sig-old' });
    store.put({ ...base, pool_signature: 'sig-new', last_simmed_at: 2 });
    expect(store.get('F-S-us', 'single_target_patchwerk')?.pool_signature).toBe('sig-new');
  });

  it('clear() empties the store', () => {
    const store = freshStore();
    store.put({
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      pool_signature: 's',
      pairs: [],
      top_ring_identities: [],
      last_simmed_at: 1,
    });
    store.clear();
    expect(store.get('F-S-us', 'single_target_patchwerk')).toBeUndefined();
  });
});

describe('planRingScan', () => {
  const character_key = 'F-S-us';
  const scenario = 'single_target_patchwerk';

  it('returns full when fewer than 2 rings', () => {
    const store = freshStore();
    const plan = planRingScan({
      rings: [fakeRing(1)],
      cache: store,
      character_key,
      scenario,
    });
    expect(plan.kind).toBe('full');
  });

  it('returns full when no cache entry exists', () => {
    const store = freshStore();
    const plan = planRingScan({
      rings: [fakeRing(1), fakeRing(2)],
      cache: store,
      character_key,
      scenario,
    });
    expect(plan.kind).toBe('full');
    if (plan.kind === 'full') expect(plan.reason).toMatch(/no cache/);
  });

  it('returns reuse when pool signature matches cache', () => {
    const store = freshStore();
    const A = fakeRing(1);
    const B = fakeRing(2);
    const pairs = [fakePair(A, B, 100_000)];
    store.put({
      character_key,
      scenario,
      pool_signature: poolSignature([A, B]),
      pairs,
      top_ring_identities: [A.identity, B.identity],
      last_simmed_at: 1,
    });
    const plan = planRingScan({ rings: [A, B], cache: store, character_key, scenario });
    expect(plan.kind).toBe('reuse');
    if (plan.kind === 'reuse') {
      expect(plan.result.pairs).toEqual(pairs);
      expect(plan.result.winner).toEqual(pairs[0]);
    }
  });

  it('returns full when a cached top ring disappeared', () => {
    const store = freshStore();
    const A = fakeRing(1);
    const B = fakeRing(2);
    const C = fakeRing(3);
    store.put({
      character_key,
      scenario,
      pool_signature: poolSignature([A, B, C]),
      pairs: [fakePair(A, B, 100_000)],
      top_ring_identities: [A.identity, B.identity, C.identity],
      last_simmed_at: 1,
    });
    const plan = planRingScan({ rings: [A, B], cache: store, character_key, scenario });
    expect(plan.kind).toBe('full');
    if (plan.kind === 'full') expect(plan.reason).toMatch(/no longer in pool/);
  });

  it('returns incremental when one new ring arrives, simming only new × cached-top', () => {
    const store = freshStore();
    const A = fakeRing(1);
    const B = fakeRing(2);
    const C = fakeRing(3);
    const cached = [fakePair(A, B, 100_000)];
    store.put({
      character_key,
      scenario,
      pool_signature: poolSignature([A, B]),
      pairs: cached,
      top_ring_identities: [A.identity, B.identity],
      last_simmed_at: 1,
    });
    const plan = planRingScan({
      rings: [A, B, C],
      cache: store,
      character_key,
      scenario,
    });
    expect(plan.kind).toBe('incremental');
    if (plan.kind === 'incremental') {
      expect(plan.newRings.map((r) => r.item_id)).toEqual([3]);
      expect(plan.cachedTop.map((r) => r.item_id).sort()).toEqual([1, 2]);
      expect(plan.pairsToSim).toHaveLength(2);
      const containsC = plan.pairsToSim.every(
        (p) => p[0].item_id === 3 || p[1].item_id === 3,
      );
      expect(containsC).toBe(true);
    }
  });

  it('returns incremental for multiple new rings, simming new×top + new×new', () => {
    const store = freshStore();
    const A = fakeRing(1);
    const B = fakeRing(2);
    const C = fakeRing(3);
    const D = fakeRing(4);
    store.put({
      character_key,
      scenario,
      pool_signature: poolSignature([A, B]),
      pairs: [fakePair(A, B, 100_000)],
      top_ring_identities: [A.identity, B.identity],
      last_simmed_at: 1,
    });
    const plan = planRingScan({
      rings: [A, B, C, D],
      cache: store,
      character_key,
      scenario,
    });
    expect(plan.kind).toBe('incremental');
    if (plan.kind === 'incremental') {
      expect(plan.pairsToSim).toHaveLength(5);
    }
  });

  it('returns reuse when pool only shrank (no new rings, no top vanished)', () => {
    const store = freshStore();
    const A = fakeRing(1);
    const B = fakeRing(2);
    const C = fakeRing(3);
    store.put({
      character_key,
      scenario,
      pool_signature: poolSignature([A, B, C]),
      pairs: [fakePair(A, B, 100_000), fakePair(A, C, 90_000), fakePair(B, C, 85_000)],
      top_ring_identities: [A.identity, B.identity],
      last_simmed_at: 1,
    });
    const plan = planRingScan({
      rings: [A, B],
      cache: store,
      character_key,
      scenario,
    });
    expect(plan.kind).toBe('reuse');
    if (plan.kind === 'reuse') {
      expect(plan.result.pairs).toHaveLength(1);
      expect([1, 2]).toContain(plan.result.winner?.finger1.item_id);
    }
  });
});

describe('mergePairResults', () => {
  it('combines cached + fresh pairs, sorts desc, computes delta_pct vs winner', () => {
    const A = fakeRing(1);
    const B = fakeRing(2);
    const C = fakeRing(3);
    const cached = [fakePair(A, B, 100_000)];
    const fresh = [fakePair(A, C, 110_000), fakePair(B, C, 95_000)];
    const ids = new Set([A.identity, B.identity, C.identity]);
    const merged = mergePairResults(cached, fresh, ids);
    expect(merged).toHaveLength(3);
    expect(merged[0]!.mean_dps).toBe(110_000);
    expect(merged[0]!.delta_pct).toBe(0);
    expect(merged[1]!.mean_dps).toBe(100_000);
    expect(merged[1]!.delta_pct).toBeLessThan(0);
  });

  it('drops pairs whose rings are no longer in the current pool', () => {
    const A = fakeRing(1);
    const B = fakeRing(2);
    const C = fakeRing(3);
    const cached = [fakePair(A, B, 100_000), fakePair(B, C, 90_000)];
    const merged = mergePairResults(cached, [], new Set([A.identity, B.identity]));
    expect(merged).toHaveLength(1);
  });

  it('fresh pairs override cached on duplicate pair_id', () => {
    const A = fakeRing(1);
    const B = fakeRing(2);
    const stale = fakePair(A, B, 50_000);
    const fresh = { ...fakePair(A, B, 200_000), pair_id: stale.pair_id };
    const merged = mergePairResults([stale], [fresh], new Set([A.identity, B.identity]));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.mean_dps).toBe(200_000);
  });
});
