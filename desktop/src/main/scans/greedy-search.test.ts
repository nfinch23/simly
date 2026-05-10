import { describe, expect, it } from 'vitest';
import {
  candidatesNotInLoadout,
  filterTrashFromBag,
  loadoutToBestLoadout,
  preFilterCandidates,
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
  raw_stats?: ParsedItem['raw_stats'];
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
    ...(opts.raw_stats ? { raw_stats: opts.raw_stats } : {}),
  };
}

function rawStats(opts: Partial<NonNullable<ParsedItem['raw_stats']>>): NonNullable<ParsedItem['raw_stats']> {
  return {
    intellect: opts.intellect ?? 0,
    strength: opts.strength ?? 0,
    agility: opts.agility ?? 0,
    haste_rating: opts.haste_rating ?? 0,
    crit_rating: opts.crit_rating ?? 0,
    mastery_rating: opts.mastery_rating ?? 0,
    versatility_rating: opts.versatility_rating ?? 0,
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

describe('preFilterCandidates', () => {
  it('keeps candidates whose predicted delta is above the hard floor', () => {
    // 285 vs 270 incumbent = +15 ilvl × 0.3 = +4.5%. Above -3%.
    const r = preFilterCandidates({
      candidates: [makeItem({ slot: 'chest', identity: 'A', ilvl: 285 })],
      loadout: { chest: makeItem({ slot: 'chest', identity: 'EQ', ilvl: 270 }) },
      dpsPerIlvlPct: 0.3,
      hardFloorPct: 3.0,
    });
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it('drops candidates predicted to lose by more than the hard floor', () => {
    // 250 vs 290 incumbent = -40 ilvl × 0.3 = -12%. Below -3% → drop.
    const r = preFilterCandidates({
      candidates: [makeItem({ slot: 'chest', identity: 'B', ilvl: 250 })],
      loadout: { chest: makeItem({ slot: 'chest', identity: 'EQ', ilvl: 290 }) },
      dpsPerIlvlPct: 0.3,
      hardFloorPct: 3.0,
    });
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.predictedPct).toBeCloseTo(-12, 1);
  });

  it('disables the filter when dpsPerIlvlPct is 0 (no stat weights yet)', () => {
    const r = preFilterCandidates({
      candidates: [
        makeItem({ slot: 'chest', identity: 'A', ilvl: 100 }),
        makeItem({ slot: 'chest', identity: 'B', ilvl: 280 }),
      ],
      loadout: { chest: makeItem({ slot: 'chest', identity: 'EQ', ilvl: 290 }) },
      dpsPerIlvlPct: 0,
    });
    expect(r.kept).toHaveLength(2);
    expect(r.dropped).toHaveLength(0);
  });

  it('keeps a candidate for an empty slot unconditionally', () => {
    const r = preFilterCandidates({
      candidates: [makeItem({ slot: 'chest', identity: 'A', ilvl: 100 })],
      loadout: {}, // no incumbent in chest
      dpsPerIlvlPct: 0.3,
      hardFloorPct: 3.0,
    });
    expect(r.kept).toHaveLength(1);
  });

  it('uses the worse-ilvl finger as the bar for ring candidates', () => {
    // f1=290, f2=270. Worse bar = 270. Candidate 280 → +10 ilvl × 0.3 = +3% above floor → kept.
    const loadout = {
      finger1: makeItem({ slot: 'finger1', identity: 'F1', ilvl: 290 }),
      finger2: makeItem({ slot: 'finger2', identity: 'F2', ilvl: 270 }),
    };
    const r = preFilterCandidates({
      candidates: [makeItem({ slot: 'finger1', identity: 'NEW', ilvl: 280 })],
      loadout,
      dpsPerIlvlPct: 0.3,
      hardFloorPct: 3.0,
    });
    expect(r.kept).toHaveLength(1);
  });

  it('drops a ring candidate that loses to BOTH finger positions by hard floor', () => {
    const loadout = {
      finger1: makeItem({ slot: 'finger1', identity: 'F1', ilvl: 290 }),
      finger2: makeItem({ slot: 'finger2', identity: 'F2', ilvl: 285 }),
    };
    const r = preFilterCandidates({
      candidates: [makeItem({ slot: 'finger1', identity: 'NEW', ilvl: 250 })],
      loadout,
      dpsPerIlvlPct: 0.3,
      hardFloorPct: 3.0,
    });
    expect(r.dropped).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Stat-vector mode (precise prediction from per-item raw_stats)
  // -------------------------------------------------------------------------

  it('uses stat-vector prediction when raw_stats + statWeights + baselineDps all available', () => {
    // Candidate has BAD secondaries despite higher ilvl; ilvl-proxy would keep
    // it but stat-vector correctly predicts a loss.
    // Δint = +5, Δhaste = -200 (loses 200 haste rating)
    // weights: int=33, haste=15
    // predicted_dps = 5*33 + (-200)*15 = 165 - 3000 = -2835
    // baselineDps = 70000 → pct = -4.05% → BELOW -3% floor → drop.
    const r = preFilterCandidates({
      candidates: [
        makeItem({
          slot: 'chest', identity: 'BAD', ilvl: 285,
          raw_stats: rawStats({ intellect: 235, haste_rating: 100 }),
        }),
      ],
      loadout: {
        chest: makeItem({
          slot: 'chest', identity: 'EQ', ilvl: 270,
          raw_stats: rawStats({ intellect: 230, haste_rating: 300 }),
        }),
      },
      dpsPerIlvlPct: 0.3, // ilvl proxy would predict +4.5% (false positive)
      hardFloorPct: 3.0,
      statWeights: { intellect: 33, haste: 15 },
      baselineDps: 70_000,
    });
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.source).toBe('stat-vector');
    expect(r.dropped[0]!.predictedPct).toBeCloseTo(-4.05, 1);
  });

  it('keeps a low-ilvl candidate that ilvl-proxy would wrongly drop (good secondaries)', () => {
    // ilvl 250 vs 290 incumbent (-40 ilvl × 0.3 = -12% via ilvl proxy → would drop)
    // BUT the candidate has way more haste at the right stat.
    // Δint = -5, Δhaste = +500 (huge stat upgrade)
    // weights: int=33, haste=15
    // predicted_dps = -5*33 + 500*15 = -165 + 7500 = +7335
    // baselineDps=70k → pct = +10.48% → KEEP (ilvl proxy would have dropped).
    const r = preFilterCandidates({
      candidates: [
        makeItem({
          slot: 'chest', identity: 'GOOD', ilvl: 250,
          raw_stats: rawStats({ intellect: 200, haste_rating: 800 }),
        }),
      ],
      loadout: {
        chest: makeItem({
          slot: 'chest', identity: 'EQ', ilvl: 290,
          raw_stats: rawStats({ intellect: 205, haste_rating: 300 }),
        }),
      },
      dpsPerIlvlPct: 0.3,
      hardFloorPct: 3.0,
      statWeights: { intellect: 33, haste: 15 },
      baselineDps: 70_000,
    });
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toEqual([]);
  });

  it('falls back to ilvl-proxy when candidate raw_stats are missing', () => {
    // Candidate has no raw_stats — fall back to ilvl proxy.
    // 250 vs 290 = -40 ilvl × 0.3 = -12% → drop via ilvl-proxy.
    const r = preFilterCandidates({
      candidates: [makeItem({ slot: 'chest', identity: 'B', ilvl: 250 })],
      loadout: {
        chest: makeItem({
          slot: 'chest', identity: 'EQ', ilvl: 290,
          raw_stats: rawStats({ intellect: 230, haste_rating: 300 }),
        }),
      },
      dpsPerIlvlPct: 0.3,
      hardFloorPct: 3.0,
      statWeights: { intellect: 33, haste: 15 },
      baselineDps: 70_000,
    });
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.source).toBe('ilvl');
  });

  it('falls back to ilvl-proxy when statWeights is omitted', () => {
    const r = preFilterCandidates({
      candidates: [
        makeItem({
          slot: 'chest', identity: 'B', ilvl: 250,
          raw_stats: rawStats({ intellect: 200 }),
        }),
      ],
      loadout: {
        chest: makeItem({
          slot: 'chest', identity: 'EQ', ilvl: 290,
          raw_stats: rawStats({ intellect: 230 }),
        }),
      },
      dpsPerIlvlPct: 0.3,
      hardFloorPct: 3.0,
      // no statWeights, no baselineDps
    });
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.source).toBe('ilvl');
  });

  it('keeps stat-vector mode active even when dpsPerIlvlPct is 0 (no calibration but raw_stats available)', () => {
    // dpsPerIlvlPct=0 alone would disable filter (legacy guard), but with
    // statWeights+raw_stats we have a precise prediction so the filter stays on.
    const r = preFilterCandidates({
      candidates: [
        makeItem({
          slot: 'chest', identity: 'BAD', ilvl: 250,
          raw_stats: rawStats({ intellect: 50, haste_rating: 50 }),
        }),
      ],
      loadout: {
        chest: makeItem({
          slot: 'chest', identity: 'EQ', ilvl: 290,
          raw_stats: rawStats({ intellect: 250, haste_rating: 300 }),
        }),
      },
      dpsPerIlvlPct: 0,
      hardFloorPct: 3.0,
      statWeights: { intellect: 33, haste: 15 },
      baselineDps: 70_000,
    });
    // Δint=-200, Δhaste=-250. predicted = -200*33 + -250*15 = -6600 - 3750 = -10350.
    // pct = -14.79% → drop via stat-vector.
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.source).toBe('stat-vector');
  });

  it('ring stat-vector: keeps candidate that wins against the WORSE finger position', () => {
    // f1 has 300 haste, f2 has 100 haste. Candidate has 200 haste.
    // vs f1: Δhaste = -100, predicted = -100*15 = -1500 dps = -2.14% (above floor)
    // vs f2: Δhaste = +100, predicted = +100*15 = +1500 dps = +2.14% (clearly upgrade-ish)
    // Best of two = +2.14%. Above -3% floor → keep.
    const r = preFilterCandidates({
      candidates: [
        makeItem({
          slot: 'finger1', identity: 'NEW', ilvl: 280,
          raw_stats: rawStats({ haste_rating: 200 }),
        }),
      ],
      loadout: {
        finger1: makeItem({
          slot: 'finger1', identity: 'F1', ilvl: 280,
          raw_stats: rawStats({ haste_rating: 300 }),
        }),
        finger2: makeItem({
          slot: 'finger2', identity: 'F2', ilvl: 280,
          raw_stats: rawStats({ haste_rating: 100 }),
        }),
      },
      dpsPerIlvlPct: 0.3,
      hardFloorPct: 3.0,
      statWeights: { haste: 15 },
      baselineDps: 70_000,
    });
    expect(r.kept).toHaveLength(1);
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
