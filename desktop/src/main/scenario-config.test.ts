import { describe, expect, it } from 'vitest';
import {
  applyTalentOverride,
  getScenarioConfig,
  resolveTalentLine,
  SCENARIO_CONFIGS,
  scenarioProfileLines,
} from './scenario-config';
import type { Scenario } from '@simly/shared';
import type { ParsedExport } from './simc-export-parser';

describe('SCENARIO_CONFIGS', () => {
  it('covers every Scenario tag from the shared schema', () => {
    // If a future Scenario string-union member lands without a config
    // entry here, this test forces the mapping to be updated.
    const expected: Scenario[] = [
      'single_target_patchwerk',
      'm_plus',
      'aoe_cleave',
      'aoe_funnel',
    ];
    for (const s of expected) {
      expect(SCENARIO_CONFIGS, `missing config for ${s}`).toHaveProperty(s);
      expect(SCENARIO_CONFIGS[s].fightStyle).toBeTruthy();
      expect(SCENARIO_CONFIGS[s].label).toBeTruthy();
    }
  });

  it('single_target_patchwerk uses Patchwerk fight style with no extras', () => {
    const c = SCENARIO_CONFIGS.single_target_patchwerk;
    expect(c.fightStyle).toBe('Patchwerk');
    expect(c.extraDirectives).toBeUndefined();
  });

  it('AoE scenarios pin desired_targets via extraDirectives', () => {
    expect(SCENARIO_CONFIGS.aoe_cleave.extraDirectives).toContain('desired_targets=3');
    expect(SCENARIO_CONFIGS.aoe_funnel.extraDirectives).toContain('desired_targets=5');
  });

  it('Mythic+ is DungeonSlice without target pinning', () => {
    expect(SCENARIO_CONFIGS.m_plus.fightStyle).toBe('DungeonSlice');
    expect(SCENARIO_CONFIGS.m_plus.extraDirectives).toBeUndefined();
  });
});

describe('getScenarioConfig', () => {
  it('returns the matching config for known tags', () => {
    expect(getScenarioConfig('single_target_patchwerk').fightStyle).toBe('Patchwerk');
    expect(getScenarioConfig('m_plus').fightStyle).toBe('DungeonSlice');
  });

  it('falls back to single_target_patchwerk for unknown tags (defensive)', () => {
    // Caster has type Scenario | string; pretend a malformed
    // SavedVariables file sent through 'unknown_scenario'.
    const c = getScenarioConfig('garbage_tag');
    expect(c.fightStyle).toBe('Patchwerk');
  });
});

describe('scenarioProfileLines', () => {
  it('emits a single fight_style line for single_target', () => {
    const lines = scenarioProfileLines('single_target_patchwerk');
    expect(lines).toEqual(['fight_style=Patchwerk']);
  });

  it('emits fight_style + desired_targets for aoe_cleave', () => {
    const lines = scenarioProfileLines('aoe_cleave');
    expect(lines).toEqual(['fight_style=DungeonSlice', 'desired_targets=3']);
  });

  it('emits fight_style + desired_targets for aoe_funnel', () => {
    const lines = scenarioProfileLines('aoe_funnel');
    expect(lines).toEqual(['fight_style=DungeonSlice', 'desired_targets=5']);
  });

  it('falls back to Patchwerk lines for unknown scenario', () => {
    const lines = scenarioProfileLines('garbage');
    expect(lines).toEqual(['fight_style=Patchwerk']);
  });

  it('lines are valid SimC directive syntax (key=value, no leading whitespace)', () => {
    for (const tag of Object.keys(SCENARIO_CONFIGS)) {
      const lines = scenarioProfileLines(tag);
      for (const line of lines) {
        expect(line, `line "${line}" for ${tag}`).toMatch(/^[a-z_]+=[\w/=]+/);
      }
    }
  });
});

function buildParsed(overrides: Partial<ParsedExport> = {}): ParsedExport {
  return {
    character: { class: 'warlock' },
    equipped: [],
    bag: [],
    poolBySlot: {} as ParsedExport['poolBySlot'],
    equipped_talents: 'EQUIPPED_TALENTS_STR',
    saved_loadouts: [
      { name: 'Raid', talents: 'RAID_TALENTS_STR' },
      { name: 'm+', talents: 'MPLUS_TALENTS_STR' },
    ],
    ...overrides,
  };
}

describe('resolveTalentLine', () => {
  it('returns null when no parsed export is provided (no override possible)', () => {
    expect(resolveTalentLine('m_plus', undefined, { m_plus: 'Raid' })).toBeNull();
  });

  it('returns null when no selection map is provided', () => {
    expect(resolveTalentLine('m_plus', buildParsed(), undefined)).toBeNull();
  });

  it('returns null when the scenario maps to the "equipped" sentinel', () => {
    expect(resolveTalentLine('m_plus', buildParsed(), { m_plus: 'equipped' })).toBeNull();
  });

  it('returns null when the scenario has no entry in the selection map', () => {
    expect(resolveTalentLine('m_plus', buildParsed(), { single_target_patchwerk: 'Raid' })).toBeNull();
  });

  it('returns the matched saved loadout talents when selection names an existing loadout', () => {
    expect(resolveTalentLine('m_plus', buildParsed(), { m_plus: 'm+' })).toBe('MPLUS_TALENTS_STR');
    expect(resolveTalentLine('single_target_patchwerk', buildParsed(), { single_target_patchwerk: 'Raid' })).toBe('RAID_TALENTS_STR');
  });

  it('falls back to null + warns when the named loadout no longer exists in the export', () => {
    // Renamed loadout in-game is a realistic failure mode — we don't
    // want to crash the sim, just fall back to equipped.
    expect(resolveTalentLine('m_plus', buildParsed(), { m_plus: 'RenamedLoadout' })).toBeNull();
  });
});

describe('applyTalentOverride', () => {
  const baseProfile = [
    'warlock="Felfriend"',
    'level=90',
    'spec=demonology',
    '',
    'talents=ORIGINAL_TALENTS',
    '',
    '# Some Item (276)',
    'head=,id=12345,bonus_id=1/2/3',
  ].join('\n');

  it('returns the profile unchanged when talents is null', () => {
    expect(applyTalentOverride(baseProfile, null)).toBe(baseProfile);
  });

  it('strips the existing `talents=` line and injects the override before the item block', () => {
    const result = applyTalentOverride(baseProfile, 'OVERRIDE_TALENTS');
    expect(result).not.toContain('talents=ORIGINAL_TALENTS');
    expect(result).toContain('talents=OVERRIDE_TALENTS');
    // Override must come BEFORE the item line so SimC's parser sees
    // it as the active talents= assignment for this character.
    const overrideIdx = result.indexOf('talents=OVERRIDE_TALENTS');
    const itemIdx = result.indexOf('head=,id=12345');
    expect(overrideIdx).toBeLessThan(itemIdx);
  });

  it('preserves commented `# talents=` Saved Loadout lines (they are documentation, not directives)', () => {
    const withSaved = [
      'warlock="Felfriend"',
      'talents=ORIGINAL',
      '# Saved Loadout: Raid',
      '# talents=RAID_TALENTS',
      '# Item (276)',
      'head=,id=1',
    ].join('\n');
    const result = applyTalentOverride(withSaved, 'OVERRIDE');
    expect(result).toContain('# Saved Loadout: Raid');
    expect(result).toContain('# talents=RAID_TALENTS');
    expect(result).not.toContain('\ntalents=ORIGINAL');
  });

  it('appends at end when no item line exists (paste-input edge case)', () => {
    const headerOnly = 'warlock="Bob"\nlevel=80\ntalents=ABC\n';
    const result = applyTalentOverride(headerOnly, 'XYZ');
    expect(result).toContain('talents=XYZ');
    expect(result).not.toContain('talents=ABC');
  });
});
