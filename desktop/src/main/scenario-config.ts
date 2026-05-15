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
import { TALENT_LOADOUT_EQUIPPED } from '@simly/shared';
import type { ParsedExport } from './simc-export-parser';

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

/**
 * Resolve which talent string to use for a given scenario. Returns the
 * raw talent string (without the `talents=` prefix), or null when the
 * caller should leave the active `talents=` line in the base profile
 * untouched.
 *
 *   - selection missing OR `"equipped"` (TALENT_LOADOUT_EQUIPPED) → null
 *     (use the export's existing `talents=` line; today's behavior).
 *   - selection names a saved loadout that exists → its talents string.
 *   - selection names a loadout that doesn't exist in the export → null
 *     with a console warning. (Defensive: stale selection from a renamed
 *     in-game loadout shouldn't break the sim — fall back to equipped.)
 */
export function resolveTalentLine(
  scenario: Scenario | string,
  parsed: ParsedExport | undefined,
  selection: Partial<Record<string, string>> | undefined,
): string | null {
  if (!parsed || !selection) return null;
  const chosen = selection[scenario];
  if (!chosen || chosen === TALENT_LOADOUT_EQUIPPED) return null;
  const match = parsed.saved_loadouts.find((l) => l.name === chosen);
  if (!match) {
    console.warn(
      `[talents] scenario=${scenario} requested loadout "${chosen}" but it isn't in the export's saved loadouts; falling back to equipped.`,
    );
    return null;
  }
  return match.talents;
}

/**
 * Rewrite a base profile to use a specific talent string. Strips the
 * existing uncommented `talents=...` line (the equipped one) and appends
 * the chosen one immediately after the header. SimC accepts the override
 * because the appended line is the LAST `talents=` assignment in profile
 * order (later assignments win, by SimC's option-parsing rules).
 *
 * Returns the profile unchanged when `talents` is null.
 */
export function applyTalentOverride(baseProfile: string, talents: string | null): string {
  if (talents === null) return baseProfile;
  const lines = baseProfile.split(/\r?\n/);
  // Drop the existing uncommented `talents=` line(s). Commented
  // `# talents=` lines (saved loadouts) stay — they're documentation,
  // not directives.
  const filtered = lines.filter((l) => !/^talents=/.test(l));
  // Inject the new talents line right after the character block. Pick
  // the index just before the first item line so it stays in the
  // header region. If there's no item line, append at end.
  let insertAt = filtered.findIndex((l) => /^(?:#\s+.+\s+\(\d+\)\s*$|[a-z_]+=,id=\d+)/.test(l));
  if (insertAt < 0) insertAt = filtered.length;
  filtered.splice(insertAt, 0, `talents=${talents}`, '');
  return filtered.join('\n');
}
