/**
 * Persistent per-character gear catalog.
 *
 * Two purposes:
 *
 *   1. Drive the quick-sim gate (planQuickSim in quick-sim.ts):
 *      - "Pool unchanged" detection via `last_pool_signature`.
 *      - "What's new in the bag" diff via `seen_items`.
 *      - "What's the current best loadout to swap-test against" via
 *        `best_loadout`.
 *
 *   2. Build up institutional memory across sims so the user (and
 *      Phase 5 UI) can see what's actually trash, what might still be
 *      contextually useful, and what currently wins each slot —
 *      without having to re-derive that from raw scan results.
 *
 * Status taxonomy for each seen item:
 *   - `best`     — currently in best_loadout for its slot.
 *   - `good`     — within `good_threshold_pct` (default 1%) of best.
 *                  Could win in a different stat-weights regime; kept
 *                  in the gear-coarse pool.
 *   - `sidegrade`— within `tie_window_pct` (default 0.1%) of best.
 *                  Functionally equivalent — pick by other criteria.
 *   - `trash`    — lost by more than `trash_threshold_pct` (default 3%)
 *                  in every combo we've simmed it in. Excluded from
 *                  future cartesians until manually cleared.
 *   - `unknown`  — observed in bag but never simmed yet (transient
 *                  state pre-quick-sim).
 *
 * Statuses are recomputed on every catalog write — they're a function
 * of `best_delta_pct`, not a manually-set field. This way changing
 * the thresholds reclassifies the whole catalog automatically.
 */

import type ElectronStore from 'electron-store';
import * as ElectronStoreModule from 'electron-store';
import type { ParsedExport, ParsedItem } from './simc-export-parser';

function resolveStoreCtor(): typeof ElectronStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = ElectronStoreModule;
  for (const candidate of [m, m?.default, m?.default?.default]) {
    if (typeof candidate === 'function') return candidate as typeof ElectronStore;
  }
  const keys = m && typeof m === 'object' ? Object.keys(m) : String(m);
  throw new Error(`electron-store default export is not a constructor; module shape: ${JSON.stringify(keys)}`);
}

export type CatalogStatus = 'best' | 'good' | 'sidegrade' | 'trash' | 'unknown';

export interface CatalogItemRecord {
  identity: string;
  item_id: number;
  name: string;
  slot: string;
  ilvl: number;
  status: CatalogStatus;
  /** Most-favorable delta_pct ever observed (0 = won, -3 = lost by 3%). */
  best_delta_pct: number;
  /** Last simulated DPS observed for this item in any combo. */
  last_mean_dps?: number;
  times_simmed: number;
  last_simmed_at: number;
}

export interface BestLoadoutSlot {
  slot: string;
  item_id: number;
  name: string;
  identity: string;
  ilvl: number;
  /** DPS of the winning combo this item appeared in. */
  combo_mean_dps?: number;
}

export interface GearCatalogEntry {
  character_key: string;
  scenario: string;
  /** Per-slot winning items from the most recent gear ladder result. */
  best_loadout: Record<string, BestLoadoutSlot>;
  best_loadout_dps?: number;
  best_loadout_combo_id?: string;
  /** Every item we've ever simmed on this character + scenario, keyed by identity. */
  seen_items: Record<string, CatalogItemRecord>;
  /** Sorted-identity hash of the pool we last fully simmed. */
  last_pool_signature: string;
  last_full_sim_at: number;
  last_quick_sim_at?: number;
}

export interface ClassificationThresholds {
  /** Items within this delta_pct of best are 'good' (re-eligible). Default 1. */
  good_threshold_pct?: number;
  /** Items within this delta_pct are 'sidegrade' (functionally tied). Default 0.1. */
  tie_window_pct?: number;
  /** Items losing by more than this are 'trash'. Default 3. */
  trash_threshold_pct?: number;
}

export const DEFAULT_THRESHOLDS: Required<ClassificationThresholds> = {
  good_threshold_pct: 1,
  tie_window_pct: 0.1,
  trash_threshold_pct: 3,
};

/**
 * Map a delta_pct (winner-relative; 0 = winner, negative = lost) to a
 * status. The `is_currently_best` flag overrides — even if delta_pct
 * is 0 across multiple ties, only the actual winner gets `best`.
 */
export function classifyByDelta(
  delta_pct: number,
  is_currently_best: boolean,
  thresholds: ClassificationThresholds = {},
): CatalogStatus {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  if (is_currently_best) return 'best';
  if (delta_pct >= -t.tie_window_pct) return 'sidegrade';
  if (delta_pct >= -t.good_threshold_pct) return 'good';
  if (delta_pct <= -t.trash_threshold_pct) return 'trash';
  // Between good_threshold and trash_threshold — middle band; treat
  // as 'good' since it's still in the pool (just toward the bottom).
  return 'good';
}

/**
 * Stable signature of the entire pool (equipped + bag). Identities
 * are sorted before joining so order-of-discovery doesn't matter.
 * Same set of items, same signature, even if the player equipped a
 * bag item (item moves between equipped/bag arrays but stays in pool).
 */
export function fullPoolSignature(parsed: ParsedExport): string {
  const ids = [...parsed.equipped, ...parsed.bag].map((i) => i.identity);
  return [...new Set(ids)].sort().join(',');
}

export interface CatalogStoreOptions {
  cwd?: string;
  name?: string;
}

interface Schema {
  entries: Record<string, GearCatalogEntry>;
}

const KEY_SEP = '|';
function makeKey(character_key: string, scenario: string): string {
  return `${character_key}${KEY_SEP}${scenario}`;
}

export class GearCatalogStore {
  private readonly store: ElectronStore<Schema>;

  constructor(opts: CatalogStoreOptions = {}) {
    const StoreClass = resolveStoreCtor();
    this.store = new StoreClass<Schema>({
      name: opts.name ?? 'gear-catalog',
      cwd: opts.cwd,
      defaults: { entries: {} },
    });
  }

  get(character_key: string, scenario: string): GearCatalogEntry | undefined {
    return this.store.get('entries')[makeKey(character_key, scenario)];
  }

  put(entry: GearCatalogEntry): void {
    this.store.set(`entries.${makeKey(entry.character_key, entry.scenario)}`, entry);
  }

  clear(): void {
    this.store.set('entries', {});
  }
}

/**
 * Update a catalog entry from a fresh gear-coarse result. Writes:
 *   - best_loadout from the winning combo's items
 *   - seen_items: insert/upsert every item that appeared in any combo,
 *     tightening best_delta_pct toward zero (least-negative)
 *   - last_pool_signature + last_full_sim_at
 *
 * Pure function — caller persists the returned entry via store.put().
 * This keeps the catalog logic testable without touching electron-store
 * (which needs an electron context to default cwd).
 */
export function updateCatalogFromGearScan(opts: {
  prior: GearCatalogEntry | undefined;
  character_key: string;
  scenario: string;
  pool_signature: string;
  combos: ReadonlyArray<{
    combo_id: string;
    mean_dps: number;
    delta_pct: number;
    items: ReadonlyArray<{ slot: string; item: { item_id: number; name: string; identity: string; ilvl: number } }>;
  }>;
  thresholds?: ClassificationThresholds;
  now?: number;
}): GearCatalogEntry {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const seen_items: Record<string, CatalogItemRecord> = { ...(opts.prior?.seen_items ?? {}) };

  // For each item that appeared in any combo, find its best (least-negative) delta.
  const bestDeltaByIdentity = new Map<
    string,
    { delta_pct: number; mean_dps: number; ref: { item_id: number; name: string; identity: string; ilvl: number; slot: string } }
  >();
  for (const combo of opts.combos) {
    for (const ref of combo.items) {
      const cur = bestDeltaByIdentity.get(ref.item.identity);
      if (!cur || combo.delta_pct > cur.delta_pct) {
        bestDeltaByIdentity.set(ref.item.identity, {
          delta_pct: combo.delta_pct,
          mean_dps: combo.mean_dps,
          ref: { ...ref.item, slot: ref.slot },
        });
      }
    }
  }

  // Winning combo defines best_loadout.
  const sorted = [...opts.combos].sort((a, b) => b.mean_dps - a.mean_dps);
  const winner = sorted[0];
  const best_loadout: Record<string, BestLoadoutSlot> = {};
  if (winner) {
    for (const ref of winner.items) {
      best_loadout[ref.slot] = {
        slot: ref.slot,
        item_id: ref.item.item_id,
        name: ref.item.name,
        identity: ref.item.identity,
        ilvl: ref.item.ilvl,
        combo_mean_dps: winner.mean_dps,
      };
    }
  }

  // Upsert seen_items with new delta info, then classify.
  const winnerIdentities = new Set(
    winner ? winner.items.map((r) => r.item.identity) : [],
  );
  for (const [identity, info] of bestDeltaByIdentity) {
    const existing = seen_items[identity];
    const best_delta_pct = existing
      ? Math.max(existing.best_delta_pct, info.delta_pct)
      : info.delta_pct;
    const status = classifyByDelta(
      best_delta_pct,
      winnerIdentities.has(identity),
      opts.thresholds,
    );
    seen_items[identity] = {
      identity,
      item_id: info.ref.item_id,
      name: info.ref.name,
      slot: info.ref.slot,
      ilvl: info.ref.ilvl,
      status,
      best_delta_pct,
      last_mean_dps: info.mean_dps,
      times_simmed: (existing?.times_simmed ?? 0) + 1,
      last_simmed_at: now,
    };
  }

  // Items we'd previously marked 'best' that aren't in this run's
  // winner need to be re-classified. They keep their best_delta_pct
  // history but lose the 'best' badge.
  for (const [identity, record] of Object.entries(seen_items)) {
    if (record.status === 'best' && !winnerIdentities.has(identity)) {
      seen_items[identity] = {
        ...record,
        status: classifyByDelta(record.best_delta_pct, false, opts.thresholds),
      };
    }
  }

  return {
    character_key: opts.character_key,
    scenario: opts.scenario,
    best_loadout,
    best_loadout_dps: winner?.mean_dps,
    best_loadout_combo_id: winner?.combo_id,
    seen_items,
    last_pool_signature: opts.pool_signature,
    last_full_sim_at: now,
    last_quick_sim_at: opts.prior?.last_quick_sim_at,
  };
}

/**
 * Update the catalog after a swap-test run. Tighter scope than the
 * full update: only the swapped items get their seen_items entries
 * updated; best_loadout only changes if a swap was an upgrade.
 */
export function updateCatalogFromSwapTest(opts: {
  prior: GearCatalogEntry;
  swap_results: ReadonlyArray<{
    slot: string;
    item: { item_id: number; name: string; identity: string; ilvl: number };
    delta_pct: number;
    mean_dps: number;
  }>;
  thresholds?: ClassificationThresholds;
  now?: number;
}): GearCatalogEntry {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const seen_items: Record<string, CatalogItemRecord> = { ...opts.prior.seen_items };

  for (const swap of opts.swap_results) {
    const existing = seen_items[swap.item.identity];
    const best_delta_pct = existing
      ? Math.max(existing.best_delta_pct, swap.delta_pct)
      : swap.delta_pct;
    seen_items[swap.item.identity] = {
      identity: swap.item.identity,
      item_id: swap.item.item_id,
      name: swap.item.name,
      slot: swap.slot,
      ilvl: swap.item.ilvl,
      status: classifyByDelta(best_delta_pct, false, opts.thresholds),
      best_delta_pct,
      last_mean_dps: swap.mean_dps,
      times_simmed: (existing?.times_simmed ?? 0) + 1,
      last_simmed_at: now,
    };
  }

  return {
    ...opts.prior,
    seen_items,
    last_quick_sim_at: now,
  };
}

/**
 * Items that should be excluded from any future cartesian (the gear
 * pruner consults this in 4d-iii). 'trash' classification + not
 * manually-cleared. v1 doesn't have manual-clear in the UI yet, so
 * just filter on status.
 */
export function ignoredIdentities(
  catalog: GearCatalogEntry | undefined,
): Set<string> {
  if (!catalog) return new Set();
  const out = new Set<string>();
  for (const r of Object.values(catalog.seen_items)) {
    if (r.status === 'trash') out.add(r.identity);
  }
  return out;
}

/**
 * Identify items in the current pool that have NEVER been simmed yet.
 * Used by the quick-sim planner to decide whether a swap test is
 * sufficient or a full re-sim is needed. Trinkets are excluded — the
 * trinket cache handles those separately.
 */
export function findUnseenItems(
  parsed: ParsedExport,
  catalog: GearCatalogEntry | undefined,
): ParsedItem[] {
  const seen = new Set(Object.keys(catalog?.seen_items ?? {}));
  const out: ParsedItem[] = [];
  for (const it of [...parsed.equipped, ...parsed.bag]) {
    if (it.slot === 'trinket1' || it.slot === 'trinket2') continue;
    if (it.slot === 'tabard' || it.slot === 'shirt') continue;
    if (!seen.has(it.identity)) out.push(it);
  }
  // Dedupe — same identity may appear in equipped and bag if the
  // addon emitted it twice.
  const byIdentity = new Map<string, ParsedItem>();
  for (const it of out) if (!byIdentity.has(it.identity)) byIdentity.set(it.identity, it);
  return Array.from(byIdentity.values());
}
