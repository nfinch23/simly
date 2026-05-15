/**
 * SavedVariables schema written by the addon and read by the desktop app.
 * Mirrors SCOPE.md section 4 verbatim. Bump SAVEDVARS_SCHEMA_VERSION on any
 * breaking change; the desktop must refuse unknown versions.
 */

export const SAVEDVARS_SCHEMA_VERSION = 2;

export type Region = 'us' | 'eu' | 'kr' | 'tw' | 'cn';

export interface SavedVarsCharacter {
  name: string;
  realm: string;
  region: Region;
  class: string;
  spec: string;
  level: number;
}

/**
 * Scenario tag. v1 ships single_target_patchwerk only; Phase 6 adds
 * the dungeon / AoE variants. Each scenario maps to a different SimC
 * `fight_style=` directive (see desktop/src/main/scenario-config.ts);
 * the catalog / trinket cache / ignore list are all already keyed on
 * `(character_key, scenario)` so future additions are isolated per-key.
 *
 * Keep this as a string union so future additions are explicit and
 * exhaustively-checked.
 */
export type Scenario =
  | 'single_target_patchwerk'
  | 'm_plus'
  | 'aoe_cleave'
  | 'aoe_funnel';

export interface SimlyDB {
  schema_version: number;
  exported_at: number;
  character: SavedVarsCharacter;
  simc_export: string;
  /**
   * The addon writes this when the user clicks "Update sims" in the
   * in-game panel. The desktop watcher kicks off the scan queue when
   * this value is newer than the last completed run. 0 = no request.
   */
  update_requested_at: number;
  /** Scenario the user has selected. v1 only single_target_patchwerk. */
  active_scenario: Scenario;
  /**
   * Last `SimlyResults.generated_at` value the addon has surfaced to
   * the user. Used to decide whether a /reload reveals a NEW set of
   * results the user hasn't seen before, so the addon can pop a
   * prominent "fresh results available" message at login.
   */
  last_seen_generated_at?: number;
  /** When set and newer than lastCompletedAllAt, desktop runs all 4 scenarios. */
  update_all_requested_at?: number;
  /**
   * When set and newer than lastCompletedFullSimAt, desktop runs the
   * normal quick pipeline followed by a Raidbots-Top-Gear-style full
   * sim (cartesian over all non-trash bag items, no stat-weight pruning).
   * Dev-only — addon hides the trigger button unless SimlyResults.dev_mode
   * is true.
   */
  update_full_sim_requested_at?: number;
  /**
   * Per-scenario talent loadout selection. Value is either the name of
   * a `# Saved Loadout: <name>` block from the SimC export, or the
   * sentinel `"equipped"` (or absent) to use the currently-equipped
   * `talents=` line. Mirrors Raidbots' per-sim talent picker — lets the
   * user run M+ sims with M+ talents, raid sims with raid talents, etc.
   * without swapping in-game first.
   *
   * Additive field — desktop reads defensively (`?? {}`); no schema
   * version bump needed.
   */
  talent_loadout_per_scenario?: Partial<Record<Scenario, string>>;
}

/** Sentinel for "use the currently-equipped talent string" in the per-scenario picker. */
export const TALENT_LOADOUT_EQUIPPED = 'equipped';
