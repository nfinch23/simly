import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildGearProfileset,
  calibrateFromCatalog,
  computeDpsPerIlvlPct,
  GEAR_LADDER_SLOTS,
  HARD_FLOOR_PCT,
  ilvlScorer,
  is2HWeapon,
  pruneGearPool,
  type PrunerCalibration,
  type Scorer,
  type TrinketLock,
} from './gear-pruner';
import type { GearCatalogEntry } from '../gear-catalog';
import {
  makeItemIdentity,
  parseSimcExport,
  type ParsedExport,
  type ParsedItem,
  type SlotName,
} from '../simc-export-parser';
import type { StatWeights } from '@simly/shared';

function fakeItem(opts: {
  slot: SlotName;
  item_id: number;
  ilvl: number;
  bonus_ids?: number[];
  name?: string;
  equip_loc?: string;
}): ParsedItem {
  const bonus_ids = opts.bonus_ids ?? [];
  return {
    slot: opts.slot,
    item_id: opts.item_id,
    name: opts.name ?? `Item ${opts.item_id}`,
    ilvl: opts.ilvl,
    bonus_ids,
    is_equipped: false,
    identity: makeItemIdentity(opts.item_id, bonus_ids, undefined),
    extras: opts.equip_loc ? { simly_equip_loc: opts.equip_loc } : {},
  };
}

function emptyExport(): ParsedExport {
  return {
    character: { class: 'warlock' },
    equipped: [],
    bag: [],
    poolBySlot: {} as Record<SlotName, ParsedItem[]>,
  };
}

function exportWith(items: ParsedItem[]): ParsedExport {
  const e = emptyExport();
  for (const it of items) {
    const list = e.poolBySlot[it.slot] ?? (e.poolBySlot[it.slot] = []);
    list.push(it);
    (it.is_equipped ? e.equipped : e.bag).push(it);
  }
  return e;
}

const NO_WEIGHTS: StatWeights = {};

describe('ilvlScorer', () => {
  it('returns ilvl, ignoring weights', () => {
    const it = fakeItem({ slot: 'head', item_id: 1, ilvl: 272 });
    expect(ilvlScorer(it, NO_WEIGHTS)).toBe(272);
    expect(ilvlScorer(it, { mastery: 0.74, crit: 0.68 })).toBe(272);
  });
});

describe('pruneGearPool — single slot, default ilvl scorer', () => {
  it('keeps all items within 1/multiplier of leader (multiplier=1.5)', () => {
    // Leader is 300; multiplier 1.5 → keep score >= 200.
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 300 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 250 }),
      fakeItem({ slot: 'head', item_id: 3, ilvl: 200 }),
      fakeItem({ slot: 'head', item_id: 4, ilvl: 199 }), // dropped
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS, multiplier: 1.5 });
    expect(prune.perSlot.head?.map((i) => i.item_id)).toEqual([1, 2, 3]);
  });

  it('default multiplier (1.2) is tighter than 1.5', () => {
    // Leader 300; default mult 1.2 → keep score * 1.2 >= 300, score >= 250.
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 300 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 280 }),
      fakeItem({ slot: 'head', item_id: 3, ilvl: 250 }),
      fakeItem({ slot: 'head', item_id: 4, ilvl: 200 }), // dropped at default
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    expect(prune.perSlot.head?.map((i) => i.item_id)).toEqual([1, 2, 3]);
  });

  it('keeps everything when all items are equal', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'chest', item_id: 1, ilvl: 272 }),
      fakeItem({ slot: 'chest', item_id: 2, ilvl: 272 }),
      fakeItem({ slot: 'chest', item_id: 3, ilvl: 272 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    expect(prune.perSlot.chest).toHaveLength(3);
  });

  it('keeps the single available item even when multiplier would exclude it', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'legs', item_id: 1, ilvl: 100 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS, multiplier: 100 });
    expect(prune.perSlot.legs).toHaveLength(1);
  });

  it('respects a lower multiplier (tighter prune)', () => {
    // Leader 300; multiplier 1.1 → keep score >= 273.
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 300 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 280 }),
      fakeItem({ slot: 'head', item_id: 3, ilvl: 250 }), // dropped
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS, multiplier: 1.1 });
    expect(prune.perSlot.head?.map((i) => i.item_id)).toEqual([1, 2]);
  });
});

describe('pruneGearPool — ignore set', () => {
  it('drops ignored items before computing the leader', () => {
    // Without ignore: leader is 300, 200 dropped. With 300 ignored: leader
    // becomes 250, so 200 should now survive (250 × 1.5 = 375 >= 200... wait).
    // Re-read: keep where score * mult >= max. 200*1.5=300 >= 250 ✓.
    const a = fakeItem({ slot: 'head', item_id: 1, ilvl: 300 });
    const b = fakeItem({ slot: 'head', item_id: 2, ilvl: 250 });
    const c = fakeItem({ slot: 'head', item_id: 3, ilvl: 200 });
    const parsed = exportWith([a, b, c]);
    const prune = pruneGearPool({
      parsed,
      weights: NO_WEIGHTS,
      multiplier: 1.5,
      ignoreSet: new Set([a.identity]),
    });
    expect(prune.perSlot.head?.map((i) => i.item_id).sort()).toEqual([2, 3]);
  });
});

describe('pruneGearPool — rings', () => {
  it('merges finger1 + finger2 pools and dedupes by identity', () => {
    const r1 = fakeItem({ slot: 'finger1', item_id: 100, ilvl: 263 });
    const r1Dup = fakeItem({ slot: 'finger2', item_id: 100, ilvl: 263 }); // same id+bonus
    const r2 = fakeItem({ slot: 'finger2', item_id: 101, ilvl: 263 });
    const parsed = exportWith([r1, r1Dup, r2]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    expect(prune.ringPairs).toHaveLength(1);
    const ids = prune.ringPairs[0]!.map((it) => it.item_id).sort();
    expect(ids).toEqual([100, 101]);
  });

  it('produces n*(n-1)/2 pairs for n surviving rings', () => {
    const rings = [
      fakeItem({ slot: 'finger1', item_id: 100, ilvl: 263 }),
      fakeItem({ slot: 'finger1', item_id: 101, ilvl: 263 }),
      fakeItem({ slot: 'finger2', item_id: 102, ilvl: 263 }),
      fakeItem({ slot: 'finger2', item_id: 103, ilvl: 263 }),
    ];
    const parsed = exportWith(rings);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    expect(prune.ringPairs).toHaveLength(6); // 4 choose 2
  });

  it('prunes low-ilvl rings before pairing', () => {
    // Leader 300; 1.5× → keep >= 200. Ring at ilvl 150 should drop;
    // remaining 3 rings → 3 pairs.
    const rings = [
      fakeItem({ slot: 'finger1', item_id: 100, ilvl: 300 }),
      fakeItem({ slot: 'finger1', item_id: 101, ilvl: 250 }),
      fakeItem({ slot: 'finger2', item_id: 102, ilvl: 200 }),
      fakeItem({ slot: 'finger2', item_id: 103, ilvl: 150 }),
    ];
    const parsed = exportWith(rings);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS, multiplier: 1.5 });
    expect(prune.ringPairs).toHaveLength(3);
    const allIds = new Set(prune.ringPairs.flatMap((p) => p.map((it) => it.item_id)));
    expect(allIds.has(103)).toBe(false);
  });

  it('emits zero ring pairs for fewer than two rings', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'finger1', item_id: 100, ilvl: 263 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    expect(prune.ringPairs).toEqual([]);
  });
});

describe('pruneGearPool — trinket exemption', () => {
  it('does not include trinkets in perSlot regardless of pool', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'trinket1', item_id: 200, ilvl: 272 }),
      fakeItem({ slot: 'trinket2', item_id: 201, ilvl: 272 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    expect(prune.perSlot.trinket1).toBeUndefined();
    expect(prune.perSlot.trinket2).toBeUndefined();
  });

  it('passes the trinketLock through to the result', () => {
    const lock: TrinketLock = {
      trinket1: fakeItem({ slot: 'trinket1', item_id: 200, ilvl: 272 }),
      trinket2: fakeItem({ slot: 'trinket2', item_id: 201, ilvl: 272 }),
    };
    const prune = pruneGearPool({ parsed: emptyExport(), weights: NO_WEIGHTS, trinketLock: lock });
    expect(prune.trinketLock).toBe(lock);
  });
});

describe('pruneGearPool — slot exclusions', () => {
  it('skips tabard and shirt entirely', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'tabard', item_id: 1, ilvl: 1 }),
      fakeItem({ slot: 'shirt', item_id: 2, ilvl: 1 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    expect(prune.perSlot.tabard).toBeUndefined();
    expect(prune.perSlot.shirt).toBeUndefined();
  });

  it('only iterates GEAR_LADDER_SLOTS minus rings/trinkets', () => {
    const ladderNonRingTrinket = GEAR_LADDER_SLOTS.filter(
      (s) => s !== 'finger1' && s !== 'finger2',
    );
    expect(ladderNonRingTrinket).not.toContain('tabard');
    expect(ladderNonRingTrinket).not.toContain('shirt');
    expect(ladderNonRingTrinket).not.toContain('trinket1');
    expect(ladderNonRingTrinket).not.toContain('trinket2');
  });
});

describe('pruneGearPool — totalCombos', () => {
  it('multiplies non-empty per-slot pool sizes and ring-pair count', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 272 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 272 }),
      fakeItem({ slot: 'chest', item_id: 3, ilvl: 272 }),
      fakeItem({ slot: 'chest', item_id: 4, ilvl: 272 }),
      fakeItem({ slot: 'chest', item_id: 5, ilvl: 272 }),
      fakeItem({ slot: 'finger1', item_id: 100, ilvl: 263 }),
      fakeItem({ slot: 'finger1', item_id: 101, ilvl: 263 }),
      fakeItem({ slot: 'finger2', item_id: 102, ilvl: 263 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    // 2 heads × 3 chests × 3 ring pairs = 18
    expect(prune.totalCombos).toBe(2 * 3 * 3);
  });

  it('returns 1 when no slots have candidates', () => {
    const prune = pruneGearPool({ parsed: emptyExport(), weights: NO_WEIGHTS });
    expect(prune.totalCombos).toBe(1);
  });
});

describe('pruneGearPool — pluggable scorer', () => {
  it('uses a custom Σ(stat × weight) scorer when supplied', () => {
    const customScorer: Scorer = (item, weights) => {
      // Mock per-item stats encoded in item_id mod 10.
      const masteryAmt = item.item_id % 10;
      return masteryAmt * (weights.mastery ?? 0);
    };
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 7, ilvl: 100 }), // score 7
      fakeItem({ slot: 'head', item_id: 9, ilvl: 100 }), // score 9, leader
      fakeItem({ slot: 'head', item_id: 3, ilvl: 100 }), // score 3 — dropped (3*1.5 = 4.5 < 9)
    ]);
    const prune = pruneGearPool({
      parsed,
      weights: { mastery: 1.0 },
      scorer: customScorer,
      multiplier: 1.5,
    });
    // Survivors: 9 (leader), 7 (7*1.5=10.5 >= 9). Dropped: 3.
    const ids = prune.perSlot.head?.map((i) => i.item_id).sort();
    expect(ids).toEqual([7, 9]);
  });
});

describe('buildGearProfileset', () => {
  it('emits one profileset id per cartesian combo with deterministic names', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 272 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 272 }),
      fakeItem({ slot: 'chest', item_id: 3, ilvl: 272 }),
      fakeItem({ slot: 'chest', item_id: 4, ilvl: 272 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    const build = buildGearProfileset(prune);
    expect(build.comboCount).toBe(4);
    expect([...build.combosByName.keys()]).toEqual(['g_0000', 'g_0001', 'g_0002', 'g_0003']);
  });

  it('emits one profileset line per slot, with id and slot name', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 272 }),
      fakeItem({ slot: 'chest', item_id: 3, ilvl: 272 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    const build = buildGearProfileset(prune);
    const lines = build.script.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^profileset\."g_0000"\+="head=,id=1/);
    expect(lines[1]).toMatch(/^profileset\."g_0000"\+="chest=,id=3/);
  });

  it('expands ring pairs into finger1 + finger2 lines', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 272 }),
      fakeItem({ slot: 'finger1', item_id: 100, ilvl: 263 }),
      fakeItem({ slot: 'finger2', item_id: 101, ilvl: 263 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    const build = buildGearProfileset(prune);
    expect(build.comboCount).toBe(1);
    expect(build.script).toContain('finger1=,id=');
    expect(build.script).toContain('finger2=,id=');
    const combo = build.combosByName.get('g_0000')!;
    expect(combo.slots.finger1?.item_id).not.toBe(combo.slots.finger2?.item_id);
  });

  it('emits trinket1 + trinket2 from the lock on every combo', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 272 }),
    ]);
    const lock: TrinketLock = {
      trinket1: fakeItem({ slot: 'trinket1', item_id: 200, ilvl: 272 }),
      trinket2: fakeItem({ slot: 'trinket2', item_id: 201, ilvl: 272 }),
    };
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS, trinketLock: lock });
    const build = buildGearProfileset(prune);
    expect(build.script).toContain('trinket1=,id=200');
    expect(build.script).toContain('trinket2=,id=201');
    const combo = build.combosByName.get('g_0000')!;
    expect(combo.slots.trinket1?.item_id).toBe(200);
    expect(combo.slots.trinket2?.item_id).toBe(201);
  });

  it('throws when the cartesian would exceed maxCombos', () => {
    // Build 5 heads × 5 chests = 25 combos; cap at 10.
    const items: ParsedItem[] = [];
    for (let i = 0; i < 5; i++) items.push(fakeItem({ slot: 'head', item_id: 1 + i, ilvl: 272 }));
    for (let i = 0; i < 5; i++) items.push(fakeItem({ slot: 'chest', item_id: 100 + i, ilvl: 272 }));
    const parsed = exportWith(items);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    expect(() => buildGearProfileset(prune, { maxCombos: 10 })).toThrow(/exceed|max|tighten/i);
  });

  it('stays under default maxCombos for a typical pruned pool', () => {
    // 12 ladder slots × 2 candidates each + 3 ring pairs = 4096 × 3 = 12288.
    // We expect a tightened pool to land well under 5000 — verify the
    // path works on a realistic small case.
    const items: ParsedItem[] = [];
    for (const slot of ['head', 'chest', 'legs'] as SlotName[]) {
      items.push(fakeItem({ slot, item_id: 100 + items.length, ilvl: 272 }));
      items.push(fakeItem({ slot, item_id: 100 + items.length, ilvl: 270 }));
    }
    const parsed = exportWith(items);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    expect(() => buildGearProfileset(prune)).not.toThrow();
  });
});

describe('is2HWeapon', () => {
  it('returns true when extras.simly_equip_loc === INVTYPE_2HWEAPON', () => {
    const it = fakeItem({ slot: 'main_hand', item_id: 1, ilvl: 272, equip_loc: 'INVTYPE_2HWEAPON' });
    expect(is2HWeapon(it)).toBe(true);
  });
  it('returns false for INVTYPE_WEAPON (1H)', () => {
    const it = fakeItem({ slot: 'main_hand', item_id: 1, ilvl: 272, equip_loc: 'INVTYPE_WEAPON' });
    expect(is2HWeapon(it)).toBe(false);
  });
  it('returns false when annotation is missing (conservative — assume 1H)', () => {
    const it = fakeItem({ slot: 'main_hand', item_id: 1, ilvl: 272 });
    expect(is2HWeapon(it)).toBe(false);
  });
});

describe('buildGearProfileset — 2H/1H cartesian split', () => {
  it('all-1H pool: cartesian includes off_hand on every combo', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'main_hand', item_id: 1, ilvl: 272, equip_loc: 'INVTYPE_WEAPON' }),
      fakeItem({ slot: 'main_hand', item_id: 2, ilvl: 272, equip_loc: 'INVTYPE_WEAPON' }),
      fakeItem({ slot: 'off_hand', item_id: 50, ilvl: 272, equip_loc: 'INVTYPE_HOLDABLE' }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    const build = buildGearProfileset(prune);
    // 2 mains × 1 oh = 2 combos, each with both slots.
    expect(build.comboCount).toBe(2);
    for (const combo of build.combosByName.values()) {
      expect(combo.slots.main_hand).toBeDefined();
      expect(combo.slots.off_hand).toBeDefined();
    }
  });

  it('all-2H pool: cartesian omits off_hand on every combo', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'main_hand', item_id: 1, ilvl: 272, equip_loc: 'INVTYPE_2HWEAPON' }),
      fakeItem({ slot: 'main_hand', item_id: 2, ilvl: 272, equip_loc: 'INVTYPE_2HWEAPON' }),
      fakeItem({ slot: 'off_hand', item_id: 50, ilvl: 272 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    const build = buildGearProfileset(prune);
    expect(build.comboCount).toBe(2);
    for (const combo of build.combosByName.values()) {
      expect(combo.slots.main_hand).toBeDefined();
      expect(combo.slots.off_hand).toBeUndefined();
    }
  });

  it('mixed pool: 1H combos get OH, 2H combos do not', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'main_hand', item_id: 1, ilvl: 272, equip_loc: 'INVTYPE_WEAPON' }),
      fakeItem({ slot: 'main_hand', item_id: 2, ilvl: 272, equip_loc: 'INVTYPE_2HWEAPON' }),
      fakeItem({ slot: 'off_hand', item_id: 50, ilvl: 272 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    const build = buildGearProfileset(prune);
    // 1H × OH = 1 combo, 2H without OH = 1 combo, total 2.
    expect(build.comboCount).toBe(2);
    let with1H = 0;
    let with2H = 0;
    for (const combo of build.combosByName.values()) {
      const mh = combo.slots.main_hand;
      if (mh?.item_id === 1) {
        with1H++;
        expect(combo.slots.off_hand).toBeDefined();
      }
      if (mh?.item_id === 2) {
        with2H++;
        expect(combo.slots.off_hand).toBeUndefined();
      }
    }
    expect(with1H).toBe(1);
    expect(with2H).toBe(1);
  });

  it('mixed pool with multiple OH options: only 1H mains multiply by OH count', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'main_hand', item_id: 1, ilvl: 272, equip_loc: 'INVTYPE_WEAPON' }),
      fakeItem({ slot: 'main_hand', item_id: 2, ilvl: 272, equip_loc: 'INVTYPE_2HWEAPON' }),
      fakeItem({ slot: 'off_hand', item_id: 50, ilvl: 272 }),
      fakeItem({ slot: 'off_hand', item_id: 51, ilvl: 272 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    const build = buildGearProfileset(prune);
    // 1 (1H) × 2 (OH) + 1 (2H) × 0 (no OH) = 3 total combos.
    expect(build.comboCount).toBe(3);
  });

  it('combos retain unique sequential ids across the split branches', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'main_hand', item_id: 1, ilvl: 272, equip_loc: 'INVTYPE_WEAPON' }),
      fakeItem({ slot: 'main_hand', item_id: 2, ilvl: 272, equip_loc: 'INVTYPE_2HWEAPON' }),
      fakeItem({ slot: 'off_hand', item_id: 50, ilvl: 272 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    const build = buildGearProfileset(prune);
    expect([...build.combosByName.keys()].sort()).toEqual(['g_0000', 'g_0001']);
  });

  it('items without an equip_loc annotation are treated as 1H (conservative)', () => {
    const parsed = exportWith([
      fakeItem({ slot: 'main_hand', item_id: 1, ilvl: 272 }), // no annotation
      fakeItem({ slot: 'off_hand', item_id: 50, ilvl: 272 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
    const build = buildGearProfileset(prune);
    expect(build.comboCount).toBe(1);
    const combo = build.combosByName.get('g_0000')!;
    expect(combo.slots.off_hand).toBeDefined();
  });
});

describe('pruneGearPool — real Felfriend export', () => {
  it('produces a non-empty per-slot survivor list for the real fixture', () => {
    const fixturePath = join(__dirname, '..', '__fixtures__', 'felfriend-export.simc');
    const source = readFileSync(fixturePath, 'utf-8');
    const parsed = parseSimcExport(source);
    const prune = pruneGearPool({ parsed, weights: { intellect: 1.0, mastery: 0.74 } });

    // Felfriend has equipped items in every relevant slot — at minimum
    // each ladder slot with a pool entry should have a survivor.
    for (const slot of ['head', 'chest', 'legs', 'feet', 'main_hand', 'off_hand'] as SlotName[]) {
      if ((parsed.poolBySlot[slot] ?? []).length > 0) {
        expect(prune.perSlot[slot], `slot ${slot}`).toBeDefined();
        expect(prune.perSlot[slot]!.length).toBeGreaterThan(0);
      }
    }
  });

  it('builds a profileset script when paired with a trinketLock (within default cap)', () => {
    const fixturePath = join(__dirname, '..', '__fixtures__', 'felfriend-export.simc');
    const source = readFileSync(fixturePath, 'utf-8');
    const parsed = parseSimcExport(source);
    const trinkets = parsed.poolBySlot.trinket1 ?? parsed.poolBySlot.trinket2 ?? [];
    if (trinkets.length < 2) return; // Defensive: real fixture has 2+ trinkets, see felfriend-export.simc
    const lock: TrinketLock = { trinket1: trinkets[0]!, trinket2: trinkets[1]! };
    const prune = pruneGearPool({
      parsed,
      weights: { intellect: 1.0, mastery: 0.74 },
      trinketLock: lock,
    });
    // Real fixture cartesian — if it exceeds default cap, that's a real
    // signal the pruning needs to be tighter for live runs. Cap at a
    // permissive number for this smoke check.
    const build = buildGearProfileset(prune, { maxCombos: 100_000 });
    expect(build.comboCount).toBeGreaterThan(0);
    expect(build.script).toContain('profileset.');
    expect(build.script).toContain('trinket1=,id=');
  });
});

// ---------------------------------------------------------------------------
// computeDpsPerIlvlPct
// ---------------------------------------------------------------------------

describe('computeDpsPerIlvlPct', () => {
  it('returns 0 when bestLoadoutDps is 0', () => {
    expect(computeDpsPerIlvlPct({ intellect: 30 }, 0)).toBe(0);
  });

  it('returns 0 when bestLoadoutDps is negative', () => {
    expect(computeDpsPerIlvlPct({ intellect: 30 }, -100)).toBe(0);
  });

  it('returns 0 when all weights are zero', () => {
    const result = computeDpsPerIlvlPct({}, 100_000);
    expect(result).toBe(0);
  });

  it('uses intellect as primary when it is the highest', () => {
    // intellect=30, no secondaries → dpsPerIlvl = 30*1 = 30; pct = 30/100000*100 = 0.03%
    const result = computeDpsPerIlvlPct({ intellect: 30, strength: 10, agility: 5 }, 100_000);
    expect(result).toBeCloseTo(0.03, 5);
  });

  it('uses agility when it is the highest primary', () => {
    const result = computeDpsPerIlvlPct({ agility: 40 }, 100_000);
    expect(result).toBeCloseTo(0.04, 5);
  });

  it('incorporates average of non-zero secondaries', () => {
    // primary=30, secondaries crit=10 haste=20 mastery=0 vers=0
    // nonZero = [10, 20], avg=15
    // dpsPerIlvl = 30*1 + 15*1.8 = 30 + 27 = 57
    // pct = 57/100000*100 = 0.057
    const result = computeDpsPerIlvlPct(
      { intellect: 30, crit: 10, haste: 20 },
      100_000,
    );
    expect(result).toBeCloseTo(0.057, 5);
  });

  it('ignores zero-valued secondaries when computing average', () => {
    // Same as above — mastery and vers at 0 should not bring down avg
    const withZeros = computeDpsPerIlvlPct(
      { intellect: 30, crit: 10, haste: 20, mastery: 0, versatility: 0 },
      100_000,
    );
    const withoutZeros = computeDpsPerIlvlPct(
      { intellect: 30, crit: 10, haste: 20 },
      100_000,
    );
    expect(withZeros).toBeCloseTo(withoutZeros, 10);
  });
});

// ---------------------------------------------------------------------------
// calibrateFromCatalog
// ---------------------------------------------------------------------------

function fakeCatalogForCalibration(
  items: Array<{
    identity: string;
    slot: string;
    ilvl: number;
    best_delta_pct: number;
    times_simmed?: number;
  }>,
  bestIlvlBySlot?: Record<string, number>,
): GearCatalogEntry {
  const seen_items: GearCatalogEntry['seen_items'] = {};
  for (const it of items) {
    seen_items[it.identity] = {
      identity: it.identity,
      item_id: parseInt(it.identity, 10) || 0,
      name: `Item ${it.identity}`,
      slot: it.slot,
      ilvl: it.ilvl,
      status: 'good',
      best_delta_pct: it.best_delta_pct,
      times_simmed: it.times_simmed ?? 1,
      last_simmed_at: 1,
    };
  }
  return {
    character_key: 'F-S-us',
    scenario: 'single_target_patchwerk',
    best_loadout: {},
    seen_items,
    last_pool_signature: 'sig',
    last_full_sim_at: 1,
    best_ilvl_by_slot: bestIlvlBySlot ?? {},
  };
}

describe('calibrateFromCatalog', () => {
  it('returns null when fewer than minSamples items have been simmed', () => {
    const catalog = fakeCatalogForCalibration([
      { identity: '1', slot: 'head', ilvl: 300, best_delta_pct: 0 },
      { identity: '2', slot: 'head', ilvl: 290, best_delta_pct: -1 },
      { identity: '3', slot: 'head', ilvl: 280, best_delta_pct: -2 },
      { identity: '4', slot: 'head', ilvl: 270, best_delta_pct: -3 },
    ]);
    expect(calibrateFromCatalog(catalog, 0.3)).toBeNull();
  });

  it('returns null when items exist but none have been simmed (times_simmed=0)', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      identity: String(i),
      slot: 'head',
      ilvl: 300 - i * 5,
      best_delta_pct: -i * 0.5,
      times_simmed: 0,
    }));
    const catalog = fakeCatalogForCalibration(items);
    expect(calibrateFromCatalog(catalog, 0.3)).toBeNull();
  });

  it('returns slope equal to input dpsPerIlvlPct', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      identity: String(i),
      slot: 'head',
      ilvl: 300 - i * 10,
      best_delta_pct: -i * 1.5,
    }));
    const catalog = fakeCatalogForCalibration(items, { head: 300 });
    const result = calibrateFromCatalog(catalog, 0.15);
    expect(result).not.toBeNull();
    expect(result!.slope).toBe(0.15);
  });

  it('returns zero maxResidualPct when model is a perfect fit', () => {
    // If predicted_delta = best_delta_pct exactly, residual = 0.
    // With dpsPerIlvlPct=0.15 and bestIlvl=300:
    //   item at ilvl 290 → predicted = (290-300)*0.15 = -1.5; best_delta_pct = -1.5 → residual = 0
    const items = Array.from({ length: 5 }, (_, i) => ({
      identity: String(i),
      slot: 'head',
      ilvl: 300 - i * 10,
      best_delta_pct: -(i * 10) * 0.15,
    }));
    const catalog = fakeCatalogForCalibration(items, { head: 300 });
    const result = calibrateFromCatalog(catalog, 0.15);
    expect(result!.maxResidualPct).toBeCloseTo(0, 10);
  });

  it('returns correct maxResidualPct for a known case', () => {
    // dpsPerIlvlPct=0.2, bestIlvl=300
    // item A: ilvl=290, predicted=(290-300)*0.2=-2, best_delta_pct=-3 → residual=|-2-(-3)|=1
    // item B: ilvl=280, predicted=(280-300)*0.2=-4, best_delta_pct=-4 → residual=0
    // maxResidual should be 1
    const catalog = fakeCatalogForCalibration(
      [
        { identity: 'A', slot: 'head', ilvl: 290, best_delta_pct: -3 },
        { identity: 'B', slot: 'head', ilvl: 280, best_delta_pct: -4 },
        { identity: 'C', slot: 'head', ilvl: 270, best_delta_pct: -6 },
        { identity: 'D', slot: 'head', ilvl: 260, best_delta_pct: -8 },
        { identity: 'E', slot: 'head', ilvl: 250, best_delta_pct: -10 },
      ],
      { head: 300 },
    );
    const result = calibrateFromCatalog(catalog, 0.2);
    expect(result).not.toBeNull();
    expect(result!.maxResidualPct).toBeCloseTo(1, 5);
  });

  it('uses item.ilvl as slotBestIlvl fallback when slot is absent from best_ilvl_by_slot', () => {
    // With no bestIlvl for 'chest', slotBestIlvl defaults to item.ilvl itself.
    // predicted = (item.ilvl - item.ilvl) * dpsPerIlvlPct = 0
    // residual = |0 - best_delta_pct|
    const catalog = fakeCatalogForCalibration(
      [
        { identity: '1', slot: 'chest', ilvl: 290, best_delta_pct: -2 },
        { identity: '2', slot: 'chest', ilvl: 280, best_delta_pct: -3 },
        { identity: '3', slot: 'chest', ilvl: 270, best_delta_pct: -1 },
        { identity: '4', slot: 'chest', ilvl: 260, best_delta_pct: -4 },
        { identity: '5', slot: 'chest', ilvl: 250, best_delta_pct: -5 },
      ],
      {}, // no bestIlvl for 'chest'
    );
    const result = calibrateFromCatalog(catalog, 0.3);
    expect(result).not.toBeNull();
    // All residuals = |0 - best_delta_pct| = |best_delta_pct|, max = 5
    expect(result!.maxResidualPct).toBeCloseTo(5, 5);
  });
});

// ---------------------------------------------------------------------------
// pruneSinglePool — calibration path (via pruneGearPool)
// ---------------------------------------------------------------------------

describe('pruneGearPool — calibrated pruning', () => {
  it('keeps all items when calibration is null (fallback to multiplier)', () => {
    // This is identical to the existing behavior — calibration=undefined → multiplier path
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 300 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 250 }),
      fakeItem({ slot: 'head', item_id: 3, ilvl: 200 }),
      fakeItem({ slot: 'head', item_id: 4, ilvl: 150 }), // dropped: 150*1.5=225 < 300
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS, multiplier: 1.5 });
    expect(prune.perSlot.head?.map((i) => i.item_id)).toEqual([1, 2, 3]);
  });

  it('keeps items whose predicted delta survives the hard floor', () => {
    // dpsPerIlvlPct=0.3, bestIlvlBySlot.head=300, maxResidualPct=0, safetyBuffer=0.5
    // hardFloor=3.0; effective floor = -(3.0 - 0 - 0.5) = -2.5% (before residual/buffer applied)
    // keep if: predictedDelta - 0 - 0.5 >= -3.0
    // i.e., predictedDelta >= -2.5
    // item at ilvl 291: predicted=(291-300)*0.3=-2.7 → -2.7 - 0.5 = -3.2 < -3.0 → drop
    // item at ilvl 293: predicted=(293-300)*0.3=-2.1 → -2.1 - 0.5 = -2.6 < -3.0 → drop
    // Wait — let me recalculate: keep if predictedDelta - maxResidual - safetyBuffer >= -hardFloor
    // = predictedDelta - 0 - 0.5 >= -3.0 = predictedDelta >= -2.5
    // ilvl 292: (292-300)*0.3 = -2.4 → -2.4 - 0.5 = -2.9 >= -3.0 ✓ (keep)
    // ilvl 290: (290-300)*0.3 = -3.0 → -3.0 - 0.5 = -3.5 < -3.0 ✗ (drop)
    const calibration: PrunerCalibration = {
      bestIlvlBySlot: { head: 300 },
      dpsPerIlvlPct: 0.3,
      maxResidualPct: 0,
      hardFloorPct: HARD_FLOOR_PCT,
      safetyBufferPct: 0.5,
    };
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 300 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 292 }),
      fakeItem({ slot: 'head', item_id: 3, ilvl: 290 }), // expected: dropped
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS, calibration });
    const ids = prune.perSlot.head?.map((i) => i.item_id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).not.toContain(3);
  });

  it('falls back to keeping all items when residual+buffer >= hardFloor', () => {
    // When maxResidualPct + safetyBufferPct >= hardFloorPct, over-pruning is likely.
    // The pruner should keep everything as a safety measure.
    const calibration: PrunerCalibration = {
      bestIlvlBySlot: { head: 300 },
      dpsPerIlvlPct: 0.3,
      maxResidualPct: 3.0,   // >= hardFloor (3.0)
      safetyBufferPct: 0.5,  // residual + buffer = 3.5 >= 3.0 → keep all
    };
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 300 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 200 }), // would be aggressively pruned otherwise
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS, calibration });
    expect(prune.perSlot.head).toHaveLength(2);
  });

  it('uses multiplier path for slots without bestIlvlBySlot entry', () => {
    // calibration is provided but 'chest' is absent from bestIlvlBySlot
    // → falls back to multiplier for that slot
    const calibration: PrunerCalibration = {
      bestIlvlBySlot: { head: 300 },  // no 'chest'
      dpsPerIlvlPct: 0.3,
      maxResidualPct: 0,
    };
    const parsed = exportWith([
      fakeItem({ slot: 'chest', item_id: 1, ilvl: 300 }),
      fakeItem({ slot: 'chest', item_id: 2, ilvl: 250 }),
      fakeItem({ slot: 'chest', item_id: 3, ilvl: 150 }), // dropped by 1.2x multiplier
    ]);
    const prune = pruneGearPool({
      parsed,
      weights: NO_WEIGHTS,
      multiplier: 1.2,
      calibration,
    });
    // 150 * 1.2 = 180 < 300 → dropped
    expect(prune.perSlot.chest?.map((i) => i.item_id)).not.toContain(3);
  });

  it('always returns at least one item even when calibration would prune everything', () => {
    // With a very large bestIlvl gap, all items would be predicted to lose badly.
    // The pruner must return at least the first eligible item.
    const calibration: PrunerCalibration = {
      bestIlvlBySlot: { head: 9999 }, // artificially high
      dpsPerIlvlPct: 1.0,
      maxResidualPct: 0,
      hardFloorPct: HARD_FLOOR_PCT,
      safetyBufferPct: 0.5,
    };
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 300 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 290 }),
    ]);
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS, calibration });
    expect(prune.perSlot.head).toHaveLength(1);
  });
});
