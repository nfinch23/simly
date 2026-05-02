/**
 * Results file schema written by the desktop app and read by the addon.
 * Mirrors SCOPE.md section 5. One file, one character.
 */

import type { Scenario } from './savedvars.js';

export const RESULTS_SCHEMA_VERSION = 2;

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
  /** Sum of best DPS across the simmed loadout. */
  expected_dps?: number;
}

export interface ScanCollection {
  stat_weights?: ScanRecord<StatWeights>;
  trinket_pre_scan?: ScanRecord<unknown>;
  gear_coarse?: ScanRecord<unknown>;
  gear_refined?: ScanRecord<unknown>;
  gear_final?: ScanRecord<unknown>;
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

export interface SimlyResults {
  schema_version: number;
  generated_at: number;
  simc_version: string;
  character_key: string;
  active_scenario: Scenario;
  /** Hash of equipped+bag items at sim time; addon uses to flag "stale". */
  gear_hash?: string;
  scans: ScanCollection;
  composed?: ComposedLoadout;
}
