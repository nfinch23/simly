/**
 * Raid-buff block for SimC profiles.
 *
 * Raidbots applies a "raid-buffed actor" by default — bloodlust, all the
 * standard raid buffs/debuffs, a default combat potion, weapon oil, and
 * the Midnight expansion's crucible flags. Simly was sim'ing a bare
 * actor with none of these, which produced ~5-6% lower DPS than Raidbots
 * AND flipped flask rankings (haste returns are linear without
 * bloodlust → Shattered Sun over-won vs Magisters). See PR #57 / the
 * D-investigate findings.
 *
 * This module exposes the canonical block as a deterministic list of
 * SimC directive lines. Consumers join with newlines and prepend to
 * every profile before sim. Per-character/spec customization (e.g. a
 * Warlock probably doesn't want potion_of_recklessness) is a future
 * concern; the v1 block matches Raidbots' default Patchwerk template.
 */

/**
 * Standard raid buff + debuff overrides. Each forces the named buff
 * permanently on. Without these the actor sims raid-bare and our DPS
 * numbers diverge from any external benchmark by ~5-6%.
 */
export const RAID_BUFF_OVERRIDES: readonly string[] = [
  'override.bloodlust=1',
  'override.arcane_intellect=1',
  'override.power_word_fortitude=1',
  'override.battle_shout=1',
  'override.mystic_touch=1',
  'override.chaos_brand=1',
  'override.skyfury=1',
  'override.mark_of_the_wild=1',
  'override.hunters_mark=1',
  'override.bleeding=1',
];

/**
 * Default combat potion. Replaced by a per-spec scan in Slice I; until
 * then we lock the same default Raidbots uses for caster DPS. Frost
 * Mage's potion of recklessness is intellect-based and the right
 * default for any caster.
 */
export const DEFAULT_POTION = 'potion_of_recklessness_2';

/**
 * Default temporary weapon oil. Same rationale as DEFAULT_POTION —
 * replaced by a scan later; matches Raidbots' caster default for now.
 */
export const DEFAULT_WEAPON_OIL = 'main_hand:thalassian_phoenix_oil_2';

/**
 * Midnight expansion's Crucible of Erratic Energies buffs. These are
 * persistent passives the player has selected in-game; without the
 * flags SimC ignores them entirely. All three default to enabled —
 * matches Raidbots and the typical end-game build. Per-character
 * configurability is a polish slice.
 */
export const CRUCIBLE_FLAGS: readonly string[] = [
  'midnight.crucible_of_erratic_energies_violence=1',
  'midnight.crucible_of_erratic_energies_sustenance=1',
  'midnight.crucible_of_erratic_energies_predation=1',
];

/**
 * Build the raid-buff block as a deterministic list of SimC directive
 * lines. Order matches Raidbots' input for easier diffing during
 * future investigations.
 *
 * Inject this between the character's profile (gear/talents) and any
 * `profileset.*=` lines so per-profileset overrides can still flip
 * specific buffs off when needed.
 */
export function buildRaidBuffBlock(): string[] {
  return [
    '# Consumables (defaults — replaced by per-spec scans later)',
    `potion=${DEFAULT_POTION}`,
    'augmentation=disabled',
    '',
    '# Temporary weapon enchant',
    `temporary_enchant=${DEFAULT_WEAPON_OIL}`,
    '',
    '# Midnight crucible buffs',
    ...CRUCIBLE_FLAGS,
    '',
    '# Raid buffs + debuffs (override.* forces them permanently on)',
    ...RAID_BUFF_OVERRIDES,
  ];
}
