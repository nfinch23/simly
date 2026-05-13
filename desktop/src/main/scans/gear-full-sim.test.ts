import { describe, expect, it } from 'vitest';
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
import { FULL_SIM_ITERATIONS, MAX_FULL_SIM_COMBOS } from './gear-full-sim';

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

const lock: TrinketLock = {
  trinket1: fakeItem({ slot: 'trinket1', item_id: 200, ilvl: 272 }),
  trinket2: fakeItem({ slot: 'trinket2', item_id: 201, ilvl: 272 }),
};

describe('full-sim pool builder (pruner with multiplier=Infinity)', () => {
  it('keeps every non-zero-score item per slot (no stat-weight pruning)', () => {
    // Three head items spanning a 50-ilvl gap. The greedy pruner with
    // multiplier=1.2 would drop the bottom one; full sim keeps all three.
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 300 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 280 }),
      fakeItem({ slot: 'head', item_id: 3, ilvl: 250 }),
    ]);
    const prune = pruneGearPool({
      parsed,
      weights: {},
      multiplier: Number.POSITIVE_INFINITY,
      trinketLock: lock,
    });
    expect(prune.perSlot.head).toHaveLength(3);
  });

  it('drops items in the ignoreSet (catalog trash filter applies)', () => {
    const trashItem = fakeItem({ slot: 'chest', item_id: 99, ilvl: 280 });
    const parsed = exportWith([
      fakeItem({ slot: 'chest', item_id: 1, ilvl: 272 }),
      trashItem,
      fakeItem({ slot: 'chest', item_id: 2, ilvl: 272 }),
    ]);
    const prune = pruneGearPool({
      parsed,
      weights: {},
      multiplier: Number.POSITIVE_INFINITY,
      ignoreSet: new Set([trashItem.identity]),
      trinketLock: lock,
    });
    const ids = (prune.perSlot.chest ?? []).map((i) => i.item_id);
    expect(ids).not.toContain(99);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });

  it('throws cartesian-too-large from buildGearProfileset when over the cap', () => {
    // Stack 8 slots × 3 candidates each → 3^8 = 6561 combos > 2000 cap.
    const slots: SlotName[] = ['head', 'neck', 'shoulder', 'chest', 'wrist', 'hands', 'waist', 'legs'];
    const items: ParsedItem[] = [];
    let nextId = 1;
    for (const slot of slots) {
      for (let i = 0; i < 3; i++) {
        items.push(fakeItem({ slot, item_id: nextId++, ilvl: 272 }));
      }
    }
    const parsed = exportWith(items);
    const prune = pruneGearPool({
      parsed,
      weights: {},
      multiplier: Number.POSITIVE_INFINITY,
      trinketLock: lock,
    });
    expect(() =>
      buildGearProfileset(prune, { maxCombos: MAX_FULL_SIM_COMBOS }),
    ).toThrow(/combos.*max/i);
  });

  it('MAX_FULL_SIM_COMBOS and FULL_SIM_ITERATIONS are sane defaults', () => {
    expect(MAX_FULL_SIM_COMBOS).toBe(2000);
    expect(FULL_SIM_ITERATIONS).toBe(3000);
  });
});
