import { describe, expect, it } from 'vitest';
import {
  composeFromConsumableScans,
  composeFromScans,
  deriveGearFromCatalog,
  refreshScanTimestamps,
  synthesizeResultsFromCatalog,
} from './composer';
import type {
  BestFlaskResult,
  BestFoodResult,
  GearScanResult,
  ScanCollection,
} from '@simly/shared';
import type { GearCatalogEntry } from './gear-catalog';

function fakeFlaskResult(name: string, dps: number, item_id = 0): BestFlaskResult {
  return {
    label: 'Best flask',
    best: { item_id, name, dps },
    alternatives: [],
  };
}

function fakeFoodResult(name: string, dps: number, item_id = 0): BestFoodResult {
  return {
    label: 'Best food',
    best: { item_id, name, dps },
    alternatives: [],
  };
}

function fakeGearScan(opts: {
  winner_dps: number;
  items: Array<{ slot: string; item_id: number; name: string; ilvl: number }>;
}): GearScanResult {
  return {
    label: 'Test scan',
    iterations: 1000,
    total_combos: 1,
    combos: [
      {
        combo_id: 'g_0000',
        items: opts.items.map((i) => ({
          slot: i.slot,
          item: { item_id: i.item_id, name: i.name, ilvl: i.ilvl, identity: `${i.item_id}::` },
        })),
        mean_dps: opts.winner_dps,
        delta_pct: 0,
      },
    ],
    winner: {
      combo_id: 'g_0000',
      items: opts.items.map((i) => ({
        slot: i.slot,
        item: { item_id: i.item_id, name: i.name, ilvl: i.ilvl, identity: `${i.item_id}::` },
      })),
      mean_dps: opts.winner_dps,
      delta_pct: 0,
    },
  };
}

function fakeCatalog(opts?: { dps?: number; slots?: Record<string, { item_id: number; name: string; ilvl: number }> }): GearCatalogEntry {
  return {
    character_key: 'F-S-us',
    scenario: 'single_target_patchwerk',
    best_loadout: opts?.slots
      ? Object.fromEntries(
          Object.entries(opts.slots).map(([slot, info]) => [
            slot,
            { slot, ...info, identity: `${info.item_id}::`, combo_mean_dps: opts.dps },
          ]),
        )
      : {},
    best_loadout_dps: opts?.dps,
    seen_items: {},
    last_pool_signature: 'sig',
    last_full_sim_at: 1,
  };
}

describe('refreshScanTimestamps', () => {
  it('marks pending records as done with the new finished_at', () => {
    const scans: ScanCollection = {
      stat_weights: { status: 'pending', started_at: 100 },
    };
    const out = refreshScanTimestamps(scans, 200);
    expect(out.stat_weights?.status).toBe('done');
    expect(out.stat_weights?.finished_at).toBe(200);
    expect(out.stat_weights?.started_at).toBe(100); // preserved
  });

  it('preserves data fields verbatim when bumping done records', () => {
    const scans: ScanCollection = {
      stat_weights: {
        status: 'done',
        started_at: 100,
        finished_at: 150,
        data: { intellect: 30, mastery: 15 },
      },
    };
    const out = refreshScanTimestamps(scans, 200);
    expect(out.stat_weights?.data).toEqual({ intellect: 30, mastery: 15 });
    expect(out.stat_weights?.finished_at).toBe(200);
  });

  it('keeps failed records unchanged (failure is a real signal)', () => {
    const scans: ScanCollection = {
      gear_coarse: {
        status: 'failed',
        started_at: 100,
        finished_at: 150,
        error: 'simc crashed',
      },
    };
    const out = refreshScanTimestamps(scans, 200);
    expect(out.gear_coarse?.status).toBe('failed');
    expect(out.gear_coarse?.finished_at).toBe(150);
    expect(out.gear_coarse?.error).toBe('simc crashed');
  });

  it('drops nullish records (defensive)', () => {
    const scans: ScanCollection = {
      stat_weights: undefined,
    } as ScanCollection;
    const out = refreshScanTimestamps(scans, 200);
    expect(out.stat_weights).toBeUndefined();
  });
});

describe('deriveGearFromCatalog', () => {
  it('returns undefined for missing catalog', () => {
    expect(deriveGearFromCatalog(undefined)).toBeUndefined();
  });

  it('returns undefined when best_loadout is empty', () => {
    expect(deriveGearFromCatalog(fakeCatalog())).toBeUndefined();
  });

  it('maps each best_loadout slot to a ComposedGearItem', () => {
    const catalog = fakeCatalog({
      slots: { head: { item_id: 1, name: 'Helm', ilvl: 272 } },
    });
    const gear = deriveGearFromCatalog(catalog);
    expect(gear).toEqual({
      head: { item_id: 1, name: 'Helm', ilvl: 272, identity: '1::' },
    });
  });
});

describe('synthesizeResultsFromCatalog', () => {
  it('produces a SimlyResults with stub scans + composed.gear from catalog', () => {
    const catalog = fakeCatalog({
      dps: 100_000,
      slots: { head: { item_id: 1, name: 'Helm', ilvl: 272 } },
    });
    const r = synthesizeResultsFromCatalog({
      catalog,
      characterKey: 'F-S-us',
      scenario: 'single_target_patchwerk',
      simcVersion: 'cached',
      finishedAt: 200,
    });
    expect(r.generated_at).toBe(200);
    expect(r.character_key).toBe('F-S-us');
    expect(r.scans!.stat_weights?.status).toBe('done');
    expect(r.scans!.gear_coarse?.status).toBe('done');
    expect(r.composed?.expected_dps).toBe(100_000);
    expect(r.composed?.gear?.head?.name).toBe('Helm');
  });

  it('omits composed when no catalog provided', () => {
    const r = synthesizeResultsFromCatalog({
      catalog: undefined,
      characterKey: 'F-S-us',
      scenario: 'single_target_patchwerk',
      simcVersion: 'placeholder',
      finishedAt: 200,
    });
    expect(r.composed).toBeUndefined();
    expect(r.scans!.stat_weights?.status).toBe('done');
  });

  it('always includes catalog_summary even when catalog is undefined', () => {
    const r = synthesizeResultsFromCatalog({
      catalog: undefined,
      characterKey: 'F-S-us',
      scenario: 'single_target_patchwerk',
      simcVersion: 'placeholder',
      finishedAt: 200,
    });
    expect(r.catalog_summary).toBeDefined();
    expect(r.catalog_summary?.total_seen).toBe(0);
  });
});

describe('composeFromScans', () => {
  it('returns undefined when no flask, food, or gear data', () => {
    expect(composeFromScans({}, undefined)).toBeUndefined();
  });

  it('produces flask + food when consumables ran but no gear', () => {
    const scans: ScanCollection = {
      best_flask: { status: 'done', data: fakeFlaskResult('Flask of Foo', 100) },
      best_food: { status: 'done', data: fakeFoodResult('Best Food', 99) },
    };
    const c = composeFromScans(scans, undefined);
    expect(c?.flask?.name).toBe('Flask of Foo');
    expect(c?.food?.name).toBe('Best Food');
    expect(c?.gear).toBeUndefined();
  });

  it('uses gear_coarse winner when only coarse ran', () => {
    const scans: ScanCollection = {
      gear_coarse: {
        status: 'done',
        data: fakeGearScan({
          winner_dps: 70_000,
          items: [{ slot: 'head', item_id: 1, name: 'Coarse Helm', ilvl: 272 }],
        }),
      },
    };
    const c = composeFromScans(scans, undefined);
    expect(c?.gear?.head?.name).toBe('Coarse Helm');
    expect(c?.expected_dps).toBe(70_000);
  });

  it('prefers gear_refined winner over gear_coarse when both ran', () => {
    const scans: ScanCollection = {
      gear_coarse: {
        status: 'done',
        data: fakeGearScan({
          winner_dps: 70_000,
          items: [{ slot: 'head', item_id: 1, name: 'Coarse Helm', ilvl: 272 }],
        }),
      },
      gear_refined: {
        status: 'done',
        data: fakeGearScan({
          winner_dps: 71_500,
          items: [{ slot: 'head', item_id: 2, name: 'Refined Helm', ilvl: 272 }],
        }),
      },
    };
    const c = composeFromScans(scans, undefined);
    expect(c?.gear?.head?.name).toBe('Refined Helm');
    expect(c?.expected_dps).toBe(71_500);
  });

  it('prefers gear_final over refined and coarse when all three ran', () => {
    const scans: ScanCollection = {
      gear_coarse: {
        status: 'done',
        data: fakeGearScan({
          winner_dps: 70_000,
          items: [{ slot: 'head', item_id: 1, name: 'Coarse Helm', ilvl: 272 }],
        }),
      },
      gear_refined: {
        status: 'done',
        data: fakeGearScan({
          winner_dps: 71_500,
          items: [{ slot: 'head', item_id: 2, name: 'Refined Helm', ilvl: 272 }],
        }),
      },
      gear_final: {
        status: 'done',
        data: fakeGearScan({
          winner_dps: 72_300,
          items: [{ slot: 'head', item_id: 3, name: 'Final Helm', ilvl: 272 }],
        }),
      },
    };
    const c = composeFromScans(scans, undefined);
    expect(c?.gear?.head?.name).toBe('Final Helm');
    expect(c?.expected_dps).toBe(72_300);
  });

  it('falls back to catalog.best_loadout when no gear scan ran (refresh path)', () => {
    const catalog = fakeCatalog({
      dps: 65_000,
      slots: { chest: { item_id: 99, name: 'Cached Chest', ilvl: 280 } },
    });
    const c = composeFromScans({}, catalog);
    expect(c?.gear?.chest?.name).toBe('Cached Chest');
    expect(c?.expected_dps).toBe(65_000);
  });

  it('combines fresh gear scan winner with consumables scan output', () => {
    const scans: ScanCollection = {
      best_flask: { status: 'done', data: fakeFlaskResult('Foo Flask', 100) },
      best_food: { status: 'done', data: fakeFoodResult('Bar Food', 99) },
      gear_coarse: {
        status: 'done',
        data: fakeGearScan({
          winner_dps: 70_000,
          items: [{ slot: 'head', item_id: 1, name: 'H', ilvl: 272 }],
        }),
      },
    };
    const c = composeFromScans(scans, undefined);
    expect(c?.flask?.name).toBe('Foo Flask');
    expect(c?.food?.name).toBe('Bar Food');
    expect(c?.gear?.head?.name).toBe('H');
  });

  it('skips a stage whose data is undefined (defensive — done w/ no data)', () => {
    const scans: ScanCollection = {
      gear_final: { status: 'done', finished_at: 100 }, // no data
      gear_coarse: {
        status: 'done',
        data: fakeGearScan({
          winner_dps: 70_000,
          items: [{ slot: 'head', item_id: 1, name: 'Coarse', ilvl: 272 }],
        }),
      },
    };
    const c = composeFromScans(scans, undefined);
    // gear_final has no data → falls through to coarse.
    expect(c?.gear?.head?.name).toBe('Coarse');
  });
});

describe('composeFromConsumableScans (back-compat alias)', () => {
  it('delegates to composeFromScans with no catalog', () => {
    const scans: ScanCollection = {
      best_flask: { status: 'done', data: fakeFlaskResult('Foo', 100) },
    };
    const c = composeFromConsumableScans(scans);
    expect(c?.flask?.name).toBe('Foo');
    expect(c?.gear).toBeUndefined();
  });

  it('returns undefined for empty scans', () => {
    expect(composeFromConsumableScans({})).toBeUndefined();
  });
});
