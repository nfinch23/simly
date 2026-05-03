import { describe, expect, it } from 'vitest';
import { planQuickSim } from './quick-sim';
import { fullPoolSignature, type GearCatalogEntry } from './gear-catalog';
import { makeItemIdentity, type ParsedExport, type ParsedItem, type SlotName } from './simc-export-parser';

function fakeItem(opts: { slot: SlotName; item_id: number; ilvl?: number; equipped?: boolean }): ParsedItem {
  return {
    slot: opts.slot,
    item_id: opts.item_id,
    name: `Item ${opts.item_id}`,
    ilvl: opts.ilvl ?? 272,
    bonus_ids: [],
    is_equipped: opts.equipped ?? false,
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
    (it.is_equipped ? e.equipped : e.bag).push(it);
  }
  return e;
}

function catalogWith(opts: {
  best_loadout: GearCatalogEntry['best_loadout'];
  seen_items?: GearCatalogEntry['seen_items'];
  pool_signature: string;
}): GearCatalogEntry {
  return {
    character_key: 'F-S-us',
    scenario: 'single_target_patchwerk',
    best_loadout: opts.best_loadout,
    seen_items: opts.seen_items ?? {},
    last_pool_signature: opts.pool_signature,
    last_full_sim_at: 1,
  };
}

describe('planQuickSim', () => {
  it('returns full_sim when no catalog exists', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const plan = planQuickSim({ parsed: exportWith([A]), catalog: undefined });
    expect(plan.kind).toBe('full_sim');
  });

  it('returns full_sim when catalog has no best_loadout (incomplete)', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const plan = planQuickSim({
      parsed: exportWith([A]),
      catalog: catalogWith({ best_loadout: {}, pool_signature: 'sig' }),
    });
    expect(plan.kind).toBe('full_sim');
  });

  it('returns up_to_date when pool signature matches the catalog', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const parsed = exportWith([A]);
    const sig = fullPoolSignature(parsed);
    const plan = planQuickSim({
      parsed,
      catalog: catalogWith({
        best_loadout: { head: { slot: 'head', item_id: 1, name: 'A', identity: A.identity, ilvl: 272 } },
        pool_signature: sig,
      }),
    });
    expect(plan.kind).toBe('up_to_date');
  });

  it('returns full_sim when a best_loadout item is missing from the current pool', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const parsed = exportWith([A]); // catalog says best is item 99
    const plan = planQuickSim({
      parsed,
      catalog: catalogWith({
        best_loadout: { head: { slot: 'head', item_id: 99, name: 'Gone', identity: 'gone-id', ilvl: 272 } },
        pool_signature: 'old-sig',
      }),
    });
    expect(plan.kind).toBe('full_sim');
    if (plan.kind === 'full_sim') expect(plan.reason).toMatch(/no longer in pool/);
  });

  it('returns swap_test when a new gear item appears with intact best_loadout', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 }); // current best
    const B = fakeItem({ slot: 'chest', item_id: 2 }); // current best
    const C = fakeItem({ slot: 'head', item_id: 3 }); // new candidate
    const parsed = exportWith([A, B, C]);
    const plan = planQuickSim({
      parsed,
      catalog: catalogWith({
        best_loadout: {
          head: { slot: 'head', item_id: 1, name: 'A', identity: A.identity, ilvl: 272 },
          chest: { slot: 'chest', item_id: 2, name: 'B', identity: B.identity, ilvl: 272 },
        },
        seen_items: {
          [A.identity]: { identity: A.identity, item_id: 1, name: 'A', slot: 'head', ilvl: 272, status: 'best', best_delta_pct: 0, times_simmed: 1, last_simmed_at: 1 },
          [B.identity]: { identity: B.identity, item_id: 2, name: 'B', slot: 'chest', ilvl: 272, status: 'best', best_delta_pct: 0, times_simmed: 1, last_simmed_at: 1 },
        },
        pool_signature: 'sig-without-c',
      }),
    });
    expect(plan.kind).toBe('swap_test');
    if (plan.kind === 'swap_test') {
      expect(plan.newItems.map((i) => i.item_id)).toEqual([3]);
      expect(plan.baselineItemBySlot.head?.item_id).toBe(1);
      expect(plan.baselineItemBySlot.chest?.item_id).toBe(2);
    }
  });

  it('returns full_sim when a new weapon appears (1H/2H ambiguity)', () => {
    const mh = fakeItem({ slot: 'main_hand', item_id: 1 });
    const newMh = fakeItem({ slot: 'main_hand', item_id: 2 });
    const parsed = exportWith([mh, newMh]);
    const plan = planQuickSim({
      parsed,
      catalog: catalogWith({
        best_loadout: { main_hand: { slot: 'main_hand', item_id: 1, name: 'MH', identity: mh.identity, ilvl: 272 } },
        seen_items: {
          [mh.identity]: { identity: mh.identity, item_id: 1, name: 'MH', slot: 'main_hand', ilvl: 272, status: 'best', best_delta_pct: 0, times_simmed: 1, last_simmed_at: 1 },
        },
        pool_signature: 'old-sig',
      }),
    });
    expect(plan.kind).toBe('full_sim');
    if (plan.kind === 'full_sim') expect(plan.reason).toMatch(/weapon/);
  });

  it('returns full_sim when a new ring appears but the ring slot is missing from best_loadout', () => {
    // Edge case: best_loadout has only finger1, finger2 missing. New
    // ring needs both finger slots present in the baseline to be
    // swap-testable.
    const f1 = fakeItem({ slot: 'finger1', item_id: 100 });
    const newRing = fakeItem({ slot: 'finger1', item_id: 102 });
    const parsed = exportWith([f1, newRing]);
    const plan = planQuickSim({
      parsed,
      catalog: catalogWith({
        best_loadout: {
          finger1: { slot: 'finger1', item_id: 100, name: 'F1', identity: f1.identity, ilvl: 272 },
        },
        seen_items: {
          [f1.identity]: { identity: f1.identity, item_id: 100, name: 'F1', slot: 'finger1', ilvl: 272, status: 'best', best_delta_pct: 0, times_simmed: 1, last_simmed_at: 1 },
        },
        pool_signature: 'old-sig',
      }),
    });
    expect(plan.kind).toBe('full_sim');
    if (plan.kind === 'full_sim') expect(plan.reason).toMatch(/finger2|swap target/);
  });

  it('treats trinket changes as full pool change but does not include trinkets in swap-test items', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 });
    const T1 = fakeItem({ slot: 'trinket1', item_id: 200 });
    const T2 = fakeItem({ slot: 'trinket2', item_id: 201 });
    const newTrinket = fakeItem({ slot: 'trinket1', item_id: 202 });
    const parsed = exportWith([A, T1, T2, newTrinket]);
    const plan = planQuickSim({
      parsed,
      catalog: catalogWith({
        best_loadout: {
          head: { slot: 'head', item_id: 1, name: 'A', identity: A.identity, ilvl: 272 },
          trinket1: { slot: 'trinket1', item_id: 200, name: 'T1', identity: T1.identity, ilvl: 272 },
          trinket2: { slot: 'trinket2', item_id: 201, name: 'T2', identity: T2.identity, ilvl: 272 },
        },
        seen_items: {
          [A.identity]: { identity: A.identity, item_id: 1, name: 'A', slot: 'head', ilvl: 272, status: 'best', best_delta_pct: 0, times_simmed: 1, last_simmed_at: 1 },
        },
        pool_signature: 'old-sig',
      }),
    });
    // Pool signature differs (new trinket added) but quick-sim's
    // unseen items should NOT include trinkets — they're delegated
    // to the trinket cache. Since no non-trinket items are unseen,
    // this should resolve to up_to_date.
    expect(plan.kind).toBe('up_to_date');
  });

  it('returns up_to_date when only non-best items were removed from the pool', () => {
    const A = fakeItem({ slot: 'head', item_id: 1 }); // best
    const parsed = exportWith([A]); // some non-best items removed
    const plan = planQuickSim({
      parsed,
      catalog: catalogWith({
        best_loadout: { head: { slot: 'head', item_id: 1, name: 'A', identity: A.identity, ilvl: 272 } },
        seen_items: {
          [A.identity]: { identity: A.identity, item_id: 1, name: 'A', slot: 'head', ilvl: 272, status: 'best', best_delta_pct: 0, times_simmed: 1, last_simmed_at: 1 },
        },
        pool_signature: 'sig-with-extras-now-gone',
      }),
    });
    expect(plan.kind).toBe('up_to_date');
  });
});
