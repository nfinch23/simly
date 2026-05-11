import { describe, expect, it } from 'vitest';
import { canPairAsMH, canPairAsOH, classifyWeapon, locksOffHand } from './weapon-config';
import type { ParsedItem, SlotName } from '../simc-export-parser';

function item(slot: SlotName, equipLoc: string | undefined): ParsedItem {
  const extras: Record<string, string> = {};
  if (equipLoc) extras['simly_equip_loc'] = equipLoc;
  return {
    slot,
    item_id: 1,
    name: 'X',
    ilvl: 270,
    bonus_ids: [],
    is_equipped: false,
    identity: 'x',
    extras,
  };
}

describe('classifyWeapon', () => {
  it('classifies 2H weapons by INVTYPE_2HWEAPON', () => {
    expect(classifyWeapon(item('main_hand', 'INVTYPE_2HWEAPON'))).toBe('2H');
  });

  it('classifies hunter ranged weapons as 2H (they also lock the off-hand)', () => {
    expect(classifyWeapon(item('main_hand', 'INVTYPE_RANGED'))).toBe('2H');
    expect(classifyWeapon(item('main_hand', 'INVTYPE_RANGEDRIGHT'))).toBe('2H');
  });

  it('classifies main-hand-only 1H weapons as 1H_MH', () => {
    expect(classifyWeapon(item('main_hand', 'INVTYPE_WEAPONMAINHAND'))).toBe('1H_MH');
  });

  it('classifies dual-wieldable 1H weapons as 1H_DUAL', () => {
    expect(classifyWeapon(item('main_hand', 'INVTYPE_WEAPON'))).toBe('1H_DUAL');
  });

  it('classifies off-hands (holdable, shield, off-hand-only weapon) as OH', () => {
    expect(classifyWeapon(item('off_hand', 'INVTYPE_HOLDABLE'))).toBe('OH');
    expect(classifyWeapon(item('off_hand', 'INVTYPE_SHIELD'))).toBe('OH');
    expect(classifyWeapon(item('off_hand', 'INVTYPE_WEAPONOFFHAND'))).toBe('OH');
  });

  it('returns NON_WEAPON for unknown or missing equipLoc', () => {
    expect(classifyWeapon(item('chest', 'INVTYPE_CHEST'))).toBe('NON_WEAPON');
    expect(classifyWeapon(item('main_hand', undefined))).toBe('NON_WEAPON');
  });
});

describe('canPairAsOH', () => {
  it('accepts dedicated off-hands', () => {
    expect(canPairAsOH(item('off_hand', 'INVTYPE_HOLDABLE'))).toBe(true);
    expect(canPairAsOH(item('off_hand', 'INVTYPE_SHIELD'))).toBe(true);
  });

  it('accepts dual-wieldable 1H weapons', () => {
    expect(canPairAsOH(item('main_hand', 'INVTYPE_WEAPON'))).toBe(true);
  });

  it('rejects 2H weapons', () => {
    expect(canPairAsOH(item('main_hand', 'INVTYPE_2HWEAPON'))).toBe(false);
  });

  it('rejects MH-only 1H weapons', () => {
    expect(canPairAsOH(item('main_hand', 'INVTYPE_WEAPONMAINHAND'))).toBe(false);
  });
});

describe('canPairAsMH', () => {
  it('accepts 2H, 1H_MH, and 1H_DUAL', () => {
    expect(canPairAsMH(item('main_hand', 'INVTYPE_2HWEAPON'))).toBe(true);
    expect(canPairAsMH(item('main_hand', 'INVTYPE_WEAPONMAINHAND'))).toBe(true);
    expect(canPairAsMH(item('main_hand', 'INVTYPE_WEAPON'))).toBe(true);
  });

  it('rejects pure off-hands', () => {
    expect(canPairAsMH(item('off_hand', 'INVTYPE_SHIELD'))).toBe(false);
    expect(canPairAsMH(item('off_hand', 'INVTYPE_HOLDABLE'))).toBe(false);
  });
});

describe('locksOffHand', () => {
  it('returns true only for 2H weapons', () => {
    expect(locksOffHand(item('main_hand', 'INVTYPE_2HWEAPON'))).toBe(true);
    expect(locksOffHand(item('main_hand', 'INVTYPE_RANGED'))).toBe(true);
    expect(locksOffHand(item('main_hand', 'INVTYPE_WEAPON'))).toBe(false);
    expect(locksOffHand(item('main_hand', 'INVTYPE_WEAPONMAINHAND'))).toBe(false);
  });
});
