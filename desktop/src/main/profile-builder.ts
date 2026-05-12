/**
 * Profile-rewriting helpers for the two-pass stat-reconverge pipeline.
 *
 * SimC profileset inheritance means every gear / trinket / stat-weight
 * scan ultimately runs against a parent profile (the actor's class +
 * race + talents + equipped items + consumables). Most scan stages
 * already accept a `baseProfile: string`; they don't care WHAT's in it.
 *
 * Slice 2 of two-pass-stat-reconverge needs to:
 *   - run pass-1 scans with locked consumables (flask + food appended)
 *   - run end-of-pass-1 diagnostics (stat-weights re-run, consumables
 *     re-eval) against the converged actor (gear swapped to gear_v1)
 *   - run pass-2 scans with both new gear AND new locks
 *
 * Two pure helpers below do all the string manipulation. Everything else
 * (gear-greedy-pipeline, trinket-pre-scan, stat-weights) stays unchanged.
 */

import type { ParsedItem, SlotName } from './simc-export-parser';
import { formatItemLine } from './simc-export-parser';

/**
 * Slots a converged-gear rewrite touches. Excludes cosmetic slots
 * (tabard, shirt) since those have zero DPS impact and aren't part of
 * any loadout we'd ever optimize against. Includes finger1/finger2 and
 * trinket1/trinket2 since the converged loadout fills paired slots.
 */
const REWRITABLE_SLOTS: readonly SlotName[] = [
  'head',
  'neck',
  'shoulder',
  'back',
  'chest',
  'wrist',
  'hands',
  'waist',
  'legs',
  'feet',
  'finger1',
  'finger2',
  'trinket1',
  'trinket2',
  'main_hand',
  'off_hand',
  'ranged',
] as const;

const REWRITABLE_SET = new Set<string>(REWRITABLE_SLOTS);

/**
 * Replace the equipped-item lines in `baseProfile` with the items in
 * `gear`. The original profile may have items in any of REWRITABLE_SLOTS;
 * for each slot present in `gear`, the matching line is overwritten.
 *
 * Special cases:
 *   - Slots in `gear` that DON'T exist in baseProfile: appended at end.
 *   - Slots in baseProfile that DON'T exist in `gear`: left alone EXCEPT
 *     when the new loadout has `main_hand` but no `off_hand` (2H case) —
 *     the off_hand= line is then removed to avoid SimC double-counting.
 *   - Commented "# slot=..." lines (bag items) are never touched.
 *   - Non-slot lines (talents, race, flask=, food=, etc.) are preserved
 *     in original order.
 *
 * The result is a new string; `baseProfile` is not mutated.
 */
export function replaceGearInProfile(
  baseProfile: string,
  gear: Record<string, ParsedItem>,
): string {
  const lines = baseProfile.split('\n');
  const handledSlots = new Set<string>();
  const result: string[] = [];

  // Detect 2H: main_hand present in gear but off_hand absent.
  const is2H =
    gear['main_hand'] !== undefined && gear['off_hand'] === undefined;

  for (const line of lines) {
    // Preserve commented lines (bag items) verbatim.
    if (line.startsWith('#')) {
      result.push(line);
      continue;
    }

    // Match `<slot>=...` at the start of an uncommented line.
    const m = line.match(/^([a-z_]+)=/);
    if (!m) {
      result.push(line);
      continue;
    }
    const slot = m[1]!;

    if (!REWRITABLE_SET.has(slot)) {
      // Not a gear slot (e.g. flask=, race=, level=, spec=) — preserve.
      result.push(line);
      continue;
    }

    // 2H case: drop the original off_hand= line entirely. The converged
    // 2H actor has no off-hand; leaving the line in would let SimC keep
    // double-counting stats.
    if (slot === 'off_hand' && is2H) {
      handledSlots.add(slot);
      continue;
    }

    const newItem = gear[slot];
    if (newItem) {
      result.push(formatItemLine(newItem, slot as SlotName));
      handledSlots.add(slot);
    } else {
      // Slot exists in baseProfile but not in new gear: preserve old
      // line. Common case: the original profile had a ranged item the
      // gear search doesn't track.
      result.push(line);
    }
  }

  // Append any new-gear slots that weren't already in the profile.
  for (const [slot, item] of Object.entries(gear)) {
    if (handledSlots.has(slot)) continue;
    if (!REWRITABLE_SET.has(slot)) continue;
    // Skip off_hand for 2H — already handled above.
    if (slot === 'off_hand' && is2H) continue;
    result.push(formatItemLine(item, slot as SlotName));
  }

  return result.join('\n');
}

/**
 * Set (or replace) the `flask=` and/or `food=` lines in a baseProfile.
 *
 * SimC profile semantics: a child profileset inherits the parent's
 * flask/food unless it overrides them. So locking a flask for the
 * whole gear search is just: append `flask=<simc_key>` to the parent
 * profile. Every profileset below inherits it.
 *
 * If `flask` is undefined, no flask line is added (and any existing
 * flask= line is removed — convention: undefined = no flask). Same for
 * food.
 *
 * Returns a new string; input is not mutated.
 */
export function setConsumablesInProfile(
  baseProfile: string,
  consumables: { flask?: string; food?: string },
): string {
  const lines = baseProfile.split('\n');
  const result: string[] = [];
  let flaskHandled = false;
  let foodHandled = false;

  for (const line of lines) {
    if (line.startsWith('#')) {
      result.push(line);
      continue;
    }
    if (/^flask=/.test(line)) {
      if (consumables.flask !== undefined) {
        result.push(`flask=${consumables.flask}`);
      }
      flaskHandled = true;
      continue;
    }
    if (/^food=/.test(line)) {
      if (consumables.food !== undefined) {
        result.push(`food=${consumables.food}`);
      }
      foodHandled = true;
      continue;
    }
    result.push(line);
  }

  if (!flaskHandled && consumables.flask !== undefined) {
    result.push(`flask=${consumables.flask}`);
  }
  if (!foodHandled && consumables.food !== undefined) {
    result.push(`food=${consumables.food}`);
  }

  return result.join('\n');
}

/**
 * Produce a stable hash of a gear loadout for use as a cache key axis.
 *
 * The hash incorporates each slot's item identity (the parser's stable
 * `<item_id>:<bonus_ids>:<crafted_stats>` form). Slot order is fixed
 * for determinism; missing slots are encoded as empty strings.
 *
 * Pass-1 trinket prescans use a synthetic "baseline" hash that's stable
 * for the user's equipped gear. Pass-2 prescans use a hash computed
 * from the converged loadout. Cache hits across passes only when both
 * gear context AND trinket pool match.
 */
export function hashGearContext(
  gear: Record<string, ParsedItem | undefined>,
): string {
  const parts: string[] = [];
  for (const slot of REWRITABLE_SLOTS) {
    parts.push(`${slot}:${gear[slot]?.identity ?? ''}`);
  }
  // FNV-1a 32-bit, same scheme as breakpoint-search's comboHash for
  // stylistic consistency. Hash size is fine for cache keys.
  const input = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
