import { describe, expect, it } from 'vitest';
import {
  buildPotionProfilesetLines,
  parseBestPotion,
  pickWinningPotionSimcKey,
  POTION_CANDIDATES,
} from './best-potion';
import type { SimcRunResult } from '../simc-runner';

function makeRun(profilesets: Array<{ name: string; mean: number }>): SimcRunResult {
  return {
    simcVersion: '1205-01',
    gitRevision: 'd6f091a0000000000000000000000000',
    buildDate: '2026-04-30',
    profilesets: profilesets.map((p) => ({
      name: p.name,
      mean: p.mean,
      stddev: 10,
      iterations: 1000,
    })),
    rawJsonPath: '/tmp/fake.json',
    rawJson: {},
  };
}

describe('POTION_CANDIDATES', () => {
  it('all simcPotion identifiers end with _2 (Midnight tier)', () => {
    for (const c of POTION_CANDIDATES) {
      expect(c.simcPotion).toMatch(/_2$/);
    }
  });

  it('covers the three Midnight-tier combat potions SimC stock profiles use', () => {
    const keys = POTION_CANDIDATES.map((c) => c.simcPotion).sort();
    expect(keys).toEqual([
      'draught_of_rampant_abandon_2',
      'lights_potential_2',
      'potion_of_recklessness_2',
    ]);
  });

  it('has unique keys', () => {
    const keys = POTION_CANDIDATES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildPotionProfilesetLines', () => {
  it('emits one line per candidate using potion_<key> naming', () => {
    const out = buildPotionProfilesetLines();
    const lines = out.split('\n');
    expect(lines.length).toBe(POTION_CANDIDATES.length);
    for (const c of POTION_CANDIDATES) {
      expect(out).toContain(`profileset."potion_${c.key}"+="potion=${c.simcPotion}"`);
    }
  });
});

describe('parseBestPotion', () => {
  it('picks the highest mean DPS as the winner', () => {
    const run = makeRun([
      { name: 'potion_recklessness', mean: 640 },
      { name: 'potion_lights_potential', mean: 700 },
    ]);
    const result = parseBestPotion(run);
    expect(result?.best.name).toBe("Light's Potential Potion");
    expect(result?.best.dps).toBe(700);
  });

  it('returns undefined when no profilesets match known potion keys', () => {
    const run = makeRun([
      { name: 'flask_magisters', mean: 1000 },
      { name: 'food_blooming_feast', mean: 999 },
    ]);
    expect(parseBestPotion(run)).toBeUndefined();
  });

  it('lists losing candidates as alternatives with negative delta_pct', () => {
    const run = makeRun([
      { name: 'potion_recklessness', mean: 700 },
      { name: 'potion_lights_potential', mean: 686 },
      { name: 'potion_draught_rampant_abandon', mean: 650 },
    ]);
    const result = parseBestPotion(run);
    expect(result?.best.name).toBe('Potion of Recklessness');
    expect(result?.alternatives).toHaveLength(2);
    expect(result?.alternatives[0]!.delta_pct).toBe(-2);
  });
});

describe('pickWinningPotionSimcKey', () => {
  it('returns the simcPotion identifier of the highest-DPS profileset', () => {
    const run = makeRun([
      { name: 'potion_recklessness', mean: 640 },
      { name: 'potion_lights_potential', mean: 700 },
    ]);
    expect(pickWinningPotionSimcKey(run)).toBe('lights_potential_2');
  });

  it('returns undefined when no potion profilesets are present', () => {
    const run = makeRun([{ name: 'flask_magisters', mean: 9999 }]);
    expect(pickWinningPotionSimcKey(run)).toBeUndefined();
  });
});
