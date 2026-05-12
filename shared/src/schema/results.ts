/**
 * Results file schema written by the desktop app and read by the addon.
 * Mirrors SCOPE.md section 5. One file, one character.
 */

import type { Scenario } from './savedvars.js';

export const RESULTS_SCHEMA_VERSION = 3;

export type ScanStatus = 'pending' | 'running' | 'done' | 'failed';

/**
 * One stage of the scan pipeline. The desktop writes the file after
 * every status change so the in-game panel can show progress live (at
 * the next /reload).
 */
export interface ScanRecord<TData = unknown> {
  status: ScanStatus;
  started_at?: number;
  finished_at?: number;
  /** Only present when status === 'done'. */
  data?: TData;
  /** Only present when status === 'failed'. */
  error?: string;
}

/**
 * Common shape for "best consumable" questions. Each candidate is an
 * item with a name + item_id (for tooltip lookup) + DPS measurement.
 * The winner sits in `best`; everything else lands in `alternatives`
 * with a delta_pct vs the winner.
 */
export interface BestConsumableResult {
  label: string;
  best: { item_id: number; name: string; dps: number };
  alternatives: Array<{
    item_id: number;
    name: string;
    dps: number;
    delta_pct: number;
  }>;
}

export type BestFlaskResult = BestConsumableResult;
export type BestFoodResult = BestConsumableResult;

/** Compact identifier for an item slot, used in scan results that name specific items. */
export interface ScannedItemRef {
  item_id: number;
  name: string;
  ilvl: number;
  /** Stable identity hash from the parser; used by the ignore list. */
  identity: string;
}

/** One trinket pair tested in the trinket pre-scan. */
export interface TrinketPairResult {
  pair_id: string;
  trinket1: ScannedItemRef;
  trinket2: ScannedItemRef;
  mean_dps: number;
  /** Delta vs the winning pair, in percent. The winner has 0. */
  delta_pct: number;
}

/** Output of the trinket pre-scan. */
export interface TrinketPreScanResult {
  label: string;
  /** Sorted descending by mean_dps. */
  pairs: TrinketPairResult[];
  /** Same as pairs[0] when populated. */
  winner?: TrinketPairResult;
}

/** SimC stat-weight output (per-stat normalized to intellect or strength). */
export interface StatWeights {
  intellect?: number;
  strength?: number;
  agility?: number;
  mastery?: number;
  crit?: number;
  haste?: number;
  versatility?: number;
  /** Catch-all for stats the desktop doesn't know about yet. */
  [stat: string]: number | undefined;
}

/** One slot in the recommended best loadout (for the addon's gear render). */
export interface ComposedGearItem {
  item_id: number;
  name: string;
  ilvl: number;
  /** Stable identity hash (used to detect bonus-id-level differences vs equipped). */
  identity: string;
}

/**
 * The composed final answer the in-game panel renders prominently.
 * Populated incrementally as scans finish; fields are optional because
 * early scans haven't run yet on the first sim cycle.
 */
export interface ComposedLoadout {
  label: string;
  /** Optional consumables — populated by the consumables scan. */
  flask?: { item_id: number; name: string };
  food?: { item_id: number; name: string };
  potion?: { item_id: number; name: string };
  augment_rune?: { item_id: number; name: string };
  /**
   * Per-slot recommended gear, keyed by SimC slot name (head, neck,
   * shoulder, back, chest, wrist, hands, waist, legs, feet, finger1,
   * finger2, trinket1, trinket2, main_hand, off_hand). Populated from
   * the gear_coarse winner + the trinket pre-scan winner. The addon
   * panel compares each entry against GetInventoryItemID("player", ...)
   * to highlight slots that aren't currently equipped.
   */
  gear?: Record<string, ComposedGearItem>;
  /** Sum of best DPS across the simmed loadout. */
  expected_dps?: number;
}

/** One slot's item in a `GearComboResult`. Slot is the SimC slot name (head, finger1, etc). */
export interface GearComboItemRef {
  slot: string;
  item: ScannedItemRef;
}

/** One simulated cartesian combination from a gear ladder scan. */
export interface GearComboResult {
  combo_id: string;
  items: GearComboItemRef[];
  mean_dps: number;
  /** Delta vs the winning combo, in percent. Winner is 0. */
  delta_pct: number;
}

/**
 * Output of one stage of the gear ladder (`gear_coarse` / `gear_refined`
 * / `gear_final`). Combos are sorted descending by mean DPS; `winner`
 * mirrors `combos[0]` for fast lookup.
 */
export interface GearScanResult {
  label: string;
  combos: GearComboResult[];
  winner?: GearComboResult;
  /** Iteration count used for this stage's profileset sim. */
  iterations: number;
  /** Total candidate count fed into SimC (== combos.length when sim succeeded). */
  total_combos: number;
}

/**
 * Compact view of one item the gear catalog has seen, for rendering
 * in the addon panel. Mirrors the desktop-side CatalogItemRecord but
 * trimmed: just identity / display fields / classification / delta.
 */
export interface CatalogSummaryItem {
  identity: string;
  item_id: number;
  name: string;
  slot: string;
  ilvl: number;
  status: 'best' | 'good' | 'sidegrade' | 'trash' | 'unknown';
  /** Most-favorable delta_pct ever observed (0 = won, -3 = lost by 3%). */
  best_delta_pct: number;
  times_simmed: number;
}

/**
 * Snapshot of the gear catalog at the time SimlyResults.lua was
 * written. Lets the addon panel show what's been classified as
 * trash/good/sidegrade without having to re-derive it from scan
 * results. Items with status='best' are excluded — they're already
 * displayed via composed.gear (and would just duplicate noise).
 */
export interface CatalogSummary {
  total_seen: number;
  items: CatalogSummaryItem[];
}

export interface ScanCollection {
  stat_weights?: ScanRecord<StatWeights>;
  trinket_pre_scan?: ScanRecord<TrinketPreScanResult>;
  gear_coarse?: ScanRecord<GearScanResult>;
  gear_refined?: ScanRecord<GearScanResult>;
  gear_final?: ScanRecord<GearScanResult>;
  /**
   * v1-shim scans carried forward from Phase 2 — the consumables suite
   * lives behind `best_flask` / `best_food` for now and will fold into
   * `consumables_gems_enchants` when Phase 4 lands.
   */
  best_flask?: ScanRecord<BestFlaskResult>;
  best_food?: ScanRecord<BestFoodResult>;
  consumables_gems_enchants?: ScanRecord<unknown>;
  /** Catch-all so future scans don't require a schema bump. */
  [scanId: string]: ScanRecord<unknown> | undefined;
}

/**
 * One row in the pass-history log produced by the two-pass stat-reconverge
 * pipeline. Optional and additive: scenarios run by older orchestrator code
 * (or by future code that skips re-convergence) will not write this field.
 *
 * Pass 1 is always recorded. Pass 2 is recorded only when the reconverge
 * gate fired. `triggers` enumerates which gate condition(s) caused the
 * follow-up pass — diagnostic only.
 */
export interface PassHistoryEntry {
  pass: 1 | 2;
  /** Unix seconds the pass finished. */
  finished_at: number;
  /** Stat weights computed at end-of-pass against the pass's converged actor. */
  weights?: StatWeights;
  /** Triggers that fired AT THE END of this pass (i.e. reasons the NEXT pass would run, if any). */
  triggers?: Array<'weights' | 'consumables' | 'trinket'>;
  /**
   * Human-readable detail strings describing each trigger (mirrors
   * `formatReconvergeReason` output). Stored alongside `triggers` so the
   * addon panel can render the explanation without re-deriving it.
   */
  trigger_details?: string[];
}

/** Per-scenario result bucket stored inside SimlyResults.scenarios. */
export interface ScenarioResults {
  generated_at: number;
  simc_version: string;
  scans: ScanCollection;
  composed?: ComposedLoadout;
  catalog_summary?: CatalogSummary;
  /**
   * Pass history for the two-pass stat-reconverge pipeline. Optional and
   * additive — absent on scenarios written by single-pass orchestrators
   * or by future orchestrators that skipped re-convergence (no triggers
   * fired). When present, length is 1 (pass 1 only) or 2 (pass 2 ran).
   */
  pass_history?: PassHistoryEntry[];
}

export interface SimlyResults {
  schema_version: number;
  character_key: string;
  /** Currently viewed/last-simmed scenario. */
  active_scenario: Scenario;
  /** Hash of equipped+bag items at sim time; addon uses to flag "stale". */
  gear_hash?: string;
  /** v3+: per-scenario result buckets. */
  scenarios?: Partial<Record<Scenario, ScenarioResults>>;
  // v2 legacy fields — present in old files, absent in new writes:
  generated_at?: number;
  simc_version?: string;
  scans?: ScanCollection;
  composed?: ComposedLoadout;
  /**
   * Snapshot of the gear catalog's seen_items map (excluding the
   * currently-best items, which are already shown via composed.gear).
   * Lets the in-game panel render a "what we know is bad" list so
   * the user can see what's being rejected without having to read
   * the dev log.
   */
  catalog_summary?: CatalogSummary;
}
