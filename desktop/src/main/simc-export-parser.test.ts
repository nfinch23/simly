import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSimcExport,
  makeItemIdentity,
  formatItemLine,
  getTrinketPool,
  allUnorderedPairs,
  type ParsedExport,
} from './simc-export-parser';

const FIXTURE_PATH = join(__dirname, '__fixtures__', 'felfriend-export.simc');

let parsed: ParsedExport;
function getParsed(): ParsedExport {
  if (!parsed) {
    const source = readFileSync(FIXTURE_PATH, 'utf8');
    parsed = parseSimcExport(source);
  }
  return parsed;
}

describe('parseSimcExport — character header', () => {
  it('extracts class + name from the warlock="..." line', () => {
    const p = getParsed();
    expect(p.character.class).toBe('warlock');
    expect(p.character.name).toBe('Felfriend');
  });

  it('extracts level / race / region / server / spec / role', () => {
    const p = getParsed();
    expect(p.character.level).toBe(90);
    expect(p.character.race).toBe('nightborne');
    expect(p.character.region).toBe('us');
    expect(p.character.server).toBe('zuljin');
    expect(p.character.spec).toBe('demonology');
    expect(p.character.role).toBe('spell');
  });
});

describe('parseSimcExport — equipped items', () => {
  it('parses all 16 equipped slots from the fixture', () => {
    const p = getParsed();
    const slots = p.equipped.map((i) => i.slot).sort();
    // Felfriend is wearing 16 items (no shirt/tabard/ranged).
    expect(p.equipped.length).toBeGreaterThanOrEqual(16);
    expect(slots).toContain('head');
    expect(slots).toContain('main_hand');
    expect(slots).toContain('off_hand');
    expect(slots).toContain('finger1');
    expect(slots).toContain('finger2');
    expect(slots).toContain('trinket1');
    expect(slots).toContain('trinket2');
  });

  it('flags equipped items with is_equipped=true', () => {
    const p = getParsed();
    expect(p.equipped.every((i) => i.is_equipped)).toBe(true);
  });

  it('parses item_id + bonus_ids for the head slot (Abyssal Immolator helm)', () => {
    const p = getParsed();
    const head = p.equipped.find((i) => i.slot === 'head');
    expect(head).toBeDefined();
    expect(head!.item_id).toBe(250042);
    expect(head!.name).toBe("Abyssal Immolator's Smoldering Flames");
    expect(head!.ilvl).toBe(272);
    expect(head!.bonus_ids).toEqual([6652, 12801, 13534, 13440, 13338, 13575, 3157]);
  });

  it('parses crafted_stats + crafting_quality for the back slot (Adherent\'s Silken Shroud)', () => {
    const p = getParsed();
    const back = p.equipped.find((i) => i.slot === 'back');
    expect(back).toBeDefined();
    expect(back!.crafted_stats).toEqual([40, 36]);
    expect(back!.crafting_quality).toBe(5);
  });
});

describe('parseSimcExport — bag items', () => {
  it('parses items from the "### Gear from Bags" section', () => {
    const p = getParsed();
    expect(p.bag.length).toBeGreaterThan(0);
    expect(p.bag.every((i) => !i.is_equipped)).toBe(true);
  });

  it('finds both Lightbinder Shoulderguards (272 + 276 ilvl variants)', () => {
    const p = getParsed();
    const shoulders = p.bag.filter(
      (i) => i.slot === 'shoulder' && i.name.startsWith('Lightbinder'),
    );
    expect(shoulders).toHaveLength(2);
    const ilvls = shoulders.map((s) => s.ilvl).sort();
    expect(ilvls).toEqual([272, 276]);
  });

  it('parses drop_level when present (Threadbare Mitts)', () => {
    const p = getParsed();
    const mitts = p.bag.find((i) => i.name === 'Threadbare Mitts');
    expect(mitts).toBeDefined();
    expect(mitts!.drop_level).toBe(90);
    expect(mitts!.bonus_ids).toEqual([13611]);
  });

  it('does NOT parse the commented "Saved Loadout" lines as items', () => {
    const p = getParsed();
    const fakeItems = p.bag.filter((i) => i.slot === ('talents' as never));
    expect(fakeItems).toHaveLength(0);
  });
});

describe('parseSimcExport — poolBySlot', () => {
  it('groups equipped + bag items by slot', () => {
    const p = getParsed();
    const shoulderPool = p.poolBySlot.shoulder ?? [];
    // 1 equipped + multiple variants in the bag
    expect(shoulderPool.length).toBeGreaterThan(1);
    expect(shoulderPool.some((i) => i.is_equipped)).toBe(true);
    expect(shoulderPool.some((i) => !i.is_equipped)).toBe(true);
  });
});

describe('formatItemLine', () => {
  it('round-trips a parsed equipped item back to its original SimC line shape', () => {
    const p = getParsed();
    const head = p.equipped.find((i) => i.slot === 'head')!;
    const line = formatItemLine(head);
    expect(line).toMatch(/^head=,id=250042,bonus_id=6652\/12801\/13534\/13440\/13338\/13575\/3157$/);
  });

  it('includes crafted_stats and crafting_quality when present', () => {
    const p = getParsed();
    const back = p.equipped.find((i) => i.slot === 'back')!;
    const line = formatItemLine(back);
    expect(line).toContain('crafted_stats=40/36');
    expect(line).toContain('crafting_quality=5');
  });

  it('lets caller override the slot name (ring/trinket pool routing)', () => {
    const p = getParsed();
    const head = p.equipped.find((i) => i.slot === 'head')!;
    const asTrinket = formatItemLine(head, 'trinket1');
    expect(asTrinket.startsWith('trinket1=,id=')).toBe(true);
  });
});

describe('getTrinketPool', () => {
  it('dedupes by identity but keeps separate ilvl variants of the same item_id', () => {
    const p = getParsed();
    const trinkets = getTrinketPool(p);
    // Felfriend has 2 equipped + several in the bag; identities should
    // all be unique.
    const identities = new Set(trinkets.map((t) => t.identity));
    expect(identities.size).toBe(trinkets.length);
    // Includes both equipped trinkets
    expect(trinkets.some((t) => t.name.includes('Gaze of the Alnseer'))).toBe(true);
    expect(trinkets.some((t) => t.name.includes('Heart of Wind'))).toBe(true);
  });
});

describe('allUnorderedPairs', () => {
  it('yields n*(n-1)/2 pairs in stable index order', () => {
    const items: number[] = [10, 20, 30, 40];
    const pairs = Array.from(allUnorderedPairs(items));
    expect(pairs).toEqual([
      [10, 20],
      [10, 30],
      [10, 40],
      [20, 30],
      [20, 40],
      [30, 40],
    ]);
  });

  it('yields nothing for empty or single-element arrays', () => {
    expect(Array.from(allUnorderedPairs([]))).toEqual([]);
    expect(Array.from(allUnorderedPairs(['x']))).toEqual([]);
  });
});

describe('makeItemIdentity', () => {
  it('produces stable identity regardless of bonus_id order', () => {
    const a = makeItemIdentity(250042, [6652, 12801, 13534], undefined);
    const b = makeItemIdentity(250042, [13534, 6652, 12801], undefined);
    expect(a).toBe(b);
  });

  it('treats different bonus_ids as different identities (crest-upgraded item)', () => {
    const base = makeItemIdentity(258578, [12801, 13440, 6652, 13577, 12699], undefined);
    const upgraded = makeItemIdentity(258578, [13440, 6652, 13577, 12699, 12798], undefined);
    expect(base).not.toBe(upgraded);
  });

  it('includes crafted_stats in the identity', () => {
    const a = makeItemIdentity(239656, [12214, 13667], [40, 36]);
    const b = makeItemIdentity(239656, [12214, 13667], [40, 32]);
    expect(a).not.toBe(b);
  });
});
