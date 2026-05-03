import { describe, expect, it } from 'vitest';
import { parseGearCoarseResult } from './gear-coarse';
import {
  buildGearProfileset,
  pruneGearPool,
  type TrinketLock,
} from './gear-pruner';
import {
  makeItemIdentity,
  type ParsedExport,
  type ParsedItem,
  type SlotName,
} from '../simc-export-parser';
import type { SimcRunResult } from '../simc-runner';

function fakeItem(opts: {
  slot: SlotName;
  item_id: number;
  ilvl: number;
  name?: string;
}): ParsedItem {
  return {
    slot: opts.slot,
    item_id: opts.item_id,
    name: opts.name ?? `Item ${opts.item_id}`,
    ilvl: opts.ilvl,
    bonus_ids: [],
    is_equipped: false,
    identity: makeItemIdentity(opts.item_id, [], undefined),
    extras: {},
  };
}

function exportWith(items: ParsedItem[]): ParsedExport {
  const e: ParsedExport = {
    character: { class: 'warlock' },
    equipped: [],
    bag: [],
    poolBySlot: {} as Record<SlotName, ParsedItem[]>,
  };
  for (const it of items) {
    const list = e.poolBySlot[it.slot] ?? (e.poolBySlot[it.slot] = []);
    list.push(it);
    e.bag.push(it);
  }
  return e;
}

function fakeRun(profilesets: Array<{ name: string; mean: number }>): SimcRunResult {
  return {
    simcVersion: '1205-01',
    gitRevision: 'abcdef0',
    buildDate: '2026-05-02',
    profilesets: profilesets.map((p) => ({
      name: p.name,
      mean: p.mean,
      stddev: 100,
      iterations: 1000,
    })),
    rawJsonPath: '/tmp/x.json',
    rawJson: {},
  };
}

describe('parseGearCoarseResult', () => {
  it('maps profilesets back to combos, sorts desc, computes delta_pct', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 272 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 272 }),
      fakeItem({ slot: 'chest', item_id: 3, ilvl: 272 }),
    ]);
    const lock: TrinketLock = {
      trinket1: fakeItem({ slot: 'trinket1', item_id: 200, ilvl: 272 }),
      trinket2: fakeItem({ slot: 'trinket2', item_id: 201, ilvl: 272 }),
    };
    const prune = pruneGearPool({ parsed, weights: {}, trinketLock: lock });
    const build = buildGearProfileset(prune);
    expect(build.comboCount).toBe(2);

    // Pretend SimC ran them and gave back the means.
    const run = fakeRun([
      { name: 'g_0000', mean: 100_000 },
      { name: 'g_0001', mean: 110_000 }, // winner
    ]);
    const result = parseGearCoarseResult(run, build.combosByName, 1000);

    expect(result.combos).toHaveLength(2);
    expect(result.winner?.combo_id).toBe('g_0001');
    expect(result.combos[0]!.delta_pct).toBe(0);
    // (100k - 110k) / 110k = -0.0909... → -9.09
    expect(result.combos[1]!.delta_pct).toBeCloseTo(-9.09, 1);
    expect(result.iterations).toBe(1000);
  });

  it('drops profilesets without a matching combo', () => {
    const parsed = exportWith([fakeItem({ slot: 'head', item_id: 1, ilvl: 272 })]);
    const lock: TrinketLock = {
      trinket1: fakeItem({ slot: 'trinket1', item_id: 200, ilvl: 272 }),
      trinket2: fakeItem({ slot: 'trinket2', item_id: 201, ilvl: 272 }),
    };
    const prune = pruneGearPool({ parsed, weights: {}, trinketLock: lock });
    const build = buildGearProfileset(prune);

    const run = fakeRun([
      { name: 'g_0000', mean: 100_000 },
      { name: 'unknown_profile', mean: 999_999 }, // dropped
    ]);
    const result = parseGearCoarseResult(run, build.combosByName, 1000);
    expect(result.combos).toHaveLength(1);
    expect(result.combos[0]!.combo_id).toBe('g_0000');
  });

  it('returns empty combos when SimC produced none', () => {
    const result = parseGearCoarseResult(fakeRun([]), new Map(), 1000);
    expect(result.combos).toEqual([]);
    expect(result.winner).toBeUndefined();
    expect(result.total_combos).toBe(0);
  });

  it('combo items include trinkets from the lock', () => {
    const parsed = exportWith([fakeItem({ slot: 'head', item_id: 1, ilvl: 272 })]);
    const lock: TrinketLock = {
      trinket1: fakeItem({ slot: 'trinket1', item_id: 200, ilvl: 272, name: 'T1' }),
      trinket2: fakeItem({ slot: 'trinket2', item_id: 201, ilvl: 272, name: 'T2' }),
    };
    const prune = pruneGearPool({ parsed, weights: {}, trinketLock: lock });
    const build = buildGearProfileset(prune);
    const run = fakeRun([{ name: 'g_0000', mean: 100_000 }]);
    const result = parseGearCoarseResult(run, build.combosByName, 1000);
    const slots = result.combos[0]!.items.map((i) => i.slot).sort();
    expect(slots).toContain('trinket1');
    expect(slots).toContain('trinket2');
    expect(slots).toContain('head');
  });
});
