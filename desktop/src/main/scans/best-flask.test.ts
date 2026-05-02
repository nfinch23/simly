import { describe, expect, it } from 'vitest';
import { buildFlaskProfilesetLines, parseBestFlask, FLASK_CANDIDATES } from './best-flask';
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
  };
}

describe('FLASK_CANDIDATES', () => {
  it('uses 12.0.5 simcFlask identifiers ending in _2', () => {
    for (const c of FLASK_CANDIDATES) {
      expect(c.simcFlask).toMatch(/_2$/);
      expect(c.simcFlask).toMatch(/^flask_/);
    }
  });

  it('has unique keys', () => {
    const keys = FLASK_CANDIDATES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildFlaskProfilesetLines', () => {
  it('emits one line per candidate using flask_<key> naming', () => {
    const out = buildFlaskProfilesetLines();
    const lines = out.split('\n');
    expect(lines.length).toBe(FLASK_CANDIDATES.length);
    for (const c of FLASK_CANDIDATES) {
      expect(out).toContain(`profileset."flask_${c.key}"+="flask=${c.simcFlask}"`);
    }
  });
});

describe('parseBestFlask', () => {
  it('picks the highest mean DPS as the winner', () => {
    const run = makeRun([
      { name: 'flask_blood_knights', mean: 640 },
      { name: 'flask_magisters', mean: 700 },
    ]);
    const result = parseBestFlask(run);
    expect(result?.best.name).toBe('Flask of the Magisters');
    expect(result?.best.dps).toBe(700);
  });

  it('lists losing candidates as alternatives with negative delta_pct', () => {
    const run = makeRun([
      { name: 'flask_blood_knights', mean: 700 },
      { name: 'flask_magisters', mean: 686 },
    ]);
    const result = parseBestFlask(run);
    expect(result?.alternatives).toHaveLength(1);
    expect(result?.alternatives[0]!.name).toBe('Flask of the Magisters');
    expect(result?.alternatives[0]!.delta_pct).toBe(-2);
  });

  it('rounds delta_pct to 2 decimal places', () => {
    const run = makeRun([
      { name: 'flask_blood_knights', mean: 642.9796792076426 },
      { name: 'flask_magisters', mean: 642.1818217126573 },
    ]);
    const result = parseBestFlask(run);
    expect(result?.alternatives[0]!.delta_pct).toBe(-0.12);
    expect(Number.isFinite(result!.alternatives[0]!.delta_pct)).toBe(true);
    expect(String(result!.alternatives[0]!.delta_pct).length).toBeLessThanOrEqual(6);
  });

  it('returns undefined when no profilesets match known flask keys', () => {
    const run = makeRun([
      { name: 'something_unrelated', mean: 1000 },
      { name: 'flask_unknown_key', mean: 999 },
    ]);
    expect(parseBestFlask(run)).toBeUndefined();
  });

  it('ignores profilesets whose names do not match any candidate', () => {
    const run = makeRun([
      { name: 'flask_blood_knights', mean: 640 },
      { name: 'noise_profileset', mean: 9999 },
      { name: 'food_silvermoon_parade', mean: 8888 },
    ]);
    const result = parseBestFlask(run);
    expect(result?.best.name).toBe('Flask of the Blood Knights');
    expect(result?.alternatives).toHaveLength(0);
  });

  it('handles a single matched profileset (winner with no alternatives)', () => {
    const run = makeRun([{ name: 'flask_blood_knights', mean: 640 }]);
    const result = parseBestFlask(run);
    expect(result?.best.name).toBe('Flask of the Blood Knights');
    expect(result?.alternatives).toEqual([]);
  });

  it('rounds dps to integers (Lua doesn\'t care about float precision here)', () => {
    const run = makeRun([{ name: 'flask_blood_knights', mean: 642.7 }]);
    expect(parseBestFlask(run)?.best.dps).toBe(643);
  });
});
