/**
 * Pure data-transformation helpers for assembling the addon-facing
 * SimlyResults shape. Extracted from scan-queue.ts to keep the queue
 * focused on orchestration and to make these functions independently
 * unit-testable (they have no electron / node-notifier / disk-IO
 * dependencies).
 *
 * Five functions:
 *   - composeFromScans / composeFromConsumableScans: build the
 *     ComposedLoadout view (gear + consumables + DPS) from a fresh
 *     scan collection plus the optional catalog fallback.
 *   - deriveGearFromCatalog: catalog.best_loadout → composed.gear
 *     mapper, used by the synthesize and quick-sim refresh paths.
 *   - synthesizeResultsFromCatalog: build a minimal but useful
 *     SimlyResults when the on-disk results file is missing or
 *     unparseable. Composed loadout from best_loadout; scans stubbed
 *     as 'done' at finishedAt.
 *   - refreshScanTimestamps: bump every scan record to 'done' at the
 *     given timestamp (preserving data fields), except 'failed' which
 *     stays as-is. Used by the quick-sim short-circuit to refresh the
 *     existing results file without redoing the actual work.
 */

import {
  RESULTS_SCHEMA_VERSION,
  type BestFlaskResult,
  type BestFoodResult,
  type BestPotionResult,
  type BestGemsResult,
  type BestEnchantsResult,
  type ComposedGearItem,
  type ComposedLoadout,
  type RingPreScanResult,
  type ScanCollection,
  type Scenario,
  type SimlyResults,
  type TrinketPreScanResult,
} from '@simly/shared';
import { buildCatalogSummary, type GearCatalogEntry } from './gear-catalog';

/**
 * Mark every scan record in a collection as 'done' at the new
 * timestamp. Preserves data fields verbatim — only status and
 * finished_at change. Pending scans become done (the short-circuit
 * means we believe everything is current); failed scans stay failed
 * since that's a real signal worth preserving.
 */
export function refreshScanTimestamps(
  scans: ScanCollection,
  finishedAt: number,
): ScanCollection {
  const out: ScanCollection = {};
  for (const [id, record] of Object.entries(scans)) {
    if (!record) continue;
    if (record.status === 'failed') {
      out[id] = record;
      continue;
    }
    out[id] = {
      ...record,
      status: 'done',
      finished_at: finishedAt,
    };
  }
  return out;
}

/**
 * Build a minimal SimlyResults from the catalog when the existing
 * results file is missing or unparseable. Composed loadout comes
 * from best_loadout; scans are stubbed as 'done' at finishedAt with
 * no data (the panel still shows the timestamp, just no per-scan
 * detail). This is a fallback — the happy path is reading +
 * refreshing the existing file.
 */
export function synthesizeResultsFromCatalog(opts: {
  catalog: GearCatalogEntry | undefined;
  characterKey: string;
  scenario: Scenario;
  simcVersion: string;
  finishedAt: number;
}): SimlyResults {
  // Build composed.gear from the catalog's best_loadout so the addon
  // panel can render the recommended gear list even when this is a
  // synthesized result (no fresh sim ran).
  const composed: ComposedLoadout | undefined = opts.catalog
    ? {
        label: 'Cached best loadout',
        expected_dps: opts.catalog.best_loadout_dps,
        gear: deriveGearFromCatalog(opts.catalog),
      }
    : undefined;

  return {
    schema_version: RESULTS_SCHEMA_VERSION,
    generated_at: opts.finishedAt,
    simc_version: opts.simcVersion,
    character_key: opts.characterKey,
    active_scenario: opts.scenario,
    scans: {
      stat_weights: { status: 'done', finished_at: opts.finishedAt },
      trinket_pre_scan: { status: 'done', finished_at: opts.finishedAt },
      gear_coarse: { status: 'done', finished_at: opts.finishedAt },
    },
    composed,
    catalog_summary: buildCatalogSummary(opts.catalog),
  };
}

/**
 * Map a catalog's best_loadout (per-slot winners) into the addon-facing
 * composed.gear shape. Used by the synthesize-from-catalog fallback
 * and the quick-sim refresh path so the panel always has gear data
 * to render even when no fresh sim ran.
 */
export function deriveGearFromCatalog(
  catalog: GearCatalogEntry | undefined,
): Record<string, ComposedGearItem> | undefined {
  if (!catalog || Object.keys(catalog.best_loadout).length === 0) return undefined;
  const out: Record<string, ComposedGearItem> = {};
  for (const [slot, info] of Object.entries(catalog.best_loadout)) {
    out[slot] = {
      item_id: info.item_id,
      name: info.name,
      ilvl: info.ilvl,
      identity: info.identity,
    };
  }
  return out;
}

/**
 * Phase 4e composer: combine consumables (flask/food) with the gear
 * ladder winner (per-slot best items) into the addon-facing
 * `composed` view. Prefers the most-accurate stage's winner:
 *   final > refined > coarse
 * Each later stage re-sims at higher iter on a tighter survivor set,
 * so its winner ranking is the most trustworthy. Falls back through
 * the chain when a stage failed or didn't run; falls back to the
 * catalog's last-known best_loadout when no gear scan ran at all
 * (e.g., a quick-sim short-circuit refresh).
 */
export function composeFromScans(
  scans: ScanCollection,
  catalog: GearCatalogEntry | undefined,
): ComposedLoadout | undefined {
  const flask = scans.best_flask?.data as BestFlaskResult | undefined;
  const food = scans.best_food?.data as BestFoodResult | undefined;
  const potion = scans.best_potion?.data as BestPotionResult | undefined;
  const gems = scans.best_gems?.data as BestGemsResult | undefined;
  const enchants = scans.best_enchants?.data as BestEnchantsResult | undefined;
  const gearScan = (scans.gear_final?.data ?? scans.gear_refined?.data ?? scans.gear_coarse?.data) as
    | { winner?: { items: ReadonlyArray<{ slot: string; item: { item_id: number; name: string; identity: string; ilvl: number } }>; mean_dps: number } }
    | undefined;

  const gear: Record<string, ComposedGearItem> = {};
  if (gearScan?.winner) {
    for (const ref of gearScan.winner.items) {
      gear[ref.slot] = {
        item_id: ref.item.item_id,
        name: ref.item.name,
        ilvl: ref.item.ilvl,
        identity: ref.item.identity,
      };
    }
  } else if (catalog?.best_loadout) {
    for (const [slot, slotInfo] of Object.entries(catalog.best_loadout)) {
      gear[slot] = {
        item_id: slotInfo.item_id,
        name: slotInfo.name,
        ilvl: slotInfo.ilvl,
        identity: slotInfo.identity,
      };
    }
  }

  // Merge the trinket pre-scan winner into composed.gear. Trinkets
  // aren't enumerated by the gear ladder (they're effect/proc-based —
  // can't stat-score them, must pair-sim), so they need their own
  // path into the addon's per-slot view. Only fill slots the gear
  // scan didn't already populate, so a future gear pipeline that
  // owns trinkets (unlikely) wouldn't be silently overridden.
  const trinketScan = scans.trinket_pre_scan?.data as TrinketPreScanResult | undefined;
  if (trinketScan?.winner) {
    if (!gear.trinket1) {
      gear.trinket1 = {
        item_id: trinketScan.winner.trinket1.item_id,
        name: trinketScan.winner.trinket1.name,
        ilvl: trinketScan.winner.trinket1.ilvl,
        identity: trinketScan.winner.trinket1.identity,
      };
    }
    if (!gear.trinket2) {
      gear.trinket2 = {
        item_id: trinketScan.winner.trinket2.item_id,
        name: trinketScan.winner.trinket2.name,
        ilvl: trinketScan.winner.trinket2.ilvl,
        identity: trinketScan.winner.trinket2.identity,
      };
    }
  }

  // Merge the ring pre-scan winner into composed.gear. Same rationale
  // as the trinket merge above — rings aren't enumerated by the gear
  // ladder (their effects/sockets can dominate over raw stat budgets),
  // so they get their own pair-sim + composer merge. Defensive ordering:
  // only fill slots the gear scan didn't already populate.
  const ringScan = scans.ring_pre_scan?.data as RingPreScanResult | undefined;
  if (ringScan?.winner) {
    if (!gear.finger1) {
      gear.finger1 = {
        item_id: ringScan.winner.finger1.item_id,
        name: ringScan.winner.finger1.name,
        ilvl: ringScan.winner.finger1.ilvl,
        identity: ringScan.winner.finger1.identity,
      };
    }
    if (!gear.finger2) {
      gear.finger2 = {
        item_id: ringScan.winner.finger2.item_id,
        name: ringScan.winner.finger2.name,
        ilvl: ringScan.winner.finger2.ilvl,
        identity: ringScan.winner.finger2.identity,
      };
    }
  }

  // Build per-slot enchant map for composed.enchants. Only includes
  // slots with a winning enchant scanned.
  let composedEnchants: Record<string, { enchant_id: number; name: string }> | undefined;
  if (enchants) {
    composedEnchants = {};
    for (const [slot, result] of Object.entries(enchants.per_slot)) {
      composedEnchants[slot] = {
        enchant_id: result.best.item_id,
        name: result.best.name,
      };
    }
  }

  const hasAnything = flask || food || potion || gems || enchants || Object.keys(gear).length > 0;
  if (!hasAnything) return undefined;
  return {
    label: 'Best loadout (single-target Patchwerk)',
    flask: flask?.best ? { item_id: flask.best.item_id, name: flask.best.name } : undefined,
    food: food?.best ? { item_id: food.best.item_id, name: food.best.name } : undefined,
    potion: potion?.best ? { item_id: potion.best.item_id, name: potion.best.name } : undefined,
    gems: gems?.best ? { item_id: gems.best.item_id, name: gems.best.name } : undefined,
    enchants: composedEnchants,
    gear: Object.keys(gear).length > 0 ? gear : undefined,
    expected_dps: gearScan?.winner?.mean_dps ?? catalog?.best_loadout_dps,
  };
}

/**
 * Back-compat alias. The old name was a Phase 3 v1-shim that only
 * combined consumables; we keep the symbol so out-of-tree usages
 * still resolve. New code should use composeFromScans directly.
 */
export function composeFromConsumableScans(
  scans: ScanCollection,
): ComposedLoadout | undefined {
  return composeFromScans(scans, undefined);
}
