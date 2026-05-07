import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyByDelta,
  findUnseenItems,
  fullPoolSignature,
  GearCatalogStore,
  ignoredIdentities,
  updateCatalogFromGearScan,
  updateCatalogFromSwapTest,
  type GearCatalogEntry,
} from './gear-catalog';
import { makeItemIdentity, type ParsedExport, type ParsedItem, type SlotName } from './simc-export-parser';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'simly-catalog-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshStore(): GearCatalogStore {
  return new GearCatalogStore({ cwd: tmp, name: `t-${Math.random().toString(36).slice(2)}` });
}

function fakeItem(opts: { slot: SlotName; item_id: number; ilvl?: number; bonus_ids?: number[]; equipped?: boolean }): ParsedItem {
  const bonus_ids = opts.bonus_ids ?? [];
  return {
    slot: opts.slot,
    item_id: opts.item_id,
    name: `Item ${opts.item_id}`,
    ilvl: opts.ilvl ?? 272,
    bonus_ids,
    is_equipped: opts.equipped ?? false,
    identity: makeItemIdentity(opts.item_id, bonus_ids, undefined),
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
    (it.is_equipped ? e.equipped : e.bag).push(it);
  }
  return e;
}

describe('classifyByDelta', () => {
  it('returns best when is_currently_best regardless of delta', () => {
    expect(classifyByDelta(-50, true)).toBe('best');
  });
  it('returns sidegrade for ties within tie_window', () => {
    expect(classifyByDelta(0, false)).toBe('sidegrade');
    expect(classifyByDelta(-0.05, false)).toBe('sidegrade');
  });
  it('returns good for losses within good_threshold', () => {
    expect(classifyByDelta(-0.5, false)).toBe('good');
  });
  it('returns trash for losses past trash_threshold', () => {
    expect(classifyByDelta(-3, false)).toBe('trash');
    expect(classifyByDelta(-10, false)).toBe('trash');
  });
  it('returns good for losses between good and trash thresholds', () => {
    expect(classifyByDelta(-2, false)).toBe('good');
  });
  it('respects custom thresholds', () => {
    expect(classifyByDelta(-2, false, { trash_threshold_pct: 1 })).toBe('trash');
  });
});

describe('fullPoolSignature', () => {
  it('is stable regardless of equipped/bag split (same item set ⇒ same signature)', () => {
    const A = fakeItem({ slot: 'head', item_id: 1, equipped: true });
    const B = fakeItem({ slot: 'chest', item_id: 2, equipped: false });
    const sig1 = fullPoolSignature(exportWith([A, B]));

    const A2 = { ...A, is_equipped: false };
    const B2 = { ...B, is_equipped: true };
    const sig2 = fullPoolSignature(exportWith([A2, B2]));
    expect(sig1).toBe(sig2);
  });

  it('changes when a new item is added to the pool', () => {
    const a = exportWith([fakeItem({ slot: 'head', item_id: 1 })]);
    const b = exportWith([
      fakeItem({ slot: 'head', item_id: 1 }),
      fakeItem({ slot: 'chest', item_id: 2 }),
    ]);
    expect(fullPoolSignature(a)).not.toBe(fullPoolSignature(b));
  });
});

describe('updateCatalogFromGearScan', () => {
  it('writes best_loadout from the winning combo', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const B = fakeItem({ slot: 'chest', item_id: 2 });
    const updated = updateCatalogFromGearScan({
      prior: undefined,
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      pool_signature: 'sig',
      combos: [
        {
          combo_id: 'g_0',
          mean_dps: 100_000,
          delta_pct: 0,
          items: [
            { slot: 'head', item: itemRef(A) },
            { slot: 'chest', item: itemRef(B) },
          ],
        },
      ],
      now: 1000,
    });
    expect(updated.best_loadout.head?.item_id).toBe(1);
    expect(updated.best_loadout.chest?.item_id).toBe(2);
    expect(updated.best_loadout_dps).toBe(100_000);
    expect(updated.last_full_sim_at).toBe(1000);
  });

  it('classifies items as best / good / trash from combo deltas', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const B = fakeItem({ slot: 'head', item_id: 2 });
    const C = fakeItem({ slot: 'head', item_id: 3 });
    const updated = updateCatalogFromGearScan({
      prior: undefined,
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      pool_signature: 'sig',
      combos: [
        { combo_id: 'g_0', mean_dps: 100_000, delta_pct: 0, items: [{ slot: 'head', item: itemRef(A) }] },
        { combo_id: 'g_1', mean_dps: 99_500, delta_pct: -0.5, items: [{ slot: 'head', item: itemRef(B) }] },
        { combo_id: 'g_2', mean_dps: 95_000, delta_pct: -5, items: [{ slot: 'head', item: itemRef(C) }] },
      ],
    });
    expect(updated.seen_items[A.identity]?.status).toBe('best');
    expect(updated.seen_items[B.identity]?.status).toBe('good');
    expect(updated.seen_items[C.identity]?.status).toBe('trash');
  });

  it('demotes a previously-best item that no longer wins', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const B = fakeItem({ slot: 'head', item_id: 2 });
    const prior = updateCatalogFromGearScan({
      prior: undefined,
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      pool_signature: 'sig-1',
      combos: [
        { combo_id: 'g_0', mean_dps: 100_000, delta_pct: 0, items: [{ slot: 'head', item: itemRef(A) }] },
      ],
    });
    expect(prior.seen_items[A.identity]?.status).toBe('best');

    const next = updateCatalogFromGearScan({
      prior,
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      pool_signature: 'sig-2',
      combos: [
        { combo_id: 'g_0', mean_dps: 110_000, delta_pct: 0, items: [{ slot: 'head', item: itemRef(B) }] },
      ],
    });
    // B is now best; A's status should reflect its history (no entry in
    // this run but classifyByDelta on its old delta of 0). Since the
    // run didn't include A, its status should reflect "no longer best"
    // — derived from its remembered best_delta_pct.
    expect(next.seen_items[B.identity]?.status).toBe('best');
    // A was 'best' with best_delta_pct=0; now demoted with delta=0 →
    // 'sidegrade' (within tie window).
    expect(next.seen_items[A.identity]?.status).toBe('sidegrade');
  });

  it('tightens best_delta_pct toward zero across multiple runs', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const B = fakeItem({ slot: 'head', item_id: 2 });
    // Run 1: A wins, B loses by 5%.
    const prior = updateCatalogFromGearScan({
      prior: undefined,
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      pool_signature: 'sig-1',
      combos: [
        { combo_id: 'g_0', mean_dps: 100_000, delta_pct: 0, items: [{ slot: 'head', item: itemRef(A) }] },
        { combo_id: 'g_1', mean_dps: 95_000, delta_pct: -5, items: [{ slot: 'head', item: itemRef(B) }] },
      ],
    });
    expect(prior.seen_items[B.identity]?.best_delta_pct).toBe(-5);
    // Run 2: B loses by less (-1%). best_delta_pct should tighten to -1.
    const next = updateCatalogFromGearScan({
      prior,
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      pool_signature: 'sig-2',
      combos: [
        { combo_id: 'g_0', mean_dps: 100_000, delta_pct: 0, items: [{ slot: 'head', item: itemRef(A) }] },
        { combo_id: 'g_1', mean_dps: 99_000, delta_pct: -1, items: [{ slot: 'head', item: itemRef(B) }] },
      ],
    });
    expect(next.seen_items[B.identity]?.best_delta_pct).toBe(-1);
    // -1% is within good_threshold (1%), so status should be 'good'.
    expect(next.seen_items[B.identity]?.status).toBe('good');
  });
});

describe('updateCatalogFromSwapTest', () => {
  it('writes new entries for tested items without touching best_loadout', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const prior: GearCatalogEntry = {
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      best_loadout: { head: { slot: 'head', item_id: 99, name: 'Old', identity: 'old-id', ilvl: 272 } },
      best_loadout_dps: 100_000,
      seen_items: {},
      last_pool_signature: 'sig-1',
      last_full_sim_at: 1,
      best_ilvl_by_slot: {},
    };
    const next = updateCatalogFromSwapTest({
      prior,
      swap_results: [
        {
          slot: 'head',
          item: { item_id: A.item_id, name: A.name, identity: A.identity, ilvl: A.ilvl },
          delta_pct: -0.5,
          mean_dps: 99_500,
        },
      ],
      now: 2,
    });
    expect(next.seen_items[A.identity]?.status).toBe('good');
    expect(next.seen_items[A.identity]?.times_simmed).toBe(1);
    expect(next.best_loadout).toEqual(prior.best_loadout); // unchanged
    expect(next.last_quick_sim_at).toBe(2);
  });
});

describe('ignoredIdentities', () => {
  it('returns identities with status=trash', () => {
    const cat = updateCatalogFromGearScan({
      prior: undefined,
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      pool_signature: 'sig',
      combos: [
        { combo_id: 'g_0', mean_dps: 100_000, delta_pct: 0, items: [{ slot: 'head', item: itemRef(fakeItem({ slot: 'head', item_id: 1 })) }] },
        { combo_id: 'g_1', mean_dps: 90_000, delta_pct: -10, items: [{ slot: 'head', item: itemRef(fakeItem({ slot: 'head', item_id: 2 })) }] },
      ],
    });
    const ignored = ignoredIdentities(cat);
    // Item 2 lost by 10% → trash.
    expect(ignored.size).toBe(1);
  });
});

describe('findUnseenItems', () => {
  it('returns gear items not in the catalog seen_items', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const B = fakeItem({ slot: 'chest', item_id: 2 });
    const parsed = exportWith([A, B]);
    const catalog: GearCatalogEntry = {
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      best_loadout: {},
      seen_items: {
        [A.identity]: {
          identity: A.identity,
          item_id: A.item_id,
          name: A.name,
          slot: A.slot,
          ilvl: A.ilvl,
          status: 'best',
          best_delta_pct: 0,
          times_simmed: 1,
          last_simmed_at: 1,
        },
      },
      last_pool_signature: 'sig',
      last_full_sim_at: 1,
      best_ilvl_by_slot: {},
    };
    const unseen = findUnseenItems(parsed, catalog);
    expect(unseen.map((i) => i.item_id)).toEqual([2]);
  });

  it('returns the whole pool when no catalog exists', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const B = fakeItem({ slot: 'chest', item_id: 2 });
    const parsed = exportWith([A, B]);
    const unseen = findUnseenItems(parsed, undefined);
    expect(unseen).toHaveLength(2);
  });

  it('excludes trinkets, tabard, shirt', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'trinket1', item_id: 1 }),
      fakeItem({ slot: 'trinket2', item_id: 2 }),
      fakeItem({ slot: 'tabard', item_id: 3 }),
      fakeItem({ slot: 'shirt', item_id: 4 }),
      fakeItem({ slot: 'head', item_id: 5 }),
    ]);
    const unseen = findUnseenItems(parsed, undefined);
    expect(unseen.map((i) => i.item_id)).toEqual([5]);
  });
});

describe('GearCatalogStore', () => {
  it('persists across put / get', () => {
    const store = freshStore();
    const entry: GearCatalogEntry = {
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      best_loadout: { head: { slot: 'head', item_id: 1, name: 'X', identity: 'x', ilvl: 272 } },
      seen_items: {},
      last_pool_signature: 'sig',
      last_full_sim_at: 1,
      best_ilvl_by_slot: {},
    };
    store.put(entry);
    expect(store.get('F-S-us', 'single_target_patchwerk')).toEqual(entry);
  });

  it('clear() empties the store', () => {
    const store = freshStore();
    store.put({
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      best_loadout: {},
      seen_items: {},
      last_pool_signature: 'sig',
      last_full_sim_at: 1,
      best_ilvl_by_slot: {},
    });
    store.clear();
    expect(store.get('F-S-us', 'single_target_patchwerk')).toBeUndefined();
  });
});

function itemRef(item: ParsedItem) {
  return {
    item_id: item.item_id,
    name: item.name,
    identity: item.identity,
    ilvl: item.ilvl,
  };
}
