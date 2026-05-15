import { describe, expect, it } from 'vitest';
import {
  buildRaidBuffBlock,
  CRUCIBLE_FLAGS,
  DEFAULT_POTION,
  DEFAULT_WEAPON_OIL,
  RAID_BUFF_OVERRIDES,
} from './raid-buffs';

describe('raid-buffs constants', () => {
  it('RAID_BUFF_OVERRIDES contains every Raidbots-default raid buff/debuff', () => {
    // This is the canonical 10-line list captured from a Raidbots
    // Patchwerk input (Frostyfriend, 2026-05-15). Any future change
    // here should be backed by an updated Raidbots reference.
    expect(RAID_BUFF_OVERRIDES).toEqual([
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
    ]);
  });

  it('uses potion_of_recklessness as the default caster combat potion', () => {
    expect(DEFAULT_POTION).toBe('potion_of_recklessness_2');
  });

  it('uses thalassian_phoenix_oil as the default weapon oil', () => {
    expect(DEFAULT_WEAPON_OIL).toBe('main_hand:thalassian_phoenix_oil_2');
  });

  it('enables all three crucible flags by default', () => {
    expect(CRUCIBLE_FLAGS).toEqual([
      'midnight.crucible_of_erratic_energies_violence=1',
      'midnight.crucible_of_erratic_energies_sustenance=1',
      'midnight.crucible_of_erratic_energies_predation=1',
    ]);
  });
});

describe('buildRaidBuffBlock', () => {
  const block = buildRaidBuffBlock();
  const joined = block.join('\n');

  it('includes every override.* line from RAID_BUFF_OVERRIDES', () => {
    for (const line of RAID_BUFF_OVERRIDES) {
      expect(joined, `missing ${line}`).toContain(line);
    }
  });

  it('sets the default potion + disables augmentation', () => {
    expect(joined).toContain(`potion=${DEFAULT_POTION}`);
    expect(joined).toContain('augmentation=disabled');
  });

  it('sets the default temporary weapon enchant', () => {
    expect(joined).toContain(`temporary_enchant=${DEFAULT_WEAPON_OIL}`);
  });

  it('emits every CRUCIBLE_FLAG', () => {
    for (const flag of CRUCIBLE_FLAGS) {
      expect(joined, `missing ${flag}`).toContain(flag);
    }
  });

  it('every non-blank, non-comment line is valid SimC directive syntax', () => {
    for (const line of block) {
      if (line === '' || line.startsWith('#')) continue;
      expect(line, `bad line: "${line}"`).toMatch(/^[a-z_][\w.]*=[^\s]/);
    }
  });

  it('is deterministic — same call returns same block', () => {
    expect(buildRaidBuffBlock()).toEqual(block);
  });
});
