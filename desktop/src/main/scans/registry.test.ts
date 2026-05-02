import { describe, expect, it } from 'vitest';
import { SCANS, buildAllScanLines, parseAllScanRecords } from './registry';
import type { SimcRunResult } from '../simc-runner';

function fakeRun(profilesets: Array<{ name: string; mean: number }>): SimcRunResult {
  return {
    simcVersion: '1205-01',
    gitRevision: 'abcdefg',
    buildDate: '2026-04-30',
    profilesets: profilesets.map((p) => ({
      name: p.name,
      mean: p.mean,
      stddev: 0,
      iterations: 1,
    })),
    rawJsonPath: '/tmp/x.json',
  };
}

describe('SCANS registry', () => {
  it('contains the best_flask scan', () => {
    const ids = SCANS.map((s) => s.id);
    expect(ids).toContain('best_flask');
  });

  it('every registered scan has a unique id and prefix', () => {
    const ids = SCANS.map((s) => s.id);
    const prefixes = SCANS.map((s) => s.profilesetPrefix);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe('buildAllScanLines', () => {
  it('concatenates each scan\'s buildLines() output', () => {
    const out = buildAllScanLines();
    expect(out).toContain('profileset."flask_');
    expect(out).toContain('profileset."food_');
  });
});

describe('parseAllScanRecords', () => {
  it('wraps each scan\'s data in a ScanRecord with done status and timestamps', () => {
    const run = fakeRun([
      { name: 'flask_blood_knights', mean: 100 },
      { name: 'flask_magisters', mean: 110 },
      { name: 'food_silvermoon_parade', mean: 120 },
      { name: 'food_royal_roast', mean: 115 },
    ]);
    const startedAt = 1000;
    const finishedAt = 1010;
    const all = parseAllScanRecords(run, startedAt, finishedAt);

    expect(all.best_flask).toBeDefined();
    expect(all.best_flask?.status).toBe('done');
    expect(all.best_flask?.started_at).toBe(startedAt);
    expect(all.best_flask?.finished_at).toBe(finishedAt);
    expect((all.best_flask?.data as { best: { name: string } }).best.name).toBe(
      'Flask of the Magisters',
    );

    expect(all.best_food).toBeDefined();
    expect(all.best_food?.status).toBe('done');
    expect((all.best_food?.data as { best: { name: string } }).best.name).toBe(
      'Silvermoon Parade',
    );
  });

  it('omits scans whose parseResult returns undefined', () => {
    const run = fakeRun([{ name: 'unrelated_profileset', mean: 1 }]);
    const all = parseAllScanRecords(run, 1, 2);
    expect(all.best_flask).toBeUndefined();
    expect(all.best_food).toBeUndefined();
    expect(Object.keys(all)).toHaveLength(0);
  });
});
