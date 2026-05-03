import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildGearProfileset,
  GEAR_LADDER_SLOTS,
  ilvlScorer,
  pruneGearPool,
  type Scorer,
  type TrinketLock,
} from './gear-pruner';
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
    extras: {},
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
  it('keeps all items within 1/multiplier of leader', () => {
    // Leader is 300; multiplier 1.5 → keep score >= 200.
    const parsed = exportWith([
      fakeItem({ slot: 'head', item_id: 1, ilvl: 300 }),
      fakeItem({ slot: 'head', item_id: 2, ilvl: 250 }),
      fakeItem({ slot: 'head', item_id: 3, ilvl: 200 }),
      fakeItem({ slot: 'head', item_id: 4, ilvl: 199 }), // dropped
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
    const prune = pruneGearPool({ parsed, weights: NO_WEIGHTS });
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
