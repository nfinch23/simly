/**
 * Phase 6 backend prep — per-scenario SimC configuration.
 *
 * Each scenario tag (defined in shared/savedvars.ts) maps to a SimC
 * `fight_style=` directive plus optional supporting parameters
 * (target count, fight length, etc.). The scan-queue injects these
 * into the profile script before SimC runs so each scenario produces
 * a meaningfully different sim.
 *
 * The catalog / trinket cache / ignore list are already keyed on
 * `(character_key, scenario)` (see gear-catalog.ts, trinket-cache.ts,
 * ignore-list.ts), so swapping scenarios produces a fresh result set
 * without touching cached single-target data. Phase 6 also requires
 * an addon-side UI to switch the active scenario; that's a separate
 * commit since it requires WoW visual confirmation.
 *
 * v1 ships single_target_patchwerk only (default Patchwerk fight
 * style). The other entries are stubs documenting the SCOPE-defined
 * mappings; they're testable today and ready to wire once the addon
 * UI lands.
 */

import type { Scenario } from '@simly/shared';

export interface ScenarioConfig {
  /** SimC `fight_style=` directive value. */
  fightStyle: string;
  /** Display label for log lines + future settings UI. */
  label: string;
  /** Optional extra SimC directives (newline-joined and emitted alongside fight_style). */
  extraDirectives?: string[];
}

/**
 * SCOPE-defined scenario mapping. Sources:
 *   - SimC's stock fight styles: Patchwerk (single-target),
 *     DungeonSlice (sequence of 5 mob pulls scaled to dungeons),
 *     HelterSkelter (high-variance multi-target),
 *     CastingPatchwerk (always-casting variant).
 *   - The cleave/funnel variants emit DungeonSlice + a `desired_targets=`
 *     pin so SimC weights AoE differently between them.
 *
 * fight_style values are exact strings SimC's parser expects (case-
 * sensitive). Verify against the SimC version pinned in
 * simc-version-source.ts before adjusting.
 */
export const SCENARIO_CONFIGS: Record<Scenario, ScenarioConfig> = {
  single_target_patchwerk: {
    fightStyle: 'Patchwerk',
    label: 'Single-target (Patchwerk)',
  },
  m_plus: {
    fightStyle: 'DungeonSlice',
    label: 'Mythic+ (DungeonSlice)',
  },
  aoe_cleave: {
    fightStyle: 'DungeonSlice',
    label: 'AoE cleave (3-target)',
    extraDirectives: ['desired_targets=3'],
  },
  aoe_funnel: {
    fightStyle: 'DungeonSlice',
    label: 'AoE funnel (5-target, primary focus)',
    extraDirectives: ['desired_targets=5'],
  },
};

/**
 * Look up the SimC config for a scenario tag. Falls back to the
 * single-target mapping for any tag the type system would reject —
 * defensive in case a malformed SavedVariables file slips through.
 */
export function getScenarioConfig(scenario: Scenario | string): ScenarioConfig {
  return (
    SCENARIO_CONFIGS[scenario as Scenario] ??
    SCENARIO_CONFIGS.single_target_patchwerk
  );
}

/**
 * Build the SimC profile lines that go IMMEDIATELY before profileset
 * lines to set the scenario. Returns an empty array for the v1 default
 * (Patchwerk is SimC's built-in default fight style — emitting it
 * explicitly is harmless but unnecessary).
 *
 * Used by scan-queue when running gear / consumables / trinket sims so
 * each scenario produces a distinct DPS ranking.
 */
export function scenarioProfileLines(scenario: Scenario | string): string[] {
  const cfg = getScenarioConfig(scenario);
  const lines: string[] = [];
  // Always emit fight_style for clarity in the input file even though
  // Patchwerk is the SimC default — it makes profile-script
  // post-mortems readable without cross-referencing the version's
  // default.
  lines.push(`fight_style=${cfg.fightStyle}`);
  if (cfg.extraDirectives) lines.push(...cfg.extraDirectives);
  return lines;
}
