import { describe, expect, it } from 'vitest';
import {
  applyComboToLoadout,
  generateCombos,
  loadoutToBestLoadoutSlots,
} from './breakpoint-search';
import type { ParsedItem, SlotName } from '../simc-export-parser';

function makeItem(slot: SlotName, identity: string, ilvl = 270): ParsedItem {
  return {
    slot,
    item_id: 1,
    name: `Item ${identity}`,
    ilvl,
    bonus_ids: [],
    is_equipped: false,
    identity,
    extras: {},
  };
}

describe('generateCombos', () => {
  it('returns no combos for empty input', () => {
    expect(generateCombos([])).toEqual([]);
  });

  it('returns no combos for a single item (need at least 2)', () => {
    expect(generateCombos([makeItem('chest', 'A')])).toEqual([]);
  });

  it('generates a single 2-item combo for two different-slot items', () => {
    const combos = generateCombos([
      makeItem('chest', 'A'),
      makeItem('legs', 'B'),
    ]);
    // Pair only (only 2 items so no triples possible).
    expect(combos).toHaveLength(1);
    expect(combos[0]!.id).toMatch(/^bp2_/);
    expect(combos[0]!.swaps).toEqual({
      chest: expect.objectContaining({ identity: 'A' }),
      legs: expect.objectContaining({ identity: 'B' }),
    });
  });

  it('rejects same-slot pairs for non-paired slots', () => {
    const combos = generateCombos([
      makeItem('chest', 'A'),
      makeItem('chest', 'B'),
    ]);
    expect(combos).toEqual([]);
  });

  it('allows ring pairs to occupy finger1 + finger2', () => {
    const combos = generateCombos([
      makeItem('finger1', 'A'),
      makeItem('finger2', 'B'),
    ]);
    expect(combos).toHaveLength(1);
    expect(combos[0]!.swaps).toHaveProperty('finger1');
    expect(combos[0]!.swaps).toHaveProperty('finger2');
  });

  it('allows trinket pairs to occupy trinket1 + trinket2', () => {
    const combos = generateCombos([
      makeItem('trinket1', 'A'),
      makeItem('trinket1', 'B'),
    ]);
    expect(combos).toHaveLength(1);
    expect(combos[0]!.swaps).toHaveProperty('trinket1');
    expect(combos[0]!.swaps).toHaveProperty('trinket2');
  });

  it('generates pairs AND triples for 3 different-slot items', () => {
    const combos = generateCombos([
      makeItem('chest', 'A'),
      makeItem('legs', 'B'),
      makeItem('gloves', 'C'),
    ]);
    // C(3,2)=3 pairs + C(3,3)=1 triple = 4 total
    expect(combos.filter((c) => c.id.startsWith('bp2_'))).toHaveLength(3);
    expect(combos.filter((c) => c.id.startsWith('bp3_'))).toHaveLength(1);
  });

  it('produces deterministic combo ids regardless of input order', () => {
    const a = makeItem('chest', 'A');
    const b = makeItem('legs', 'B');
    const c1 = generateCombos([a, b]);
    const c2 = generateCombos([b, a]);
    expect(c1[0]!.id).toBe(c2[0]!.id);
  });

  it('skips triples when rejected pool size > 15', () => {
    const items: ParsedItem[] = [];
    // 16 items in different slots — 16 > MAX_REJECTED_FOR_TRIPLES (15)
    const slots: SlotName[] = [
      'head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist',
      'legs', 'feet', 'finger1', 'finger2', 'trinket1', 'trinket2', 'main_hand', 'off_hand',
    ];
    for (let i = 0; i < 16; i++) items.push(makeItem(slots[i]!, `id${i}`));
    const combos = generateCombos(items);
    // Should only have pairs.
    expect(combos.every((c) => c.id.startsWith('bp2_'))).toBe(true);
  });
});

describe('applyComboToLoadout', () => {
  it('applies the combo swaps to the loadout', () => {
    const loadout: Record<string, ParsedItem> = {
      chest: makeItem('chest', 'EQ_C', 270),
      legs: makeItem('legs', 'EQ_L', 270),
      gloves: makeItem('gloves', 'EQ_G', 270),
    };
    const combo = {
      id: 'bp2_xyz',
      swaps: {
        chest: makeItem('chest', 'NEW_C', 280),
        legs: makeItem('legs', 'NEW_L', 285),
      },
    };
    const out = applyComboToLoadout(loadout, combo);
    expect(out['chest']!.identity).toBe('NEW_C');
    expect(out['legs']!.identity).toBe('NEW_L');
    expect(out['gloves']!.identity).toBe('EQ_G'); // untouched
  });

  it('does not mutate the input loadout', () => {
    const loadout: Record<string, ParsedItem> = {
      chest: makeItem('chest', 'EQ_C'),
    };
    const combo = {
      id: 'bp_x',
      swaps: { chest: makeItem('chest', 'NEW') },
    };
    applyComboToLoadout(loadout, combo);
    expect(loadout['chest']!.identity).toBe('EQ_C');
  });
});

describe('loadoutToBestLoadoutSlots', () => {
  it('converts ParsedItem map to BestLoadoutSlot map', () => {
    const loadout = {
      chest: makeItem('chest', 'A', 280),
    };
    const out = loadoutToBestLoadoutSlots(loadout);
    expect(out['chest']).toEqual({
      slot: 'chest',
      item_id: 1,
      name: 'Item A',
      identity: 'A',
      ilvl: 280,
    });
  });
});
