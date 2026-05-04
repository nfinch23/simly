import { describe, expect, it } from 'vitest';
import {
  getScenarioConfig,
  SCENARIO_CONFIGS,
  scenarioProfileLines,
} from './scenario-config';
import type { Scenario } from '@simly/shared';

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
