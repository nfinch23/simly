import { describe, expect, it } from 'vitest';
import { buildFoodProfilesetLines, parseBestFood, FOOD_CANDIDATES } from './best-food';
import type { SimcRunResult } from '../simc-runner';

function makeRun(profilesets: Array<{ name: string; mean: number }>): SimcRunResult {
  return {
    simcVersion: '1205-01',
    gitRevision: 'abc',
    buildDate: '2026-04-30',
    profilesets: profilesets.map((p) => ({
      name: p.name,
      mean: p.mean,
      stddev: 0,
      iterations: 1000,
    })),
    rawJsonPath: '/tmp/x.json',
  };
}

describe('FOOD_CANDIDATES', () => {
  it('lists the 12.0.5 feast names verified against simc.exe profiles', () => {
    const simcNames = FOOD_CANDIDATES.map((c) => c.simcFood).sort();
    expect(simcNames).toEqual([
      'blooming_feast',
      'harandar_celebration',
      'queldorei_medley',
      'royal_roast',
      'silvermoon_parade',
    ]);
  });

  it('has unique keys', () => {
    const keys = FOOD_CANDIDATES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildFoodProfilesetLines', () => {
  it('emits one line per candidate using food_<key> naming', () => {
    const out = buildFoodProfilesetLines();
    const lines = out.split('\n');
    expect(lines).toHaveLength(FOOD_CANDIDATES.length);
    for (const c of FOOD_CANDIDATES) {
      expect(out).toContain(`profileset."food_${c.key}"+="food=${c.simcFood}"`);
    }
  });
});

describe('parseBestFood', () => {
  it('picks the highest mean DPS as the winner', () => {
    const run = makeRun([
      { name: 'food_blooming_feast', mean: 688 },
      { name: 'food_silvermoon_parade', mean: 849 },
      { name: 'food_royal_roast', mean: 848 },
    ]);
    const result = parseBestFood(run);
    expect(result?.best.name).toBe('Silvermoon Parade');
    expect(result?.best.dps).toBe(849);
  });

  it('lists losers as alternatives sorted highest-to-lowest with rounded delta_pct', () => {
    const run = makeRun([
      { name: 'food_silvermoon_parade', mean: 849.3 },
      { name: 'food_harandar_celebration', mean: 848.3 },
      { name: 'food_royal_roast', mean: 848.0 },
    ]);
    const result = parseBestFood(run);
    expect(result?.alternatives.map((a) => a.name)).toEqual([
      "Har'andar Celebration",
      'Royal Roast',
    ]);
    for (const a of result!.alternatives) {
      expect(a.delta_pct).toBeLessThan(0);
      expect(String(a.delta_pct).length).toBeLessThanOrEqual(6);
    }
  });

  it('returns undefined when nothing matches food_<key>', () => {
    const run = makeRun([
      { name: 'flask_magisters', mean: 1000 },
      { name: 'random', mean: 999 },
    ]);
    expect(parseBestFood(run)).toBeUndefined();
  });

  it('ignores profilesets that look like food but use unknown keys', () => {
    const run = makeRun([
      { name: 'food_blooming_feast', mean: 688 },
      { name: 'food_some_made_up_meal', mean: 9999 },
    ]);
    const result = parseBestFood(run);
    expect(result?.best.name).toBe('Blooming Feast');
    expect(result?.alternatives).toHaveLength(0);
  });
});
