/**
 * Quick-sim planner — the first gate every "Update sims" run hits.
 *
 * Three outcomes:
 *
 *   - `up_to_date`: pool unchanged since the last full sim AND we
 *     have a complete catalog. No SimC at all. Returned to the addon
 *     panel as "still current".
 *
 *   - `swap_test`: every new (unseen) item is in a slot we can
 *     cleanly swap-test against the cached best loadout. Returns the
 *     list of items + the resolved baseline ParsedItems so the runner
 *     can build a profileset script.
 *
 *   - `full_sim`: first run, OR a swap-incompatible new item appeared
 *     (typically a weapon configuration mismatch), OR the catalog is
 *     incomplete (missing best_loadout slots), OR the pool *shrank*
 *     in a way that invalidates the catalog (a previously-best item
 *     vanished). Caller falls through to the existing pipeline.
 *
 * Trinkets are NOT swap-tested here — the trinket cache (in
 * trinket-cache.ts) handles them. This planner explicitly excludes
 * trinket slots from its "unseen items" search; full-sim still kicks
 * off as needed when other gear is involved.
 */

import type { ParsedExport, ParsedItem } from './simc-export-parser';
import {
  findUnseenItems,
  fullPoolSignature,
  type GearCatalogEntry,
} from './gear-catalog';
import { swapTargetSlots } from './swap-test';

export type QuickSimDecision =
  | { kind: 'up_to_date'; reason: string; pool_signature: string }
  | {
      kind: 'swap_test';
      newItems: ParsedItem[];
      /** Resolved best-loadout ParsedItems by slot — the runner needs full
       * ParsedItems (with bonus_ids) to build the SimC baseline lines. */
      baselineItemBySlot: Record<string, ParsedItem>;
      reason: string;
    }
  | { kind: 'full_sim'; reason: string };

export interface PlanQuickSimOptions {
  parsed: ParsedExport;
  catalog: GearCatalogEntry | undefined;
}

/** Slots the gear ladder cares about. Trinkets handled by trinket cache. */
const NON_TRINKET_GEAR_SLOTS = new Set<string>([
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
  'main_hand',
  'off_hand',
  'ranged',
]);

export function planQuickSim(opts: PlanQuickSimOptions): QuickSimDecision {
  const { parsed, catalog } = opts;
  const pool_signature = fullPoolSignature(parsed);

  if (!catalog || Object.keys(catalog.best_loadout).length === 0) {
    return { kind: 'full_sim', reason: 'no catalog yet (first full sim)' };
  }

  // Pool unchanged since the last full sim — we can short-circuit
  // entirely. Note: trinket pool is part of the full pool signature
  // (trinkets ARE in equipped+bag), so trinket changes are detected
  // here and force a downstream re-evaluation. The trinket cache will
  // still optimize the trinket sim itself.
  if (catalog.last_pool_signature === pool_signature) {
    return {
      kind: 'up_to_date',
      reason: 'pool signature matches last full sim',
      pool_signature,
    };
  }

  // Pool changed. Walk the diff and decide.
  const unseen = findUnseenItems(parsed, catalog);

  // Pool changed but no NEW items? That means items were only
  // removed. Two sub-cases:
  //   - A previously-best item vanished → catalog is stale, full re-sim.
  //   - Only non-best (good/trash) items vanished → cache is still valid.
  // Re-derive by checking that every best_loadout slot's item is still
  // in the current pool.
  const currentIdentities = new Set(
    [...parsed.equipped, ...parsed.bag].map((i) => i.identity),
  );
  for (const slotInfo of Object.values(catalog.best_loadout)) {
    if (!currentIdentities.has(slotInfo.identity)) {
      return {
        kind: 'full_sim',
        reason: `best_loadout item "${slotInfo.name}" (slot ${slotInfo.slot}) no longer in pool`,
      };
    }
  }

  if (unseen.length === 0) {
    // Pool changed (e.g., a non-best ring was removed) but we still
    // know what's best — treat as up-to-date for the user's purposes,
    // just bump the signature so the next zero-change run is also
    // instant.
    return {
      kind: 'up_to_date',
      reason: 'only non-best items removed; cached best loadout still valid',
      pool_signature,
    };
  }

  // We have new items. Are they all in slots we can swap-test? Skip
  // anything in a slot we don't have a best for — for those we have
  // to fall back to a full sim. Likewise skip weapons when the
  // baseline configuration would be ambiguous (1H/2H mismatch).
  const swapSlotsAvailable = new Set(Object.keys(catalog.best_loadout));
  for (const item of unseen) {
    if (!NON_TRINKET_GEAR_SLOTS.has(item.slot)) {
      // Tabard, shirt, etc. — already filtered, but defensive.
      continue;
    }
    const targets = swapTargetSlots(item.slot);
    if (targets.length === 0) continue;
    // Every target slot must be present in best_loadout for the
    // swap to make sense (otherwise the baseline would be partial
    // and SimC results would be misleading).
    for (const t of targets) {
      if (!swapSlotsAvailable.has(t)) {
        return {
          kind: 'full_sim',
          reason: `new item "${item.name}" (slot ${item.slot}) needs swap target ${t} not in best_loadout`,
        };
      }
    }
    // Weapon configuration check. If item is main_hand/off_hand,
    // best_loadout must agree on whether we're 2H or 1H+OH. We can't
    // detect 2H vs 1H from the parser today, so any new weapon
    // forces full_sim. This is a known limitation noted in
    // gear-pruner.ts; revisit once we have an item-DB lookup.
    if (item.slot === 'main_hand' || item.slot === 'off_hand') {
      return {
        kind: 'full_sim',
        reason: `new weapon "${item.name}" — full sim needed (1H/2H config not detectable from parser)`,
      };
    }
  }

  // Resolve best_loadout identities → ParsedItems from the current
  // pool so the swap-test builder can render full SimC lines.
  const itemByIdentity = new Map<string, ParsedItem>();
  for (const it of [...parsed.equipped, ...parsed.bag]) {
    itemByIdentity.set(it.identity, it);
  }
  const baselineItemBySlot: Record<string, ParsedItem> = {};
  for (const [slot, slotInfo] of Object.entries(catalog.best_loadout)) {
    const item = itemByIdentity.get(slotInfo.identity);
    if (!item) {
      return {
        kind: 'full_sim',
        reason: `best_loadout slot ${slot} item missing from current pool (race?)`,
      };
    }
    baselineItemBySlot[slot] = item;
  }

  return {
    kind: 'swap_test',
    newItems: unseen,
    baselineItemBySlot,
    reason: `${unseen.length} new item(s) to swap-test against cached best loadout`,
  };
}
