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
 * Scenario tag for v1 (single-target Patchwerk only). Phase 6 adds
 * 'm_plus' / 'aoe_cleave' / 'aoe_funnel'. Keep this as a string union so
 * future additions are explicit.
 */
export type Scenario = 'single_target_patchwerk';

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
}
