import { describe, expect, it } from 'vitest';
import {
  candidatesNotInLoadout,
  filterTrashFromBag,
  loadoutToBestLoadout,
  runGreedyGearSearch,
  selectBestUpgrade,
  type SwapTestRunner,
} from './greedy-search';
import type { ParsedItem, SlotName } from '../simc-export-parser';
import type { SwapResult, SwapTestResult } from '../swap-test';
import type { GearCatalogEntry } from '../gear-catalog';

function makeItem(opts: {
  slot: SlotName;
  identity: string;
  name?: string;
  ilvl?: number;
  item_id?: number;
}): ParsedItem {
  return {
    slot: opts.slot,
    item_id: opts.item_id ?? 1,
    name: opts.name ?? `Item ${opts.identity}`,
    ilvl: opts.ilvl ?? 270,
    bonus_ids: [],
    is_equipped: false,
    identity: opts.identity,
    extras: {},
  };
}

function makeSwapResult(opts: {
  slot: string;
  identity: string;
  delta_pct: number;
  ilvl?: number;
  mean_dps?: number;
}): SwapResult {
  return {
    slot: opts.slot,
    item: { item_id: 1, name: `Item ${opts.identity}`, identity: opts.identity, ilvl: opts.ilvl ?? 270 },
    delta_pct: opts.delta_pct,
    mean_dps: opts.mean_dps ?? 100_000 * (1 + opts.delta_pct / 100),
    is_upgrade: opts.delta_pct > 0.1,
    position_deltas: [{ position_slot: opts.slot, delta_pct: opts.delta_pct, mean_dps: opts.mean_dps ?? 100_000 }],
  };
}

describe('candidatesNotInLoadout', () => {
  it('drops bag items already in loadout (matched by identity)', () => {
    const equipped = makeItem({ slot: 'chest', identity: 'A' });
    const loadout = { chest: equipped };
    const bag = [
      makeItem({ slot: 'chest', identity: 'A' }),
      makeItem({ slot: 'chest', identity: 'B' }),
    ];
    const out = candidatesNotInLoadout(bag, loadout);
    expect(out).toHaveLength(1);
    expect(out[0]!.identity).toBe('B');
  });
});

describe('selectBestUpgrade', () => {
  it('returns the highest delta_pct upgrade above tie window', () => {
    const results = [
      makeSwapResult({ slot: 'chest', identity: 'A', delta_pct: 0.5 }),
      makeSwapResult({ slot: 'legs', identity: 'B', delta_pct: 2.4 }),
      makeSwapResult({ slot: 'gloves', identity: 'C', delta_pct: 1.1 }),
    ];
    const best = selectBestUpgrade(results, 0.1);
    expect(best?.item.identity).toBe('B');
  });

  it('returns null when no candidate beats the tie window', () => {
    const results = [
      makeSwapResult({ slot: 'chest', identity: 'A', delta_pct: 0.05 }),
      makeSwapResult({ slot: 'legs', identity: 'B', delta_pct: -0.5 }),
    ];
    expect(selectBestUpgrade(results, 0.1)).toBeNull();
  });

  it('treats exactly-tie-window as not-an-upgrade', () => {
    const results = [
      makeSwapResult({ slot: 'chest', identity: 'A', delta_pct: 0.1 }),
    ];
    expect(selectBestUpgrade(results, 0.1)).toBeNull();
  });
});

describe('loadoutToBestLoadout', () => {
  it('converts a per-slot ParsedItem map into BestLoadoutSlot shape', () => {
    const loadout = {
      chest: makeItem({ slot: 'chest', identity: 'A', name: 'Aegis', ilvl: 280 }),
      legs: makeItem({ slot: 'legs', identity: 'B', name: 'Greaves', ilvl: 275 }),
    };
    const out = loadoutToBestLoadout(loadout);
    expect(out['chest']).toEqual({
      slot: 'chest',
      item_id: 1,
      name: 'Aegis',
      identity: 'A',
      ilvl: 280,
    });
    expect(out['legs']!.identity).toBe('B');
  });
});

describe('filterTrashFromBag', () => {
  it('keeps everything when no catalog provided', () => {
    const bag = [makeItem({ slot: 'chest', identity: 'A' })];
    expect(filterTrashFromBag(bag, undefined)).toHaveLength(1);
  });

  it('drops items the catalog has marked trash', () => {
    const bag = [
      makeItem({ slot: 'chest', identity: 'A' }),
      makeItem({ slot: 'chest', identity: 'B' }),
    ];
    const catalog: GearCatalogEntry = {
      character_key: 'X', scenario: 'single_target_patchwerk',
      best_loadout: {},
      seen_items: {
        A: {
          identity: 'A', item_id: 1, name: 'A', slot: 'chest', ilvl: 270,
          status: 'trash', best_delta_pct: -10, times_simmed: 3, last_simmed_at: 0,
        },
      },
      last_pool_signature: '', last_full_sim_at: 0, best_ilvl_by_slot: {},
    };
    const out = filterTrashFromBag(bag, catalog);
    expect(out.map((i) => i.identity)).toEqual(['B']);
  });

  it('keeps items the catalog has classified non-trash', () => {
    const bag = [makeItem({ slot: 'chest', identity: 'A' })];
    const catalog: GearCatalogEntry = {
      character_key: 'X', scenario: 'single_target_patchwerk',
      best_loadout: {},
      seen_items: {
        A: {
          identity: 'A', item_id: 1, name: 'A', slot: 'chest', ilvl: 270,
          status: 'good', best_delta_pct: -1, times_simmed: 1, last_simmed_at: 0,
        },
      },
      last_pool_signature: '', last_full_sim_at: 0, best_ilvl_by_slot: {},
    };
    expect(filterTrashFromBag(bag, catalog)).toHaveLength(1);
  });
});

describe('runGreedyGearSearch', () => {
  it('converges immediately when no upgrades exist', async () => {
    const equipped = makeItem({ slot: 'chest', identity: 'EQ', ilvl: 290 });
    const bag = [makeItem({ slot: 'chest', identity: 'B', ilvl: 270 })];
    const runSwapTest: SwapTestRunner = async () => ({
      baseline_dps: 100_000,
      results: [makeSwapResult({ slot: 'chest', identity: 'B', delta_pct: -1.5 })],
      any_upgrade: false,
    });

    const out = await runGreedyGearSearch({
      initialLoadout: { chest: equipped },
      bagItems: bag,
      dpsPerIlvlPct: 0.3,
      runSwapTest,
    });

    expect(out.iterations).toBe(1);
    expect(out.converged['chest']!.identity).toBe('EQ');
    expect(out.rejected.map((i) => i.identity)).toEqual(['B']);
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0]!.outcome).toBe('rejected');
  });

  it('folds the best upgrade in across iterations until convergence', async () => {
    const equipped = makeItem({ slot: 'chest', identity: 'EQ', ilvl: 270 });
    const bag = [
      makeItem({ slot: 'chest', identity: 'A', ilvl: 280 }),
      makeItem({ slot: 'chest', identity: 'B', ilvl: 275 }),
    ];

    let call = 0;
    const runSwapTest: SwapTestRunner = async (args) => {
      call += 1;
      if (call === 1) {
        // Iter 1: equipped chest. A is the bigger upgrade.
        expect(args.newItems).toHaveLength(2);
        return {
          baseline_dps: 100_000,
          results: [
            makeSwapResult({ slot: 'chest', identity: 'A', delta_pct: 3.0, ilvl: 280 }),
            makeSwapResult({ slot: 'chest', identity: 'B', delta_pct: 1.5, ilvl: 275 }),
          ],
          any_upgrade: true,
        };
      }
      if (call === 2) {
        // Iter 2: chest=A. B should compete against A — loses.
        expect(args.newItems).toHaveLength(1); // A is now in loadout, only B remains
        expect(args.newItems[0]!.identity).toBe('B');
        return {
          baseline_dps: 103_000,
          results: [
            makeSwapResult({ slot: 'chest', identity: 'B', delta_pct: -1.0, ilvl: 275 }),
          ],
          any_upgrade: false,
        };
      }
      throw new Error(`unexpected iter ${call}`);
    };

    const out = await runGreedyGearSearch({
      initialLoadout: { chest: equipped },
      bagItems: bag,
      dpsPerIlvlPct: 0.3,
      runSwapTest,
    });

    expect(out.iterations).toBe(2);
    expect(out.converged['chest']!.identity).toBe('A');
    expect(out.rejected.map((i) => i.identity)).toEqual(['B']);
    // Diagnostics: 2 from iter 1 (A=accepted, B=rejected) + 1 from iter 2 (B=rejected) = 3.
    expect(out.diagnostics).toHaveLength(3);
    const accepted = out.diagnostics.filter((d) => d.outcome === 'accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.label).toContain('A');
  });

  it('respects maxIterations cap (defends against runaway loops)', async () => {
    const equipped = makeItem({ slot: 'chest', identity: 'EQ', ilvl: 270 });
    // Always returns "yes upgrade" — would loop forever without the cap.
    const bag = [
      makeItem({ slot: 'chest', identity: 'A', ilvl: 280 }),
      makeItem({ slot: 'chest', identity: 'B', ilvl: 280 }),
    ];
    const runSwapTest: SwapTestRunner = async (args) => ({
      baseline_dps: 100_000,
      results: args.newItems.map((i) =>
        makeSwapResult({ slot: i.slot, identity: i.identity, delta_pct: 1.0 }),
      ),
      any_upgrade: true,
    });

    const out = await runGreedyGearSearch({
      initialLoadout: { chest: equipped },
      bagItems: bag,
      dpsPerIlvlPct: 0.3,
      maxIterations: 3,
      runSwapTest,
    });

    expect(out.hitIterationCap).toBe(true);
    expect(out.iterations).toBe(3);
  });

  it('stops cleanly when bag is empty (no candidates after filter)', async () => {
    const equipped = makeItem({ slot: 'chest', identity: 'EQ' });
    const runSwapTest: SwapTestRunner = async () => {
      throw new Error('runSwapTest should not be called when bag is empty');
    };
    const out = await runGreedyGearSearch({
      initialLoadout: { chest: equipped },
      bagItems: [],
      dpsPerIlvlPct: 0.3,
      runSwapTest,
    });
    expect(out.iterations).toBe(1); // entered loop once, found no candidates, exited
    expect(out.converged['chest']!.identity).toBe('EQ');
    expect(out.rejected).toEqual([]);
  });
});
