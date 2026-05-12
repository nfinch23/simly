import { describe, expect, it } from 'vitest';
import {
  hashGearContext,
  replaceGearInProfile,
  setConsumablesInProfile,
} from './profile-builder';
import type { ParsedItem, SlotName } from './simc-export-parser';

function item(
  slot: SlotName,
  id: number,
  identity: string,
  ilvl = 270,
  bonus_ids: number[] = [],
): ParsedItem {
  return {
    slot,
    item_id: id,
    name: `item_${id}`,
    ilvl,
    bonus_ids,
    is_equipped: false,
    identity,
    extras: {},
  };
}

const SAMPLE_PROFILE = `warlock="Felfriend"
level=80
race=void_elf
spec=demonology
head=,id=100,bonus_id=1/2
neck=,id=101
shoulder=,id=102
chest=,id=103
main_hand=,id=200
off_hand=,id=201
# head=,id=999,bonus_id=99
# chest=,id=998`;

describe('replaceGearInProfile', () => {
  it('replaces an existing slot line in-place', () => {
    const newChest = item('chest', 555, 'NEW_CHEST', 285);
    const out = replaceGearInProfile(SAMPLE_PROFILE, { chest: newChest });
    expect(out).toContain('chest=,id=555');
    // Original chest=,id=103 must be gone.
    expect(out).not.toContain('chest=,id=103');
    // Other slots untouched.
    expect(out).toContain('head=,id=100');
    expect(out).toContain('neck=,id=101');
  });

  it('preserves commented bag-item lines', () => {
    const newChest = item('chest', 555, 'NEW_CHEST');
    const out = replaceGearInProfile(SAMPLE_PROFILE, { chest: newChest });
    expect(out).toContain('# head=,id=999');
    expect(out).toContain('# chest=,id=998');
  });

  it('preserves non-slot lines (talents, race, spec)', () => {
    const out = replaceGearInProfile(SAMPLE_PROFILE, {});
    expect(out).toContain('warlock="Felfriend"');
    expect(out).toContain('level=80');
    expect(out).toContain('race=void_elf');
    expect(out).toContain('spec=demonology');
  });

  it('appends slots not present in the original profile', () => {
    // SAMPLE_PROFILE has no `legs=` line. Add one.
    const newLegs = item('legs', 777, 'NEW_LEGS');
    const out = replaceGearInProfile(SAMPLE_PROFILE, { legs: newLegs });
    expect(out).toContain('legs=,id=777');
  });

  it('drops off_hand= when new gear is 2H (main_hand present, off_hand absent)', () => {
    const new2H = item('main_hand', 999, 'NEW_2H');
    const out = replaceGearInProfile(SAMPLE_PROFILE, { main_hand: new2H });
    expect(out).toContain('main_hand=,id=999');
    // Original off_hand line must be gone — leaving it would
    // double-count stats since SimC treats 2H + OH as both equipped.
    expect(out).not.toMatch(/^off_hand=/m);
  });

  it('preserves off_hand= when new gear keeps it (1H + OH case)', () => {
    const newMH = item('main_hand', 999, 'NEW_MH');
    const newOH = item('off_hand', 998, 'NEW_OH');
    const out = replaceGearInProfile(SAMPLE_PROFILE, {
      main_hand: newMH,
      off_hand: newOH,
    });
    expect(out).toContain('main_hand=,id=999');
    expect(out).toContain('off_hand=,id=998');
    expect(out).not.toContain('main_hand=,id=200');
    expect(out).not.toContain('off_hand=,id=201');
  });

  it('does not mutate the input string', () => {
    const original = SAMPLE_PROFILE;
    replaceGearInProfile(SAMPLE_PROFILE, {
      chest: item('chest', 555, 'X'),
    });
    expect(SAMPLE_PROFILE).toBe(original);
  });

  it('formats new items with bonus_ids when present', () => {
    const newChest = item('chest', 555, 'X', 285, [10, 20, 30]);
    const out = replaceGearInProfile(SAMPLE_PROFILE, { chest: newChest });
    expect(out).toContain('chest=,id=555,bonus_id=10/20/30');
  });

  it('preserves ranged= line if present and not in new gear', () => {
    const profileWithRanged = SAMPLE_PROFILE + '\nranged=,id=400';
    const out = replaceGearInProfile(profileWithRanged, {
      chest: item('chest', 555, 'X'),
    });
    expect(out).toContain('ranged=,id=400');
  });

  it('handles empty gear input as a no-op (returns equivalent profile)', () => {
    const out = replaceGearInProfile(SAMPLE_PROFILE, {});
    // All original lines must still be there.
    expect(out).toContain('head=,id=100');
    expect(out).toContain('off_hand=,id=201');
    expect(out).toContain('# head=,id=999');
  });
});

describe('setConsumablesInProfile', () => {
  it('appends flask= when profile has none', () => {
    const out = setConsumablesInProfile(SAMPLE_PROFILE, {
      flask: 'flask_of_alchemical_chaos_3',
    });
    expect(out).toContain('flask=flask_of_alchemical_chaos_3');
  });

  it('appends food= when profile has none', () => {
    const out = setConsumablesInProfile(SAMPLE_PROFILE, {
      food: 'feast_of_the_divine_day',
    });
    expect(out).toContain('food=feast_of_the_divine_day');
  });

  it('appends both flask and food', () => {
    const out = setConsumablesInProfile(SAMPLE_PROFILE, {
      flask: 'flask_a',
      food: 'food_b',
    });
    expect(out).toContain('flask=flask_a');
    expect(out).toContain('food=food_b');
  });

  it('replaces existing flask= line', () => {
    const withFlask = SAMPLE_PROFILE + '\nflask=old_flask';
    const out = setConsumablesInProfile(withFlask, { flask: 'new_flask' });
    expect(out).toContain('flask=new_flask');
    expect(out).not.toContain('flask=old_flask');
    // Should appear once, not duplicated.
    const matches = out.match(/^flask=/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('replaces existing food= line', () => {
    const withFood = SAMPLE_PROFILE + '\nfood=old_food';
    const out = setConsumablesInProfile(withFood, { food: 'new_food' });
    expect(out).toContain('food=new_food');
    expect(out).not.toContain('food=old_food');
  });

  it('removes existing flask= line when flask is undefined', () => {
    const withFlask = SAMPLE_PROFILE + '\nflask=existing';
    const out = setConsumablesInProfile(withFlask, {});
    expect(out).not.toContain('flask=existing');
  });

  it('does not touch flask= when neither flask nor food specified and none present', () => {
    const out = setConsumablesInProfile(SAMPLE_PROFILE, {});
    expect(out).toBe(SAMPLE_PROFILE);
  });

  it('does not mutate the input string', () => {
    const original = SAMPLE_PROFILE;
    setConsumablesInProfile(SAMPLE_PROFILE, { flask: 'x' });
    expect(SAMPLE_PROFILE).toBe(original);
  });

  it('preserves commented lines and non-flask/food lines verbatim', () => {
    const out = setConsumablesInProfile(SAMPLE_PROFILE, { flask: 'new' });
    expect(out).toContain('warlock="Felfriend"');
    expect(out).toContain('# head=,id=999');
    expect(out).toContain('head=,id=100');
  });
});

describe('hashGearContext', () => {
  it('produces stable hash for the same gear', () => {
    const gear = {
      chest: item('chest', 100, 'A'),
      legs: item('legs', 200, 'B'),
    };
    expect(hashGearContext(gear)).toBe(hashGearContext(gear));
  });

  it('produces different hashes for different gear', () => {
    const gear1 = { chest: item('chest', 100, 'A') };
    const gear2 = { chest: item('chest', 100, 'B') }; // different identity
    expect(hashGearContext(gear1)).not.toBe(hashGearContext(gear2));
  });

  it('is order-independent (hash depends on slot mapping, not insertion order)', () => {
    const gear1: Record<string, ParsedItem> = {
      chest: item('chest', 100, 'A'),
      legs: item('legs', 200, 'B'),
    };
    const gear2: Record<string, ParsedItem> = {
      legs: item('legs', 200, 'B'),
      chest: item('chest', 100, 'A'),
    };
    expect(hashGearContext(gear1)).toBe(hashGearContext(gear2));
  });

  it('treats empty/missing slots the same as undefined', () => {
    const gear1 = { chest: item('chest', 100, 'A') };
    const gear2 = { chest: item('chest', 100, 'A'), legs: undefined };
    expect(hashGearContext(gear1)).toBe(hashGearContext(gear2));
  });

  it('produces different hashes for swapped items between slots', () => {
    // Same items but swapped slots → different hash (slot matters).
    const A = item('chest', 100, 'X');
    const B = item('legs', 200, 'Y');
    const gear1 = { chest: A, legs: B };
    const gear2 = {
      chest: { ...B, slot: 'chest' as SlotName },
      legs: { ...A, slot: 'legs' as SlotName },
    };
    expect(hashGearContext(gear1)).not.toBe(hashGearContext(gear2));
  });
});
