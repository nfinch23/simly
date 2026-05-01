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
      { name: 'flask_tepid_versatility', mean: 640 },
      { name: 'flask_elemental_chaos', mean: 700 },
    ]);
    const result = parseBestFlask(run);
    expect(result?.best.name).toBe('Phial of Elemental Chaos');
    expect(result?.best.dps).toBe(700);
  });

  it('lists losing candidates as alternatives with negative delta_pct', () => {
    const run = makeRun([
      { name: 'flask_tepid_versatility', mean: 700 },
      { name: 'flask_elemental_chaos', mean: 686 },
    ]);
    const result = parseBestFlask(run);
    expect(result?.alternatives).toHaveLength(1);
    expect(result?.alternatives[0]!.name).toBe('Phial of Elemental Chaos');
    expect(result?.alternatives[0]!.delta_pct).toBe(-2);
  });

  it('rounds delta_pct to 2 decimal places', () => {
    const run = makeRun([
      { name: 'flask_tepid_versatility', mean: 642.9796792076426 },
      { name: 'flask_elemental_chaos', mean: 642.1818217126573 },
    ]);
    const result = parseBestFlask(run);
    // (642.18 - 642.98) / 642.98 * 100 = -0.124..., rounds to -0.12
    expect(result?.alternatives[0]!.delta_pct).toBe(-0.12);
    // Verify it's a finite, short number, not a long-tail float
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
      { name: 'flask_tepid_versatility', mean: 640 },
      { name: 'noise_profileset', mean: 9999 },
    ]);
    const result = parseBestFlask(run);
    expect(result?.best.name).toBe('Phial of Tepid Versatility');
    expect(result?.alternatives).toHaveLength(0);
  });

  it('handles a single matched profileset (winner with no alternatives)', () => {
    const run = makeRun([{ name: 'flask_tepid_versatility', mean: 640 }]);
    const result = parseBestFlask(run);
    expect(result?.best.name).toBe('Phial of Tepid Versatility');
    expect(result?.alternatives).toEqual([]);
  });

  it('rounds dps to integers (Lua doesn\'t care about float precision here)', () => {
    const run = makeRun([{ name: 'flask_tepid_versatility', mean: 642.7 }]);
    expect(parseBestFlask(run)?.best.dps).toBe(643);
  });
});
