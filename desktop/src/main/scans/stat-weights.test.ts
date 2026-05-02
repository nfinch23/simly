import { describe, expect, it } from 'vitest';
import {
  extractStatWeights,
  SCALE_FACTOR_STATS,
} from './stat-weights';
import type { SimcRunResult } from '../simc-runner';

function makeRun(scaleFactors: Record<string, number>): SimcRunResult {
  return {
    simcVersion: '1205-01',
    gitRevision: 'abcdef',
    buildDate: '2026-05-02',
    profilesets: [],
    rawJsonPath: '/tmp/x.json',
    rawJson: {
      sim: {
        players: [{ scale_factors: scaleFactors }],
      },
    },
  };
}

describe('SCALE_FACTOR_STATS', () => {
  it('covers primary + secondary stats', () => {
    expect(SCALE_FACTOR_STATS).toContain('intellect');
    expect(SCALE_FACTOR_STATS).toContain('strength');
    expect(SCALE_FACTOR_STATS).toContain('agility');
    expect(SCALE_FACTOR_STATS).toContain('crit');
    expect(SCALE_FACTOR_STATS).toContain('haste');
    expect(SCALE_FACTOR_STATS).toContain('mastery');
    expect(SCALE_FACTOR_STATS).toContain('versatility');
  });
});

describe('extractStatWeights', () => {
  it('maps SimC keys (Int/Crit/Haste/Mastery/Vers) to canonical lowercase', () => {
    const out = extractStatWeights(
      makeRun({ Int: 3.95, Crit: 0.55, Haste: 0.61, Mastery: 0.64, Vers: 0.40 }),
    );
    expect(out.intellect).toBeCloseTo(3.95);
    expect(out.crit).toBeCloseTo(0.55);
    expect(out.haste).toBeCloseTo(0.61);
    expect(out.mastery).toBeCloseTo(0.64);
    expect(out.versatility).toBeCloseTo(0.40);
  });

  it('drops zero/NaN entries (irrelevant stats — Strength on a warlock)', () => {
    const out = extractStatWeights(
      makeRun({ Int: 3.95, Str: 0, Agi: 0, SP: 0, Crit: 0.55 }),
    );
    expect(out.intellect).toBeCloseTo(3.95);
    expect(out.crit).toBeCloseTo(0.55);
    expect(out.strength).toBeUndefined();
    expect(out.agility).toBeUndefined();
    expect(out.spell_power).toBeUndefined();
  });

  it('returns empty object when scale_factors are missing', () => {
    const out = extractStatWeights({
      ...makeRun({}),
      rawJson: { sim: { players: [{}] } },
    });
    expect(out).toEqual({});
  });

  it('passes through unknown SimC keys as lowercase fallback', () => {
    // SimC may add new stats per patch; we shouldn't drop them, just
    // surface them with a lowercase name so the data is at least visible.
    const out = extractStatWeights(makeRun({ FutureStat: 1.23 }));
    expect(out.futurestat).toBeCloseTo(1.23);
  });
});
