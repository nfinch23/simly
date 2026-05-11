/**
 * Weapon-slot classification used by the swap-test profileset builder
 * and the OH-pairing sub-pruner. WoW physically locks out the off-hand
 * slot when a 2H weapon is equipped, so the sim profileset has to model
 * that lockout — otherwise SimC happily counts the off-hand's stats
 * even though the player can't wield both.
 *
 * Source: each item's `simly_equip_loc=INVTYPE_*` annotation, set by
 * the addon's `AnnotateEquipLoc` step in addon/Core/Export.lua.
 */

import type { ParsedItem } from '../simc-export-parser';

export type WeaponHand =
  | '2H'         // INVTYPE_2HWEAPON, INVTYPE_RANGED, INVTYPE_RANGEDRIGHT — locks off-hand
  | '1H_MH'      // INVTYPE_WEAPONMAINHAND — main_hand only
  | '1H_DUAL'    // INVTYPE_WEAPON — usable in either hand for dual-wield specs
  | 'OH'         // INVTYPE_HOLDABLE / INVTYPE_SHIELD / INVTYPE_WEAPONOFFHAND
  | 'NON_WEAPON'; // every other slot (and items without annotation)

export function classifyWeapon(item: ParsedItem): WeaponHand {
  const loc = item.extras['simly_equip_loc'];
  switch (loc) {
    case 'INVTYPE_2HWEAPON':
    case 'INVTYPE_RANGED':
    case 'INVTYPE_RANGEDRIGHT':
      return '2H';
    case 'INVTYPE_WEAPONMAINHAND':
      return '1H_MH';
    case 'INVTYPE_WEAPON':
      return '1H_DUAL';
    case 'INVTYPE_HOLDABLE':
    case 'INVTYPE_SHIELD':
    case 'INVTYPE_WEAPONOFFHAND':
      return 'OH';
    default:
      return 'NON_WEAPON';
  }
}

/**
 * Items eligible to fill the off-hand slot on a 1H + OH spec. Includes
 * dedicated off-hands AND dual-wieldable 1H weapons (a Fury Warrior or
 * Frost DK can put a 1H_DUAL sword in either MH or OH).
 */
export function canPairAsOH(item: ParsedItem): boolean {
  const c = classifyWeapon(item);
  return c === 'OH' || c === '1H_DUAL';
}

/**
 * Items eligible to fill the main_hand slot. Includes 2H weapons (which
 * also lock out OH), dedicated MH-only 1H weapons, and dual-wieldable
 * 1H weapons (which can be MH OR OH).
 */
export function canPairAsMH(item: ParsedItem): boolean {
  const c = classifyWeapon(item);
  return c === '2H' || c === '1H_MH' || c === '1H_DUAL';
}

/**
 * True when this main_hand item locks out the off-hand slot. The
 * profileset builder reads this and emits `off_hand=` (empty) for these
 * candidates.
 */
export function locksOffHand(item: ParsedItem): boolean {
  return classifyWeapon(item) === '2H';
}
